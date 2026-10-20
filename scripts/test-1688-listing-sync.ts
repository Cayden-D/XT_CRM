import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { buildApp } from '../server/app.js'
import { db } from '../server/db.js'
import { saveConnection } from '../server/integrations/1688.js'
import { platformTime } from '../server/routes/1688.js'

// 平台商品 incremental sync against a mocked alibaba.product.list.get that honours startModifyTime/endModifyTime,
// ID order and 20-per-page paging like the platform.
const originalFetch = globalThis.fetch
const DAY = 86_400_000
const shop = new Map<string, { productID: string; subject: string; status: string; modified: number }>()
for (let i = 1; i <= 25; i++) shop.set(String(1000 + i), { productID: String(1000 + i), subject: `商品 ${i}`, status: 'published', modified: Date.now() - DAY })
const parse = (value: string) => { const m = value.match(/^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)(\d{3})\+0800$/)!; return Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${m[7]}+08:00`) }
const calls: Record<string, string>[] = []
let beforePage: ((pageNo: number) => void) | null = null
globalThis.fetch = async (input, init) => {
  const url = String(input)
  assert.ok(url.includes('alibaba.product.list.get'), `unexpected ${url}`)
  const p = Object.fromEntries((init!.body as URLSearchParams).entries())
  calls.push(p)
  const pageNo = Number(p.pageNo)
  beforePage?.(pageNo)
  const from = p.startModifyTime ? parse(p.startModifyTime) : -Infinity, to = p.endModifyTime ? parse(p.endModifyTime) : Infinity
  const matching = [...shop.values()].filter(x => x.modified >= from && x.modified <= to).sort((a, b) => Number(a.productID) - Number(b.productID))
  const resultList = matching.slice((pageNo - 1) * 20, pageNo * 20).map(({ modified, ...x }) => ({ ...x, modifyTime: platformTime(new Date(modified).toISOString()) }))
  return new Response(JSON.stringify({ result: { pageResult: { resultList, totalRecords: matching.length } } }), { status: 200 })
}

const app = await buildApp(), tenants: string[] = []
try {
  for (let i = 0; i < 2; i++) tenants.push((await db.query('INSERT INTO tenants(name,slug)VALUES($1,$2)RETURNING id', ['增量同步测试', `listing-sync-${randomUUID().slice(0, 8)}`])).rows[0].id)
  const actor = (await db.query("INSERT INTO users(tenant_id,email,password_hash,display_name,status)VALUES($1,$2,'x','测试','active')RETURNING id", [tenants[0], `${randomUUID()}@sync.test`])).rows[0].id
  const auth = (tenant = tenants[0]) => ({ authorization: `Bearer ${app.jwt.sign({ sub: actor, tenantId: tenant, email: 't', displayName: 't', roles: [], permissions: ['*'] })}` })
  const conn = await saveConnection(tenants[0], actor, { access_token: 'a', refresh_token: 'r', expires_in: 36000, aliId: `sync-${randomUUID()}`, refresh_token_timeout: '20990101000000000+0800' })
  const page = (body: object, tenant?: string) => app.inject({ method: 'POST', url: `/api/integrations/1688/connections/${conn.id}/sync`, headers: auth(tenant), payload: body })
  /** Drives a whole pass the way the browser does. */
  async function pass(mode: 'full' | 'incremental') {
    let window, total, result, count = 0
    for (let pageNo = 1; ; pageNo++) {
      const r = await page({ pageNo, mode, window, total }); assert.equal(r.statusCode, 200, r.body)
      result = r.json().data; window = result.window; total = result.total; count += result.count
      if (!result.hasMore) break
    }
    return { ...result, count }
  }
  const watermark = async () => (await db.query('SELECT listings_synced_through,listings_full_synced_at FROM integration_1688_connections WHERE id=$1', [conn.id])).rows[0]

  // 1. No completed pass yet: an incremental request reads everything (2 pages) and sets the watermark.
  const first = await pass('incremental')
  assert.deepEqual([first.mode, first.count, first.completed, calls.length], ['full', 25, true, 2])
  assert.ok(calls.every(c => !c.startModifyTime))
  const w1 = await watermark(); assert.ok(w1.listings_synced_through && w1.listings_full_synced_at)

  // 2. Two products change: the next pass asks only for the window since the watermark (minus the overlap).
  calls.length = 0
  for (const id of ['1003', '1024']) Object.assign(shop.get(id)!, { subject: `改过的 ${id}`, status: id === '1024' ? 'expired' : 'published', modified: Date.now() })
  const second = await pass('incremental')
  assert.deepEqual([second.mode, second.count, second.completed, calls.length], ['incremental', 2, true, 1])
  assert.equal(parse(calls[0].startModifyTime), new Date(w1.listings_synced_through).getTime() - 10 * 60_000)
  const rows = Object.fromEntries((await db.query('SELECT offer_id,title,status FROM integration_1688_listings WHERE connection_id=$1', [conn.id])).rows.map(r => [r.offer_id, `${r.title}/${r.status}`]))
  assert.equal(Object.keys(rows).length, 25); assert.equal(rows['1003'], '改过的 1003/published'); assert.equal(rows['1024'], '改过的 1024/expired')
  const w2 = await watermark(); assert.ok(w2.listings_synced_through > w1.listings_synced_through); assert.equal(+w2.listings_full_synced_at, +w1.listings_full_synced_at, 'incremental pass is not a full one')

  // 3. Nothing changed since: one call; only the overlap's recent changes are read again (none older).
  calls.length = 0
  for (const id of ['1003', '1024']) shop.get(id)!.modified = Date.now() - 20 * 60_000
  const idle = await pass('incremental'); assert.deepEqual([idle.count, calls.length, idle.completed], [0, 1, true])

  // 4. A product in the window is edited again mid-pass: it leaves the window, the ID pages shift and 1021 would be
  //    skipped. The total differs between pages, so the watermark stays and the same window is read again next time.
  for (const x of shop.values()) x.modified = Date.now()
  const w3 = await watermark()
  beforePage = pageNo => { if (pageNo === 2) shop.get('1001')!.modified = Date.now() + 1 }
  const shifted = await pass('incremental'); beforePage = null
  assert.equal(shifted.completed, false); assert.equal(+(await watermark()).listings_synced_through, +w3.listings_synced_through)
  await new Promise(resolve => setTimeout(resolve, 10))
  const retry = await pass('incremental'); assert.equal(retry.completed, true); assert.equal(retry.count, 25)

  // 5. A full pass re-reads everything and records itself.
  calls.length = 0
  const full = await pass('full'); assert.deepEqual([full.mode, full.count, calls.every(c => !c.startModifyTime)], ['full', 25, true])
  assert.ok((await watermark()).listings_full_synced_at > w2.listings_full_synced_at)

  // 6. Bad windows are refused before calling the platform; other tenants cannot sync this shop.
  calls.length = 0
  assert.equal((await page({ pageNo: 2, mode: 'incremental', window: { from: null, to: new Date(Date.now() + DAY).toISOString() } })).statusCode, 400)
  assert.equal((await page({ pageNo: 1, mode: 'full' }, tenants[1])).statusCode, 404)
  assert.equal(calls.length, 0)
  console.log(JSON.stringify({ firstIsFull: 'ok', incrementalWindow: 'ok', idle: 'ok', unstableKeepsWatermark: 'ok', fullPass: 'ok', guards: 'ok' }))
} finally {
  globalThis.fetch = originalFetch
  for (const id of tenants) { await db.query('DELETE FROM audit_logs WHERE tenant_id=$1', [id]); await db.query('DELETE FROM tenants WHERE id=$1', [id]) }
  await app.close(); await db.end()
}
