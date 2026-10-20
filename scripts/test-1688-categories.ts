import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { db } from '../server/db.js'
import { saveConnection } from '../server/integrations/1688.js'
import { categoryPath } from '../server/integrations/1688-categories.js'

// Category names from alibaba.category.get (shape observed live on 2026-10-20: {categoryInfo:[{categoryID,name,parentIDs,isLeaf}]}).
const tree: Record<string, { name: string; parent: number }> = { '9001001': { name: '座垫、座套', parent: 9001 }, '9001': { name: '汽车内饰', parent: 90 }, '90': { name: '汽车用品', parent: 0 } }
const originalFetch = globalThis.fetch
let calls = 0, fail = false
globalThis.fetch = async (input, init) => {
  const url = String(input)
  assert.ok(url.includes('/com.alibaba.product/alibaba.category.get/'), `unexpected ${url}`)
  calls++
  if (fail) return new Response('gateway down', { status: 502 })
  const id = (init!.body as URLSearchParams).get('categoryID')!
  const c = tree[id]
  return new Response(JSON.stringify(c ? { categoryInfo: [{ categoryID: Number(id), name: c.name, isLeaf: id === '9001001', parentIDs: [c.parent] }], succes: 'true' } : { categoryInfo: [], succes: 'true' }), { status: 200 })
}
const tenant = (await db.query('INSERT INTO tenants(name,slug)VALUES($1,$2)RETURNING id', ['类目测试', `cat-${randomUUID().slice(0, 8)}`])).rows[0].id
try {
  await db.query('DELETE FROM integration_1688_categories WHERE cat_id IN (9001001,9001,90,9999999)')
  const actor = (await db.query("INSERT INTO users(tenant_id,email,display_name,status)VALUES($1,$2,'t','active')RETURNING id", [tenant, `${randomUUID()}@cat.test`])).rows[0].id
  const conn = await saveConnection(tenant, actor, { aliId: `cat-${randomUUID()}`, access_token: 'fixture', expires_in: 36000 })
  assert.deepEqual(await categoryPath(conn.id, tenant, actor, '9001001'), ['汽车用品', '汽车内饰', '座垫、座套'])
  assert.equal(calls, 3)
  assert.deepEqual(await categoryPath(conn.id, tenant, actor, 9001001), ['汽车用品', '汽车内饰', '座垫、座套'])
  assert.equal(calls, 3, 'cached names are reused')
  assert.equal(await categoryPath(conn.id, tenant, actor, '9999999'), null, 'unknown category')
  fail = true
  await db.query("UPDATE integration_1688_categories SET fetched_at=now()-interval '40 days' WHERE cat_id=90")
  assert.deepEqual(await categoryPath(conn.id, tenant, actor, '9001001'), ['汽车内饰', '座垫、座套'], 'a failed lookup keeps the known part')
  console.log(JSON.stringify({ path: 'ok', cache: 'ok', unknown: 'ok', partialOnFailure: 'ok' }))
} finally {
  globalThis.fetch = originalFetch
  await db.query('DELETE FROM integration_1688_categories WHERE cat_id IN (9001001,9001,90,9999999)')
  await db.query('DELETE FROM audit_logs WHERE tenant_id=$1', [tenant]); await db.query('DELETE FROM tenants WHERE id=$1', [tenant])
  await db.end()
}
