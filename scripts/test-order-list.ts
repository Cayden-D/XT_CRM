import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { buildApp } from '../server/app.js'
import { db } from '../server/db.js'
import { saveConnection } from '../server/integrations/1688.js'

// 订单: list from synced orders; detail live from alibaba.trade.ec.getOrder.sellerView (shape observed 2026-10-20).
const originalFetch = globalThis.fetch
let detailCalls = 0
globalThis.fetch = async (input, init) => {
  const url = String(input)
  assert.ok(url.includes('/com.alibaba.trade/alibaba.trade.ec.getOrder.sellerView/'), `unexpected ${url}`)
  detailCalls++
  const body = Object.fromEntries((init!.body as URLSearchParams).entries())
  assert.match(body.includeFields, /NativeLogistics/)
  return new Response(JSON.stringify({ success: 'true', retCodes: ['BUYER_ENCRYPT'], result: {
    baseInfo: { idOfStr: body.orderId, status: 'waitbuyerreceive', tradeTypeDesc: '4.0担保交易', createTime: '20261020100541000+0800', payTime: '20261020100600000+0800', allDeliveredTime: '20261020150000000+0800',
      totalAmount: 37.75, sumProductPayment: 34.1, shippingFee: 4.5, discount: -85, refund: 0, payChannelList: ['诚e赊'], sellerMemo: ' ', buyerLevel: 'L3', buyerContact: { companyName: '玥翔' }, buyerLoginId: '胡*', buyerOpenUid: 'BBBbuyer1' },
    productItems: [{ name: '车用安全锤', productImgUrl: ['http://cbu01.alicdn.com/a.80x80.jpg', 'http://cbu01.alicdn.com/a.jpg'], skuInfos: [{ name: '颜色', value: '黑色' }], quantity: 11, unit: '个', price: 3.1, itemAmount: 33.25, refund: 0, statusStr: '等待买家收货', cargoNumber: 'AC06', productID: 955287139679 }],
    nativeLogistics: { contactPerson: '胡*', mobile: '180****8902', province: '浙江省', city: '金华市', area: '义乌市', address: '稠江街道*栋', logisticsItems: [{ logisticsCompanyName: '中通快递', logisticsBillNo: '7531', status: 'alreadysend', deliveredTime: '20261020150000000+0800' }] },
    orderBizInfo: { creditOrder: true, creditOrderDetail: { statusStr: '支付成功', payAmount: 3775, restRepayAmount: 3775 } }, orderRateInfo: { buyerRateStatus: 5, sellerRateStatus: 5 } } }), { status: 200 })
}
const app = await buildApp(), tenants: string[] = []
const today = new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10)
try {
  for (let i = 0; i < 2; i++) tenants.push((await db.query('INSERT INTO tenants(name,slug)VALUES($1,$2)RETURNING id', ['订单测试', `orders-${randomUUID().slice(0, 8)}`])).rows[0].id)
  const tenant = tenants[0]
  const user = async (name: string) => (await db.query("INSERT INTO users(tenant_id,email,password_hash,display_name,status)VALUES($1,$2,'x',$3,'active')RETURNING id", [tenant, `${randomUUID()}@orders.test`, name])).rows[0].id as string
  const [boss, agentUser, other] = [await user('店长'), await user('客服甲'), await user('客服乙')]
  const auth = (sub: string, permissions: string[], t = tenant) => ({ authorization: `Bearer ${app.jwt.sign({ sub, tenantId: t, email: 't', displayName: 't', roles: [], permissions })}` })
  const all = auth(boss, ['*']), base = '/api/integrations/1688/performance'
  const conn = await saveConnection(tenant, boss, { access_token: 'o', refresh_token: 'o-r', expires_in: 36000, aliId: `ord-${randomUUID()}`, resource_owner: 'shop', refresh_token_timeout: '20990101000000000+0800' }, Date.now(), 'performance')
  const agent = (await db.query("INSERT INTO perf_agents(tenant_id,connection_id,login_id,is_main,user_id) VALUES($1,$2,'shop:甲',false,$3) RETURNING id", [tenant, conn.id, agentUser])).rows[0].id
  const order = async (id: string, status: string, total: number, refund = 0, items = [{ name: '车用安全锤', sku: '颜色:黑色', price: 3.1, amount: 33.25, quantity: 11 }]) => (await db.query(`INSERT INTO perf_orders(tenant_id,connection_id,order_id,buyer_open_uid,status,total_amount,refund_amount,placed_at,items)
    VALUES($1,$2,$3,'BBBbuyer1',$4,$5,$6,now(),$7) RETURNING id`, [tenant, conn.id, id, status, total, refund, JSON.stringify(items)])).rows[0].id
  const o1 = await order('3300000000000000001', 'waitbuyerreceive', 37.75)
  await order('3300000000000000002', 'waitsellersend', 10)
  await order('3300000000000000003', 'success', 20, 5, [{ name: '洗车泡沫喷壶', sku: '', price: 20, amount: 20, quantity: 1 }])
  await order('3300000000000000004', 'cancel', 8)
  await db.query("INSERT INTO perf_settings(tenant_id) VALUES($1) ON CONFLICT DO NOTHING", [tenant])
  const scheme = (await db.query('SELECT default_scheme FROM perf_settings WHERE tenant_id=$1', [tenant])).rows[0].default_scheme
  await db.query("INSERT INTO perf_order_attributions(order_id,scheme,agent_id,share,basis) VALUES($1,$2,$3,1,'order_reply')", [o1, scheme, agent])
  const list = (q: string, headers = all) => app.inject({ method: 'GET', url: `${base}/order-list?connectionId=${conn.id}&from=${today}&to=${today}${q}`, headers })

  const r = (await list('')).json()
  assert.deepEqual([r.total, r.counts.all, r.counts.toship, r.counts.shipped, r.counts.done, r.counts.closed, r.counts.refund, r.amount], [4, 4, 1, 1, 1, 1, 1, 75.75])
  assert.equal(r.data.find((o: any) => o.order_id === '3300000000000000001').agents[0].login_id, 'shop:甲')
  assert.deepEqual((await list('&group=toship')).json().data.map((o: any) => o.order_id), ['3300000000000000002'])
  assert.deepEqual((await list('&group=refund')).json().data.map((o: any) => o.order_id), ['3300000000000000003'])
  assert.deepEqual((await list(`&search=${encodeURIComponent('泡沫')}`)).json().data.map((o: any) => o.order_id), ['3300000000000000003'])
  assert.equal((await list('&search=3300000000000000004')).json().total, 1)
  // Own-only access: orders attributed to the user's agents.
  assert.deepEqual((await list('', auth(agentUser, ['performance:read_own']))).json().data.map((o: any) => o.order_id), ['3300000000000000001'])
  assert.equal((await list('', auth(other, ['performance:read_own']))).json().total, 0)

  // Detail: fetched live, reduced and masked by the platform; nothing written back.
  const d = (await app.inject({ method: 'GET', url: `${base}/order-list/3300000000000000001?connectionId=${conn.id}`, headers: all })).json().data
  assert.deepEqual([d.order.status, d.order.total_amount, d.order.discount, d.order.seller_memo, d.order.credit.amount, d.order.paid_at], ['waitbuyerreceive', 37.75, -0.85, null, 37.75, '2026-10-20T02:06:00.000Z'])
  assert.deepEqual([d.items[0].image, d.items[0].sku, d.items[0].quantity], ['https://cbu01.alicdn.com/a.jpg', '颜色：黑色', 11])
  assert.deepEqual([d.shipments[0].company, d.receiver.mobile, d.receiver.region, d.masked], ['中通快递', '180****8902', '浙江省 金华市 义乌市', ['BUYER_ENCRYPT']])
  assert.equal(d.buyer.open_uid, undefined)
  assert.equal(detailCalls, 1)
  assert.equal((await app.inject({ method: 'GET', url: `${base}/order-list/3300000000000000002?connectionId=${conn.id}`, headers: auth(agentUser, ['performance:read_own']) })).statusCode, 404, 'not attributed to this agent')
  assert.equal((await app.inject({ method: 'GET', url: `${base}/order-list/9999999999999999999?connectionId=${conn.id}`, headers: all })).statusCode, 404, 'unknown orders are not fetched')
  assert.equal((await app.inject({ method: 'GET', url: `${base}/order-list/3300000000000000001?connectionId=${conn.id}`, headers: auth(boss, ['*'], tenants[1]) })).statusCode, 404)
  assert.equal(detailCalls, 1, 'refused requests never reach the platform')
  // Once the agent has chatted with that buyer, their orders open from the chat even when credited to someone else.
  const buyer = (await db.query("INSERT INTO perf_buyers(tenant_id,connection_id,buyer_key) VALUES($1,$2,'BBBbuyer1') RETURNING id", [tenant, conn.id])).rows[0].id
  await db.query('INSERT INTO perf_buyer_identities(connection_id,open_uid,buyer_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [conn.id, 'BBBbuyer1', buyer])
  await db.query("INSERT INTO perf_chat_sessions(tenant_id,connection_id,agent_id,buyer_id,cid,chat_date,last_peer_at,needs_sync) VALUES($1,$2,$3,$4,'c-o',$5::date,now(),false)", [tenant, conn.id, agent, buyer, today])
  assert.equal((await app.inject({ method: 'GET', url: `${base}/order-list/3300000000000000002?connectionId=${conn.id}`, headers: auth(agentUser, ['performance:read_own']) })).statusCode, 200)
  assert.equal((await app.inject({ method: 'GET', url: `${base}/order-list/3300000000000000002?connectionId=${conn.id}`, headers: auth(other, ['performance:read_own']) })).statusCode, 404)
  assert.equal(detailCalls, 2)
  console.log(JSON.stringify({ list: 'ok', groups: 'ok', search: 'ok', ownScope: 'ok', detail: 'ok', masked: 'ok', isolation: 'ok', fromChat: 'ok' }))
} finally {
  globalThis.fetch = originalFetch
  for (const id of tenants) { await db.query('DELETE FROM audit_logs WHERE tenant_id=$1', [id]); await db.query('DELETE FROM tenants WHERE id=$1', [id]) }
  await app.close(); await db.end()
}
