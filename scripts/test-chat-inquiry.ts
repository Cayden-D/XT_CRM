import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { buildApp } from '../server/app.js'
import { db } from '../server/db.js'
import { saveConnection } from '../server/integrations/1688.js'

// 聊天与询盘: inquiry analysis, buyer lookup (loginid.openuid.encrypt) and Wangwang links (wangwangnick.openuid.decrypt),
// against a mocked gateway with the response shapes observed live on 2026-10-19 ({openUid} / {wangwangNick}).
const originalFetch = globalThis.fetch
const directory = new Map([['buyer-one', 'BBBopenuid000000000001'], ['stranger', 'BBBopenuid000000000099']])
const calls: string[] = []
globalThis.fetch = async (input, init) => {
  const url = String(input)
  assert.ok(url.startsWith('https://gw.open.1688.com/openapi/param2/1/com.alibaba.account/'), `unexpected ${url}`)
  const body = Object.fromEntries((init!.body as URLSearchParams).entries())
  const api = url.split('/').at(-2)!
  calls.push(api)
  const reply = (data: unknown) => new Response(JSON.stringify(data), { status: 200 })
  if (api === 'loginid.openuid.encrypt') return reply(directory.has(body.loginId) ? { openUid: directory.get(body.loginId) } : { openUid: '' })
  if (api === 'wangwangnick.openuid.decrypt') return reply([...directory].find(([, uid]) => uid === body.openUid) ? { wangwangNick: [...directory].find(([, uid]) => uid === body.openUid)![0] } : {})
  throw new Error(`unmocked ${api}`)
}

const app = await buildApp(), tenants: string[] = []
const today = new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10)
try {
  for (let i = 0; i < 2; i++) tenants.push((await db.query('INSERT INTO tenants(name,slug)VALUES($1,$2)RETURNING id', ['询盘测试', `inquiry-${randomUUID().slice(0, 8)}`])).rows[0].id)
  const tenant = tenants[0]
  const user = async (name: string) => (await db.query("INSERT INTO users(tenant_id,email,password_hash,display_name,status)VALUES($1,$2,'x',$3,'active')RETURNING id", [tenant, `${randomUUID()}@inquiry.test`, name])).rows[0].id as string
  const [boss, agentUser, otherUser] = [await user('店长'), await user('客服甲'), await user('客服乙')]
  const auth = (sub: string, permissions: string[], t = tenant) => ({ authorization: `Bearer ${app.jwt.sign({ sub, tenantId: t, email: 't', displayName: 't', roles: [], permissions })}` })
  const all = auth(boss, ['*'])
  const base = '/api/integrations/1688/performance'
  const conn = await saveConnection(tenant, boss, { access_token: 'inq', refresh_token: 'inq-r', expires_in: 36000, aliId: `inq-${randomUUID()}`, resource_owner: 'shop', refresh_token_timeout: '20990101000000000+0800' }, Date.now(), 'performance')
  const agent = (await db.query("INSERT INTO perf_agents(tenant_id,connection_id,login_id,is_main,user_id) VALUES($1,$2,'shop:甲',false,$3) RETURNING id", [tenant, conn.id, agentUser])).rows[0].id
  const buyer = (await db.query('INSERT INTO perf_buyers(tenant_id,connection_id,buyer_key,open_uid,first_chat_at,last_chat_at) VALUES($1,$2,$3,$3,now(),now()) RETURNING id', [tenant, conn.id, directory.get('buyer-one')])).rows[0].id
  const session = (await db.query(`INSERT INTO perf_chat_sessions(tenant_id,connection_id,agent_id,buyer_id,cid,chat_date,last_peer_at,needs_sync,buyer_messages,agent_messages)
    VALUES($1,$2,$3,$4,'c1',$5::date,now(),false,3,2) RETURNING id`, [tenant, conn.id, agent, buyer, today])).rows[0].id
  await db.query("INSERT INTO perf_orders(tenant_id,connection_id,order_id,buyer_open_uid,total_amount,placed_at,paid_at) VALUES($1,$2,'o-1',$3,88.5,now(),now())", [tenant, conn.id, directory.get('buyer-one')]).catch(() => {})
  await db.query('INSERT INTO perf_buyer_identities(connection_id,open_uid,buyer_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [conn.id, directory.get('buyer-one'), buyer])

  // Inquiry analysis answers for the period.
  const inquiry = await app.inject({ method: 'GET', url: `${base}/inquiry?connectionId=${conn.id}&from=${today}&to=${today}`, headers: all })
  assert.equal(inquiry.statusCode, 200, inquiry.body)
  assert.equal(inquiry.json().data.totals.sessions, 1)
  assert.equal(inquiry.json().data.agents[0].login_id, 'shop:甲')

  // Lookup: the typed login name is encrypted by the platform and matched to our buyer; unknown names find nothing.
  const found = (await app.inject({ method: 'POST', url: `${base}/buyers/lookup`, headers: all, payload: { connectionId: conn.id, loginId: 'buyer-one' } })).json().data
  assert.deepEqual([found.id, found.sessions.length, found.sessions[0].id], [buyer, 1, session])
  assert.equal(found.buyer_tail, directory.get('buyer-one')!.slice(-6))
  assert.equal((await app.inject({ method: 'POST', url: `${base}/buyers/lookup`, headers: all, payload: { connectionId: conn.id, loginId: 'stranger' } })).json().data, null)
  assert.equal((await app.inject({ method: 'POST', url: `${base}/buyers/lookup`, headers: all, payload: { connectionId: conn.id, loginId: 'nobody' } })).statusCode, 404)

  // Wangwang: decrypted on the click, returned only inside chat links.
  const links = (await app.inject({ method: 'POST', url: `${base}/buyers/${buyer}/wangwang`, headers: all, payload: {} })).json().data
  assert.equal(links.web, 'https://air.1688.com/app/ocms-fusion-components-1688/def_cbu_web_im/index.html?touid=cnalichnbuyer-one&siteid=cnalichn&status=1#/')
  assert.match(links.client, /^aliim:sendmsg\?uid=cnalichn&touid=cnalichnbuyer-one/)

  // Nothing typed or decrypted is stored: not in audit data, not in the operations log.
  const stored = JSON.stringify((await db.query('SELECT after_data FROM audit_logs WHERE tenant_id=$1', [tenant])).rows)
  assert.ok(!stored.includes('buyer-one') && !stored.includes('stranger'))
  const ops = (await db.query('SELECT api_name FROM integration_1688_operations WHERE perf_connection_id=$1 ORDER BY created_at', [conn.id])).rows.map(r => r.api_name)
  assert.deepEqual(ops, ['loginid.openuid.encrypt', 'loginid.openuid.encrypt', 'loginid.openuid.encrypt', 'wangwangnick.openuid.decrypt'])

  // Own-only access: an agent sees only buyers their own sessions talked to.
  assert.equal((await app.inject({ method: 'POST', url: `${base}/buyers/${buyer}/wangwang`, headers: auth(agentUser, ['performance:read_own']), payload: {} })).statusCode, 200)
  assert.equal((await app.inject({ method: 'POST', url: `${base}/buyers/${buyer}/wangwang`, headers: auth(otherUser, ['performance:read_own']), payload: {} })).statusCode, 404)
  assert.equal((await app.inject({ method: 'POST', url: `${base}/buyers/lookup`, headers: auth(otherUser, ['performance:read_own']), payload: { connectionId: conn.id, loginId: 'buyer-one' } })).json().data, null)
  // Other tenants cannot reach the buyer; people without performance access cannot call at all.
  assert.equal((await app.inject({ method: 'POST', url: `${base}/buyers/${buyer}/wangwang`, headers: auth(boss, ['*'], tenants[1]), payload: {} })).statusCode, 404)
  assert.equal((await app.inject({ method: 'POST', url: `${base}/buyers/${buyer}/wangwang`, headers: auth(boss, ['collection:read']), payload: {} })).statusCode, 403)

  // Manual use only: after 30 decrypts in ten minutes the next is refused without calling the platform.
  const before = calls.length
  let status = 200
  for (let i = 0; i < 30 && status === 200; i++) status = (await app.inject({ method: 'POST', url: `${base}/buyers/${buyer}/wangwang`, headers: all, payload: {} })).statusCode
  assert.equal(status, 429)
  assert.equal(calls.length - before, 29, 'the refused request does not reach 1688')

  console.log(JSON.stringify({ inquiry: 'ok', lookup: 'ok', notFound: 'ok', wangwangLinks: 'ok', nothingStored: 'ok', ownScope: 'ok', isolation: 'ok', throttle: 'ok' }))
} finally {
  globalThis.fetch = originalFetch
  for (const id of tenants) { await db.query('DELETE FROM audit_logs WHERE tenant_id=$1', [id]); await db.query('DELETE FROM tenants WHERE id=$1', [id]) }
  await app.close(); await db.end()
}
