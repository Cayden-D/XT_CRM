import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { buildApp } from '../server/app.js'
import { db } from '../server/db.js'
import { saveConnection } from '../server/integrations/1688.js'

// Paginated catalogue lists behind 产品目录 and 1688 商品采集: pages, facet counts, filters, search escaping, isolation.
const originalFetch = globalThis.fetch
globalThis.fetch = async () => { throw new Error('no network in this suite') }
const marker = randomUUID(), tenantIds: string[] = []
const app = await buildApp()

try {
  for (let i = 0; i < 2; i++) tenantIds.push((await db.query('INSERT INTO tenants(name,slug)VALUES($1,$2)RETURNING id', ['catalog test', `test-catalog-${marker}-${i}`])).rows[0].id)
  const tenantId = tenantIds[0]
  const admin = (await db.query("INSERT INTO users(tenant_id,email,password_hash,display_name,status)VALUES($1,$2,'unused','采集员','active')RETURNING id", [tenantId, `catalog-${marker}@integration.local`])).rows[0].id
  const auth = (tenant = tenantId) => ({ authorization: `Bearer ${app.jwt.sign({ sub: admin, tenantId: tenant, email: 't', displayName: 't', roles: [], permissions: ['*'] })}` })
  const get = async (url: string, tenant = tenantId) => { const r = await app.inject({ method: 'GET', url, headers: auth(tenant) }); assert.equal(r.statusCode, 200, r.body); return r.json() }

  // 30 products: 20 active (10 in 汽车用品), 6 draft, 4 inactive; one name contains a literal "%".
  for (let i = 0; i < 30; i++) {
    const status = i < 20 ? 'active' : i < 26 ? 'draft' : 'inactive'
    await db.query(`INSERT INTO products(tenant_id,sku,name,category,status,base_price,images,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,now()-make_interval(mins=>$8))`,
      [tenantId, `SKU-${i}`, i === 3 ? '折扣 100% 纯棉' : `产品 ${i}`, i < 10 ? '汽车用品' : '家居', status, 10 + i, JSON.stringify([`https://img.example/${i}.jpg`]), i])
  }
  const page1 = await get('/api/products?page=1&pageSize=12')
  assert.deepEqual([page1.data.length, page1.total, page1.page, page1.pageSize], [12, 30, 1, 12])
  assert.deepEqual(page1.facets, { all: 30, active: 20, draft: 6, inactive: 4 }); assert.deepEqual(page1.categories, ['家居', '汽车用品'])
  assert.equal(page1.data[0].sku, 'SKU-0', 'most recently updated first'); assert.deepEqual(page1.data[0].images, ['https://img.example/0.jpg'])
  const page3 = await get('/api/products?page=3&pageSize=12'); assert.equal(page3.data.length, 6)
  const ids = new Set([...page1.data, ...(await get('/api/products?page=2&pageSize=12')).data, ...page3.data].map((p: { id: string }) => p.id)); assert.equal(ids.size, 30, 'pages do not overlap')
  const drafts = await get('/api/products?page=1&status=draft'); assert.equal(drafts.total, 6); assert.equal(drafts.facets.all, 30, 'status counts ignore the status filter')
  const cars = await get(`/api/products?page=1&category=${encodeURIComponent('汽车用品')}&status=active`); assert.equal(cars.total, 10); assert.deepEqual(cars.facets, { all: 10, active: 10, draft: 0, inactive: 0 })
  assert.equal((await get('/api/products?page=9&pageSize=12')).total, 30, 'a page past the end still reports the total')
  assert.equal((await get(`/api/products?page=1&search=${encodeURIComponent('100%')}`)).total, 1, '% is matched literally')
  assert.equal((await get('/api/products')).data.length, 30, 'without page the whole catalogue is returned for pickers')
  assert.equal((await get('/api/products?page=1', tenantIds[1])).total, 0)
  assert.equal((await app.inject({ method: 'GET', url: '/api/products?page=1&pageSize=500', headers: auth() })).statusCode, 400)

  // Collections in every stage.
  const shop = await saveConnection(tenantId, admin, { access_token: 'c', refresh_token: 'c', expires_in: 36000, aliId: `catalog-${marker}`, resource_owner: 'shop', refresh_token_timeout: '20990101000000000+0800' }, Date.now(), 'product')
  const productId = page1.data[5].id
  const stages: [string, string | null, boolean][] = [['pending', null, false], ['pending', 'cancelled', false], ['queue', 'queued', false], ['queue', 'processing', false], ['attention', 'blocked', false], ['attention', 'unknown', false], ['promoted', null, true], ['published', 'published', true]]
  for (const [i, [, queue, promoted]] of stages.entries()) {
    const id = (await db.query(`INSERT INTO collected_products(tenant_id,source,source_product_id,source_url,title,main_image_url,collected_by,product_id,collected_at) VALUES($1,'1688',$2,'https://detail.1688.com/x',$3,$4,$5,$6,now()-make_interval(mins=>$7)) RETURNING id`,
      [tenantId, `${900 + i}`, i === 1 ? '车载 50%off 充气泵' : `采集 ${i}`, `https://img.example/c${i}.jpg`, admin, promoted ? productId : null, i])).rows[0].id
    await db.query(`INSERT INTO collected_product_variants(tenant_id,collected_product_id,position,label,price) VALUES($1,$2,0,'黑',${10 + i}),($1,$2,1,'白',${20 + i})`, [tenantId, id])
    if (queue) await db.query(`INSERT INTO integration_1688_collection_queue_jobs(tenant_id,connection_id,collected_product_id,source_updated_at,status,message) VALUES($1,$2,$3,now(),$4,$5)`, [tenantId, shop.id, id, queue, queue === 'blocked' ? '来源类目 ID 缺失' : null])
  }
  const all = await get('/api/product-collections?page=1&pageSize=5')
  assert.deepEqual(all.facets, { all: 8, pending: 2, queue: 2, attention: 2, promoted: 1, published: 1 })
  assert.deepEqual([all.data.length, all.total], [5, 8]); assert.equal(all.data[0].title, '采集 0', 'newest first')
  const card = all.data[0]
  assert.deepEqual([card.variant_count, Number(card.min_price), Number(card.max_price), card.collector_name, card.stage], [2, 10, 20, '采集员', 'pending'])
  assert.equal(card.raw_data, undefined, 'raw snapshots are not sent to the cards')
  const attention = await get('/api/product-collections?stage=attention'); assert.equal(attention.total, 2); assert.equal(attention.facets.all, 8)
  assert.ok(attention.data.some((c: { queue_message: string | null }) => c.queue_message === '来源类目 ID 缺失'))
  assert.deepEqual((await get('/api/product-collections?stage=published')).data.map((c: { title: string }) => c.title), ['采集 7'], 'published wins over promoted')
  assert.equal((await get('/api/product-collections?page=2&pageSize=5')).data.length, 3)
  assert.equal((await get(`/api/product-collections?search=${encodeURIComponent('50%')}`)).total, 1)
  assert.equal((await get('/api/product-collections?source=alibaba')).total, 0)
  assert.equal((await get('/api/product-collections', tenantIds[1])).total, 0)

  // 产品目录 platform view: offers from synced listings, price/stock/SKU from the snapshot, 30-day sales from orders.
  const snap = (sku: number[], extra: object = {}) => JSON.stringify({ categoryName: '车用吸尘器', productCargoNumber: `HH-${sku.length}`, lastUpdateTime: `2026091${sku.length}000000000+0800`,
    saleInfo: { unit: '台', amountOnSale: 500 }, skuInfos: sku.map((price, i) => ({ specId: `s${i}`, price, amountOnSale: 10, attributes: [{ attributeValue: `款${i}` }] })), ...extra })
  const listing = (offer: string, status: string, snapshot: string, deletion = 'active') => db.query(`INSERT INTO integration_1688_listings(tenant_id,connection_id,offer_id,title,status,image_url,snapshot,deletion_state) VALUES($1,$2,$3,$4,$5,'img/ibank/x.jpg',$6,$7)`,
    [tenantId, shop.id, offer, `吸尘器 ${offer}`, status, snapshot, deletion])
  await listing('1001', 'published', snap([59, 88, 72]))
  await listing('1002', 'published', snap([], { saleInfo: { unit: '个', amountOnSale: 9, priceRanges: [{ price: 12.5, startQuantity: 1 }, { price: 9.9, startQuantity: 100 }] } }))
  await listing('1003', 'published', snap([], { saleInfo: {}, referencePrice: '30.0', categoryName: '车载香薰' }))
  await listing('1004', 'member expired', snap([5]))
  await listing('1005', 'deleted', snap([5]))
  await listing('1006', 'published', snap([5]), 'deleted')
  const perf = await saveConnection(tenantId, admin, { access_token: 'p', refresh_token: 'p', expires_in: 36000, aliId: `catalog-perf-${marker}`, resource_owner: 'shop', refresh_token_timeout: '20990101000000000+0800' }, Date.now(), 'performance')
  const order = (id: string, items: object[], paidDaysAgo: number | null) => db.query(`INSERT INTO perf_orders(tenant_id,connection_id,order_id,buyer_open_uid,status,total_amount,placed_at,paid_at,items) VALUES($1,$2,$3,'b','success',1,now(),$4,$5)`,
    [tenantId, perf.id, id, paidDaysAgo == null ? null : new Date(Date.now() - paidDaysAgo * 86_400_000), JSON.stringify(items)])
  await order('9001', [{ productId: '1002', quantity: 5, amount: 62.5 }, { productId: '1001', quantity: 1, amount: 59 }], 2)
  await order('9002', [{ productId: '1002', quantity: 3, amount: 37.5 }], 10)
  await order('9003', [{ productId: '1002', quantity: 99, amount: 999 }], 40)
  await order('9004', [{ productId: '1001', quantity: 50, amount: 999 }], null)
  const catalog = async (query = '') => get(`/api/integrations/1688/catalog?pageSize=10${query}`)
  const onSale = await catalog()
  assert.deepEqual(onSale.facets, { on_sale: 3, expired: 1, other: 0 }, 'deleted offers are hidden'); assert.equal(onSale.total, 3)
  const byOffer = Object.fromEntries(onSale.data.map((r: { offer_id: string }) => [r.offer_id, r]))
  assert.deepEqual([byOffer['1001'].price_min, byOffer['1001'].price_max, byOffer['1001'].sku_count, byOffer['1001'].stock], [59, 88, 3, 500], 'SKU prices')
  assert.deepEqual([byOffer['1002'].price_min, byOffer['1002'].price_max, byOffer['1002'].unit], [9.9, 12.5, '个'], 'price ladder')
  assert.deepEqual([byOffer['1003'].price_min, byOffer['1003'].stock], [30, null], 'reference price')
  assert.deepEqual([byOffer['1002'].sales_quantity, byOffer['1002'].sales_amount, byOffer['1002'].sales_orders], [8, 100, 2], 'only paid orders of the last 30 days')
  assert.deepEqual([byOffer['1001'].sales_quantity, byOffer['1001'].category, byOffer['1001'].cargo_number], [1, '车用吸尘器', 'HH-3'])
  assert.deepEqual((await catalog('&sort=sales')).data.map((r: { offer_id: string }) => r.offer_id), ['1002', '1001', '1003'])
  assert.deepEqual((await catalog('&sort=price_asc')).data.map((r: { offer_id: string }) => r.offer_id), ['1002', '1003', '1001'])
  assert.deepEqual((await catalog('&group=expired')).data.map((r: { offer_id: string }) => r.offer_id), ['1004'])
  assert.deepEqual((await catalog('&search=HH-3')).data.map((r: { offer_id: string }) => r.offer_id), ['1001'], 'search by 货号')
  assert.equal((await catalog('&search=1003')).total, 1, 'search by offer id')
  // Filter by product type (the offer's 1688 category); the choices ignore the chosen type and count each one.
  assert.deepEqual(onSale.categories, [{ name: '车用吸尘器', count: 2 }, { name: '车载香薰', count: 1 }])
  const fragrance = await catalog(`&category=${encodeURIComponent('车载香薰')}`)
  assert.deepEqual([fragrance.total, fragrance.data.map((r: { offer_id: string }) => r.offer_id), fragrance.categories.length], [1, ['1003'], 2])
  const expired = await catalog(`&category=${encodeURIComponent('车用吸尘器')}&group=expired`)
  assert.deepEqual([expired.total, expired.categories], [1, [{ name: '车用吸尘器', count: 1 }]], 'counts follow the tab')
  assert.ok(onSale.shops.some((s: { id: string }) => s.id === shop.id))
  assert.equal((await get('/api/integrations/1688/catalog', tenantIds[1])).total, 0)
  const noRead = await app.inject({ method: 'GET', url: '/api/integrations/1688/catalog', headers: { authorization: `Bearer ${app.jwt.sign({ sub: admin, tenantId, email: 't', displayName: 't', roles: [], permissions: ['product:read'] })}` } })
  assert.equal(noRead.statusCode, 403)

  console.log(JSON.stringify({ platformCatalog: 'ok', categoryFilter: 'ok', catalogSales: 'ok', productPages: 'ok', productFacets: 'ok', pickerUnpaged: 'ok', collectionPages: 'ok', collectionStages: 'ok', literalSearch: 'ok', slimCards: 'ok', isolation: 'ok' }))
} finally {
  globalThis.fetch = originalFetch
  for (const id of tenantIds) { await db.query('DELETE FROM audit_logs WHERE tenant_id=$1', [id]); await db.query('DELETE FROM tenants WHERE id=$1', [id]) }
  await app.close(); await db.end()
}
