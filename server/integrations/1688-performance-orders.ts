import { config } from '../config.js'
import { db } from '../db.js'
import { IntegrationError } from './1688.js'

type Json = Record<string, any>
export type SyncContext = {
  tenantId: string
  connectionId: string
  /** Oldest point the shop asked to backfill to (ms), kept until reached. */
  backfillFrom: number | null
  /** Set for a scoped run: only modify times from here on are read. */
  scopeFrom?: number | null
  stats: Json
  call: (name: string, input?: Json) => Promise<Json>
  heartbeat: (phase: string) => Promise<void>
}

const DAY = 86_400_000, HOUR = 3_600_000, BEIJING = 8 * HOUR
const ORDER_PAGE_SIZE = 20, REFUND_PAGE_SIZE = 50, OVERLAP = HOUR
const ORDER_MAX_PAGES = 1000, REFUND_MAX_PAGES = 1000

// All nine schemes. memo_flag needs agents to flag or @-mention orders; owner_* need an owning agent per customer
// (set by hand, or assigned automatically from the earliest paid order).
export const availableSchemes = ['order_first','payment_first','order_only','payment_only','memo_flag','payment_day_chat','order_payment_split','owner_only','owner_collaborator_split'] as const
export type Scheme = typeof availableSchemes[number]

/** "20261014102903000+0800" */
export function parsePlatformTime(value: unknown) {
  if (value == null || value === '') return null
  const match = typeof value === 'string' && /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{3})?([+-]\d{2})(\d{2})$/.exec(value)
  if (!match) throw new IntegrationError('INVALID_PLATFORM_TIME', '平台时间格式无法解析。')
  return new Date(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.${match[7] || '000'}${match[8]}:${match[9]}`)
}
export function formatPlatformTime(ms: number) {
  const b = new Date(ms + BEIJING).toISOString()
  return `${b.slice(0, 4)}${b.slice(5, 7)}${b.slice(8, 10)}${b.slice(11, 13)}${b.slice(14, 16)}${b.slice(17, 19)}${b.slice(20, 23)}+0800`
}
const money = (value: unknown) => { const n = Number(value); return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0 }
const text = (value: unknown) => value == null || value === '' ? null : String(value)

function windows(from: number, to: number) {
  const list: [number, number][] = []
  for (let start = from; start < to; start += DAY) list.push([start, Math.min(start + DAY, to)])
  return list
}
/**
 * Runs `fetch` over modify-time windows: first from the cursor up to now, then missing history newest-first down to the
 * backfill target. `<feed>_synced_from` marks how far back the feed is complete, so an interrupted backfill resumes.
 */
async function syncFeed(ctx: SyncContext, now: number, feed: 'orders' | 'refunds', fetch: (beg: number, end: number) => Promise<void>) {
  const row = (await db.query(`SELECT ${feed}_synced_until AS until,${feed}_synced_from AS since FROM integration_1688_perf_connections WHERE id=$1`, [ctx.connectionId])).rows[0] as { until: Date | null; since: Date | null }
  const cursorStart = row.until ? row.until.getTime() - OVERLAP : now - config.PERF_SYNC_INITIAL_DAYS * DAY
  // A scoped run starting after the cursor reads only its window and leaves the cursors for the next full run.
  const contiguous = ctx.scopeFrom == null || cursorStart >= ctx.scopeFrom
  const start = contiguous ? cursorStart : ctx.scopeFrom!
  for (const [beg, end] of windows(start, now)) {
    await fetch(beg, end)
    if (contiguous) await db.query(`UPDATE integration_1688_perf_connections SET ${feed}_synced_until=greatest(coalesce(${feed}_synced_until,$2),$2),${feed}_synced_from=least(coalesce(${feed}_synced_from,$3),$3) WHERE id=$1`,
      [ctx.connectionId, new Date(end), new Date(start)])
  }
  let since = row.since ? Math.min(row.since.getTime(), start) : start
  while (ctx.backfillFrom != null && since > ctx.backfillFrom) {
    const beg = Math.max(since - DAY, ctx.backfillFrom)
    await fetch(beg, since)
    since = beg
    await db.query(`UPDATE integration_1688_perf_connections SET ${feed}_synced_from=least(coalesce(${feed}_synced_from,$2),$2) WHERE id=$1`, [ctx.connectionId, new Date(beg)])
  }
}

async function saveOrder(ctx: SyncContext, order: Json) {
  const base = (order.baseInfo || {}) as Json
  const orderId = text(base.idOfStr ?? base.id)
  const placedAt = parsePlatformTime(base.createTime)
  if (!orderId || !/^\d+$/.test(orderId) || !placedAt || typeof base.status !== 'string') { ctx.stats.skippedOrders = (ctx.stats.skippedOrders || 0) + 1; return }
  const items = (Array.isArray(order.productItems) ? order.productItems : []).map((item: Json) => ({
    productId: text(item.productID), name: text(item.name), quantity: Number(item.quantity) || 0, price: money(item.price), amount: money(item.itemAmount),
    sku: Array.isArray(item.skuInfos) ? item.skuInfos.map((sku: Json) => `${sku.name ?? ''}:${sku.value ?? ''}`).join(' / ') : null,
  }))
  const modifiedAt = parsePlatformTime(base.modifyTime)
  const flag = Number(base.sellerRemarkIcon)
  await db.query(`INSERT INTO perf_orders(tenant_id,connection_id,order_id,buyer_open_uid,status,business_type,total_amount,product_amount,shipping_fee,refund_amount,placed_at,paid_at,platform_modified_at,buyer_rate_status,items,seller_memo,seller_flag)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
    ON CONFLICT(connection_id,order_id) DO UPDATE SET buyer_open_uid=excluded.buyer_open_uid,status=excluded.status,business_type=excluded.business_type,total_amount=excluded.total_amount,
      product_amount=excluded.product_amount,shipping_fee=excluded.shipping_fee,refund_amount=excluded.refund_amount,placed_at=excluded.placed_at,paid_at=excluded.paid_at,
      platform_modified_at=excluded.platform_modified_at,buyer_rate_status=excluded.buyer_rate_status,items=excluded.items,seller_memo=excluded.seller_memo,seller_flag=excluded.seller_flag,synced_at=now(),
      attribution_key=CASE WHEN perf_orders.paid_at IS NOT DISTINCT FROM excluded.paid_at AND perf_orders.placed_at=excluded.placed_at AND perf_orders.buyer_open_uid IS NOT DISTINCT FROM excluded.buyer_open_uid
        AND perf_orders.seller_memo IS NOT DISTINCT FROM excluded.seller_memo AND perf_orders.seller_flag IS NOT DISTINCT FROM excluded.seller_flag THEN perf_orders.attribution_key END`,
  [ctx.tenantId, ctx.connectionId, orderId, text(base.buyerOpenUid), base.status, text(base.businessType), money(base.totalAmount), money(base.sumProductPayment), money(base.shippingFee), money(base.refund),
    placedAt, parsePlatformTime(base.payTime), modifiedAt, Number.isFinite(Number(order.orderRateInfo?.buyerRateStatus)) ? Number(order.orderRateInfo.buyerRateStatus) : null, JSON.stringify(items),
    text(base.sellerMemo)?.slice(0, 500) ?? null, Number.isInteger(flag) && flag >= 1 && flag <= 10 ? flag : null])
  ctx.stats.orders = (ctx.stats.orders || 0) + 1
}

export async function syncOrders(ctx: SyncContext, now: number) {
  await syncFeed(ctx, now, 'orders', async (beg, end) => {
    for (let page = 1; page <= ORDER_MAX_PAGES; page++) {
      await ctx.heartbeat('orders')
      const response = await ctx.call('alibaba.trade.ec.getOrderList.sellerView', { modifyStartTime: formatPlatformTime(beg), modifyEndTime: formatPlatformTime(end), page, pageSize: ORDER_PAGE_SIZE, needMemoInfo: true })
      const list = Array.isArray(response.result) ? response.result : []
      for (const order of list) await saveOrder(ctx, order)
      if (list.length < ORDER_PAGE_SIZE || page * ORDER_PAGE_SIZE >= Number(response.totalRecord || 0)) break
    }
  })
}

export async function syncRefunds(ctx: SyncContext, now: number) {
  await syncFeed(ctx, now, 'refunds', async (beg, end) => {
    for (let page = 0; page < REFUND_MAX_PAGES; page++) {
      await ctx.heartbeat('refunds')
      // dipsuteType 0 (sic, platform spelling) includes both in-sale and after-sale refunds.
      const response = await ctx.call('alibaba.trade.refund.queryOrderRefundList', { modifyStartTime: formatPlatformTime(beg), modifyEndTime: formatPlatformTime(end), currentPageNum: page, pageSize: REFUND_PAGE_SIZE, dipsuteType: 0 })
      const result = (response.result || {}) as Json
      const list = Array.isArray(result.opOrderRefundModels) ? result.opOrderRefundModels : []
      for (const refund of list) {
        const refundId = text(refund.id ?? refund.refundId), orderId = text(refund.orderId)
        if (!refundId || !orderId || typeof refund.status !== 'string') { ctx.stats.skippedRefunds = (ctx.stats.skippedRefunds || 0) + 1; continue }
        // All refund amounts are reported in fen; goods and shipping come separately (refundPayment excludes refundCarriage).
        const fen = (value: unknown) => Number.isFinite(Number(value)) ? money(Number(value) / 100) : 0
        await db.query(`INSERT INTO perf_refunds(tenant_id,connection_id,refund_id,order_id,buyer_open_uid,status,dispute_type,only_refund,apply_amount,refund_amount,apply_reason,applied_at,completed_at,platform_modified_at,apply_carriage,refund_carriage)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
          ON CONFLICT(connection_id,refund_id) DO UPDATE SET status=excluded.status,dispute_type=excluded.dispute_type,only_refund=excluded.only_refund,apply_amount=excluded.apply_amount,
            refund_amount=excluded.refund_amount,apply_carriage=excluded.apply_carriage,refund_carriage=excluded.refund_carriage,apply_reason=excluded.apply_reason,applied_at=excluded.applied_at,completed_at=excluded.completed_at,platform_modified_at=excluded.platform_modified_at,synced_at=now()`,
        [ctx.tenantId, ctx.connectionId, refundId, orderId, text(refund.buyerOpenUid), refund.status, Number.isFinite(Number(refund.disputeType)) ? Number(refund.disputeType) : null,
          typeof refund.onlyRefund === 'boolean' ? refund.onlyRefund : null, fen(refund.applyPayment), fen(refund.refundPayment),
          text(refund.applyReason)?.slice(0, 100) ?? null, parsePlatformTime(refund.gmtApply), parsePlatformTime(refund.gmtCompleted), parsePlatformTime(refund.gmtModified), fen(refund.applyCarriage), fen(refund.refundCarriage)])
        ctx.stats.refunds = (ctx.stats.refunds || 0) + 1
      }
      if (list.length < REFUND_PAGE_SIZE || (page + 1) * REFUND_PAGE_SIZE >= Number(result.totalCount || 0)) break
    }
  })
}

type Reply = { agent_id: string; session_id: string; sent_at: Date }
type Credit = { agent_id: string; share: number; basis: 'order_reply'|'payment_reply'|'payment_day_chat'|'owner'|'memo_mention'|'memo_flag'; session_id: string | null; basis_at: Date | null }
/** Order facts beyond chats: the customer's owning agent and the agent named by the seller memo or flag. */
export type OrderExtras = { owner?: string | null; memo?: { agent_id: string; basis: 'memo_mention'|'memo_flag' } | null; orderShare?: number; ownerShare?: number }
const lastBefore = (replies: Reply[], at: Date, windowMs: number) =>
  replies.filter(r => r.sent_at.getTime() <= at.getTime() && r.sent_at.getTime() >= at.getTime() - windowMs).sort((a, b) => b.sent_at.getTime() - a.sent_at.getTime())[0]
const beijingDay = (date: Date) => new Date(date.getTime() + BEIJING).toISOString().slice(0, 10)

/** Credits for every scheme, from the manual agent replies to this buyer around the order plus owner and memo facts. */
export function attribute(order: { placed_at: Date; paid_at: Date | null }, replies: Reply[], windowMs: number, extras: OrderExtras = {}): Record<Scheme, Credit[]> {
  const orderShare = extras.orderShare ?? 0.5, ownerShare = extras.ownerShare ?? 0.5
  const byOrder = lastBefore(replies, order.placed_at, windowMs)
  const byPayment = order.paid_at ? lastBefore(replies, order.paid_at, windowMs) : undefined
  const credit = (reply: Reply | undefined, basis: Credit['basis'], share = 1): Credit[] => reply ? [{ agent_id: reply.agent_id, share, basis, session_id: reply.session_id, basis_at: reply.sent_at }] : []
  const plain = (agentId: string | null | undefined, basis: Credit['basis'], share = 1): Credit[] => agentId ? [{ agent_id: agentId, share, basis, session_id: null, basis_at: null }] : []
  const dayChat: Credit[] = []
  if (order.paid_at) {
    const day = beijingDay(order.paid_at), seen = new Map<string, Reply>()
    for (const reply of replies) if (beijingDay(reply.sent_at) === day && !seen.has(reply.agent_id)) seen.set(reply.agent_id, reply)
    for (const reply of seen.values()) dayChat.push({ agent_id: reply.agent_id, share: 1 / seen.size, basis: 'payment_day_chat', session_id: reply.session_id, basis_at: reply.sent_at })
  }
  let split: Credit[]
  if (byOrder && byPayment && byOrder.agent_id !== byPayment.agent_id) split = [...credit(byOrder, 'order_reply', orderShare), ...credit(byPayment, 'payment_reply', 1 - orderShare)]
  else split = byOrder ? credit(byOrder, 'order_reply') : credit(byPayment, 'payment_reply')
  // Owner and collaborator: the closing agent (scheme 1's choice) shares with the owner; either alone takes the whole order.
  const closer = byOrder ? credit(byOrder, 'order_reply') : credit(byPayment, 'payment_reply')
  let ownerSplit: Credit[]
  if (extras.owner && closer.length && closer[0].agent_id !== extras.owner) ownerSplit = [...plain(extras.owner, 'owner', ownerShare), { ...closer[0], share: 1 - ownerShare }]
  else ownerSplit = extras.owner ? plain(extras.owner, 'owner') : closer
  return {
    order_first: closer,
    payment_first: byPayment ? credit(byPayment, 'payment_reply') : credit(byOrder, 'order_reply'),
    order_only: credit(byOrder, 'order_reply'),
    payment_only: credit(byPayment, 'payment_reply'),
    memo_flag: extras.memo ? plain(extras.memo.agent_id, extras.memo.basis) : [],
    payment_day_chat: dayChat,
    order_payment_split: split,
    owner_only: plain(extras.owner, 'owner'),
    owner_collaborator_split: ownerSplit,
  }
}

/** Scheme 5: an "@name" in the seller memo (sub-account name or full login) wins; otherwise the shop's flag-colour rule. */
export function memoAgent(memo: string | null, flag: number | null, agents: { id: string; login_id: string }[], rules: Map<number, string>): OrderExtras['memo'] {
  if (memo) for (const match of memo.matchAll(/@([^\s@,，;；。:：]+)/g)) {
    const name = match[1]
    const agent = agents.find(a => a.login_id === name || a.login_id.slice(a.login_id.indexOf(':') + 1) === name)
    if (agent) return { agent_id: agent.id, basis: 'memo_mention' }
  }
  const ruled = flag == null ? undefined : rules.get(flag)
  return ruled ? { agent_id: ruled, basis: 'memo_flag' } : null
}

// Manual agent replies: no auto/system/broadcast/transfer messages; "其他消息" only when the setting counts it.
export const manualReplySql = `m.direction=0 AND NOT (m.message_types && ARRAY['自动回复消息','系统消息','广播消息','客服转交消息']::text[])
  AND ($COUNT_OTHER OR NOT ('其他消息'=ANY(m.message_types) AND NOT '正常消息'=ANY(m.message_types)))`

/** Inputs that change order credit; orders whose stored key differs are recomputed. */
export const attributionKeySql = `attribution_window_hours||':'||(CASE WHEN count_other_as_reply THEN 1 ELSE 0 END)||':'||split_order_share||':'||owner_share`

/** Recomputes every scheme for orders whose key is stale (or only `orderIds`, e.g. after an owner change). */
export async function computeAttributions(ctx: SyncContext, orderIds?: string[]) {
  await db.query('INSERT INTO perf_settings(tenant_id) VALUES($1) ON CONFLICT DO NOTHING', [ctx.tenantId])
  const settings = (await db.query(`SELECT attribution_window_hours,count_other_as_reply,split_order_share::float AS order_share,owner_share::float,${attributionKeySql} AS key
    FROM perf_settings WHERE tenant_id=$1`, [ctx.tenantId])).rows[0]
  const windowMs = settings.attribution_window_hours * HOUR, key = settings.key as string
  const agents = (await db.query<{ id: string; login_id: string }>('SELECT id,login_id FROM perf_agents WHERE connection_id=$1', [ctx.connectionId])).rows
  const rules = new Map((await db.query<{ flag: number; agent_id: string }>('SELECT flag,agent_id FROM perf_flag_rules WHERE connection_id=$1', [ctx.connectionId])).rows.map(r => [r.flag, r.agent_id]))
  const chunks = orderIds ? Array.from({ length: Math.ceil(orderIds.length / 500) }, (_, i) => orderIds.slice(i * 500, i * 500 + 500)) : null
  for (let round = 0; ; round++) {
    if (chunks && round >= chunks.length) break
    await ctx.heartbeat('attribution')
    type Row = { id: string; placed_at: Date; paid_at: Date | null; seller_memo: string | null; seller_flag: number | null; owner: string | null }
    const orders = (await db.query<Row>(`SELECT o.id,o.placed_at,o.paid_at,o.seller_memo,o.seller_flag,
        (SELECT p.owner_agent_id FROM perf_buyer_identities i JOIN cust_profiles p ON p.buyer_id=i.buyer_id WHERE i.connection_id=o.connection_id AND i.open_uid=o.buyer_open_uid LIMIT 1) AS owner
      FROM perf_orders o WHERE o.connection_id=$1 AND CASE WHEN $3::uuid[] IS NULL THEN o.attribution_key IS DISTINCT FROM $2::text ELSE o.id=ANY($3) END ORDER BY o.placed_at LIMIT 500`,
    [ctx.connectionId, key, chunks ? chunks[round] : null])).rows
    if (!orders.length) { if (chunks) continue; break }
    const replies = (await db.query<Reply & { order_id: string }>(`SELECT o.id AS order_id,s.agent_id,s.id AS session_id,m.sent_at
      FROM perf_orders o JOIN perf_buyer_identities i ON i.connection_id=o.connection_id AND i.open_uid=o.buyer_open_uid
      JOIN perf_chat_sessions s ON s.buyer_id=i.buyer_id
        AND s.chat_date BETWEEN ((o.placed_at-make_interval(hours=>$2)) AT TIME ZONE 'Asia/Shanghai')::date AND (coalesce(o.paid_at,o.placed_at) AT TIME ZONE 'Asia/Shanghai')::date
      JOIN perf_chat_messages m ON m.session_id=s.id AND m.sent_at>=o.placed_at-make_interval(hours=>$2)
      WHERE o.id=ANY($1) AND ${manualReplySql.replace('$COUNT_OTHER', '$3')}`, [orders.map(o => o.id), settings.attribution_window_hours, settings.count_other_as_reply])).rows
    const grouped = new Map<string, Reply[]>()
    for (const reply of replies) grouped.set(reply.order_id, [...(grouped.get(reply.order_id) || []), reply])
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      await client.query('DELETE FROM perf_order_attributions WHERE order_id=ANY($1)', [orders.map(o => o.id)])
      for (const order of orders) {
        const result = attribute(order, grouped.get(order.id) || [], windowMs, {
          owner: order.owner, memo: memoAgent(order.seller_memo, order.seller_flag, agents, rules), orderShare: settings.order_share, ownerShare: settings.owner_share })
        for (const [scheme, credits] of Object.entries(result)) for (const c of credits) {
          await client.query(`INSERT INTO perf_order_attributions(order_id,scheme,agent_id,share,basis,session_id,basis_at)VALUES($1,$2,$3,$4,$5,$6,$7)
            ON CONFLICT(order_id,scheme,agent_id) DO UPDATE SET share=perf_order_attributions.share+excluded.share`, [order.id, scheme, c.agent_id, Math.round(c.share * 100000) / 100000, c.basis, c.session_id, c.basis_at])
        }
      }
      await client.query('UPDATE perf_orders SET attribution_key=$2 WHERE id=ANY($1)', [orders.map(o => o.id), key])
      await client.query('COMMIT')
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
    ctx.stats.attributedOrders = (ctx.stats.attributedOrders || 0) + orders.length
  }
}
