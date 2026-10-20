import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { db } from '../db.js'
import { IntegrationError } from '../integrations/1688.js'
import { callPerformanceApi } from '../integrations/1688-performance.js'
import { parsePlatformTime } from '../integrations/1688-performance-orders.js'
import { ensureSettings, schemeOf } from '../integrations/1688-performance-reports.js'
import { ensureConnection, ownOnly, readScope } from './1688-performance.js'

/**
 * 订单: the shop's orders as synced by the performance app, and one order's full detail fetched live from
 * alibaba.trade.ec.getOrder.sellerView (加密场景, seller view). Buyer and receiver details arrive masked by the platform
 * and are only passed through for display, never stored.
 */
const tenant = (request: FastifyRequest) => request.authUser.tenantId
const scope = (request: FastifyRequest) => ownOnly(request) ? request.authUser.sub : null
export const ORDER_GROUPS = {
  unpaid: ['waitbuyerpay', 'waitbuyerrepayment'],
  toship: ['waitsellersend', 'waitsellerconfirm', 'waitbuyerconfirm'],
  shipped: ['waitbuyerreceive', 'send_goods_but_not_fund', 'waitlogisticstakein', 'waitbuyersign', 'signinsuccess', 'signinfailed'],
  done: ['success', 'confirm_goods', 'confirm_goods_but_not_fund', 'confirm_goods_and_has_subsidy'],
  closed: ['cancel', 'terminated'],
} as const
type Group = keyof typeof ORDER_GROUPS | 'refund'
const groupSql = `CASE ${Object.entries(ORDER_GROUPS).map(([g, list]) => `WHEN o.status IN (${list.map(s => `'${s}'`).join(',')}) THEN '${g}'`).join(' ')} ELSE 'other' END`
const listQuery = z.object({
  connectionId: z.string().uuid(), from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  group: z.enum(['unpaid', 'toship', 'shipped', 'done', 'closed', 'refund']).optional(), search: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).max(2000).default(1), pageSize: z.coerce.number().int().min(10).max(100).default(20),
}).refine(q => q.from <= q.to, '开始日期不能晚于结束日期')

const time = (value: unknown) => { try { return parsePlatformTime(value)?.toISOString() ?? null } catch { return null } }
const num = (value: unknown) => { const n = Number(value); return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0 }
const str = (value: unknown) => value == null || String(value).trim() === '' ? null : String(value).trim()
type Json = Record<string, any>

/** The detail response, reduced to what the order page shows. */
export function orderDetail(raw: Json) {
  const r: Json = raw.result ?? raw, base: Json = r.baseInfo ?? {}, logistics: Json = r.nativeLogistics ?? {}
  const credit = r.orderBizInfo?.creditOrder ? r.orderBizInfo.creditOrderDetail : null
  return {
    order: {
      id: str(base.idOfStr ?? base.id), status: str(base.status), trade_type: str(base.tradeTypeDesc), business_type: str(base.businessType),
      created_at: time(base.createTime), paid_at: time(base.payTime), delivered_at: time(base.allDeliveredTime), received_at: time(base.receivingTime), completed_at: time(base.completeTime), modified_at: time(base.modifyTime),
      total_amount: num(base.totalAmount), product_amount: num(base.sumProductPayment), shipping_fee: num(base.shippingFee), discount: num(base.discount) / 100, coupon: num(base.couponFee), refund: num(base.refund),
      pay_channels: Array.isArray(base.payChannelList) ? base.payChannelList.map(String) : [], close_reason: str(base.closeReason ?? base.closeRemark),
      buyer_memo: str(base.buyerMemo ?? base.buyerFeedback), seller_memo: str(base.sellerMemo), remark: str(base.remark),
      credit: credit ? { status: str(credit.statusStr), amount: num(credit.payAmount) / 100, unpaid: num(credit.restRepayAmount) / 100 } : null,
    },
    buyer: { login: str(base.buyerLoginId), company: str(base.buyerContact?.companyName), level: str(base.buyerLevel), open_uid: str(base.buyerOpenUid) },
    receiver: { name: str(logistics.contactPerson ?? base.receiverInfo?.toFullName), mobile: str(logistics.mobile), phone: str(logistics.telephone),
      region: [logistics.province, logistics.city, logistics.area, logistics.town].filter(Boolean).join(' ') || str(base.receiverInfo?.toArea), address: str(logistics.address), zip: str(logistics.zip) },
    items: (Array.isArray(r.productItems) ? r.productItems : []).map((i: Json) => ({
      name: str(i.name), image: Array.isArray(i.productImgUrl) ? String(i.productImgUrl.at(-1) ?? '').replace(/^http:/, 'https:') || null : null,
      sku: (Array.isArray(i.skuInfos) ? i.skuInfos : []).map((s: Json) => `${s.name}：${s.value}`).join('；') || null,
      quantity: num(i.quantity), unit: str(i.unit), price: num(i.price), amount: num(i.itemAmount), refund: num(i.refund), status: str(i.statusStr ?? i.status),
      cargo_number: str(i.cargoNumber ?? i.productCargoNumber), product_id: str(i.productID), snapshot_url: str(i.productSnapshotUrl), sub_item_id: str(i.subItemIDString ?? i.subItemID),
    })),
    shipments: (Array.isArray(logistics.logisticsItems) ? logistics.logisticsItems : []).map((l: Json) => ({
      company: str(l.logisticsCompanyName ?? l.logisticsCompanyNo), bill_no: str(l.logisticsBillNo), status: str(l.status), delivered_at: time(l.deliveredTime),
      no_logistics: l.noLogisticsCondition ? str(l.noLogisticsName) ?? '无需物流' : null,
    })),
    rate: { buyer: r.orderRateInfo?.buyerRateStatus ?? null, seller: r.orderRateInfo?.sellerRateStatus ?? null },
    invoice: r.orderInvoice ? { type: str(r.orderInvoice.invoiceType), title: str(r.orderInvoice.invoiceCompanyName) } : null,
    masked: Array.isArray(raw.retCodes) ? raw.retCodes.map(String) : [],
  }
}

export async function orderListRoutes(app: FastifyInstance) {
  app.get('/order-list', { preHandler: readScope }, async request => {
    const q = listQuery.parse(request.query)
    await ensureConnection(tenant(request), q.connectionId)
    await ensureSettings(tenant(request))
    const scheme = schemeOf((await db.query('SELECT default_scheme FROM perf_settings WHERE tenant_id=$1', [tenant(request)])).rows[0].default_scheme)
    const params: unknown[] = [tenant(request), q.connectionId, q.from, q.to, scope(request), scheme]
    // Own-only access: orders attributed to the user's bound agents.
    const base = `FROM perf_orders o WHERE o.tenant_id=$1 AND o.connection_id=$2 AND o.placed_at>=($3::date::timestamp AT TIME ZONE 'Asia/Shanghai')
      AND o.placed_at<(($4::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai')
      AND ($5::uuid IS NULL OR EXISTS(SELECT 1 FROM perf_order_attributions a JOIN perf_agents ag ON ag.id=a.agent_id WHERE a.order_id=o.id AND a.scheme=$6 AND ag.user_id=$5))`
    let filter = ''
    if (q.search) { params.push(q.search); filter += ` AND (o.order_id=$${params.length} OR o.items::text ILIKE '%'||$${params.length}||'%' OR o.seller_memo ILIKE '%'||$${params.length}||'%')` }
    const facets = Object.fromEntries((await db.query(`SELECT ${groupSql} AS g,count(*)::int AS n,coalesce(sum(o.total_amount),0)::float AS amount ${base}${filter} GROUP BY 1
      UNION ALL SELECT 'refund',count(*)::int,coalesce(sum(o.refund_amount),0)::float ${base}${filter} AND o.refund_amount>0`, params)).rows.map(r => [r.g as string, { count: r.n as number, amount: r.amount as number }])) as Record<string, { count: number; amount: number }>
    if (q.group === 'refund') filter += ' AND o.refund_amount>0'
    else if (q.group) filter += ` AND o.status IN (${ORDER_GROUPS[q.group].map(s => `'${s}'`).join(',')})`
    const total = (await db.query(`SELECT count(*)::int AS n ${base}${filter}`, params)).rows[0].n as number
    params.push(q.pageSize, (q.page - 1) * q.pageSize)
    const rows = (await db.query(`SELECT o.order_id,o.status,${groupSql} AS status_group,o.total_amount::float,o.product_amount::float,o.shipping_fee::float,o.refund_amount::float,
        o.placed_at,o.paid_at,o.items,o.seller_memo,o.seller_flag,o.buyer_rate_status,
        (SELECT i.buyer_id FROM perf_buyer_identities i WHERE i.connection_id=o.connection_id AND i.open_uid=o.buyer_open_uid LIMIT 1) AS buyer_id,
        right(o.buyer_open_uid,6) AS buyer_tail,
        (SELECT json_agg(json_build_object('login_id',ag.login_id,'is_main',ag.is_main,'user_name',u.display_name,'share',a.share::float)) FROM perf_order_attributions a
          JOIN perf_agents ag ON ag.id=a.agent_id LEFT JOIN users u ON u.id=ag.user_id WHERE a.order_id=o.id AND a.scheme=$6) AS agents
      ${base}${filter} ORDER BY o.placed_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params)).rows
    const counts = Object.fromEntries(Object.entries(facets).map(([g, v]) => [g, v.count]))
    const all = Object.entries(facets).filter(([g]) => g !== 'refund').reduce((s, [, v]) => ({ count: s.count + v.count, amount: s.amount + v.amount }), { count: 0, amount: 0 })
    return { data: rows, total, page: q.page, pageSize: q.pageSize, counts: { ...counts, all: all.count } as Record<Group | 'all' | 'other', number>, amount: Math.round(all.amount * 100) / 100 }
  })

  // One order's full detail, fetched live from the platform (seller view, buyer details masked by 1688).
  app.get('/order-list/:orderId', { preHandler: readScope }, async request => {
    const { orderId } = z.object({ orderId: z.string().regex(/^\d{6,30}$/, '订单号格式不正确。') }).parse(request.params)
    const { connectionId } = z.object({ connectionId: z.string().uuid() }).parse(request.query)
    await ensureConnection(tenant(request), connectionId)
    await ensureSettings(tenant(request))
    const scheme = schemeOf((await db.query('SELECT default_scheme FROM perf_settings WHERE tenant_id=$1', [tenant(request)])).rows[0].default_scheme)
    const local = (await db.query(`SELECT o.id,o.seller_memo,o.seller_flag,(SELECT i.buyer_id FROM perf_buyer_identities i WHERE i.connection_id=o.connection_id AND i.open_uid=o.buyer_open_uid LIMIT 1) AS buyer_id
      FROM perf_orders o WHERE o.connection_id=$1 AND o.tenant_id=$2 AND o.order_id=$3
      AND ($4::uuid IS NULL OR EXISTS(SELECT 1 FROM perf_order_attributions a JOIN perf_agents ag ON ag.id=a.agent_id WHERE a.order_id=o.id AND a.scheme=$5 AND ag.user_id=$4)
        OR EXISTS(SELECT 1 FROM perf_buyer_identities i JOIN perf_chat_sessions s ON s.buyer_id=i.buyer_id JOIN perf_agents ag ON ag.id=s.agent_id
          WHERE i.connection_id=o.connection_id AND i.open_uid=o.buyer_open_uid AND ag.user_id=$4))`,
    [connectionId, tenant(request), orderId, scope(request), scheme])).rows[0]
    // Own-only users see orders credited to them and orders of buyers they have chatted with (linked from their chats).
    if (!local) throw new IntegrationError('NOT_FOUND', '订单不存在，或不在你的查看范围内。', 404)
    const raw = await callPerformanceApi(connectionId, tenant(request), request.authUser.sub, 'alibaba.trade.ec.getOrder.sellerView',
      { orderId, includeFields: 'GuaranteesTerms,NativeLogistics,RateDetail,OrderInvoice' }, request.id) as Json
    const detail = orderDetail(raw)
    return { data: { ...detail, order: { ...detail.order, seller_memo: detail.order.seller_memo ?? local.seller_memo, seller_flag: local.seller_flag }, buyer: { ...detail.buyer, open_uid: undefined, buyer_id: local.buyer_id } } }
  })
}
