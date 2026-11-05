import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { buildApp } from '../server/app.js'
import { db } from '../server/db.js'
import { saveConnection } from '../server/integrations/1688.js'
import { draftProductChanges, fillFromProductData } from '../server/integrations/product-attributes.js'
import { logisticsOfferInfo, measurementAttributes, parseCsv, parseSizeMm, parseWeightGrams, specificationsOf } from '../shared/product-attributes.js'
import { validateLogistics } from '../shared/1688-logistics.js'

// Units and mapping: the three weights must not be mixed up, and what is filled must pass the platform's measurement checks.
assert.deepEqual(logisticsOfferInfo({ package_weight_g: 1500, package_length_mm: 200, package_width_mm: 305, package_height_mm: 100 }), { weight: 1500, length: 30.5, width: 20, height: 10, volume: 6100 })
assert.deepEqual(logisticsOfferInfo({ package_weight_g: 1500 }), { weight: 1500, length: 0, width: 0, height: 0, volume: 0 })
assert.equal(logisticsOfferInfo({ net_weight_g: 1200, carton_gross_weight_g: 9000, package_length_mm: 300, package_width_mm: 200, package_height_mm: 100 }), null, 'no package weight: nothing filled, and net or carton weight never stand in')
assert.equal(validateLogistics({ logisticsRequired: true }, { showLogisticsCategory: 'item', offerInfo: logisticsOfferInfo({ package_weight_g: 1500, package_length_mm: 123, package_width_mm: 456, package_height_mm: 78 }) }).length, 0)
assert.deepEqual(measurementAttributes({ net_weight_g: 1200, package_weight_g: 1500, carton_gross_weight_g: 9000, product_length_mm: 300, product_width_mm: 200, product_height_mm: 105 }), { 净重: '1200g', 尺寸: '30×20×10.5cm' })
assert.deepEqual(specificationsOf([{ label: '功率', value: '60', unit: 'W' }, { label: '电压', value: '12V', unit: 'V' }, { label: '待确认', value: 'x', confirmed_at: null }], null), { 功率: '60W', 电压: '12V' })
for (const [text, grams] of [['1.2kg', 1200], ['500克', 500], ['1公斤', 1000], ['2斤', 1000], ['500', null], ['约1kg', null], ['0g', null]] as const) assert.equal(parseWeightGrams(text), grams, text)
assert.deepEqual(parseSizeMm('30*20*10cm'), [300, 200, 100]); assert.deepEqual(parseSizeMm('300x200x100mm'), [300, 200, 100]); assert.equal(parseSizeMm('30*20*10'), null); assert.equal(parseSizeMm('30*20cm'), null)
assert.deepEqual(parseCsv('﻿SKU,"名称,含逗号",备注\r\nA,"他说""好""",\'=1+1\r\n\r\n,,\r\n'), [['SKU', '名称,含逗号', '备注'], ['A', '他说"好"', '=1+1']])

const schema = { global: { systemParam: { catId: '1' } }, data: {
  catProp: { fields: { dataSource: [
    { name: 'p_net', label: '净重', uiType: 'input' }, { name: 'p_size', label: '外形尺寸', uiType: 'input' }, { name: 'p_power', label: '额定功率', uiType: 'input' },
    { name: 'p_type', label: '类型', uiType: 'select', dataSource: [{ value: 1, text: '车载' }, { value: 2, text: '家用' }] }, { name: 'p_ro', label: '材质', uiType: 'input', readonly: true },
  ] } },
  officialLogistics: { fields: { logisticsRequired: true, value: { showLogisticsCategory: 'item', measuredImageVerify: false } } },
} }
const facts = { measurement: { net_weight_g: 1200, product_length_mm: 300, product_width_mm: 200, product_height_mm: 100, package_weight_g: 1500, package_length_mm: 320, package_width_mm: 220, package_height_mm: 120 },
  attributes: [{ label: '功率', value: '60W', confirmed_at: '2026-11-05' }, { label: '类型', value: '家用', confirmed_at: '2026-11-05' }, { label: '材质', value: 'ABS', confirmed_at: '2026-11-05' }, { label: '未确认', value: 'x', confirmed_at: null }] } as never
const filled = fillFromProductData(schema, { catProp: { p_power: '手填 80W' }, officialLogistics: { showLogisticsCategory: 'item', measuredImageVerify: false } }, facts)
assert.deepEqual(filled.catProp, { p_power: '手填 80W', p_net: '1200g', p_size: '30×20×10cm', p_type: { value: 2, text: '家用' } }, 'blanks filled; a value typed by hand and read-only fields are left alone')
assert.deepEqual(filled.officialLogistics, { showLogisticsCategory: 'item', measuredImageVerify: false, offerInfo: { weight: 1500, length: 32, width: 22, height: 12, volume: 8448 } })
assert.deepEqual(fillFromProductData(schema, { officialLogistics: { showLogisticsCategory: 'item', offerInfo: { weight: 999, length: 0, width: 0, height: 0, volume: 0 } } }, facts).officialLogistics.offerInfo.weight, 999, 'existing measurements are kept')
const noLogistics = fillFromProductData({ data: { catProp: schema.data.catProp, officialLogistics: { fields: { visible: false } } } }, {}, facts)
assert.equal(noLogistics.officialLogistics, undefined, 'a hidden platform field stays empty')
const changes = draftProductChanges(schema, { catProp: { p_power: '手填 80W' }, officialLogistics: { showLogisticsCategory: 'item', offerInfo: { weight: 1000, length: 0, width: 0, height: 0, volume: 0 } } }, facts)
assert.deepEqual(changes.map(c => [c.field, c.current, c.next]), [['catProp.p_net', '（空）', '1200g'], ['catProp.p_size', '（空）', '30×20×10cm'], ['catProp.p_power', '手填 80W', '60W'], ['catProp.p_type', '（空）', '家用'], ['officialLogistics', '1000g', '1500g · 32×22×12cm']])

const app = await buildApp(), marker = randomUUID().slice(0, 8), tenants: string[] = []
const originalFetch = globalThis.fetch
globalThis.fetch = async input => { throw new Error(`unexpected network call ${String(input)}`) }
try {
  for (let i = 0; i < 2; i++) tenants.push((await db.query('INSERT INTO tenants(name,slug)VALUES($1,$2)RETURNING id', ['产品属性测试', `attrs-${marker}-${i}`])).rows[0].id)
  const tenant = tenants[0]
  const boss = (await db.query("INSERT INTO users(tenant_id,email,password_hash,display_name,status)VALUES($1,$2,'x','主管','active')RETURNING id", [tenant, `boss-${marker}@t.cn`])).rows[0].id
  const auth = (permissions: string[], t = tenant) => ({ authorization: `Bearer ${app.jwt.sign({ sub: boss, tenantId: t, email: 't', displayName: 't', roles: [], permissions })}` })
  const call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: object, headers = auth(['*'])) => app.inject({ method, url, headers, ...(payload ? { payload } : {}) })

  const created = await call('POST', '/api/products', { sku: 'A-1', name: '充气泵', category: '车载', basePrice: 20, status: 'draft', specifications: { 功率: '60W', 'a:b': '冒号' } })
  assert.equal(created.statusCode, 201, created.body)
  const id = created.json().data.id
  // A PATCH leaves out what it does not name (defaults used to reset status, price and specifications).
  const patched = (await call('PATCH', `/api/products/${id}`, { name: '充气泵 Pro' })).json().data
  assert.deepEqual([patched.name, patched.status, Number(patched.base_price), patched.specifications], ['充气泵 Pro', 'draft', 20, { 功率: '60W', 'a:b': '冒号' }])

  // Products created with plain specifications are readable as attributes straight away.
  const first = (await call('GET', `/api/products/${id}/attributes`)).json().data
  assert.deepEqual(first.attributes.map((a: { label: string; source: string }) => [a.label, a.source]).sort(), [['a:b', 'legacy'], ['功率', 'legacy']])
  assert.equal(first.measurement, null)

  assert.equal((await call('PUT', `/api/products/${id}/attributes`, { attributes: [] }, auth(['product:read']))).statusCode, 403)
  assert.equal((await call('GET', `/api/products/${id}/attributes`, undefined, auth(['*'], tenants[1]))).statusCode, 404, 'another tenant cannot read it')
  assert.equal((await call('PUT', `/api/products/${id}/attributes`, { measurement: { revision: 0, package_weight_g: -5 } })).statusCode, 400)
  assert.equal((await call('PUT', `/api/products/${id}/attributes`, { attributes: [{ label: '颜色', value: '黑' }, { label: '颜色', value: '白' }] })).statusCode, 400, 'duplicate labels are refused')
  const saved = await call('PUT', `/api/products/${id}/attributes`, { measurement: { revision: 0, net_weight_g: 1200, product_length_mm: 300, product_width_mm: 200, product_height_mm: 100, package_weight_g: 1500, carton_quantity: 12 },
    attributes: [{ label: '功率', value: '60', unit: 'W', groupName: '电气参数' }, { label: '客户备注', value: '仅供内部', groupName: '自定义' }, { label: '待核实', value: 'x', confirmed: false }] })
  assert.equal(saved.statusCode, 200, saved.body)
  assert.equal(saved.json().data.measurement.revision, 1)
  assert.equal((await call('PUT', `/api/products/${id}/attributes`, { measurement: { revision: 0, net_weight_g: 1 } })).statusCode, 409, 'a stale revision is refused')
  const product = (await call('GET', `/api/products/${id}`)).json().data
  assert.deepEqual(product.specifications, { 净重: '1200g', 尺寸: '30×20×10cm', 功率: '60W', 客户备注: '仅供内部' }, 'specifications follow: confirmed values only, carton left out')
  assert.equal((await call('GET', '/api/products?page=1&missingPackage=true')).json().total, 0)

  // Suggestions from collection: nothing applied until accepted.
  await db.query(`INSERT INTO collected_products(tenant_id,source,source_product_id,source_url,title,attributes,product_id)VALUES($1,'1688','9','https://detail.1688.com/offer/9.html','采集',$2,$3)`, [tenant, JSON.stringify({ 材质: 'ABS', 功率: '80W', 产品重量: '2kg', 品牌: '详询' }), id])
  const suggestions = (await call('GET', `/api/products/${id}/attributes`)).json().data.suggestions
  assert.deepEqual(suggestions.attributes.map((a: { label: string }) => a.label), ['材质', '产品重量'], 'known labels and placeholder values are left out')

  // Attribute templates
  const def = await call('POST', '/api/products/attribute-defs', { category: '车载', label: '额定电压', unit: 'V', groupName: '电气参数', aliases: ['电压'] })
  assert.equal(def.statusCode, 201, def.body)
  assert.equal((await call('POST', '/api/products/attribute-defs', { category: '车载', label: '额定电压' })).statusCode, 409)
  assert.deepEqual((await call('GET', '/api/products/attribute-defs?category=车载')).json().data.map((d: { label: string }) => d.label), ['额定电压'])
  assert.deepEqual((await call('GET', '/api/products/attribute-defs?category=家用')).json().data, [])

  // CSV: a dry run changes nothing; a bad row blocks the whole import; export round-trips.
  await call('POST', '/api/products', { sku: 'B-2', name: '另一个', basePrice: 1 })
  const csv = 'SKU,产品名称,含包装重量(g),每箱数量,属性:材质,不认识\r\nA-1,x,1600,,ABS,1\r\nB-2,y,,24,=危险,2\r\n'
  const dry = (await call('POST', '/api/products/attributes/import', { csv, dryRun: true })).json().data
  assert.deepEqual([dry.applied, dry.products, dry.measurements, dry.attributes, dry.unknownColumns, dry.errorCount], [false, 2, 2, 2, ['不认识'], 0])
  assert.equal((await call('GET', `/api/products/${id}/attributes`)).json().data.measurement.package_weight_g, 1500)
  const bad = (await call('POST', '/api/products/attributes/import', { csv: 'SKU,净重(g)\nA-1,12.5\nNOPE,3\nA-1,4\n', dryRun: false })).json().data
  assert.deepEqual([bad.applied, bad.errors.map((e: { line: number }) => e.line)], [false, [2, 3, 4]])
  assert.equal((await call('POST', '/api/products/attributes/import', { csv: 'name\nA' })).statusCode, 400)
  const applied = (await call('POST', '/api/products/attributes/import', { csv, dryRun: false })).json().data
  assert.equal(applied.applied, true)
  const after = (await call('GET', `/api/products/${id}/attributes`)).json().data
  assert.deepEqual([after.measurement.package_weight_g, after.measurement.carton_quantity, after.measurement.net_weight_g], [1600, 12, 1200], 'an empty cell leaves the value')
  assert.equal(after.attributes.find((a: { label: string }) => a.label === '材质').value, 'ABS')
  const exported = await call('GET', '/api/products/attributes/export')
  const table = parseCsv(exported.body)
  assert.ok(table[0].includes('属性:材质') && !table[0].includes('属性:待核实'), 'unconfirmed values stay out of the export')
  const b2 = table.find(row => row[0] === 'B-2')!
  assert.equal(b2[table[0].indexOf('属性:材质')], '=危险', 'formula neutralised in the file, restored on import')
  assert.ok(exported.body.includes("'=危险"))

  // Existing draft: preview shows differences, apply takes only what was picked, a stale revision is refused.
  const connection = await saveConnection(tenant, boss, { access_token: 'a', refresh_token: 'r', expires_in: 36000, aliId: `attrs-${marker}`, resource_owner: 'shop', refresh_token_timeout: '20991231000000000+0800' })
  const body = { global: schema.global, formValues: { title: '标题', catProp: {}, officialLogistics: { showLogisticsCategory: 'item', offerInfo: { weight: 1000, length: 0, width: 0, height: 0, volume: 0 } } } }
  const draft = (await db.query("INSERT INTO integration_1688_publish_drafts(tenant_id,connection_id,product_id,cat_id,scene,platform_schema,data_body,created_by)VALUES($1,$2,$3,'1','cbu',$4,$5,$6)RETURNING id,revision", [tenant, connection.id, id, JSON.stringify(schema), JSON.stringify(body), boss])).rows[0]
  const base = `/api/integrations/1688/drafts/${draft.id}/product-attributes`
  assert.equal((await call('POST', `${base}/preview`, {}, auth(['integration:read', 'product:read']))).statusCode, 403)
  const preview = (await call('POST', `${base}/preview`, {})).json().data
  assert.deepEqual(preview.changes.find((c: { field: string }) => c.field === 'officialLogistics'), { field: 'officialLogistics', label: '件重尺（含包装）', current: '1000g', next: '1600g' })
  assert.ok(!('value' in preview.changes[0]))
  assert.equal((await db.query('SELECT revision FROM integration_1688_publish_drafts WHERE id=$1', [draft.id])).rows[0].revision, draft.revision, 'preview changes nothing')
  assert.equal((await call('POST', `${base}/apply`, { revision: draft.revision + 5, fields: ['officialLogistics'] })).statusCode, 409)
  const done = await call('POST', `${base}/apply`, { revision: draft.revision, fields: ['officialLogistics'] })
  assert.equal(done.statusCode, 200, done.body)
  assert.equal(done.json().data.data_body.formValues.officialLogistics.offerInfo.weight, 1600)
  assert.deepEqual(done.json().data.data_body.formValues.catProp, {}, 'fields not picked stay as they were')
  await db.query("UPDATE integration_1688_publish_drafts SET status='published' WHERE id=$1", [draft.id])
  assert.equal((await call('POST', `${base}/apply`, { revision: draft.revision + 1, fields: ['catProp.p_net'] })).statusCode, 409, 'a published draft cannot change')
  console.log(JSON.stringify({ units: 'ok', mapping: 'ok', partialPatch: 'ok', backfill: 'ok', conflicts: 'ok', isolation: 'ok', suggestions: 'ok', templates: 'ok', csv: 'ok', draftPreviewApply: 'ok' }))
} finally {
  globalThis.fetch = originalFetch
  for (const id of tenants) {
    await db.query('DELETE FROM integration_1688_publish_drafts WHERE tenant_id=$1', [id])
    await db.query('DELETE FROM audit_logs WHERE tenant_id=$1', [id])
    await db.query('DELETE FROM tenants WHERE id=$1', [id])
  }
  await app.close(); await db.end()
}
