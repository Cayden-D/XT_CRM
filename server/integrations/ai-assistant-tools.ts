import { z } from 'zod'
import { hasPermission } from '../auth.js'
import { db } from '../db.js'
import type { LlmTool } from '../llm/qwen.js'
import { agentMetrics } from './1688-performance-reports.js'
import { keywordHits, replyQuality } from './chat-insights.js'
import { LOSS_NAMES, finalLossSql, reviewFactsCte, type LossCode } from './chat-review.js'
import { buildDashboard } from '../routes/dashboard.js'
import { customerDetail, customersOf, listQuery, queryCustomers } from '../routes/customer-ops.js'

/**
 * Tools the 销途 AI sidebar may call. Every tool reads the CRM's own mirror tables (never the 1688 API, whose daily quota
 * belongs to the sync), is offered only when the user holds the matching permission, and is scoped to the user's tenant.
 * Writes are never executed here: `propose_followup` records a pending ai_action_request the user confirms in the sidebar.
 */
export type AssistantContext = { tenantId: string; userId: string; permissions: string[]; connectionId: string | null; conversationId: string; proposals: string[] }
type ToolDef<T extends z.ZodTypeAny> = { name: string; description: string; allowed: (p: string[]) => boolean; args: T; parameters: Record<string, unknown>; run: (ctx: AssistantContext, args: z.infer<T>) => Promise<unknown> }
const tool = <T extends z.ZodTypeAny>(def: ToolDef<T>) => def

const HOUR = 3_600_000, DAY = 24 * HOUR
export const beijingDate = (offset = 0) => new Date(Date.now() + 8 * HOUR + offset * DAY).toISOString().slice(0, 10)
const beijingTime = (date: Date) => new Date(date.getTime() + 8 * HOUR).toISOString().slice(0, 16).replace('T', ' ')
const can = (p: string[], ...any: string[]) => any.some(x => hasPermission(p, x))
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD')
const needShop = (ctx: AssistantContext) => { if (!ctx.connectionId) throw new Error('还没有授权的 1688 店铺。'); return ctx.connectionId }
const labels = {
  customer_type: { prospect: '潜在客户(未付款)', new: '新客(1单)', returning: '复购客', loyal: '忠实客' },
  level: { normal: '普通', platinum: '白金', vip: 'VIP' },
  due_reason: { planned: '计划跟进已到期', overdue: '超过购买周期未跟进' },
  pool: { unpaid: '下单未付款', no_order: '咨询未下单' },
} as const
const label = (kind: keyof typeof labels, value: unknown) => value == null ? undefined : (labels[kind] as Record<string, string>)[String(value)] ?? value

/** Compact JSON for the model: Beijing times, two-decimal numbers, nulls dropped. */
export function compact(value: unknown): unknown {
  if (value instanceof Date) return beijingTime(value)
  if (typeof value === 'number') return Number.isInteger(value) ? value : Math.round(value * 100) / 100
  if (Array.isArray(value)) return value.map(compact)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, v]) => v != null && v !== '' && !(Array.isArray(v) && !v.length)).map(([k, v]) => [k, compact(v)]))
  return value
}

type Names = { tags: Map<string, string>; agents: Map<string, string> }
/** Tag and agent names, so the model sees 标签/所属客服 as words rather than ids. */
async function names(ctx: AssistantContext): Promise<Names> {
  const tags = (await db.query('SELECT id,name FROM cust_tags WHERE tenant_id=$1', [ctx.tenantId])).rows
  const agents = ctx.connectionId ? (await db.query('SELECT id,login_id FROM perf_agents WHERE connection_id=$1', [ctx.connectionId])).rows : []
  return { tags: new Map(tags.map(t => [t.id, t.name])), agents: new Map(agents.map(a => [a.id, a.login_id])) }
}
const customerName = (r: Record<string, unknown>) => (r.name ?? r.wangwang_id ?? `买家尾号 ${r.buyer_tail}`) as string
const customerRow = (r: Record<string, unknown>, n?: Names) => ({
  ...(n ? { tags: (r.tag_ids as string[] ?? []).map(id => n.tags.get(id)).filter(Boolean),
    owner: r.owner_agent_id ? `${n.agents.get(r.owner_agent_id as string) ?? '其他客服'}${r.owner_source === 'manual' ? '（手动指定）' : '（自动分配）'}` : undefined } : {}),
  customerId: r.id, name: customerName(r), wangwang: r.wangwang_id, type: label('customer_type', r.customer_type), level: label('level', r.level),
  paidOrders: r.paid_orders, paidAmount: r.paid_amount, avgOrderAmount: r.avg_order_amount, lastPaidAt: r.last_paid_at, purchaseCycleDays: r.cycle_known ? r.cycle : undefined,
  overdue: r.overdue || undefined, lastChatAt: r.last_chat_at, pool: label('pool', r.pool), unpaidAmount: r.unpaid_amount, dueReason: label('due_reason', r.due_reason),
  nextFollowUpAt: r.next_follow_up_at, lastFollowup: (r.last_followup as { content?: string; created_at?: string } | null)?.content, followups: r.followups, note: r.note,
})

const FLAG_NAMES: Record<string, string> = { phone: '手机号', wechat: '微信', qq: 'QQ', offsite: '站外付款/交易用语', external_link: '外部链接', curt: '生硬用语', address: '地址/退货信息' }
const periodArgs = z.object({ from: date.optional(), to: date.optional() })
const periodParams = { from: { type: 'string', description: '开始日期 YYYY-MM-DD（北京时间），默认 7 天前' }, to: { type: 'string', description: '结束日期，默认今天' } }
function period(args: { from?: string; to?: string }) {
  const to = args.to ?? beijingDate(0), from = args.from ?? beijingDate(-6)
  if (from > to || Date.parse(to) - Date.parse(from) > 92 * DAY) throw new Error('日期范围需在 92 天以内且开始不晚于结束。')
  return { from, to }
}
const ownScope = (ctx: AssistantContext) => hasPermission(ctx.permissions, 'performance:read') ? null : ctx.userId

/** Latest agent replies to one buyer (masked text) and keyword hits in the buyer's messages. */
async function chatContext(buyerId: string) {
  const replies = (await db.query(`SELECT m.sent_at,a.login_id,m.text_masked,m.flags FROM perf_chat_messages m JOIN perf_chat_sessions s ON s.id=m.session_id JOIN perf_agents a ON a.id=s.agent_id
    WHERE s.buyer_id=$1 AND m.direction=0 AND m.text_masked IS NOT NULL AND m.text_masked<>'[图片]' ORDER BY m.sent_at DESC LIMIT 15`, [buyerId])).rows
  const words = (await db.query(`SELECT k->>'word' AS word,count(*)::int AS times,max(m.sent_at) AS last FROM perf_chat_messages m JOIN perf_chat_sessions s ON s.id=m.session_id CROSS JOIN LATERAL jsonb_array_elements(m.keywords) k
    WHERE s.buyer_id=$1 AND m.direction=1 AND m.keywords<>'[]'::jsonb GROUP BY 1 ORDER BY 2 DESC LIMIT 10`, [buyerId])).rows
  return {
    recentAgentReplies: replies.reverse().map(r => ({ at: r.sent_at, agent: String(r.login_id).split(':').pop(), text: r.text_masked, flags: (r.flags as string[]).filter(f => FLAG_NAMES[f]).map(f => FLAG_NAMES[f]) })),
    buyerKeywordHits: words,
    chatNote: '买家消息原文被 1688 隐藏；以上为客服发出的文本（联系方式已遮盖）和买家消息命中的关键词',
  }
}

const tools = [
  tool({
    name: 'get_business_overview',
    description: '店铺经营概览（与首页经营看板同口径）：付款金额/订单/买家、退款（含运费）、净额、接待人数、询单转化率、首次响应、每日趋势、客服排行、新老客结构、客户待办数量、商品采集与上架队列状态。含上一周期对比和数据同步完整度。',
    allowed: p => can(p, 'performance:read', 'customer_ops:read', 'integration:read'),
    args: z.object({ range: z.enum(['today', '7d', '30d']).default('7d') }),
    parameters: { type: 'object', properties: { range: { type: 'string', enum: ['today', '7d', '30d'], description: 'today=今天（对比昨天），7d=近7天，30d=近30天；默认 7d' } } },
    run: async (ctx, args) => {
      const d = await buildDashboard(ctx.tenantId, ctx.permissions, { range: args.range, ...(ctx.connectionId ? { connectionId: ctx.connectionId } : {}) })
      const shop = (d.shops as { id: string; display_name: string | null }[]).find(s => s.id === d.connectionId)
      const { shops: _shops, sections: _sections, connectionId: _id, ...rest } = d
      const lastRun = (rest.sync as { last_run?: { errorCode?: string | null } } | undefined)?.last_run
      const quota = lastRun?.errorCode?.startsWith('gw.Qos') ? '最近同步因 1688 平台当日调用额度用完而暂停，系统会在额度恢复后自动继续，无需手动重试；' : ''
      return { shop: shop?.display_name, currency: '元', notes: `${quota}金额单位元；退款按完成时间、含退运费；转化=周期内咨询的买家在归因窗口内下单并付款`, ...rest }
    },
  }),
  tool({
    name: 'list_customers',
    description: '按条件查询 1688 线上客户（客户经营）。可查待跟进、下单未付款、咨询未下单、超过购买周期、按关键词（姓名/旺旺/电话/备注/订单号）搜索，并按金额等排序。返回客户编号 customerId，可用于 get_customer 或 propose_followup。',
    allowed: p => can(p, 'customer_ops:read'),
    args: z.object({
      segment: z.enum(['all', 'due', 'unpaid', 'no_order', 'overdue']).default('all'), search: z.string().trim().max(60).optional(),
      customerType: z.enum(['prospect', 'new', 'returning', 'loyal']).optional(), level: z.enum(['normal', 'platinum', 'vip']).optional(),
      sort: z.enum(['last_paid', 'paid_amount', 'paid_orders', 'last_chat', 'unpaid_at', 'next_follow_up']).optional(), limit: z.number().int().min(1).max(20).default(10),
      tag: z.string().trim().max(30).optional(),
    }),
    parameters: { type: 'object', properties: {
      segment: { type: 'string', enum: ['all', 'due', 'unpaid', 'no_order', 'overdue'], description: 'due=今天该跟进；unpaid=下单未付款；no_order=咨询未下单；overdue=超过购买周期；all=全部' },
      search: { type: 'string', description: '关键词：姓名、旺旺、电话、备注、买家尾号或订单号' },
      customerType: { type: 'string', enum: ['prospect', 'new', 'returning', 'loyal'] }, level: { type: 'string', enum: ['normal', 'platinum', 'vip'] },
      sort: { type: 'string', enum: ['last_paid', 'paid_amount', 'paid_orders', 'last_chat', 'unpaid_at', 'next_follow_up'] },
      limit: { type: 'integer', minimum: 1, maximum: 20, description: '默认 10' },
      tag: { type: 'string', description: '只看带此标签的客户（标签名）' },
    } },
    run: async (ctx, args) => {
      const sort = args.sort ?? ({ due: 'next_follow_up', unpaid: 'unpaid_at', no_order: 'last_chat', overdue: 'paid_amount', all: 'last_paid' } as const)[args.segment]
      const n = await names(ctx)
      const tagId = args.tag ? [...n.tags].find(([, name]) => name === args.tag)?.[0] : undefined
      if (args.tag && !tagId) throw new Error(`没有名为“${args.tag}”的标签。现有标签：${[...n.tags.values()].join('、') || '无'}`)
      const query = listQuery.parse({ connectionId: needShop(ctx), sort, search: args.search, customerType: args.customerType, level: args.level, tagId,
        ...(args.segment === 'due' ? { due: 'yes' } : args.segment === 'overdue' ? { overdue: 'yes' } : args.segment === 'unpaid' || args.segment === 'no_order' ? { pool: args.segment } : {}) })
      const rows = await queryCustomers(ctx.tenantId, query, args.limit)
      return { total: rows[0]?.total ?? 0, shown: rows.length, customers: rows.map(r => customerRow(r, n)) }
    },
  }),
  tool({
    name: 'get_customer',
    description: '读取一位 1688 客户的完整资料：画像与分层、购买周期、最近订单与商品明细、退款、跟进记录、咨询日期与接待客服。',
    allowed: p => can(p, 'customer_ops:read'),
    args: z.object({ customerId: z.string().uuid() }),
    parameters: { type: 'object', required: ['customerId'], properties: { customerId: { type: 'string', description: 'list_customers 返回的 customerId，或上下文中的当前客户' } } },
    run: async (ctx, args) => {
      const d = await customerDetail(ctx.tenantId, args.customerId)
      const c = d.customer as Record<string, unknown>
      return {
        ...customerRow(c, await names(ctx)), phone: c.phone, wechat: c.wechat, address: c.address, memberIdentity: c.member_identity, purchaseType: c.purchase_type, salesChannels: c.sales_channels,
        firstPaidAt: c.first_paid_at, inquiryDays: c.inquiry_days, linkedCrmCustomer: (d.account as { name?: string } | null)?.name,
        orders: (d.orders as Record<string, unknown>[]).slice(0, 10).map(o => ({ orderId: o.order_id, status: o.status, amount: o.total_amount, refunded: o.refunded || undefined, placedAt: o.placed_at, paidAt: o.paid_at,
          items: ((o.items as { name?: string; sku?: string; quantity?: number; amount?: number }[]) ?? []).slice(0, 5).map(i => `${i.name ?? ''}${i.sku ? `（${i.sku}）` : ''} ×${i.quantity ?? '?'} ¥${i.amount ?? '?'}`) })),
        followups: (d.followups as Record<string, unknown>[]).slice(0, 10).map(f => ({ at: f.created_at, by: f.created_by_name, content: f.content, next: f.need_follow_up ? f.next_follow_up_at ?? '需跟进' : undefined })),
        chatDays: (d.chats as Record<string, unknown>[]).slice(0, 10).map(s => ({ date: s.chat_date, agent: s.login_id, buyerMessages: s.buyer_messages, agentMessages: s.agent_messages })),
        // What agents last said to this buyer (masked) and what the buyer's messages hit; agent text is for performance managers only.
        ...(can(ctx.permissions, 'performance:read') ? await chatContext(args.customerId) : {}),
      }
    },
  }),
  tool({
    name: 'get_agent_performance',
    description: '客服绩效明细：每个客服账号的接待人数、询单、下单/付款买家、归因付款金额、退款、首次与平均响应时长（按工作时间计）、未回复、转接。最多 92 天。',
    allowed: p => can(p, 'performance:read', 'performance:read_own'),
    args: z.object({ from: date.optional(), to: date.optional() }),
    parameters: { type: 'object', properties: { from: { type: 'string', description: '开始日期 YYYY-MM-DD（北京时间），默认 7 天前' }, to: { type: 'string', description: '结束日期，默认今天' } } },
    run: async (ctx, args) => {
      const to = args.to ?? beijingDate(0), from = args.from ?? beijingDate(-6)
      if (from > to || Date.parse(to) - Date.parse(from) > 92 * DAY) throw new Error('日期范围需在 92 天以内且开始不晚于结束。')
      const own = hasPermission(ctx.permissions, 'performance:read') ? null : ctx.userId
      const m = await agentMetrics(ctx.tenantId, needShop(ctx), from, to, own)
      return { from, to, attributionScheme: m.scheme, scope: own ? '仅本人绑定的客服账号' : '全部客服', agents: m.rows.filter(r => r.reception > 0 || r.paid_amount > 0).map(r => ({
        agent: r.login_id, mainAccount: r.is_main || undefined, staff: r.user_name, reception: r.reception, inquiry: r.inquiry, orderedBuyers: r.ordered_buyers, paidBuyers: r.paid_buyers,
        paidAmount: r.paid_amount, refundAmount: r.refund_amount, firstResponseSeconds: r.first_response_seconds, avgResponseSeconds: r.avg_response_seconds, unanswered: r.unanswered, transfers: r.transfers })) }
    },
  }),
  tool({
    name: 'get_reply_quality',
    description: '客服回复质量与站外交易风险：各客服人工消息数、平均回复字数、极短回复占比、发图/卡片数、生硬用语、站外交易风险（客服发手机号、微信、QQ、站外付款用语、外部链接）及具体记录（文本已遮盖联系方式）。买家原文平台不提供。',
    allowed: p => can(p, 'performance:read', 'performance:read_own'),
    args: periodArgs,
    parameters: { type: 'object', properties: periodParams },
    run: async (ctx, args) => {
      const { from, to } = period(args)
      const q = await replyQuality(ctx.tenantId, needShop(ctx), from, to, ownScope(ctx))
      return {
        from, to, scope: ownScope(ctx) ? '仅本人绑定的客服账号' : '全部客服', textCoverage: q.coverage, totals: q.totals,
        notes: '文本覆盖率低于 80% 时指标仅供参考；生硬用语与极短回复只是复盘提示，不计入绩效；手机号与地址一起出现（退货/寄样地址）不算风险',
        agents: q.agents.map(a => ({ agent: a.login_id, mainAccount: a.is_main || undefined, staff: a.user_name, manualMessages: a.messages, avgChars: a.avg_chars,
          shortReplyRate: a.text_replies ? Math.round(a.short_replies / a.text_replies * 1000) / 1000 : null, imagesOrCards: a.images, curt: a.curt, offsiteRisks: a.offsite })),
        offsiteRisks: q.risks.slice(0, 20).map(r => ({ at: r.sent_at, agent: String(r.login_id).split(':').pop(), customerId: r.buyer_id, customer: r.buyer_name ?? `买家尾号 ${r.buyer_tail}`,
          types: (r.flags as string[]).filter(f => ['phone', 'wechat', 'qq', 'offsite', 'external_link'].includes(f)).map(f => FLAG_NAMES[f]), text: r.text_masked })),
        curtExamples: q.curt.slice(0, 10).map(c => ({ at: c.sent_at, agent: String(c.login_id).split(':').pop(), text: c.text_masked })),
      }
    },
  }),
  tool({
    name: 'get_keyword_hits',
    description: '旺旺关键词库与命中：当前词库（分类、添加时间）、每个词被买家/客服提到的次数、涉及会话和买家数、最近命中记录（含 customerId）。买家原文被平台隐藏，关键词命中是了解买家在问什么（退款、投诉、催发货、发票、议价、定制等）的唯一途径。',
    allowed: p => can(p, 'performance:read', 'performance:read_own'),
    args: periodArgs.extend({ category: z.string().trim().max(20).optional() }),
    parameters: { type: 'object', properties: { ...periodParams, category: { type: 'string', description: '只看某个分类，如 售后退款、投诉差评、物流催单、发票、议价、定制大单' } } },
    run: async (ctx, args) => {
      const { from, to } = period(args)
      const shop = needShop(ctx)
      const library = (await db.query('SELECT word,category,on_platform,created_at FROM perf_keywords WHERE connection_id=$1 ORDER BY category,created_at', [shop])).rows
      const h = await keywordHits(ctx.tenantId, shop, from, to, ownScope(ctx))
      const pick = <T extends { category: string }>(rows: T[]) => args.category ? rows.filter(r => r.category === args.category) : rows
      return {
        from, to, notes: '1688 只在关键词加入后的新消息上标记命中，加入前的历史消息不会补标；词库为空时不会有任何命中',
        library: library.map(k => ({ word: k.word, category: k.category, addedAt: k.created_at, onPlatform: k.on_platform })),
        words: pick(h.words).map(w => ({ word: w.word, category: w.category, buyerMentions: w.buyer_hits, agentMentions: w.agent_hits, sessions: w.sessions, buyers: w.buyers, lastHit: w.last_hit })),
        recent: pick(h.recent).slice(0, 20).map(r => ({ at: r.sent_at, word: r.word, category: r.category, by: r.direction === 1 ? '买家' : '客服', agent: String(r.login_id).split(':').pop(), customerId: r.buyer_id, customer: r.buyer_name ?? `买家尾号 ${r.buyer_tail}` })),
      }
    },
  }),
  tool({
    name: 'get_inquiry_review_summary',
    description: '询盘复盘汇总：已过归属窗口的未下单询盘的流失原因分布（只含主管确认和时间规则能证明的结论）、各客服已确认的问题数、尚未复盘的数量。平台隐藏买家文字，这些结论是推断，不能当作买家原话。',
    allowed: p => can(p, 'performance:review', 'performance:review_read'),
    args: periodArgs,
    parameters: { type: 'object', properties: periodParams },
    run: async (ctx, args) => {
      const { from, to } = period(args), params = [ctx.tenantId, needShop(ctx), from, to, null]
      const reasons = (await db.query(`WITH ${reviewFactsCte} SELECT coalesce(${finalLossSql('r', 'f')},'unknown') AS code,count(*)::int AS sessions
        FROM review_rules f LEFT JOIN chat_reviews r ON r.session_id=f.id WHERE f.category='no_order' AND f.matured AND coalesce(r.status,'')<>'dismissed' GROUP BY 1 ORDER BY 2 DESC`, params)).rows
      const agents = (await db.query(`SELECT a.login_id,count(*)::int AS confirmed,sum(jsonb_array_length(coalesce(r.final_findings,r.ai_findings)))::int AS findings FROM chat_reviews r JOIN perf_agents a ON a.id=r.agent_id
        WHERE r.tenant_id=$1 AND a.connection_id=$2 AND r.chat_date BETWEEN $3::date AND $4::date AND r.status IN ('confirmed','corrected') GROUP BY 1 ORDER BY 3 DESC LIMIT 30`, params.slice(0, 4))).rows
      return { from, to, notes: '“证据不足”是最常见的正确结论；买家文字不可见，不要转述为买家说过的话；未确认的 AI 推断不在其中', reasons: reasons.map(r => ({ reason: LOSS_NAMES[r.code as LossCode] ?? r.code, sessions: r.sessions })), agents: agents.map(a => ({ agent: String(a.login_id).split(':').pop(), confirmedReviews: a.confirmed, confirmedFindings: a.findings })) }
    },
  }),
  tool({
    name: 'get_top_products',
    description: '按付款订单统计商品销量排行：每个商品的付款金额、件数、订单数、买家数。用于分析热销/滞销商品。',
    allowed: p => can(p, 'performance:read'),
    args: z.object({ from: date.optional(), to: date.optional(), limit: z.number().int().min(1).max(20).default(10) }),
    parameters: { type: 'object', properties: { from: { type: 'string', description: '开始日期 YYYY-MM-DD，默认 7 天前' }, to: { type: 'string', description: '结束日期，默认今天' }, limit: { type: 'integer', minimum: 1, maximum: 20 } } },
    run: async (ctx, args) => {
      const to = args.to ?? beijingDate(0), from = args.from ?? beijingDate(-6)
      if (from > to || Date.parse(to) - Date.parse(from) > 92 * DAY) throw new Error('日期范围需在 92 天以内且开始不晚于结束。')
      const rows = (await db.query(`SELECT coalesce(i->>'productId',i->>'name') AS product_id,max(i->>'name') AS name,sum((i->>'amount')::numeric)::float AS amount,
          sum((i->>'quantity')::numeric)::float AS quantity,count(DISTINCT o.order_id)::int AS orders,count(DISTINCT o.buyer_open_uid)::int AS buyers
        FROM perf_orders o CROSS JOIN LATERAL jsonb_array_elements(o.items) i
        WHERE o.connection_id=$1 AND o.paid_at>=($2::date::timestamp AT TIME ZONE 'Asia/Shanghai') AND o.paid_at<(($3::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai')
        GROUP BY 1 ORDER BY 3 DESC NULLS LAST LIMIT $4`, [needShop(ctx), from, to, args.limit])).rows
      return { from, to, products: rows.map(r => ({ productId: r.product_id, name: r.name, amount: r.amount, quantity: r.quantity, orders: r.orders, buyers: r.buyers })) }
    },
  }),
  tool({
    name: 'propose_followup',
    description: '为客户拟一条跟进记录（可附下次跟进日期）。不会直接写入：系统会在侧边栏生成确认卡片，由用户点击“确认执行”后才保存。每位客户一次只提一条。',
    allowed: p => can(p, 'customer_ops:update'),
    args: z.object({ customerId: z.string().uuid(), content: z.string().trim().min(1).max(500), nextFollowUpDate: date.optional() }),
    parameters: { type: 'object', required: ['customerId', 'content'], properties: {
      customerId: { type: 'string' }, content: { type: 'string', description: '跟进内容，500 字以内' },
      nextFollowUpDate: { type: 'string', description: '下次跟进日期 YYYY-MM-DD（北京时间）；不填表示无需再次跟进' },
    } },
    run: async (ctx, args) => {
      if (args.nextFollowUpDate && args.nextFollowUpDate < beijingDate(0)) throw new Error('下次跟进日期不能早于今天。')
      const d = await customerDetail(ctx.tenantId, args.customerId)
      const c = d.customer as Record<string, unknown>
      const payload = { customerId: args.customerId, customerName: customerName(c), content: args.content, nextFollowUpDate: args.nextFollowUpDate ?? null }
      return propose(ctx, 'customer.followup', args.customerId, payload)
    },
  }),
  tool({
    name: 'get_customer_options',
    description: '客户经营的可选项：现有客户标签（及客户数）、当前店铺的客服账号（可作所属客服）、是否开启自动分配所属客服。拟写标签或所属客服前先查。',
    allowed: p => can(p, 'customer_ops:read'),
    args: z.object({}),
    parameters: { type: 'object', properties: {} },
    run: async ctx => {
      const tags = (await db.query('SELECT t.name,(SELECT count(*)::int FROM cust_buyer_tags b WHERE b.tag_id=t.id) AS customers FROM cust_tags t WHERE t.tenant_id=$1 ORDER BY t.name', [ctx.tenantId])).rows
      const agents = (await db.query('SELECT login_id,is_main,present FROM perf_agents WHERE connection_id=$1 ORDER BY is_main DESC,login_id', [needShop(ctx)])).rows
      const auto = (await db.query('SELECT auto_assign_owner FROM perf_settings WHERE tenant_id=$1', [ctx.tenantId])).rows[0]?.auto_assign_owner ?? true
      return { tags, agents: agents.map(a => ({ agent: a.login_id, mainAccount: a.is_main || undefined, active: a.present })), autoAssignOwner: auto }
    },
  }),
  tool({
    name: 'propose_tags',
    description: '为一位或多位客户（同一店铺，最多 50 位）添加和/或移除标签（按标签名；添加不存在的标签会新建）。不会直接写入：生成确认卡片，用户确认后才保存。',
    allowed: p => can(p, 'customer_ops:update'),
    args: z.object({ customerIds: z.array(z.string().uuid()).min(1).max(50), add: z.array(z.string().trim().min(1).max(30)).max(10).default([]), remove: z.array(z.string().trim().min(1).max(30)).max(10).default([]) })
      .refine(v => v.add.length + v.remove.length > 0, { message: '至少添加或移除一个标签' }),
    parameters: { type: 'object', required: ['customerIds'], properties: {
      customerIds: { type: 'array', items: { type: 'string' }, description: 'customerId 列表' },
      add: { type: 'array', items: { type: 'string' }, description: '要添加的标签名' }, remove: { type: 'array', items: { type: 'string' }, description: '要移除的标签名' },
    } },
    run: async (ctx, args) => {
      const add = [...new Set(args.add)], remove = [...new Set(args.remove)].filter(t => !add.includes(t))
      const existing = (await db.query<{ name: string }>('SELECT name FROM cust_tags WHERE tenant_id=$1 AND name=ANY($2::text[])', [ctx.tenantId, [...add, ...remove]])).rows.map(r => r.name)
      const missing = remove.filter(t => !existing.includes(t))
      if (missing.length) throw new Error(`要移除的标签不存在：${missing.join('、')}`)
      const customers = await listed(ctx, args.customerIds)
      return propose(ctx, 'customer.tags', customers[0].id, { customers, add, remove, newTags: add.filter(t => !existing.includes(t)) })
    },
  }),
  tool({
    name: 'propose_owner',
    description: '把一位或多位客户（同一店铺，最多 50 位）的所属客服改为指定客服账号（手动指定，不会被自动分配覆盖），或设为 auto 交还自动分配。会影响按所属客服计算的业绩归因。生成确认卡片，用户确认后才保存。',
    allowed: p => can(p, 'customer_ops:update'),
    args: z.object({ customerIds: z.array(z.string().uuid()).min(1).max(50), agent: z.string().trim().min(1).max(100) }),
    parameters: { type: 'object', required: ['customerIds', 'agent'], properties: {
      customerIds: { type: 'array', items: { type: 'string' } },
      agent: { type: 'string', description: '客服账号（get_customer_options 返回的 agent，可只写冒号后的子账号名），或 auto 表示恢复自动分配' },
    } },
    run: async (ctx, args) => {
      const customers = await listed(ctx, args.customerIds)
      if (args.agent === 'auto') return propose(ctx, 'customer.owner', customers[0].id, { customers, agentId: 'auto', agentName: '自动分配' })
      const agents = (await db.query<{ id: string; login_id: string }>('SELECT id,login_id FROM perf_agents WHERE connection_id=$1', [needShop(ctx)])).rows
      const match = agents.filter(a => a.login_id === args.agent || a.login_id.split(':').pop() === args.agent)
      if (match.length !== 1) throw new Error(`${match.length ? '客服账号不唯一' : '找不到该客服账号'}：${args.agent}。可选：${agents.map(a => a.login_id).join('、')}`)
      return propose(ctx, 'customer.owner', customers[0].id, { customers, agentId: match[0].id, agentName: match[0].login_id })
    },
  }),
]

/** Customers of the current shop with display names, for a proposal card. */
async function listed(ctx: AssistantContext, ids: string[]) {
  const { ids: unique, connectionId } = await customersOf(ctx.tenantId, ids)
  if (connectionId !== needShop(ctx)) throw new Error('这些客户不属于当前店铺。')
  const rows = (await db.query(`SELECT b.id,p.name,p.wangwang_id,right(b.buyer_key,6) AS buyer_tail FROM perf_buyers b LEFT JOIN cust_profiles p ON p.buyer_id=b.id WHERE b.id=ANY($1::uuid[])`, [unique])).rows
  const byId = new Map(rows.map(r => [r.id, customerName(r)]))
  return unique.map(id => ({ id, name: byId.get(id)! }))
}

async function propose(ctx: AssistantContext, type: string, targetId: string, payload: object) {
  const id = (await db.query(`INSERT INTO ai_action_requests(tenant_id,conversation_id,requested_by,action_type,target_type,target_id,proposed_payload)
    VALUES($1,$2,$3,$4,'perf_buyer',$5,$6) RETURNING id`, [ctx.tenantId, ctx.conversationId, ctx.userId, type, targetId, JSON.stringify(payload)])).rows[0].id as string
  ctx.proposals.push(id)
  return { proposalId: id, status: '已生成确认卡片，等待用户确认；尚未保存' }
}

export function toolsFor(permissions: string[]): LlmTool[] {
  return tools.filter(t => t.allowed(permissions)).map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }))
}

const RESULT_LIMIT = 12_000
/** Runs one tool call; failures come back to the model as an error message instead of aborting the chat. */
export async function runTool(ctx: AssistantContext, name: string, rawArgs: string) {
  const def = tools.find(t => t.name === name)
  if (!def || !def.allowed(ctx.permissions)) return { ok: false, content: JSON.stringify({ error: '该工具不可用或当前账号无权限。' }) }
  try {
    const parsed = def.args.safeParse(rawArgs ? JSON.parse(rawArgs) : {})
    if (!parsed.success) return { ok: false, content: JSON.stringify({ error: `参数不正确：${parsed.error.issues.map(i => i.message).join('；')}` }) }
    const text = JSON.stringify(compact(await (def.run as (c: AssistantContext, a: unknown) => Promise<unknown>)(ctx, parsed.data)))
    return { ok: true, content: text.length > RESULT_LIMIT ? `${text.slice(0, RESULT_LIMIT)}…（结果过长已截断，请缩小范围）` : text }
  } catch (error) {
    return { ok: false, content: JSON.stringify({ error: error instanceof Error ? error.message : '查询失败' }) }
  }
}

