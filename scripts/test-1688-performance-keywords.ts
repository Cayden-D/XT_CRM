import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { buildApp } from '../server/app.js'
import { db } from '../server/db.js'
import { saveConnection } from '../server/integrations/1688.js'

// 关键词库 against a mocked 1688 keyword API (shapes as observed live on 2026-10-16: an empty list returns only
// {success:"true"}; add/delete return {success:true,message:"OK"}).
const originalFetch = globalThis.fetch
const platform = new Set<string>(), calls: string[] = []
let failAdd: string | null = null, qosOnAdd = false
const reply = (data: unknown) => new Response(JSON.stringify(data), { status: 200 })
globalThis.fetch = async (input, init) => {
  const url = String(input)
  assert.ok(url.startsWith('https://gw.open.1688.com/openapi/'), 'unexpected network destination')
  const flat = Object.fromEntries((init!.body as URLSearchParams).entries())
  const api = url.split('/')[url.split('/').length - 2]
  calls.push(`${api}:${flat.word ?? ''}`)
  if (api === 'wangwang.keyword.query.list') return reply(platform.size ? { result: { success: 'true', data: { words: [...platform] } } } : { result: { success: 'true' } })
  if (api === 'wangwang.keyword.add') {
    if (qosOnAdd) return reply({ error_code: 'gw.QosAppFrequencyLimit', error_message: 'App call limited' })
    if (flat.word === failAdd) return reply({ result: { success: false, code: 'WORD_INVALID', message: '关键词不合法' } })
    platform.add(flat.word); return reply({ result: { success: true, message: 'OK' } })
  }
  if (api === 'wangwang.keyword.delete') { platform.delete(flat.word); return reply({ result: { success: true, message: 'OK' } }) }
  throw new Error(`Unmocked API ${url}`)
}

const marker = randomUUID(), tenantIds: string[] = []
const app = await buildApp()
const today = new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10)
try {
  for (let i = 0; i < 2; i++) tenantIds.push((await db.query('INSERT INTO tenants(name,slug)VALUES($1,$2)RETURNING id', ['keyword test', `test-perf-keywords-${marker}-${i}`])).rows[0].id)
  const tenantId = tenantIds[0]
  const user = async (name: string) => (await db.query("INSERT INTO users(tenant_id,email,password_hash,display_name,status)VALUES($1,$2,'unused',$3,'active')RETURNING id", [tenantId, `${name}-${marker}@integration.local`, name])).rows[0].id as string
  const [admin, staff] = [await user('店长'), await user('客服')]
  const auth = (sub: string, permissions: string[], tenant = tenantId) => ({ authorization: `Bearer ${app.jwt.sign({ sub, tenantId: tenant, email: 't', displayName: 't', roles: [], permissions })}` })
  const all = auth(admin, ['*'])
  const base = '/api/integrations/1688/performance'
  const send = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object, headers = all) => app.inject({ method, url: `${base}${url}`, headers, ...(payload ? { payload } : {}) })
  const conn = await saveConnection(tenantId, admin, { access_token: 'kw-access', refresh_token: 'kw-refresh', expires_in: 36000, aliId: `kw-${marker}`, resource_owner: 'shop', refresh_token_timeout: '20990101000000000+0800' }, Date.now(), 'performance')
  const cid = conn.id

  // Presets and empty library.
  const empty = (await send('GET', `/keywords?connectionId=${cid}`)).json()
  assert.deepEqual(empty.data, []); assert.ok(empty.presets.some((p: { category: string }) => p.category === '售后退款'))

  // Adding: words go to 1688 one by one, duplicates and existing words are skipped, a rejected word is reported.
  failAdd = '坏词'
  const added = (await send('POST', '/keywords', { connectionId: cid, words: [{ word: '退款', category: '售后退款' }, { word: '退款', category: '售后退款' }, { word: '差评', category: '投诉差评' }, { word: '坏词', category: '其他' }] })).json().data
  assert.deepEqual([added.added, added.skipped, added.failed.map((f: { word: string }) => f.word)], [['退款', '差评'], [], ['坏词']])
  assert.deepEqual([...platform].sort(), ['差评', '退款']); assert.equal(added.keywords.length, 2)
  assert.deepEqual((await send('POST', '/keywords', { connectionId: cid, words: [{ word: '退款', category: '售后退款' }] })).json().data.skipped, ['退款'])
  assert.equal((await send('POST', '/keywords', { connectionId: cid, words: [{ word: '退 款', category: '其他' }] })).statusCode, 400, 'no spaces')
  assert.equal((await send('POST', '/keywords', { connectionId: cid, words: [{ word: 'x'.repeat(21), category: '其他' }] })).statusCode, 400, 'at most 20 characters')
  // A shop-level failure (quota) stops the batch instead of failing every word the same way.
  failAdd = null; qosOnAdd = true; calls.length = 0
  const throttled = (await send('POST', '/keywords', { connectionId: cid, words: [{ word: '发票', category: '发票' }, { word: '开票', category: '发票' }] })).json().data
  assert.deepEqual([throttled.added, throttled.failed.length, calls.filter(c => c.startsWith('wangwang.keyword.add')).length], [[], 1, 1]); qosOnAdd = false

  // Permissions: reading needs performance access, editing needs performance:manage; other tenants see nothing.
  assert.equal((await send('POST', '/keywords', { connectionId: cid, words: [{ word: '发票', category: '发票' }] }, auth(staff, ['performance:read']))).statusCode, 403)
  assert.equal((await send('GET', `/keywords?connectionId=${cid}`, undefined, auth(staff, ['performance:read_own']))).statusCode, 200)
  assert.equal((await send('GET', `/keywords?connectionId=${cid}`, undefined, auth(admin, ['*'], tenantIds[1]))).statusCode, 404)

  // Category change is local; deleting removes the word on 1688 too.
  const refund = added.keywords.find((k: { word: string }) => k.word === '退款')
  assert.equal((await send('PATCH', `/keywords/${refund.id}`, { category: '投诉差评' })).json().data.find((k: { word: string }) => k.word === '退款').category, '投诉差评')
  await send('PATCH', `/keywords/${refund.id}`, { category: '售后退款' })
  const bad = added.keywords.find((k: { word: string }) => k.word === '差评')
  assert.equal((await send('DELETE', `/keywords/${bad.id}`)).statusCode, 200); assert.deepEqual([...platform], ['退款'])
  assert.equal((await send('DELETE', `/keywords/${bad.id}`, undefined, auth(admin, ['*'], tenantIds[1]))).statusCode, 404)

  // Reconcile: words added in 1688 directly are imported as 其他; words removed there are marked, and can be deleted locally only.
  platform.add('定制'); platform.delete('退款')
  const rec = (await send('POST', '/keywords/reconcile', { connectionId: cid })).json().data
  assert.deepEqual([rec.platform, rec.imported, rec.missing], [1, 1, ['退款']])
  const after = Object.fromEntries(rec.keywords.map((k: { word: string }) => [k.word, k]))
  assert.deepEqual([after['定制'].category, after['定制'].on_platform, after['退款'].on_platform], ['其他', true, false])
  calls.length = 0
  await send('DELETE', `/keywords/${after['退款'].id}`)
  assert.equal(calls.length, 0, 'a word already gone from 1688 is removed locally without a platform call')
  await send('POST', '/keywords', { connectionId: cid, words: [{ word: '退款', category: '售后退款' }] })

  // Hits: from the marks stored on synced messages; buyer vs agent, sessions, buyers; own scope limits to bound agents.
  const agent = (await db.query("INSERT INTO perf_agents(tenant_id,connection_id,login_id,is_main,user_id) VALUES($1,$2,'shop:kefu',false,$3) RETURNING id", [tenantId, cid, staff])).rows[0].id
  const other = (await db.query("INSERT INTO perf_agents(tenant_id,connection_id,login_id,is_main) VALUES($1,$2,'shop',true) RETURNING id", [tenantId, cid])).rows[0].id
  const buyer = async (key: string) => (await db.query('INSERT INTO perf_buyers(tenant_id,connection_id,buyer_key) VALUES($1,$2,$3) RETURNING id', [tenantId, cid, key])).rows[0].id
  const [b1, b2] = [await buyer('buyer-1'), await buyer('buyer-2')]
  const session = async (agentId: string, buyerId: string, c: string) => (await db.query(`INSERT INTO perf_chat_sessions(tenant_id,connection_id,agent_id,buyer_id,cid,chat_date,last_peer_at,needs_sync) VALUES($1,$2,$3,$4,$5,$6::date,now(),false) RETURNING id`, [tenantId, cid, agentId, buyerId, c, today])).rows[0].id
  const [s1, s2] = [await session(agent, b1, 'c1'), await session(other, b2, 'c2')]
  const msg = (s: string, dir: 0 | 1, words: object[]) => db.query(`INSERT INTO perf_chat_messages(tenant_id,connection_id,session_id,uuid,direction,sent_at,keywords) VALUES($1,$2,$3,$4,$5,now(),$6)`, [tenantId, cid, s, randomUUID(), dir, JSON.stringify(words)])
  await msg(s1, 1, [{ word: '退款', count: 2 }]); await msg(s1, 0, [{ word: '退款', count: 1 }]); await msg(s2, 1, [{ word: '退款', count: 1 }, { word: '定制', count: 1 }]); await msg(s2, 1, [])
  const hits = (await send('GET', `/keywords/hits?connectionId=${cid}&from=${today}&to=${today}`)).json().data
  const byWord = Object.fromEntries(hits.words.map((h: { word: string }) => [h.word, h]))
  assert.deepEqual([byWord['退款'].buyer_hits, byWord['退款'].agent_hits, byWord['退款'].sessions, byWord['退款'].buyers, byWord['退款'].category], [3, 1, 2, 2, '售后退款'])
  assert.deepEqual([byWord['定制'].buyer_hits, byWord['定制'].category], [1, '其他']); assert.equal(hits.recent.length, 4)
  const own = (await send('GET', `/keywords/hits?connectionId=${cid}&from=${today}&to=${today}`, undefined, auth(staff, ['performance:read_own']))).json().data
  assert.deepEqual(own.words.map((h: { word: string; buyer_hits: number }) => [h.word, h.buyer_hits]), [['退款', 2]], 'own scope: only sessions of the bound agent')

  // Dashboard: sessions where a buyer hit an after-sales/complaint word.
  await db.query("UPDATE integration_1688_perf_connections SET status='connected' WHERE id=$1", [cid])
  const dash = (await app.inject({ method: 'GET', url: `/api/dashboard?range=today&connectionId=${cid}`, headers: all })).json().data
  assert.equal(dash.service.keywordAlerts, 2)

  console.log(JSON.stringify({ addSkipFail: 'ok', quotaStopsBatch: 'ok', validation: 'ok', permissions: 'ok', categories: 'ok', deleteOnPlatform: 'ok', reconcile: 'ok', hits: 'ok', ownScope: 'ok', dashboardAlert: 'ok', isolation: 'ok' }))
} finally {
  globalThis.fetch = originalFetch
  for (const id of tenantIds) { await db.query('DELETE FROM audit_logs WHERE tenant_id=$1', [id]); await db.query('DELETE FROM tenants WHERE id=$1', [id]) }
  await app.close(); await db.end()
}
