import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { buildApp } from '../server/app.js'
import { db } from '../server/db.js'
import { saveConnection } from '../server/integrations/1688.js'

// 产品目录: platform products are the catalogue. Everything here reads or writes local data only.
const originalFetch = globalThis.fetch
globalThis.fetch = async input => { throw new Error(`unexpected network call ${String(input)}`) }
const app = await buildApp(), marker = randomUUID().slice(0, 8), tenants: string[] = []
try {
  for (let i = 0; i < 2; i++) tenants.push((await db.query('INSERT INTO tenants(name,slug)VALUES($1,$2)RETURNING id', ['产品目录测试', `catalog-${marker}-${i}`])).rows[0].id)
  const tenant = tenants[0]
  const boss = (await db.query("INSERT INTO users(tenant_id,email,password_hash,display_name,status)VALUES($1,$2,'x','主管','active')RETURNING id", [tenant, `boss-${marker}@t.cn`])).rows[0].id
  const auth = (permissions: string[], t = tenant) => ({ authorization: `Bearer ${app.jwt.sign({ sub: boss, tenantId: t, email: 't', displayName: 't', roles: [], permissions })}` })
  const manager = auth(['product:read', 'product:create', 'product:update', 'integration:read']), rep = auth(['product:read']), stranger = auth(['customer_ops:read'])
  const call = (method: 'GET' | 'POST' | 'PUT', url: string, headers: Record<string, string>, payload?: object) => app.inject({ method, url, headers, ...(payload ? { payload } : {}) })

  const conn = await saveConnection(tenant, boss, { access_token: 'a', refresh_token: 'r', expires_in: 36000, aliId: `catalog-${marker}`, resource_owner: 'shop', refresh_token_timeout: '20991231000000000+0800' })
  const snapshot = {
    subject: '车载充气泵', categoryName: '充气泵', productCargoNumber: 'PUMP-1', referencePrice: '39.9', image: { images: ['img/ibank/a.jpg', 'https://cbu01.alicdn.com/b.jpg'] },
    saleInfo: { unit: '个', amountOnSale: 100, minOrderQuantity: 2, priceRanges: [{ startQuantity: 2, price: '45' }, { startQuantity: 10, price: '40' }] }, shippingInfo: { unitWeight: 1.5, sendGoodsAddressText: '浙江金华' },
    attributes: [{ attributeName: '功率', value: '60W' }, { attributeName: '净重', value: '1.2kg' }, { attributeName: '尺寸', value: '20*15*8cm' }],
    skuInfos: [{ specId: 's1', price: 45, amountOnSale: 60, attributes: [{ attributeDisplayName: '颜色', attributeValue: '黑' }] }, { specId: 's2', price: 42, amountOnSale: 40, attributes: [{ attributeDisplayName: '颜色', attributeValue: '白' }] }],
  }
  const listing = async (offer: string, status: string, snap: object = snapshot, title = '车载充气泵') => (await db.query(`INSERT INTO integration_1688_listings(tenant_id,connection_id,offer_id,title,status,snapshot)VALUES($1,$2,$3,$4,$5,$6)RETURNING id`, [tenant, conn.id, offer, title, status, JSON.stringify(snap)])).rows[0].id as string
  const onSale = await listing('1001', 'published')
  const expired = await listing('1002', 'member expired', { subject: '旧款', productCargoNumber: 'PUMP-1' }, '旧款')
  const gone = await listing('1003', 'deleted')

  // Reading: the product permission is enough; sales stay with those who may see shop figures.
  assert.equal((await call('GET', '/api/products/catalog', stranger)).statusCode, 403)
  const list = (await call('GET', '/api/products/catalog', rep)).json()
  assert.deepEqual([list.data.length, list.facets.on_sale, list.facets.expired, list.data[0].sales_quantity, list.data[0].package_weight_g], [1, 1, 1, null, null], 'sales hidden for someone with only the product permission')
  assert.equal((await call('GET', '/api/products/catalog', manager)).json().data[0].sales_quantity, 0)
  assert.equal((await call('GET', '/api/products/catalog', auth(['*'], tenants[1]))).json().data.length, 0, 'another tenant sees nothing')

  const detail = (await call('GET', `/api/products/catalog/listings/${onSale}`, rep)).json().data
  assert.deepEqual([detail.product, detail.listing.cargo_number, detail.listing.min_order, detail.listing.attributes.length, detail.listing.skus.length, detail.listing.images[0]], [null, 'PUMP-1', 2, 3, 2, 'https://cbu01.alicdn.com/img/ibank/a.jpg'])
  assert.deepEqual(detail.listing.skus[0], { spec_id: 's1', attributes: [{ name: '颜色', value: '黑' }], price: 45, stock: 60 })
  assert.equal((await call('GET', `/api/products/catalog/listings/${gone}`, rep)).statusCode, 404, 'deleted products are gone')
  assert.equal((await call('GET', `/api/products/catalog/listings/${onSale}`, auth(['*'], tenants[1]))).statusCode, 404)

  // Supplementing starts a CRM record, bound one-to-one; SKUs come along.
  const profile = (headers: Record<string, string>, id = onSale) => call('POST', `/api/products/catalog/listings/${id}/profile`, headers)
  assert.equal((await profile(rep)).statusCode, 403, 'viewing does not include creating')
  const started = await profile(manager)
  assert.equal(started.statusCode, 201, started.body)
  const productId = started.json().data.productId
  const product = (await db.query('SELECT sku,name,category,base_price,status,images FROM products WHERE id=$1', [productId])).rows[0]
  assert.deepEqual([product.sku, product.name, product.category, Number(product.base_price), product.status, product.images[0]], ['PUMP-1', '车载充气泵', '充气泵', 42, 'active', 'https://cbu01.alicdn.com/img/ibank/a.jpg'])
  const bound = (await db.query('SELECT product_id,sku_bindings,binding_revision FROM integration_1688_listings WHERE id=$1', [onSale])).rows[0]
  assert.deepEqual([bound.product_id, bound.sku_bindings.length, bound.binding_revision], [productId, 2, 2])
  const variants = (await db.query('SELECT id,label,attributes,unit_price,stock FROM product_variants WHERE product_id=$1 ORDER BY position', [productId])).rows
  assert.deepEqual(variants.map(v => [v.label, v.attributes, Number(v.unit_price), Number(v.stock)]), [['黑', { 颜色: '黑' }, 45, 60], ['白', { 颜色: '白' }, 42, 40]])
  assert.equal(bound.sku_bindings[0].variantId, variants[0].id)
  // Pressing it again changes nothing.
  const again = await profile(manager)
  assert.deepEqual([again.statusCode, again.json().data.productId, again.json().data.created], [200, productId, false])
  assert.equal((await db.query('SELECT count(*)::int AS n FROM products WHERE tenant_id=$1', [tenant])).rows[0].n, 1)
  // The 货号 is taken by now, so the next offer with the same one falls back to its offer id.
  const second = await profile(manager, expired)
  assert.equal((await db.query('SELECT sku FROM products WHERE id=$1', [second.json().data.productId])).rows[0].sku, '1688-1002')

  // Saving details never reaches the platform; the listing's facts and the shop's additions show side by side.
  const saved = await call('PUT', `/api/products/${productId}/attributes`, manager, { measurement: { revision: 0, package_weight_g: 1500, carton_quantity: 12 }, attributes: [{ label: '客户备注', value: '仅内部', groupName: '自定义' }] })
  assert.equal(saved.statusCode, 200, saved.body)
  const suggested = (await call('GET', `/api/products/${productId}/attributes`, manager)).json().data.suggestions
  assert.deepEqual(suggested.measurements.map((m: { field: string; value: number }) => [m.field, m.value]), [['net_weight_g', 1200], ['product_length_mm', 200], ['product_width_mm', 150], ['product_height_mm', 80]], 'what the listing states can be taken over')
  const after = (await call('GET', `/api/products/catalog/listings/${onSale}`, rep)).json().data
  assert.deepEqual([after.product.id, after.listing.attributes.length], [productId, 3])
  const listed = (await call('GET', '/api/products/catalog', manager)).json().data[0]
  assert.deepEqual([listed.package_weight_g, listed.product_sku], [1500, 'PUMP-1'])
  assert.equal((await call('GET', '/api/products/catalog?missingPackage=true', manager)).json().data.length, 0, 'filter finds the ones still missing it')
  assert.equal((await call('GET', '/api/products/catalog?group=expired&missingPackage=true', manager)).json().data.length, 1)

  // Added by hand: under 未上架, until it is on a shop.
  const manual = await call('POST', '/api/products', manager, { sku: `M-${marker}`, name: '手动产品', basePrice: 9 })
  assert.equal(manual.statusCode, 201, manual.body)
  const unlisted = () => call('GET', '/api/products?page=1&pageSize=24&unlisted=true', manager).then(r => r.json().data.map((p: { name: string }) => p.name))
  assert.deepEqual(await unlisted(), ['手动产品'], 'bound products are not listed twice')
  await db.query("UPDATE integration_1688_listings SET status='deleted' WHERE id=$1", [onSale])
  assert.ok((await unlisted()).includes('车载充气泵'), 'a product whose listing was removed comes back here, details intact')
  assert.ok((await db.query("SELECT 1 FROM audit_logs WHERE tenant_id=$1 AND action='product.catalog.profile'", [tenant])).rowCount)
  console.log(JSON.stringify({ readPermissions: 'ok', salesHidden: 'ok', detail: 'ok', profile: 'ok', idempotent: 'ok', skuFallback: 'ok', suggestions: 'ok', unlisted: 'ok', isolation: 'ok' }))
} finally {
  globalThis.fetch = originalFetch
  for (const id of tenants) {
    await db.query('DELETE FROM integration_1688_listings WHERE tenant_id=$1', [id])
    await db.query('DELETE FROM audit_logs WHERE tenant_id=$1', [id])
    await db.query('DELETE FROM tenants WHERE id=$1', [id])
  }
  await app.close(); await db.end()
}
