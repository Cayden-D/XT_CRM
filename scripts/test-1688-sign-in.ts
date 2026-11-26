import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import { buildApp } from '../server/app.js'
import { config } from '../server/config.js'
import { db } from '../server/db.js'
import { authorizeWorkspaceShops } from '../server/integrations/1688-workspace-shops.js'
import { decryptGrant, saveConnection, stateHash } from '../server/integrations/1688.js'

const key = `signin-${randomUUID()}`
const redirect = 'https://crm.example.test/1688/return'
const secret = 'signin-test-secret'
Object.assign(config, {
  ALI1688_APP_KEY: `product-${key}`,
  ALI1688_APP_SECRET: secret,
  ALI1688_REDIRECT_URI: redirect,
  ALI1688_PERFORMANCE_APP_KEY: key,
  ALI1688_PERFORMANCE_APP_SECRET: secret,
  ALI1688_PERFORMANCE_REDIRECT_URI: redirect,
  ALI1688_TOKEN_ENCRYPTION_KEY: 'a'.repeat(64),
})
const app = await buildApp()
const originalFetch = globalThis.fetch
const tenantIds = new Set<string>()
const [shopA, shopB, legacyShop, mixedShop, otherMixedShop] = Array.from({ length: 5 }, () => randomUUID())
const ids: Record<string, string> = { first: shopA, same: shopA, second: shopB, legacy: legacyShop, mixed: mixedShop, mixedOther: otherMixedShop }
let exchanges = 0
globalThis.fetch = async (url, init) => {
  assert.equal(String(url), `https://gw.open.1688.com/openapi/http/1/system.oauth2/getToken/${key}`)
  assert.ok(init?.body instanceof URLSearchParams)
  assert.equal(init.body.get('client_secret'), secret)
  assert.equal(init.body.get('grant_type'), 'authorization_code')
  assert.equal(init.body.get('redirect_uri'), redirect)
  const code = init.body.get('code')!
  exchanges++
  return Response.json({ access_token: `platform-access-${code}`, refresh_token: 'platform-refresh', expires_in: 3600, aliId: ids[code], resource_owner: '相同昵称' })
}

async function start() {
  const verifier = randomBytes(32).toString('hex')
  const r = await app.inject({ method: 'POST', url: '/api/auth/1688/start', payload: { challenge: stateHash(verifier) } })
  assert.equal(r.statusCode, 200, r.body)
  const url = new URL(r.json().authorizationUrl)
  assert.equal(url.origin, 'https://auth.1688.com')
  assert.equal(url.searchParams.get('client_id'), key)
  assert.equal(url.searchParams.get('redirect_uri'), redirect)
  assert.equal(url.searchParams.get('site'), '1688')
  return { verifier, state: url.searchParams.get('state')! }
}
function complete(code: string, trip: Awaited<ReturnType<typeof start>>, callback = redirect) {
  const query = new URLSearchParams({ code, state: trip.state, aliId: 'client-input-must-not-be-trusted' })
  return app.inject({ method: 'POST', url: '/api/auth/1688/complete', payload: { callbackUrl: `${callback}?${query}`, verifier: trip.verifier } })
}
const headers = (token: string) => ({ authorization: `Bearer ${token}` })
function signedIn(r: Awaited<ReturnType<typeof complete>>) {
  assert.equal(r.statusCode, 200, r.body)
  assert.equal(r.headers['cache-control'], 'no-store')
  assert.doesNotMatch(r.body, /platform-access|platform-refresh|signin-test-secret/)
  const data = r.json()
  tenantIds.add(data.user.tenantId)
  return data
}
try {
  assert.equal((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'old@local.test', password: 'unused' } })).statusCode, 404)
  const trip = await start()
  assert.equal((await complete('first', trip, 'https://other.example.test/1688/return')).statusCode, 400)
  assert.equal((await complete('first', trip, 'https://crm.example.test/wrong')).statusCode, 400)
  assert.equal((await complete('first', { ...trip, verifier: randomBytes(32).toString('hex') })).statusCode, 409)
  const expired = await start()
  await db.query("UPDATE auth_1688_sign_in_states SET expires_at=now()-interval '1 second' WHERE state_hash=$1", [stateHash(expired.state)])
  assert.equal((await complete('first', expired)).statusCode, 409)
  assert.equal(exchanges, 0)

  const results = await Promise.all([complete('first', trip), complete('first', trip)])
  assert.deepEqual(results.map(r => r.statusCode).sort(), [200, 409])
  assert.equal(exchanges, 1)
  const first = signedIn(results.find(r => r.statusCode === 200)!)
  assert.ok(first.user.permissions.includes('performance:*'))
  assert.ok(!first.user.permissions.includes('*') && !first.user.permissions.includes('user:manage'))
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: headers(first.token) })
  assert.equal(me.json().user.sub, first.user.sub)
  assert.equal(me.json().user.oauth1688, undefined)
  assert.match(me.headers['cache-control'] ?? '', /no-store/)
  // Sessions from before workspace ownership checks cannot open the application.
  const encode = (v: object) => Buffer.from(JSON.stringify(v)).toString('base64url')
  const payload = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(first.user)}`
  const oldNamespace = createHmac('sha256', config.JWT_SECRET).update('crm:1688-sign-in:v1').digest('hex')
  for (const secret of [config.JWT_SECRET, oldNamespace]) {
    const oldToken = `${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`
    assert.equal((await app.inject({ method: 'GET', url: '/api/auth/me', headers: headers(oldToken) })).statusCode, 401)
  }

  const current = (await db.query('SELECT * FROM integration_1688_perf_connections WHERE tenant_id=$1', [first.user.tenantId])).rows[0]
  assert.equal(current.ali_id, shopA)
  assert.equal((await decryptGrant(current.token_ciphertext)).access_token, 'platform-access-first')
  await db.query("UPDATE integration_1688_perf_connections SET status='disabled',account_role='main',member_capability='available' WHERE id=$1", [current.id])
  const repeat = signedIn(await complete('same', await start()))
  assert.deepEqual([repeat.user.sub, repeat.user.tenantId], [first.user.sub, first.user.tenantId])
  const saved = (await db.query('SELECT status,account_role,member_capability,token_ciphertext FROM integration_1688_perf_connections WHERE id=$1', [current.id])).rows[0]
  assert.deepEqual([saved.status, saved.account_role, saved.member_capability], ['disabled', 'main', 'available'])
  assert.equal((await decryptGrant(saved.token_ciphertext)).access_token, 'platform-access-same')

  const second = signedIn(await complete('second', await start()))
  assert.notEqual(second.user.tenantId, first.user.tenantId)
  assert.equal((await db.query('SELECT ali1688_owner_id FROM tenants WHERE id=$1', [second.user.tenantId])).rows[0].ali1688_owner_id, shopB)
  const get = (url: string, token = second.token) => app.inject({ method: 'GET', url, headers: headers(token) })
  const stores = await get('/api/integrations/1688/performance/connections')
  assert.deepEqual(stores.json().data.map((row: { ali_id: string }) => row.ali_id), [shopB])
  const productAccount = await saveConnection(first.user.tenantId, first.user.sub, { aliId: shopA, access_token: 'product-test', expires_in: 3600 })
  assert.equal((await get('/api/integrations/1688/connections')).json().data.length, 0)
  await assert.rejects(saveConnection(second.user.tenantId, second.user.sub,
    { aliId: shopA, access_token: 'wrong-account-test', expires_in: 3600 }), { code: 'SHOP_ACCOUNT_MISMATCH' })
  await assert.rejects(saveConnection(second.user.tenantId, second.user.sub,
    { aliId: shopA, access_token: 'wrong-performance-test', expires_in: 3600 }, Date.now(), 'performance'), { code: 'SHOP_ACCOUNT_MISMATCH' })
  await assert.rejects(db.query('UPDATE integration_1688_connections SET tenant_id=$2 WHERE id=$1', [productAccount.id, second.user.tenantId]),
    { constraint: 'crm_1688_workspace_owner' })
  const item = (await db.query(`
    INSERT INTO collected_products(tenant_id,source,source_product_id,source_url,title,collected_by)
    VALUES($1,'1688',$2,'https://detail.1688.com/offer/1.html','隔离用商品',$3) RETURNING id`,
  [first.user.tenantId, randomUUID(), first.user.sub])).rows[0].id
  assert.equal((await get('/api/product-collections')).json().total, 0)
  assert.equal((await get(`/api/product-collections/${item}`)).statusCode, 404)
  assert.equal((await get(`/api/product-collections/${item}`, first.token)).statusCode, 200)
  assert.equal((await get(`/api/dashboard?connectionId=${current.id}`)).statusCode, 404)
  assert.equal((await get(`/api/integrations/1688/performance/order-list?connectionId=${current.id}&from=2026-11-01&to=2026-11-02`)).statusCode, 404)
  const mismatchedToken = app.jwt.sign({ ...second.user, tenantId: first.user.tenantId, oauth1688: { appKey: key, aliId: shopB } })
  assert.equal((await get('/api/auth/me', mismatchedToken)).statusCode, 401)
  const liveLink = (await db.query('DELETE FROM auth_1688_identities WHERE app_key=$1 AND ali_id=$2 RETURNING user_id', [key, shopB])).rows[0]
  assert.equal((await get('/api/auth/me')).statusCode, 401, 'an unlinked browser session immediately loses access')
  await db.query('INSERT INTO auth_1688_identities(app_key,ali_id,user_id) VALUES($1,$2,$3)', [key, shopB, liveLink.user_id])

  // A code-only launch may omit Referer inside the marketplace frame. GET issues a handoff only.
  const managed = (url: string, extra: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url, headers: {
      host: new URL(redirect).host, 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe', ...extra,
    } })
  const marketPath = '/api/auth/1688/marketplace?code=same'
  const beforeMarket = exchanges
  assert.equal((await managed(marketPath, { 'sec-fetch-dest': 'document' })).statusCode, 403)
  assert.equal((await managed(marketPath, {
    referer: 'https://fuwu.1688.com.example.test/', 'sec-fetch-dest': 'document',
  })).statusCode, 403)
  assert.equal((await managed(marketPath, { 'sec-fetch-mode': 'cors' })).statusCode, 403)
  assert.equal((await managed(marketPath, { host: 'other.example.test' })).statusCode, 400)
  assert.equal((await managed(`${marketPath}&state=login_wrong`)).statusCode, 400)
  assert.equal((await managed(`${marketPath}&code=second`)).statusCode, 400)
  const launch = await managed(marketPath)
  assert.equal(launch.statusCode, 200, launch.body)
  assert.equal(exchanges, beforeMarket, 'navigation alone cannot exchange a code')
  assert.equal(launch.headers['cache-control'], 'no-store')
  assert.equal(launch.headers['referrer-policy'], 'no-referrer')
  assert.match(String(launch.headers['content-security-policy']), /frame-ancestors https:\/\/\*\.1688\.com/)
  assert.match(launch.body, /window.top === window && !handoff.allowTopLevel/)
  assert.doesNotMatch(launch.body, /platform-access|platform-refresh|signin-test-secret/)
  const handoffLiteral = launch.body.match(/const handoff = (\{[^\n]+\});/)?.[1]
  assert.ok(handoffLiteral)
  const { code: marketCode, ticket, allowTopLevel } = JSON.parse(handoffLiteral)
  assert.equal(allowTopLevel, false)
  const redeemMarket = (payload: object, origin = new URL(redirect).origin) =>
    app.inject({ method: 'POST', url: '/api/auth/1688/marketplace/complete', headers: { origin }, payload })
  assert.equal((await redeemMarket({ code: marketCode, ticket }, 'https://other.example.test')).statusCode, 403)
  assert.equal((await redeemMarket({ code: 'second', ticket })).statusCode, 409)
  assert.equal(exchanges, beforeMarket)
  const marketResults = await Promise.all([redeemMarket({ code: marketCode, ticket }), redeemMarket({ code: marketCode, ticket })])
  assert.deepEqual(marketResults.map(r => r.statusCode).sort(), [200, 409])
  const marketLogin = signedIn(marketResults.find(r => r.statusCode === 200)!)
  assert.equal(exchanges, beforeMarket + 1)
  const marketUser = (await get('/api/auth/me', marketLogin.token)).json().user
  assert.deepEqual([marketUser.sub, marketUser.tenantId], [first.user.sub, first.user.tenantId])

  const legacyTenant = (await db.query("INSERT INTO tenants(name,slug) VALUES('历史店铺',$1) RETURNING id", [`legacy-${key}`])).rows[0].id
  tenantIds.add(legacyTenant)
  const legacy = (await db.query("INSERT INTO users(tenant_id,email,display_name,password_hash)VALUES($1,'legacy@integration.local','原管理员','unused')RETURNING id", [legacyTenant])).rows[0].id
  await db.query("WITH role AS (INSERT INTO roles(tenant_id,code,name,permissions)VALUES($1,'super_admin','运营','[\"*\"]')RETURNING id) INSERT INTO user_roles(user_id,role_id) SELECT $2,id FROM role", [legacyTenant, legacy])
  const legacyConnection = await saveConnection(legacyTenant, legacy, { access_token: 'old', expires_in: 3600, aliId: legacyShop }, Date.now(), 'performance')
  const unlinked = await complete('legacy', await start())
  assert.equal(unlinked.statusCode, 409)
  assert.equal(unlinked.json().error, 'LEGACY_WORKSPACE')
  const bind = (id: string) => promisify(execFile)(process.execPath,
    ['--import', 'tsx', 'scripts/link-1688-identity.ts', id, legacyShop],
    { env: { ...process.env, ALI1688_PERFORMANCE_APP_KEY: key, ALI1688_PERFORMANCE_APP_SECRET: secret, ALI1688_PERFORMANCE_REDIRECT_URI: redirect } })
  await assert.rejects(bind(second.user.sub), (error: { stderr?: string }) => /另一个工作区/.test(error.stderr ?? ''))
  const mixedTenant = (await db.query("INSERT INTO tenants(name,slug) VALUES('历史混用店铺',$1) RETURNING id", [`mixed-${key}`])).rows[0].id
  tenantIds.add(mixedTenant)
  const mixedUser = (await db.query("INSERT INTO users(tenant_id,email,display_name) VALUES($1,'mixed@integration.local','历史成员') RETURNING id", [mixedTenant])).rows[0].id
  await saveConnection(mixedTenant, mixedUser, { aliId: mixedShop, access_token: 'mixed-perf-test', expires_in: 3600 }, Date.now(), 'performance')
  await saveConnection(mixedTenant, mixedUser, { aliId: otherMixedShop, access_token: 'mixed-product-test', expires_in: 3600 })
  await db.query('INSERT INTO auth_1688_identities(app_key,ali_id,user_id) VALUES($1,$2,$3)', [key, mixedShop, mixedUser])
  const blocked = await complete('mixed', await start())
  assert.equal(blocked.statusCode, 409)
  assert.equal(blocked.json().error, 'WORKSPACE_ISOLATION_REQUIRED')
  const collectorKey = 'crm1688_' + randomBytes(24).toString('base64url')
  await db.query(`
    INSERT INTO product_collector_keys(tenant_id,user_id,name,key_prefix,key_hash)
    VALUES($1,$2,'旧采集器',$3,$4)`,
  [mixedTenant, mixedUser, collectorKey.slice(0, 16), createHash('sha256').update(collectorKey).digest('hex')])
  const collectorSession = await app.inject({ method: 'GET', url: '/api/product-collections/session', headers: { 'x-collector-key': collectorKey } })
  assert.equal(collectorSession.statusCode, 401)
  assert.equal((await db.query('SELECT count(*)::int AS n FROM integration_1688_connections WHERE tenant_id=$1', [mixedTenant])).rows[0].n, 1)
  await db.query(`
    WITH role AS (INSERT INTO roles(tenant_id,code,name,permissions) VALUES($1,'super_admin','超级管理员','["*"]') RETURNING id)
    INSERT INTO user_roles(user_id,role_id) SELECT $2,id FROM role`, [mixedTenant, mixedUser])
  const mixedSlug = 'mixed-' + key
  const ownedShops = [mixedShop, otherMixedShop]
  await assert.rejects(authorizeWorkspaceShops(mixedSlug, [mixedShop], true), /全部历史账号/)
  await assert.rejects(authorizeWorkspaceShops(mixedSlug, [...ownedShops, shopB], true), /未在该工作区/)
  await authorizeWorkspaceShops(mixedSlug, ownedShops)
  assert.equal((await db.query('SELECT count(*)::int AS n FROM tenant_1688_shops WHERE tenant_id=$1', [mixedTenant])).rows[0].n, 0, 'preview makes no changes')
  await authorizeWorkspaceShops(mixedSlug, ownedShops, true)
  await authorizeWorkspaceShops(mixedSlug, ownedShops, true)
  const ownerSession = signedIn(await complete('mixed', await start()))
  assert.ok(ownerSession.user.roles.includes('super_admin'))
  assert.equal(ownerSession.user.tenantId, mixedTenant)
  assert.equal((await get('/api/product-collections/session', ownerSession.token)).statusCode, 401, 'collector session requires its own key')
  assert.equal((await app.inject({ method: 'GET', url: '/api/product-collections/session', headers: { 'x-collector-key': collectorKey } })).statusCode, 200)
  await assert.rejects(saveConnection(second.user.tenantId, second.user.sub,
    { aliId: otherMixedShop, access_token: 'wrong-group', expires_in: 3600 }), { code: 'SHOP_ACCOUNT_MISMATCH' })
  await assert.rejects(saveConnection(mixedTenant, mixedUser,
    { aliId: randomUUID(), access_token: 'unapproved', expires_in: 3600 }), { code: 'SHOP_ACCOUNT_MISMATCH' })
  // Explicitly linking another group account preserves its own member permissions.
  const member = (await db.query("INSERT INTO users(tenant_id,email,display_name) VALUES($1,'group-member@integration.local','店铺成员') RETURNING id", [mixedTenant])).rows[0].id
  await db.query(`WITH role AS (INSERT INTO roles(tenant_id,code,name,permissions) VALUES($1,'viewer','只读','["integration:read"]') RETURNING id)
    INSERT INTO user_roles(user_id,role_id) SELECT $2,id FROM role`, [mixedTenant, member])
  await db.query('INSERT INTO auth_1688_identities(app_key,ali_id,user_id) VALUES($1,$2,$3)', [key, otherMixedShop, member])
  const groupMember = signedIn(await complete('mixedOther', await start()))
  assert.deepEqual(groupMember.user.permissions, ['integration:read'])
  assert.equal((await get('/api/auth/me', groupMember.token)).statusCode, 200)
  assert.equal((await get('/api/integrations/1688/connections', groupMember.token)).json().data.length, 1)
  assert.equal((await get('/api/integrations/1688/connections', second.token)).json().data.length, 0)
  await db.query('DELETE FROM tenant_1688_shops WHERE ali_id=$1', [otherMixedShop])
  assert.equal((await get('/api/auth/me', groupMember.token)).statusCode, 401)
  await db.query('INSERT INTO tenant_1688_shops(tenant_id,ali_id) VALUES($1,$2)', [mixedTenant, otherMixedShop])

  await bind(legacy)
  await bind(legacy) // Repeating a planned migration is safe.
  const migrated = signedIn(await complete('legacy', await start()))
  assert.deepEqual([migrated.user.sub, migrated.user.tenantId, migrated.user.permissions], [legacy, legacyTenant, ['*']])
  assert.equal((await db.query('SELECT id FROM integration_1688_perf_connections WHERE tenant_id=$1', [legacyTenant])).rows[0].id, legacyConnection.id)
  await db.query("UPDATE users SET status='disabled' WHERE id=$1", [legacy])
  assert.equal((await complete('legacy', await start())).statusCode, 403)
  assert.equal((await complete('missing-identity', await start())).statusCode, 502)
  console.log('1688 授权登录、浏览器校验、一次性回调、身份隔离、旧工作区迁移及旧密码停用已验证')
} finally {
  globalThis.fetch = originalFetch
  await db.query('DELETE FROM auth_1688_sign_in_states WHERE app_key=$1', [key])
  await db.query('DELETE FROM auth_1688_identities WHERE app_key=$1', [key])
  await db.query('DELETE FROM audit_logs WHERE tenant_id=ANY($1::uuid[])', [[...tenantIds]])
  await db.query('DELETE FROM tenants WHERE id=ANY($1::uuid[])', [[...tenantIds]])
  await app.close()
  await db.end()
}
