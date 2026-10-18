import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { requirePermission } from '../auth.js'
import { db } from '../db.js'
import { IntegrationError } from '../integrations/1688.js'
import { computeAttributions } from '../integrations/1688-performance-orders.js'
import { assignOwners, invalidateBuyerOrders } from '../integrations/customer-ops.js'
import { attachmentLimits, attachmentTypes, attachmentUrl, putAttachment, removeAttachment } from '../integrations/customer-attachments.js'
import { sendCsv } from '../csv.js'

// Option lists from the shop's existing customer profile conventions.
export const memberIdentities = ['无会员身份','其他会员身份','网点','微分销','淘分销','贸易公司','测试','行政采购','个人自用'] as const
export const salesChannels = ['快手','抖音','拼多多','微信小商店','淘宝','天猫','跨境','淘特','有赞','京东','美团团好货','小红书','当当','苏宁','阿里巴巴C2M','寺库','大V店','行云','蜜芽','菠萝派商城','无渠道'] as const

const idSchema = z.object({ id: z.string().uuid() })
const csv = <T extends z.ZodTypeAny>(item: T) => z.string().optional().transform((value, ctx) => {
  if (!value) return undefined
  const parsed = z.array(item).max(50).safeParse(value.split(',').filter(Boolean))
  if (!parsed.success) { ctx.addIssue({ code: 'custom', message: '筛选条件不合法' }); return z.NEVER }
  return parsed.data as z.infer<T>[]
})
export const listQuery = z.object({
  connectionId: z.string().uuid(),
  search: z.string().trim().max(60).optional(),
  purchaseType: csv(z.enum(['distribution','procurement'])),
  customerType: csv(z.enum(['prospect','new','returning','loyal'])),
  memberIdentity: csv(z.enum(memberIdentities)),
  channel: csv(z.enum(salesChannels)),
  level: csv(z.enum(['normal','platinum','vip'])),
  priceTier: csv(z.enum(['low','mid','high'])),
  tagId: csv(z.string().uuid()),
  minFollowups: z.coerce.number().int().min(1).max(1000).optional(),
  overdue: z.enum(['no','yes']).optional(),
  idleDays: z.coerce.number().int().min(1).max(3650).optional(),
  cycle: csv(z.enum(['1-2','3-7','8-30','30+'])),
  pool: z.enum(['unpaid','no_order','any']).optional(),
  due: z.enum(['yes']).optional(),
  ownerAgentId: z.string().uuid().optional(),
  sort: z.enum(['last_paid','paid_amount','paid_orders','avg_order','last_chat','unpaid_at','next_follow_up']).default('last_paid'),
  page: z.coerce.number().int().min(1).max(10000).default(1),
})
const tenantOf = (request: FastifyRequest) => request.authUser.tenantId

async function audit(tenantId: string, actorId: string, entityType: string, id: string, action: string, requestId: string, after?: object) {
  await db.query('INSERT INTO audit_logs(tenant_id,actor_id,action,entity_type,entity_id,after_data,request_id)VALUES($1,$2,$3,$4,$5,$6,$7)', [tenantId, actorId, action, entityType, id, after ? JSON.stringify(after) : null, requestId])
}
async function ensureShop(tenantId: string, connectionId: string) {
  const shop = (await db.query<{ display_name: string | null }>('SELECT display_name FROM integration_1688_perf_connections WHERE id=$1 AND tenant_id=$2', [connectionId, tenantId])).rows[0]
  if (!shop) throw new IntegrationError('NOT_FOUND', '店铺不存在。', 404)
  return shop
}
async function buyerOf(tenantId: string, buyerId: string) {
  const row = (await db.query('SELECT id,connection_id FROM perf_buyers WHERE id=$1 AND tenant_id=$2', [buyerId, tenantId])).rows[0]
  if (!row) throw new IntegrationError('NOT_FOUND', '客户不存在。', 404)
  return row as { id: string; connection_id: string }
}

/**
 * Customer rows with segments derived from current thresholds. Segments are computed at query time,
 * so changing a threshold re-segments everyone immediately.
 */
const customerSql = (where: string, order: string, limit: string) => `WITH settings AS (SELECT * FROM cust_settings WHERE tenant_id=$1),
  base AS (SELECT b.id,b.buyer_key,b.connection_id,right(b.buyer_key,6) AS buyer_tail,
      p.name,p.wangwang_id,p.phone,p.wechat,p.email,p.qq,p.address,p.member_identity,p.purchase_type,coalesce(p.sales_channels,'{}') AS sales_channels,coalesce(p.cycle_mode,'system') AS cycle_mode,p.cycle_days,p.note,
      p.account_id,p.owner_agent_id,p.owner_source,coalesce(p.revision,0) AS revision,
      coalesce(st.paid_orders,0) AS paid_orders,coalesce(st.paid_amount,0)::float AS paid_amount,st.avg_order_amount::float AS avg_order_amount,st.first_paid_at,st.last_paid_at,
      st.avg_interval_days::float AS avg_interval_days,coalesce(st.inquiry_days,0) AS inquiry_days,coalesce(st.last_chat_at,b.last_chat_at) AS last_chat_at,
      st.unpaid_order_id,st.unpaid_amount::float AS unpaid_amount,st.unpaid_placed_at,
      CASE WHEN p.cycle_mode='custom' THEN p.cycle_days::float WHEN st.avg_interval_days IS NOT NULL THEN st.avg_interval_days::float ELSE s.default_cycle_days::float END AS cycle,
      CASE WHEN p.cycle_mode='custom' OR st.avg_interval_days IS NOT NULL THEN true ELSE false END AS cycle_known,
      (SELECT count(*)::int FROM cust_followups f WHERE f.buyer_id=b.id) AS followups,
      (SELECT max(f.created_at) FROM cust_followups f WHERE f.buyer_id=b.id) AS last_followup_at,
      (SELECT count(*)::int FROM cust_attachments a WHERE a.buyer_id=b.id) AS attachments,
      (SELECT json_build_object('content',f.content,'method',f.method,'need_follow_up',f.need_follow_up,'next_follow_up_at',f.next_follow_up_at,'created_at',f.created_at)
        FROM cust_followups f WHERE f.buyer_id=b.id ORDER BY f.created_at DESC LIMIT 1) AS last_followup,
      (SELECT f.next_follow_up_at FROM cust_followups f WHERE f.buyer_id=b.id AND f.need_follow_up AND NOT f.superseded ORDER BY f.created_at DESC LIMIT 1) AS next_follow_up_at,
      coalesce((SELECT array_agg(t.tag_id) FROM cust_buyer_tags t WHERE t.buyer_id=b.id),'{}') AS tag_ids,
      s.loyal_orders,s.level_platinum,s.level_vip,s.price_mid,s.price_high,s.overdue_followup
    FROM perf_buyers b CROSS JOIN settings s LEFT JOIN cust_profiles p ON p.buyer_id=b.id LEFT JOIN cust_stats st ON st.buyer_id=b.id
    WHERE b.tenant_id=$1 AND b.connection_id=$2),
  seg AS (SELECT base.*,
      CASE WHEN paid_orders=0 THEN 'prospect' WHEN paid_orders=1 THEN 'new' WHEN paid_orders>=loyal_orders THEN 'loyal' ELSE 'returning' END AS customer_type,
      CASE WHEN paid_orders=0 THEN NULL WHEN paid_amount<level_platinum THEN 'normal' WHEN paid_amount<level_vip THEN 'platinum' ELSE 'vip' END AS level,
      CASE WHEN avg_order_amount IS NULL THEN NULL WHEN avg_order_amount<price_mid THEN 'low' WHEN avg_order_amount<price_high THEN 'mid' ELSE 'high' END AS price_tier,
      (paid_orders>0 AND last_paid_at+make_interval(secs=>cycle*86400)<now()) AS overdue,
      CASE WHEN paid_orders>0 THEN last_paid_at+make_interval(secs=>cycle*86400) END AS overdue_at,
      CASE WHEN unpaid_order_id IS NOT NULL THEN 'unpaid' WHEN paid_orders=0 AND inquiry_days>0 THEN 'no_order' END AS pool
    FROM base),
  -- 待跟进: a planned follow-up that is due by the end of today, or (if enabled) a customer past their purchase cycle
  -- with no follow-up written since they became overdue and no plan for a later date.
  due AS (SELECT seg.*,
      CASE WHEN next_follow_up_at<((now() AT TIME ZONE 'Asia/Shanghai')::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai' THEN 'planned'
        WHEN overdue_followup AND overdue AND next_follow_up_at IS NULL AND (last_followup_at IS NULL OR last_followup_at<overdue_at) THEN 'overdue' END AS due_reason
    FROM seg)
  SELECT due.*,count(*) OVER()::int AS total FROM due ${where} ORDER BY ${order} ${limit}`

const sorts: Record<string, string> = {
  last_paid: 'last_paid_at DESC NULLS LAST,last_chat_at DESC NULLS LAST,id',
  paid_amount: 'paid_amount DESC,id', paid_orders: 'paid_orders DESC,id', avg_order: 'avg_order_amount DESC NULLS LAST,id',
  last_chat: 'last_chat_at DESC NULLS LAST,id', unpaid_at: 'unpaid_placed_at DESC NULLS LAST,last_chat_at DESC NULLS LAST,id',
  next_follow_up: 'next_follow_up_at ASC NULLS LAST,overdue_at ASC NULLS LAST,id',
}

function filters(query: z.infer<typeof listQuery>, params: unknown[]) {
  const where: string[] = []
  const add = (sql: (p: string) => string, value: unknown) => { params.push(value); where.push(sql(`$${params.length}`)) }
  if (query.purchaseType) add(p => `purchase_type=ANY(${p})`, query.purchaseType)
  if (query.customerType) add(p => `customer_type=ANY(${p})`, query.customerType)
  if (query.memberIdentity) add(p => `member_identity=ANY(${p})`, query.memberIdentity)
  if (query.channel) add(p => `sales_channels && ${p}::text[]`, query.channel)
  if (query.level) add(p => `level=ANY(${p})`, query.level)
  if (query.priceTier) add(p => `price_tier=ANY(${p})`, query.priceTier)
  if (query.tagId) add(p => `tag_ids && ${p}::uuid[]`, query.tagId)
  if (query.minFollowups) add(p => `followups>=${p}`, query.minFollowups)
  if (query.overdue) where.push(query.overdue === 'yes' ? 'overdue' : '(paid_orders>0 AND NOT overdue)')
  if (query.idleDays) add(p => `last_paid_at<now()-make_interval(days=>${p}::int)`, query.idleDays)
  if (query.cycle) {
    const ranges = { '1-2': 'cycle<=2', '3-7': '(cycle>2 AND cycle<=7)', '8-30': '(cycle>7 AND cycle<=30)', '30+': 'cycle>30' }
    where.push(`cycle_known AND (${query.cycle.map(c => ranges[c]).join(' OR ')})`)
  }
  if (query.pool === 'any') where.push('pool IS NOT NULL')
  else if (query.pool) add(p => `pool=${p}`, query.pool)
  if (query.due) where.push('due_reason IS NOT NULL')
  if (query.ownerAgentId) add(p => `owner_agent_id=${p}`, query.ownerAgentId)
  if (query.search) {
    params.push(`%${query.search.replace(/[\\%_]/g, m => `\\${m}`)}%`)
    const like = `$${params.length}`
    params.push(query.search)
    const exact = `$${params.length}`
    where.push(`(name ILIKE ${like} OR wangwang_id ILIKE ${like} OR phone ILIKE ${like} OR note ILIKE ${like} OR buyer_tail=${exact}
      OR EXISTS(SELECT 1 FROM perf_orders o JOIN perf_buyer_identities i ON i.connection_id=o.connection_id AND i.open_uid=o.buyer_open_uid WHERE i.buyer_id=due.id AND o.order_id=${exact}))`)
  }
  return where.length ? `WHERE ${where.join(' AND ')}` : ''
}
const ensureSettings = (tenantId: string) => db.query('INSERT INTO cust_settings(tenant_id) VALUES($1) ON CONFLICT DO NOTHING', [tenantId])
export const publicRow = ({ buyer_key: _key, loyal_orders: _a, level_platinum: _b, level_vip: _c, price_mid: _d, price_high: _e, overdue_followup: _f, total: _t, ...row }: Record<string, unknown>) => row

/** Counts behind the home dashboard, using the same segment and follow-up rules as the customer list. */
export async function customerSummary(tenantId: string, connectionId: string) {
  await ensureSettings(tenantId)
  return (await db.query(`SELECT count(*)::int AS total,
      count(*) FILTER (WHERE due_reason IS NOT NULL)::int AS due,count(*) FILTER (WHERE due_reason='overdue')::int AS due_overdue,
      count(*) FILTER (WHERE pool='unpaid')::int AS unpaid,coalesce(sum(unpaid_amount) FILTER (WHERE pool='unpaid'),0)::float AS unpaid_amount,
      count(*) FILTER (WHERE pool='no_order' AND last_chat_at>now()-interval '7 days')::int AS recent_no_order,
      count(*) FILTER (WHERE paid_orders>0)::int AS buyers,count(*) FILTER (WHERE customer_type IN ('returning','loyal'))::int AS repeat_buyers,
      count(*) FILTER (WHERE overdue)::int AS overdue
    FROM (${customerSql('', 'id', '')}) c`, [tenantId, connectionId])).rows[0] as Record<string, number>
}

/** Filtered customer rows for one shop (first page of `limit`); the list endpoint and the AI assistant share it. */
export async function queryCustomers(tenantId: string, query: z.infer<typeof listQuery>, limit: number) {
  await ensureShop(tenantId, query.connectionId)
  await ensureSettings(tenantId)
  const params: unknown[] = [tenantId, query.connectionId]
  const where = filters(query, params)
  params.push((query.page - 1) * limit)
  return (await db.query(customerSql(where, sorts[query.sort], `LIMIT ${limit} OFFSET $${params.length}`), params)).rows as Record<string, unknown>[]
}

/** One customer with recent follow-ups, orders and chat days (the 资料 drawer, also read by the AI assistant). */
export async function customerDetail(tenantId: string, id: string) {
  const buyer = await buyerOf(tenantId, id)
  await ensureSettings(tenantId)
  const row = (await db.query(customerSql('WHERE id=$3', 'id', ''), [tenantId, buyer.connection_id, id])).rows[0]
  const followups = (await db.query(`SELECT f.id,f.content,f.method,f.need_follow_up,f.next_follow_up_at,f.superseded,f.created_at,u.display_name AS created_by_name
    FROM cust_followups f LEFT JOIN users u ON u.id=f.created_by WHERE f.buyer_id=$1 ORDER BY f.created_at DESC LIMIT 100`, [id])).rows
  const orders = (await db.query(`SELECT o.order_id,o.status,o.total_amount::float AS total_amount,o.placed_at,o.paid_at,o.items,
      (SELECT coalesce(sum(r.refund_total),0)::float FROM perf_refunds r WHERE r.connection_id=o.connection_id AND r.order_id=o.order_id AND r.status='refundsuccess') AS refunded
    FROM perf_orders o JOIN perf_buyer_identities i ON i.connection_id=o.connection_id AND i.open_uid=o.buyer_open_uid WHERE i.buyer_id=$1 ORDER BY o.placed_at DESC LIMIT 20`, [id])).rows
  const chats = (await db.query(`SELECT s.id,s.chat_date::text AS chat_date,s.buyer_messages,s.agent_messages,a.login_id,a.is_main FROM perf_chat_sessions s JOIN perf_agents a ON a.id=s.agent_id
    WHERE s.buyer_id=$1 ORDER BY s.chat_date DESC,s.last_peer_at DESC LIMIT 20`, [id])).rows
  const account = row.account_id ? (await db.query('SELECT id,name FROM accounts WHERE id=$1 AND deleted_at IS NULL', [row.account_id])).rows[0] ?? null : null
  return { customer: publicRow(row), followups, orders, chats, account }
}

export const followupInput = z.object({ content: z.string().trim().min(1).max(500), method: z.enum(['wangwang','other']), needFollowUp: z.boolean(), nextFollowUpAt: z.string().datetime({ offset: true }).nullable().optional() })
  .strict().refine(v => v.needFollowUp || !v.nextFollowUpAt, { message: '不需要跟进时不能设置下次跟进时间', path: ['nextFollowUpAt'] })

/** Writes a follow-up, superseding the previous plan; used by the 写跟进 dialog and confirmed AI proposals. */
export async function addFollowup(tenantId: string, userId: string, id: string, input: z.infer<typeof followupInput>) {
  await buyerOf(tenantId, id)
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    await client.query('UPDATE cust_followups SET superseded=true WHERE buyer_id=$1 AND NOT superseded', [id])
    const row = (await client.query(`INSERT INTO cust_followups(tenant_id,buyer_id,content,method,need_follow_up,next_follow_up_at,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,created_at`,
      [tenantId, id, input.content, input.method, input.needFollowUp, input.nextFollowUpAt ?? null, userId])).rows[0]
    // Mirror onto the linked CRM customer's timeline so the 360 view stays complete.
    const account = (await client.query('SELECT p.account_id FROM cust_profiles p JOIN accounts a ON a.id=p.account_id AND a.deleted_at IS NULL WHERE p.buyer_id=$1', [id])).rows[0]?.account_id
    if (account) await client.query(`INSERT INTO activities(tenant_id,actor_id,account_id,activity_type,subject,content,next_action_at,metadata) VALUES($1,$2,$3,$4,'1688 客户跟进',$5,$6,$7)`,
      [tenantId, userId, account, 'note', input.content, input.nextFollowUpAt ?? null, JSON.stringify({ source: '1688', buyerId: id, method: input.method })])
    await client.query('COMMIT')
    return row as { id: string; created_at: string }
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}

/** Owner-based credit schemes (8/9) follow an owner change right away. */
async function reattribute(tenantId: string, connectionId: string, buyerIds: string[]) {
  const orderIds = await invalidateBuyerOrders(connectionId, buyerIds)
  if (orderIds.length) await computeAttributions({ tenantId, connectionId, backfillFrom: null, stats: {}, call: async () => ({}), heartbeat: async () => {} }, orderIds)
}

/** Customers of one shop in this tenant, in the given order; throws if any id is unknown or they span shops. */
export async function customersOf(tenantId: string, buyerIds: string[]) {
  const ids = [...new Set(buyerIds)]
  const rows = (await db.query<{ id: string; connection_id: string }>('SELECT id,connection_id FROM perf_buyers WHERE tenant_id=$1 AND id=ANY($2::uuid[])', [tenantId, ids])).rows
  if (rows.length !== ids.length) throw new IntegrationError('NOT_FOUND', '客户不存在。', 404)
  if (new Set(rows.map(r => r.connection_id)).size > 1) throw new IntegrationError('MIXED_SHOPS', '一次只能处理同一店铺的客户。', 400)
  return { ids, connectionId: rows[0]?.connection_id }
}

/** Adds and removes tags by name on several customers; missing tags to add are created. Confirmed AI proposals use it. */
export async function changeTags(tenantId: string, userId: string, buyerIds: string[], add: string[], remove: string[], requestId: string) {
  const { ids } = await customersOf(tenantId, buyerIds)
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    await client.query('INSERT INTO cust_tags(tenant_id,name,created_by) SELECT $1,unnest($2::text[]),$3 ON CONFLICT(tenant_id,name) DO NOTHING', [tenantId, add, userId])
    const added = (await client.query(`INSERT INTO cust_buyer_tags(buyer_id,tag_id) SELECT b,t.id FROM unnest($2::uuid[]) b CROSS JOIN cust_tags t WHERE t.tenant_id=$1 AND t.name=ANY($3::text[]) ON CONFLICT DO NOTHING`, [tenantId, ids, add])).rowCount ?? 0
    const removed = (await client.query(`DELETE FROM cust_buyer_tags x USING cust_tags t WHERE x.tag_id=t.id AND t.tenant_id=$1 AND x.buyer_id=ANY($2::uuid[]) AND t.name=ANY($3::text[])`, [tenantId, ids, remove])).rowCount ?? 0
    await client.query('COMMIT')
    await audit(tenantId, userId, 'cust_tag', ids[0], 'customer.tags.change', requestId, { customers: ids.length, add, remove })
    return { added, removed }
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}

/** Pins an agent as owner of several customers (manual), or hands them back to automatic assignment, then re-attributes. */
export async function setOwners(tenantId: string, userId: string, buyerIds: string[], owner: string | 'auto', requestId: string) {
  const { ids, connectionId } = await customersOf(tenantId, buyerIds)
  if (owner !== 'auto' && !(await db.query('SELECT 1 FROM perf_agents WHERE id=$1 AND connection_id=$2', [owner, connectionId])).rows.length) throw new IntegrationError('AGENT_NOT_FOUND', '所属客服不属于该店铺。', 400)
  const auto = owner === 'auto'
  await db.query(`INSERT INTO cust_profiles(buyer_id,tenant_id,owner_agent_id,owner_source,owner_assigned_at,updated_by)
      SELECT b,$1,$3::uuid,CASE WHEN $4 THEN NULL ELSE 'manual' END,CASE WHEN $4 THEN NULL ELSE now() END,$5 FROM unnest($2::uuid[]) b
    ON CONFLICT(buyer_id) DO UPDATE SET owner_agent_id=EXCLUDED.owner_agent_id,owner_source=EXCLUDED.owner_source,owner_assigned_at=EXCLUDED.owner_assigned_at,
      updated_by=EXCLUDED.updated_by,revision=cust_profiles.revision+1,updated_at=now()`, [tenantId, ids, auto ? null : owner, auto, userId])
  if (auto) await assignOwners(tenantId, connectionId)
  await reattribute(tenantId, connectionId, ids)
  for (const id of ids) await audit(tenantId, userId, 'cust_profile', id, 'customer.profile.update', requestId, { fields: ['ownerAgentId'], owner })
  return { changed: ids.length }
}

export async function customerOpsRoutes(app: FastifyInstance) {
  app.get('/options', { preHandler: requirePermission('customer_ops:read') }, async request => {
    const shops = (await db.query("SELECT id,display_name,status FROM integration_1688_perf_connections WHERE tenant_id=$1 ORDER BY created_at", [tenantOf(request)])).rows
    const tags = (await db.query('SELECT t.id,t.name,(SELECT count(*)::int FROM cust_buyer_tags b WHERE b.tag_id=t.id) AS customers FROM cust_tags t WHERE t.tenant_id=$1 ORDER BY t.name', [tenantOf(request)])).rows
    const offline = (await db.query('SELECT count(*)::int AS n FROM accounts WHERE tenant_id=$1 AND deleted_at IS NULL', [tenantOf(request)])).rows[0].n
    return { data: { shops, tags, memberIdentities, salesChannels, offlineCustomers: offline } }
  })

  // Agent accounts of a shop for the "所属客服" picker; names only, no performance data.
  app.get('/agents', { preHandler: requirePermission('customer_ops:read') }, async request => {
    const { connectionId } = z.object({ connectionId: z.string().uuid() }).parse(request.query)
    await ensureShop(tenantOf(request), connectionId)
    return { data: (await db.query('SELECT id,login_id,is_main,present FROM perf_agents WHERE connection_id=$1 ORDER BY is_main DESC,login_id', [connectionId])).rows }
  })

  app.get('/customers', { preHandler: requirePermission('customer_ops:read') }, async request => {
    const query = listQuery.parse(request.query)
    const rows = await queryCustomers(tenantOf(request), query, 50)
    const totals = (await db.query(`SELECT count(*)::int AS online FROM perf_buyers WHERE tenant_id=$1 AND connection_id=$2`, [tenantOf(request), query.connectionId])).rows[0]
    return { data: rows.map(publicRow), total: (rows[0]?.total as number | undefined) ?? 0, online: totals.online }
  })

  // CSV of the filtered list. Contains contact details, so it needs the manager permission and is audited.
  app.get('/customers/export', { preHandler: requirePermission('customer_ops:manage') }, async (request, reply) => {
    const query = listQuery.parse(request.query)
    const shop = await ensureShop(tenantOf(request), query.connectionId)
    await ensureSettings(tenantOf(request))
    const params: unknown[] = [tenantOf(request), query.connectionId]
    const rows = (await db.query(customerSql(filters(query, params), sorts[query.sort], 'LIMIT 20000'), params)).rows
    const tags = new Map((await db.query('SELECT id,name FROM cust_tags WHERE tenant_id=$1', [tenantOf(request)])).rows.map(t => [t.id, t.name]))
    const agents = new Map((await db.query('SELECT id,login_id,is_main FROM perf_agents WHERE connection_id=$1', [query.connectionId])).rows.map(a => [a.id, a.login_id]))
    const day = (v: Date | null) => v ? new Date(v.getTime() + 8 * 3_600_000).toISOString().slice(0, 10) : ''
    const names = { prospect: '未购买', new: '新客户', returning: '老客户', loyal: '忠诚客户', normal: '普通', platinum: '白金', vip: 'VIP', low: '低', mid: '一般', high: '高', distribution: '分销', procurement: '采购' } as Record<string, string>
    await audit(tenantOf(request), request.authUser.sub, 'cust_export', query.connectionId, 'customer.export', request.id, { rows: rows.length, filters: Object.keys(query).filter(k => k !== 'connectionId') })
    return sendCsv(reply, `线上客户_${shop.display_name ?? '店铺'}_${day(new Date())}.csv`, [
      ['买家尾号', '客户名称', '旺旺号', '电话', '微信', '邮箱', '地址', '会员身份', '购买类型', '客户类型', '等级', '客单价档', '购买次数', '累计金额', '客单价', '首次交易', '最近交易',
        '购买周期(天)', '超期未购', '询单天数', '最近咨询', '待付款订单', '待付款金额', '回访次数', '最近跟进', '下次跟进', '标签', '所属客服', '备注'],
      ...rows.map(r => [r.buyer_tail, r.name, r.wangwang_id, r.phone, r.wechat, r.email, r.address, r.member_identity, names[r.purchase_type] ?? '', names[r.customer_type], names[r.level] ?? '', names[r.price_tier] ?? '',
        r.paid_orders, r.paid_amount, r.avg_order_amount ?? '', day(r.first_paid_at), day(r.last_paid_at), r.cycle_known ? Math.round(r.cycle) : '', r.overdue ? '是' : '', r.inquiry_days, day(r.last_chat_at),
        r.unpaid_order_id ?? '', r.unpaid_amount ?? '', r.followups, day(r.last_followup_at), day(r.next_follow_up_at), (r.tag_ids as string[]).map(id => tags.get(id)).filter(Boolean).join('、'),
        r.owner_agent_id ? agents.get(r.owner_agent_id) ?? '' : '', r.note]),
    ])
  })

  // Attachments: up to 10 images and 10 files per customer, private OSS, short-lived links.
  app.get('/customers/:id/attachments', { preHandler: requirePermission('customer_ops:read') }, async request => {
    const { id } = idSchema.parse(request.params)
    await buyerOf(tenantOf(request), id)
    const rows = (await db.query(`SELECT a.id,a.kind,a.name,a.mime,a.size,a.storage_key,a.created_at,u.display_name AS created_by_name FROM cust_attachments a LEFT JOIN users u ON u.id=a.created_by
      WHERE a.buyer_id=$1 AND a.tenant_id=$2 ORDER BY a.created_at DESC`, [id, tenantOf(request)])).rows
    const data = []
    for (const { storage_key, ...row } of rows) data.push({ ...row, url: await attachmentUrl(storage_key, tenantOf(request), row.name, row.kind) })
    return { data, limits: attachmentLimits }
  })
  app.post('/customers/:id/attachments', { preHandler: requirePermission('customer_ops:update'), bodyLimit: 3_000_000 }, async (request, reply) => {
    const { id } = idSchema.parse(request.params)
    const input = z.object({ name: z.string().trim().min(1).max(120).refine(v => !/[\\/\u0000-\u001f]/.test(v), '文件名不能包含路径或控制字符'), mime: z.enum(Object.keys(attachmentTypes) as [string, ...string[]]),
      content: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/).max(2_900_000) }).strict().parse(request.body)
    await buyerOf(tenantOf(request), id)
    const type = attachmentTypes[input.mime], limit = attachmentLimits[type.kind]
    const bytes = Buffer.from(input.content, 'base64')
    if (!bytes.length || bytes.length > limit.bytes) throw new IntegrationError('ATTACHMENT_SIZE', type.kind === 'image' ? '图片大小须在 2MB 内。' : '文件大小须在 1MB 内。', 400)
    if (!type.check(bytes)) throw new IntegrationError('ATTACHMENT_FORMAT', '文件内容与类型不一致。', 400)
    const count = (await db.query('SELECT count(*)::int AS n FROM cust_attachments WHERE buyer_id=$1 AND kind=$2', [id, type.kind])).rows[0].n
    if (count >= limit.count) throw new IntegrationError('ATTACHMENT_LIMIT', type.kind === 'image' ? '每位客户最多 10 张图片。' : '每位客户最多 10 个文件。', 400)
    const key = await putAttachment(tenantOf(request), id, input.mime, bytes)
    try {
      const row = (await db.query(`INSERT INTO cust_attachments(tenant_id,buyer_id,kind,name,mime,size,storage_key,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,kind,name,mime,size,created_at`,
        [tenantOf(request), id, type.kind, input.name, input.mime, bytes.length, key, request.authUser.sub])).rows[0]
      await audit(tenantOf(request), request.authUser.sub, 'cust_attachment', row.id, 'customer.attachment.create', request.id, { buyerId: id, name: input.name, size: bytes.length })
      return reply.code(201).send({ data: row })
    } catch (error) { await removeAttachment(key, tenantOf(request)).catch(() => {}); throw error }
  })
  app.delete('/customers/:id/attachments/:attachmentId', { preHandler: requirePermission('customer_ops:update') }, async (request, reply) => {
    const { id, attachmentId } = z.object({ id: z.string().uuid(), attachmentId: z.string().uuid() }).parse(request.params)
    const row = (await db.query('SELECT storage_key,name FROM cust_attachments WHERE id=$1 AND buyer_id=$2 AND tenant_id=$3', [attachmentId, id, tenantOf(request)])).rows[0]
    if (!row) throw new IntegrationError('NOT_FOUND', '附件不存在。', 404)
    // Remove the object first: a failure keeps the record so it can be retried instead of leaving an orphaned file.
    try { await removeAttachment(row.storage_key, tenantOf(request)) } catch (error) {
      if ((error as { code?: string }).code !== 'NoSuchKey') throw new IntegrationError('OSS_ATTACHMENT_DELETE', '附件删除失败，请稍后重试。', 502)
    }
    await db.query('DELETE FROM cust_attachments WHERE id=$1', [attachmentId])
    await audit(tenantOf(request), request.authUser.sub, 'cust_attachment', attachmentId, 'customer.attachment.delete', request.id, { buyerId: id, name: row.name })
    return reply.code(204).send()
  })

  app.get('/customers/:id', { preHandler: requirePermission('customer_ops:read') }, async request => {
    const { id } = idSchema.parse(request.params)
    return { data: await customerDetail(tenantOf(request), id) }
  })

  app.put('/customers/:id/profile', { preHandler: requirePermission('customer_ops:update') }, async request => {
    const { id } = idSchema.parse(request.params)
    const text = (max: number) => z.string().trim().max(max).nullable().transform(v => v || null)
    const input = z.object({
      revision: z.number().int().min(0),
      name: text(100), wangwangId: text(100), phone: z.string().trim().regex(/^[0-9+\-\s()]{0,30}$/, '电话格式不正确').nullable().transform(v => v || null),
      wechat: text(60), email: z.string().trim().email().max(120).nullable().or(z.literal('')).transform(v => v || null), qq: z.string().trim().regex(/^\d{0,20}$/, 'QQ 号只能是数字').nullable().transform(v => v || null),
      address: text(200), memberIdentity: z.enum(memberIdentities).nullable(), purchaseType: z.enum(['distribution','procurement']).nullable(),
      salesChannels: z.array(z.enum(salesChannels)).max(salesChannels.length).transform(v => [...new Set(v)]),
      cycleMode: z.enum(['system','custom']), cycleDays: z.number().int().min(1).max(3650).nullable(), note: text(100),
      accountId: z.string().uuid().nullable(), ownerAgentId: z.string().uuid().nullable().or(z.literal('auto')),
    }).strict().refine(v => v.cycleMode === 'system' || v.cycleDays != null, { message: '自定义购买周期需要填写天数', path: ['cycleDays'] }).parse(request.body)
    const buyer = await buyerOf(tenantOf(request), id)
    if (input.accountId && !(await db.query('SELECT 1 FROM accounts WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL', [input.accountId, tenantOf(request)])).rows.length) throw new IntegrationError('ACCOUNT_NOT_FOUND', '关联的 CRM 客户不存在。', 400)
    if (input.ownerAgentId && input.ownerAgentId !== 'auto' && !(await db.query('SELECT 1 FROM perf_agents WHERE id=$1 AND connection_id=$2', [input.ownerAgentId, buyer.connection_id])).rows.length) throw new IntegrationError('AGENT_NOT_FOUND', '所属客服不属于该店铺。', 400)
    // Choosing an owner (or "none") by hand pins it; "auto" hands the customer back to automatic assignment.
    const current = (await db.query<{ owner_agent_id: string | null; owner_source: string | null }>('SELECT owner_agent_id,owner_source FROM cust_profiles WHERE buyer_id=$1', [id])).rows[0]
    const auto = input.ownerAgentId === 'auto'
    const owner = auto ? null : input.ownerAgentId
    const ownerChanged = auto ? current?.owner_source !== null && current?.owner_source !== undefined : (current?.owner_agent_id ?? null) !== owner
    const source = auto ? null : ownerChanged ? 'manual' : current?.owner_source ?? null
    const values = [input.name, input.wangwangId, input.phone, input.wechat, input.email, input.qq, input.address, input.memberIdentity, input.purchaseType, input.salesChannels, input.cycleMode,
      input.cycleMode === 'custom' ? input.cycleDays : null, input.note, input.accountId, owner, request.authUser.sub, source, ownerChanged]
    const saved = input.revision === 0
      ? await db.query(`INSERT INTO cust_profiles(buyer_id,tenant_id,name,wangwang_id,phone,wechat,email,qq,address,member_identity,purchase_type,sales_channels,cycle_mode,cycle_days,note,account_id,owner_agent_id,updated_by,owner_source,owner_assigned_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,CASE WHEN $20::boolean THEN now() END) ON CONFLICT DO NOTHING RETURNING revision`, [id, tenantOf(request), ...values])
      : await db.query(`UPDATE cust_profiles SET name=$3,wangwang_id=$4,phone=$5,wechat=$6,email=$7,qq=$8,address=$9,member_identity=$10,purchase_type=$11,sales_channels=$12,cycle_mode=$13,cycle_days=$14,
          note=$15,account_id=$16,owner_agent_id=$17,updated_by=$18,owner_source=$19,owner_assigned_at=CASE WHEN $20::boolean THEN now() ELSE owner_assigned_at END,revision=revision+1,updated_at=now()
          WHERE buyer_id=$1 AND tenant_id=$2 AND revision=$21 RETURNING revision`, [id, tenantOf(request), ...values, input.revision])
    if (!saved.rows.length) throw new IntegrationError('REVISION_CONFLICT', '客户资料已被他人修改，请刷新后重试。', 409)
    await audit(tenantOf(request), request.authUser.sub, 'cust_profile', id, 'customer.profile.update', request.id, { fields: Object.keys(input).filter(k => k !== 'revision'), ...(ownerChanged ? { owner: input.ownerAgentId } : {}) })
    let revision = saved.rows[0].revision as number
    if (ownerChanged) {
      if (auto) await assignOwners(tenantOf(request), buyer.connection_id)
      await reattribute(tenantOf(request), buyer.connection_id, [id])
      revision = (await db.query('SELECT revision FROM cust_profiles WHERE buyer_id=$1', [id])).rows[0].revision
    }
    return { data: { revision } }
  })

  app.post('/customers/:id/followups', { preHandler: requirePermission('customer_ops:update') }, async (request, reply) => {
    const { id } = idSchema.parse(request.params)
    const input = followupInput.parse(request.body)
    return reply.code(201).send({ data: await addFollowup(tenantOf(request), request.authUser.sub, id, input) })
  })

  app.put('/customers/:id/tags', { preHandler: requirePermission('customer_ops:update') }, async request => {
    const { id } = idSchema.parse(request.params)
    const { tagIds } = z.object({ tagIds: z.array(z.string().uuid()).max(50) }).strict().parse(request.body)
    await buyerOf(tenantOf(request), id)
    if ((await db.query('SELECT count(*)::int AS n FROM cust_tags WHERE tenant_id=$1 AND id=ANY($2)', [tenantOf(request), tagIds])).rows[0].n !== new Set(tagIds).size) throw new IntegrationError('TAG_NOT_FOUND', '标签不存在。', 400)
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      await client.query('DELETE FROM cust_buyer_tags WHERE buyer_id=$1', [id])
      for (const tagId of new Set(tagIds)) await client.query('INSERT INTO cust_buyer_tags(buyer_id,tag_id) VALUES($1,$2)', [id, tagId])
      await client.query('COMMIT')
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
    return { data: { tagIds: [...new Set(tagIds)] } }
  })
  app.post('/customers/bulk-tags', { preHandler: requirePermission('customer_ops:update') }, async request => {
    const input = z.object({ buyerIds: z.array(z.string().uuid()).min(1).max(200), tagId: z.string().uuid(), action: z.enum(['add','remove']) }).strict().parse(request.body)
    if (!(await db.query('SELECT 1 FROM cust_tags WHERE id=$1 AND tenant_id=$2', [input.tagId, tenantOf(request)])).rows.length) throw new IntegrationError('TAG_NOT_FOUND', '标签不存在。', 400)
    const result = input.action === 'add'
      ? await db.query('INSERT INTO cust_buyer_tags(buyer_id,tag_id) SELECT id,$2 FROM perf_buyers WHERE id=ANY($1) AND tenant_id=$3 ON CONFLICT DO NOTHING', [input.buyerIds, input.tagId, tenantOf(request)])
      : await db.query('DELETE FROM cust_buyer_tags t USING perf_buyers b WHERE t.buyer_id=b.id AND b.tenant_id=$3 AND t.buyer_id=ANY($1) AND t.tag_id=$2', [input.buyerIds, input.tagId, tenantOf(request)])
    await audit(tenantOf(request), request.authUser.sub, 'cust_tag', input.tagId, `customer.tags.${input.action}`, request.id, { customers: input.buyerIds.length })
    return { data: { changed: result.rowCount ?? 0 } }
  })

  app.post('/tags', { preHandler: requirePermission('customer_ops:update') }, async (request, reply) => {
    const { name } = z.object({ name: z.string().trim().min(1).max(30) }).strict().parse(request.body)
    const row = (await db.query('INSERT INTO cust_tags(tenant_id,name,created_by) VALUES($1,$2,$3) ON CONFLICT(tenant_id,name) DO NOTHING RETURNING id,name', [tenantOf(request), name, request.authUser.sub])).rows[0]
    if (!row) throw new IntegrationError('TAG_EXISTS', '标签已存在。', 409)
    return reply.code(201).send({ data: { ...row, customers: 0 } })
  })
  app.delete('/tags/:id', { preHandler: requirePermission('customer_ops:manage') }, async request => {
    const { id } = idSchema.parse(request.params)
    const removed = await db.query('DELETE FROM cust_tags WHERE id=$1 AND tenant_id=$2 RETURNING name', [id, tenantOf(request)])
    if (!removed.rowCount) throw new IntegrationError('NOT_FOUND', '标签不存在。', 404)
    await audit(tenantOf(request), request.authUser.sub, 'cust_tag', id, 'customer.tag.delete', request.id, { name: removed.rows[0].name })
    return { data: { deleted: true } }
  })

  const settingsColumns = 'level_platinum::float,level_vip::float,price_mid::float,price_high::float,loyal_orders,default_cycle_days,overdue_followup,revision,updated_at'
  app.get('/settings', { preHandler: requirePermission('customer_ops:read') }, async request => {
    await ensureSettings(tenantOf(request))
    return { data: (await db.query(`SELECT ${settingsColumns} FROM cust_settings WHERE tenant_id=$1`, [tenantOf(request)])).rows[0] }
  })
  app.put('/settings', { preHandler: requirePermission('customer_ops:manage') }, async request => {
    const amount = z.number().finite().min(0).max(100_000_000)
    const input = z.object({ revision: z.number().int().positive(), levelPlatinum: amount, levelVip: amount, priceMid: amount, priceHigh: amount, loyalOrders: z.number().int().min(3).max(1000), defaultCycleDays: z.number().int().min(1).max(3650), overdueFollowup: z.boolean().optional() })
      .strict().refine(v => v.levelPlatinum < v.levelVip && v.priceMid < v.priceHigh, '等级与客单价分档需从低到高').parse(request.body)
    await ensureSettings(tenantOf(request))
    const saved = await db.query(`UPDATE cust_settings SET level_platinum=$3,level_vip=$4,price_mid=$5,price_high=$6,loyal_orders=$7,default_cycle_days=$8,overdue_followup=coalesce($10,overdue_followup),revision=revision+1,updated_by=$9,updated_at=now()
      WHERE tenant_id=$1 AND revision=$2 RETURNING ${settingsColumns}`, [tenantOf(request), input.revision, input.levelPlatinum, input.levelVip, input.priceMid, input.priceHigh, input.loyalOrders, input.defaultCycleDays, request.authUser.sub, input.overdueFollowup ?? null])
    if (!saved.rows.length) throw new IntegrationError('REVISION_CONFLICT', '设置已被他人修改，请刷新后重试。', 409)
    await audit(tenantOf(request), request.authUser.sub, 'cust_settings', tenantOf(request), 'customer.settings.update', request.id, saved.rows[0])
    return { data: saved.rows[0] }
  })
}
