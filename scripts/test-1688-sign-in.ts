import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { buildApp } from '../server/app.js'
import { config } from '../server/config.js'
import { db } from '../server/db.js'
import { decryptGrant, saveConnection, stateHash } from '../server/integrations/1688.js'

const key = `signin-${randomUUID()}`
const redirect = 'https://crm.example.test/1688/return'
const secret = 'signin-test-secret'
Object.assign(config, {
  ALI1688_PERFORMANCE_APP_KEY: key,
  ALI1688_PERFORMANCE_APP_SECRET: secret,
  ALI1688_PERFORMANCE_REDIRECT_URI: redirect,
  ALI1688_TOKEN_ENCRYPTION_KEY: 'a'.repeat(64),
})
const app = await buildApp()
const originalFetch = globalThis.fetch
const tenantIds = new Set<string>()
const [shopA, shopB, legacyShop] = Array.from({ length: 3 }, () => randomUUID())
const ids: Record<string, string> = { first: shopA, same: shopA, second: shopB, legacy: legacyShop }
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
  // Former password sessions, signed with the former namespace, cannot open the application.
  const encode = (v: object) => Buffer.from(JSON.stringify(v)).toString('base64url')
  const payload = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(first.user)}`
  const oldToken = `${payload}.${createHmac('sha256', config.JWT_SECRET).update(payload).digest('base64url')}`
  assert.equal((await app.inject({ method: 'GET', url: '/api/auth/me', headers: headers(oldToken) })).statusCode, 401)

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
  const stores = await app.inject({ method: 'GET', url: '/api/integrations/1688/performance/connections', headers: headers(second.token) })
  assert.deepEqual(stores.json().data.map((row: { ali_id: string }) => row.ali_id), [shopB])

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
  await db.query('DELETE FROM tenants WHERE id=ANY($1::uuid[])', [[...tenantIds]])
  await app.close()
  await db.end()
}
