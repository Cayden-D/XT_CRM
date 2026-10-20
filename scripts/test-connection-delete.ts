import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { buildApp } from '../server/app.js'
import { db } from '../server/db.js'
import { saveConnection } from '../server/integrations/1688.js'

// Deleting unused shop connections (product app and performance app): only disabled ones, never one holding work
// that must be kept, and only within the tenant. No platform call is involved.
const originalFetch = globalThis.fetch
globalThis.fetch = async () => { throw new Error('no network in this suite') }
const app = await buildApp(), tenants: string[] = []
try {
  for (let i = 0; i < 2; i++) tenants.push((await db.query('INSERT INTO tenants(name,slug)VALUES($1,$2)RETURNING id', ['删除连接测试', `conn-delete-${randomUUID().slice(0, 8)}`])).rows[0].id)
  const tenant = tenants[0]
  const actor = (await db.query("INSERT INTO users(tenant_id,email,password_hash,display_name,status)VALUES($1,$2,'x','店长','active')RETURNING id", [tenant, `${randomUUID()}@delete.test`])).rows[0].id
  const auth = (permissions: string[], t = tenant) => ({ authorization: `Bearer ${app.jwt.sign({ sub: actor, tenantId: t, email: 't', displayName: 't', roles: [], permissions })}` })
  const all = auth(['*'])
  const grant = () => ({ access_token: 'a', refresh_token: 'r', expires_in: 36000, aliId: `del-${randomUUID()}`, refresh_token_timeout: '20990101000000000+0800' })
  const call = (method: 'GET' | 'POST' | 'DELETE', url: string, headers = all) => app.inject({ method, url, headers, ...(method === 'POST' ? { payload: {} } : {}) })

  // Product app: a duplicate authorization with synced listings and an unpublished draft.
  const shopBase = '/api/integrations/1688/connections'
  const spare = await saveConnection(tenant, actor, grant())
  await db.query("INSERT INTO integration_1688_listings(tenant_id,connection_id,offer_id,title,status,snapshot) VALUES($1,$2,'111','同步商品','published','{}')", [tenant, spare.id])
  const product = (await db.query("INSERT INTO products(tenant_id,name,sku) VALUES($1,'测试产品',$2) RETURNING id", [tenant, `SKU-${randomUUID().slice(0, 6)}`])).rows[0].id
  await db.query("INSERT INTO integration_1688_publish_drafts(tenant_id,connection_id,product_id,cat_id,scene,platform_schema,data_body) VALUES($1,$2,$3,'1','cbu','{}','{}')", [tenant, spare.id, product])
  // A connected shop cannot be deleted; it must be disabled first.
  const active = await call('DELETE', `${shopBase}/${spare.id}`)
  assert.equal(active.statusCode, 409); assert.equal(active.json().error, 'CONNECTION_ACTIVE')
  assert.equal((await call('POST', `${shopBase}/${spare.id}/disable`)).statusCode, 200)
  const usage = (await call('GET', `${shopBase}/${spare.id}/usage`)).json().data
  assert.deepEqual([usage.status, usage.listings, usage.drafts, usage.published], ['disabled', 1, 1, 0])
  // Other tenants and people without manage permission cannot delete it.
  assert.equal((await call('DELETE', `${shopBase}/${spare.id}`, auth(['*'], tenants[1]))).statusCode, 404)
  assert.equal((await call('DELETE', `${shopBase}/${spare.id}`, auth(['integration:read']))).statusCode, 403)
  assert.equal((await call('DELETE', `${shopBase}/${spare.id}`)).statusCode, 200)
  assert.equal((await db.query('SELECT count(*)::int AS n FROM integration_1688_listings WHERE connection_id=$1', [spare.id])).rows[0].n, 0)
  assert.equal((await db.query('SELECT count(*)::int AS n FROM integration_1688_publish_drafts WHERE connection_id=$1', [spare.id])).rows[0].n, 0)
  assert.equal((await db.query("SELECT count(*)::int AS n FROM audit_logs WHERE tenant_id=$1 AND action='1688.connection.delete' AND entity_id=$2", [tenant, spare.id])).rows[0].n, 1)
  // A shop with products published through the system keeps its history.
  const used = await saveConnection(tenant, actor, grant())
  await db.query("INSERT INTO integration_1688_publish_drafts(tenant_id,connection_id,product_id,cat_id,scene,platform_schema,data_body,status,offer_id) VALUES($1,$2,$3,'1','cbu','{}','{}','published','222')", [tenant, used.id, product])
  await call('POST', `${shopBase}/${used.id}/disable`)
  const kept = await call('DELETE', `${shopBase}/${used.id}`)
  assert.equal(kept.statusCode, 409); assert.equal(kept.json().error, 'CONNECTION_IN_USE')
  assert.equal((await db.query('SELECT count(*)::int AS n FROM integration_1688_connections WHERE id=$1', [used.id])).rows[0].n, 1)

  // Performance app: synced buyers and orders go with it; a buyer with a follow-up keeps it.
  const perfBase = '/api/integrations/1688/performance/connections'
  const perf = await saveConnection(tenant, actor, grant(), Date.now(), 'performance')
  const buyer = (await db.query("INSERT INTO perf_buyers(tenant_id,connection_id,buyer_key) VALUES($1,$2,'buyer-x') RETURNING id", [tenant, perf.id])).rows[0].id
  await db.query("INSERT INTO perf_orders(tenant_id,connection_id,order_id,buyer_open_uid,status,total_amount,placed_at) VALUES($1,$2,'9001','buyer-x','success',10,now())", [tenant, perf.id])
  assert.match((await call('DELETE', `${perfBase}/${perf.id}`)).json().message, /请先停用/)
  await call('POST', `${perfBase}/${perf.id}/disable`)
  const followup = (await db.query("INSERT INTO cust_followups(tenant_id,buyer_id,method,content,need_follow_up) VALUES($1,$2,'other','回访',false) RETURNING id", [tenant, buyer])).rows[0].id
  const perfUsage = (await call('GET', `${perfBase}/${perf.id}/usage`)).json().data
  assert.deepEqual([perfUsage.orders, perfUsage.buyers, perfUsage.followups], [1, 1, 1])
  const blocked = await call('DELETE', `${perfBase}/${perf.id}`)
  assert.equal(blocked.statusCode, 409); assert.match(blocked.json().message, /1 条跟进记录/)
  await db.query('DELETE FROM cust_followups WHERE id=$1', [followup])
  assert.equal((await call('DELETE', `${perfBase}/${perf.id}`, auth(['performance:read']))).statusCode, 403)
  assert.equal((await call('DELETE', `${perfBase}/${perf.id}`)).statusCode, 200)
  assert.equal((await db.query('SELECT count(*)::int AS n FROM perf_orders WHERE connection_id=$1', [perf.id])).rows[0].n, 0)
  assert.equal((await db.query('SELECT count(*)::int AS n FROM perf_buyers WHERE id=$1', [buyer])).rows[0].n, 0)

  console.log(JSON.stringify({ mustDisableFirst: 'ok', productUsage: 'ok', productDelete: 'ok', publishedKept: 'ok', perfDelete: 'ok', followupsKept: 'ok', isolation: 'ok', permissions: 'ok', audited: 'ok' }))
} finally {
  globalThis.fetch = originalFetch
  for (const id of tenants) { await db.query('DELETE FROM audit_logs WHERE tenant_id=$1', [id]); await db.query('DELETE FROM integration_1688_publish_drafts WHERE tenant_id=$1', [id]); await db.query('DELETE FROM tenants WHERE id=$1', [id]) }
  await app.close(); await db.end()
}
