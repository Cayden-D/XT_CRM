import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { buildApp } from '../server/app.js'
import { config } from '../server/config.js'
import { db } from '../server/db.js'
import { appCredentials, saveConnection, signApi } from '../server/integrations/1688.js'
import { marketplaceDate, normalizeServiceOrders } from '../server/integrations/1688-marketplace.js'
import { serviceSummary, type ServiceOrder } from '../shared/1688-marketplace.js'

const now = Date.now(), DAY = 86_400_000, iso = (n: number) => new Date(n).toISOString()
const serviceOrder = (days: number, status = 'S', begin = now - DAY): ServiceOrder => ({ id: randomUUID(), createdAt: iso(now - 200 * DAY), begin: iso(begin), end: iso(now + days * DAY), status, name: '测试应用', sku: '基础版' })
for (const [days, state] of [[15, 'active'], [14, 'expiring'], [7, 'urgent'], [0, 'expired']] as const) assert.equal(serviceSummary([serviceOrder(days)], now).state, state)
assert.equal(serviceSummary([serviceOrder(8.1)], now).days, 9)
assert.equal(serviceSummary([serviceOrder(20, 'P')], now).state, 'suspended')
assert.equal(serviceSummary([serviceOrder(20, 'B', now + DAY)], now).state, 'pending')
assert.equal(serviceSummary([serviceOrder(20, 'C')], now).state, 'unknown')
assert.equal(serviceSummary([serviceOrder(20, 'E')], now).state, 'closed')
assert.equal(serviceSummary([serviceOrder(6), serviceOrder(36, 'B', now + 6 * DAY)], now).days, 36, 'contiguous renewal extends service')
assert.equal(serviceSummary([serviceOrder(6), serviceOrder(36, 'B', now + 7 * DAY)], now).days, 6, 'gap must not extend current service')
assert.equal(marketplaceDate('2026-11-23T00:00:00.000Z'), '20261123080000000+0800')
const raw = (id: string, memberId = 'member-test', status = 'S', created = now - 200 * DAY) => ({ orderItemNum: id, memberId, productName: '订购应用', skuName: '基础版', bizStatus: status, payStatus: 'payment_success', gmtCreate: marketplaceDate(iso(created)), gmtServiceBegin: marketplaceDate(iso(now - 200 * DAY)), gmtServiceEnd: marketplaceDate(iso(now + 6 * DAY)), paymentAmount: 999, signCustomerUid: 'private' })
assert.equal(normalizeServiceOrders([raw('foreign', 'other'), { ...raw('unpaid'), payStatus: 'payment_none' }, raw('cancelled', 'member-test', 'C')], 'member-test', null).length, 0)
assert.throws(() => normalizeServiceOrders([{ ...raw('bad'), gmtServiceEnd: 'invalid' }], 'member-test', null))
assert.equal(normalizeServiceOrders([{ ...raw('arrears'), bizStatusExt: 'arrear_suspend' }], 'member-test', null)[0].status, 'P')

const app = await buildApp(), originalFetch = globalThis.fetch, marker = randomUUID(), tenants: string[] = []
let mode: 'normal' | 'failed' | 'malformed' | 'unpaid' | 'closed' = 'normal', calls = 0, pages: number[] = [], purposes: string[] = [], delay = false
let backwards = false
globalThis.fetch = async (input, init) => {
  const url = String(input), form = init?.body
  assert.ok(url.startsWith('https://gw.open.1688.com/openapi/param2/1/cn.alibaba.open/app.order.get/'), 'no real platform requests')
  assert.ok(form instanceof URLSearchParams)
  const path = url.split('/openapi/')[1], purpose = path.endsWith(`/${appCredentials('performance').appKey}`) ? 'performance' : 'product'
  const credentials = appCredentials(purpose), params = Object.fromEntries(form)
  assert.equal(params._aop_signature, signApi(path, params, credentials.secret))
  assert.equal(params.access_token, `${purpose}-token`)
  assert.equal(params.memberId, 'member-test'); assert.equal(params.pageSize, '50')
  assert.equal(params.bizStatusList, undefined, 'query all statuses, including suspended and closed')
  calls++; purposes.push(purpose); pages.push(Number(params.startIndex))
  if (delay) await new Promise(resolve => setTimeout(resolve, 50))
  const from = Date.parse(params.gmtCreate.replace(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{3})([+-]\d{2})(\d{2})$/, '$1-$2-$3T$4:$5:$6.$7$8:$9'))
  let values: unknown[] = []
  if (backwards ? from >= now - 200 * DAY && from - 30 * DAY <= now - 200 * DAY : from <= now - 200 * DAY && from + 30 * DAY >= now - 200 * DAY) {
    values = Number(params.startIndex) === 1 ? Array.from({ length: 50 }, (_, i) => raw(`order-${i}`, i === 49 ? 'foreign-member' : 'member-test')) : [raw('order-50')]
  }
  if (mode === 'unpaid') values = [{ ...raw('unpaid'), payStatus: 'payment_none' }]
  if (mode === 'closed') values = [raw('closed', 'member-test', 'E')]
  const data = mode === 'failed' ? { successed: false, returnValue: [] } : mode === 'malformed' ? { successed: true } : { successed: true, returnValue: values }
  return new Response(JSON.stringify(data), { status: 200 })
}
try {
  for (let i = 0; i < 2; i++) tenants.push((await db.query('INSERT INTO tenants(name,slug) VALUES($1,$2) RETURNING id', ['marketplace-test', `marketplace-${marker}-${i}`])).rows[0].id)
  const tenant = tenants[0], actor = (await db.query("INSERT INTO users(tenant_id,email,password_hash,display_name,status) VALUES($1,$2,'unused','测试人员','active') RETURNING id", [tenant, `${marker}@marketplace.test`])).rows[0].id
  const auth = (permissions = ['*'], tenantId = tenant) => ({ authorization: `Bearer ${app.jwt.sign({ sub: actor, tenantId, email: 'test', displayName: '测试人员', roles: [], permissions })}` })
  const base = '/api/integrations/1688/marketplace'
  const get = (headers = auth()) => app.inject({ method: 'GET', url: base + '/', headers })
  const post = (purpose: string, id: string, headers = auth(), refresh = false) => app.inject({ method: 'POST', url: `${base}/${purpose}/${id}/sync`, headers, payload: { refresh } })
  const connections: Record<string, string> = {}
  for (const purpose of ['product', 'performance'] as const) connections[purpose] = (await saveConnection(tenant, actor, { aliId: `${marker}-${purpose}`, memberId: 'member-test', resource_owner: 'test-shop', access_token: `${purpose}-token`, expires_in: 36000 }, now, purpose)).id
  assert.equal((await app.inject({ method: 'GET', url: base + '/' })).statusCode, 401)
  assert.equal((await post('performance', connections.performance, auth(['integration:read']))).statusCode, 403)
  assert.equal((await post('product', connections.product, auth(['*'], tenants[1]))).statusCode, 404)
  assert.equal((await post('product', connections.performance)).statusCode, 404)
  assert.deepEqual((await get(auth(['performance:read_own']))).json().connections.map((c: { purpose: string }) => c.purpose), ['performance'])
  assert.equal((await get(auth([]))).json().connections.length, 0)
  assert.equal((await get()).json().support.phone, config.MARKETPLACE_SUPPORT_PHONE)
  const initial = (await get()).json().connections[0]
  assert.equal(initial.service.state, 'unknown'); assert.equal(initial.needsSync, true)
  // Finish initial historical scan. Expired/unknown cannot be inferred from a recent empty window.
  let result
  for (let i = 0; i < 150; i++) {
    const response = await post('product', connections.product)
    assert.equal(response.statusCode, 200, response.body)
    result = response.json().data
    if (!result.syncing) break
    assert.equal(result.service.state, 'unknown')
    await db.query("UPDATE integration_1688_connections SET marketplace_subscription=jsonb_set(marketplace_subscription,'{attemptedAt}',to_jsonb((now()-interval '2 seconds')::text)) WHERE id=$1", [connections.product])
  }
  assert.ok(result.checkedAt, 'historical scan must finish'); assert.equal(result.service.state, 'urgent'); assert.equal(result.service.days, 6)
  assert.ok(pages.includes(2), 'must paginate full pages'); assert.ok(calls > 8, 'must look beyond recent 30 days')
  const snapshot = (await db.query('SELECT marketplace_subscription FROM integration_1688_connections WHERE id=$1', [connections.product])).rows[0].marketplace_subscription
  assert.equal(snapshot.orders.length, 50, 'foreign subscriber removed, second page included')
  assert.ok(!/paymentAmount|signCustomerUid|foreign-member|token|private/.test(JSON.stringify(snapshot)))
  const before = calls
  await post('product', connections.product); assert.equal(calls, before, 'completed results cached')
  await post('product', connections.product, auth(), true); assert.equal(calls, before, 'manual refresh shares cooldown')
  // Re-read known old service periods on the daily refresh, rather than losing annual subscriptions.
  await db.query("UPDATE integration_1688_connections SET marketplace_subscription=marketplace_subscription||jsonb_build_object('checkedAt',now()-interval '2 days','attemptedAt',now()-interval '2 days') WHERE id=$1", [connections.product])
  mode = 'failed'
  const failed = (await post('product', connections.product)).json().data
  assert.ok(failed.error); assert.equal(failed.service.state, 'urgent', 'failure preserves last successful service period')
  const failedCalls = calls; await post('product', connections.product); assert.equal(calls, failedCalls, 'errors back off')
  mode = 'malformed'
  const malformed = (await post('performance', connections.performance)).json().data
  assert.ok(malformed.error); assert.equal(malformed.service.state, 'unknown')
  assert.ok(purposes.includes('performance'))
  // Concurrent requests across tabs share a database lock and cannot duplicate gateway calls.
  mode = 'normal'; delay = true
  await db.query("UPDATE integration_1688_perf_connections SET marketplace_subscription='{}' WHERE id=$1", [connections.performance])
  const count = calls
  const concurrent = await Promise.all([post('performance', connections.performance), post('performance', connections.performance)])
  assert.ok(concurrent.every(r => r.statusCode === 200)); assert.equal(calls, count + 1)
  // The API description does not define which side of the timestamp "近30天" means.
  // Incremental queries cover both recent orders and the original annual order under either interpretation.
  backwards = true; delay = false
  await db.query('UPDATE integration_1688_perf_connections SET marketplace_subscription=$2 WHERE id=$1', [connections.performance, JSON.stringify({ historyComplete: true, orders: snapshot.orders, checkedAt: iso(now - 2 * DAY) })])
  let backwardsResult
  for (let i = 0; i < 10; i++) {
    backwardsResult = (await post('performance', connections.performance)).json().data
    if (!backwardsResult.syncing) break
    await db.query("UPDATE integration_1688_perf_connections SET marketplace_subscription=jsonb_set(marketplace_subscription,'{attemptedAt}',to_jsonb((now()-interval '2 seconds')::text)) WHERE id=$1", [connections.performance])
  }
  assert.equal(backwardsResult.syncing, false); assert.equal(backwardsResult.service.state, 'urgent')
  const listed = await get()
  assert.ok(!/access_token|token_ciphertext|member-test|order-50|paymentAmount|signCustomerUid/.test(listed.body), 'public response carries only summary and support contacts')
  console.log(`1688 marketplace: date boundaries, renewals, annual orders, pagination, app/tenant isolation, signing, cache, errors and concurrency passed (${calls} mocked gateway calls).`)
} finally {
  globalThis.fetch = originalFetch
  for (const id of tenants) await db.query('DELETE FROM tenants WHERE id=$1', [id])
  await app.close(); await db.end()
}
