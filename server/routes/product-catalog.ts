import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { hasPermission, requireAuth, requirePermission } from '../auth.js'
import { db } from '../db.js'
import { IntegrationError } from '../integrations/1688.js'
import { platformSkus } from '../integrations/1688-comparison.js'
import { catalogListQuery, queryCatalog } from './1688-catalog.js'

type Json = Record<string, any>
const idParams = z.object({ id: z.string().uuid() })
const tenant = (request: FastifyRequest) => request.authUser.tenantId
const imageUrl = (value: string) => value.startsWith('img/') ? `https://cbu01.alicdn.com/${value}` : value
const asArray = (value: unknown): Json[] => Array.isArray(value) ? value : []
const NUMBER = /^[0-9]+(\.[0-9]+)?$/

/** The catalogue is for looking products up, so either the product or the shop permission opens it. */
async function requireCatalogRead(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply)
  if (reply.sent) return
  if (!hasPermission(request.authUser.permissions, 'product:read') && !hasPermission(request.authUser.permissions, 'integration:read')) return reply.code(403).send({ error: 'FORBIDDEN', message: '当前账号没有查看产品目录的权限。' })
}
/** Sales belong to the people who may see shop or performance figures. */
const canSeeSales = (request: FastifyRequest) => ['integration:read', 'performance:read'].some(name => hasPermission(request.authUser.permissions, name))

const skuAttributes = (sku: Json) => asArray(sku.attributes).map(a => ({ name: String(a.attributeDisplayName ?? a.attributeName ?? '').trim(), value: String(a.attributeValue ?? a.customValueName ?? '').trim() })).filter(a => a.name && a.value)
function listingView(row: Json) {
  const info = (row.snapshot ?? {}) as Json
  const images = asArray(info.image?.images).map(String)
  return {
    id: row.id, connection_id: row.connection_id, shop: row.shop, offer_id: row.offer_id, title: row.title, status: row.status, image_url: row.image_url, synced_at: row.synced_at, product_id: row.product_id, binding_revision: row.binding_revision,
    images: images.map(imageUrl), category: info.categoryName ?? null, cargo_number: info.productCargoNumber ?? null, unit: info.saleInfo?.unit ?? null, stock: info.saleInfo?.amountOnSale ?? null, min_order: info.saleInfo?.minOrderQuantity ?? null,
    price_ranges: asArray(info.saleInfo?.priceRanges).map(p => ({ start: p.startQuantity ?? null, price: p.price ?? null })), reference_price: info.referencePrice ?? null,
    unit_weight: info.shippingInfo?.unitWeight ?? null, send_address: info.shippingInfo?.sendGoodsAddressText ?? null,
    attributes: asArray(info.attributes).map(a => ({ name: String(a.attributeName ?? '').trim(), value: String(a.value ?? a.attributeValue ?? '').trim() })).filter(a => a.name && a.value),
    skus: asArray(info.skuInfos).map(s => ({ spec_id: s.specId ?? null, attributes: skuAttributes(s), price: s.price ?? s.consignPrice ?? null, stock: s.amountOnSale ?? null })),
  }
}

export async function productCatalogRoutes(app: FastifyInstance) {
  app.get('/catalog', { preHandler: requireCatalogRead }, async request => {
    const q = catalogListQuery.parse(request.query)
    const result = await queryCatalog(tenant(request), q)
    const sales = canSeeSales(request)
    return { ...result, data: result.data.map(row => sales ? row : { ...row, sales_quantity: null, sales_amount: null, sales_orders: null }) }
  })

  // One platform product: what 1688 says (read-only, from the last sync) next to what the shop adds.
  app.get('/catalog/listings/:id', { preHandler: requireCatalogRead }, async request => {
    const { id } = idParams.parse(request.params)
    const row = (await db.query(`SELECT l.*,c.display_name AS shop FROM integration_1688_listings l JOIN integration_1688_connections c ON c.id=l.connection_id WHERE l.id=$1 AND l.tenant_id=$2 AND l.status<>'deleted' AND coalesce(l.deletion_state,'') NOT IN ('deleted','deleting')`, [id, tenant(request)])).rows[0]
    if (!row) throw new IntegrationError('NOT_FOUND', '平台商品不存在。', 404)
    const product = row.product_id ? (await db.query('SELECT id,sku,name,category,status FROM products WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL', [row.product_id, tenant(request)])).rows[0] ?? null : null
    return { data: { listing: listingView(row), product } }
  })

  /**
   * Starts the CRM record for a platform product, so its details can be added to. Local only: nothing changes on 1688.
   * The product takes its name, price and SKUs from the snapshot and is bound one-to-one, under the same lock as manual binding.
   */
  app.post('/catalog/listings/:id/profile', { preHandler: requirePermission('product:create') }, async (request, reply) => {
    const { id } = idParams.parse(request.params)
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      const identity = (await client.query('SELECT connection_id FROM integration_1688_listings WHERE id=$1 AND tenant_id=$2', [id, tenant(request)])).rows[0]
      if (!identity) throw new IntegrationError('NOT_FOUND', '平台商品不存在。', 404)
      await client.query('SELECT id FROM integration_1688_connections WHERE id=$1 AND tenant_id=$2 FOR UPDATE', [identity.connection_id, tenant(request)])
      const listing = (await client.query(`SELECT * FROM integration_1688_listings WHERE id=$1 AND tenant_id=$2 AND status<>'deleted' AND coalesce(deletion_state,'') NOT IN ('deleted','deleting') FOR UPDATE`, [id, tenant(request)])).rows[0]
      if (!listing) throw new IntegrationError('NOT_FOUND', '平台商品不存在。', 404)
      if (listing.product_id) { await client.query('COMMIT'); return reply.send({ data: { productId: listing.product_id, created: false } }) }
      const info = (listing.snapshot ?? {}) as Json
      const skus = platformSkus(info) as { specId: string | null }[]
      const rawSkus = asArray(info.skuInfos)
      // Same order as the catalogue card: SKU prices, else the price ladder, else the reference price.
      const numbers = (values: unknown[]) => values.map(v => String(v ?? '')).filter(v => NUMBER.test(v)).map(Number)
      const prices = [numbers(rawSkus.map(s => s.price ?? s.consignPrice)), numbers(asArray(info.saleInfo?.priceRanges).map(p => p.price)), numbers([info.referencePrice])].find(list => list.length) ?? []
      const cargo = String(info.productCargoNumber ?? '').trim().slice(0, 80), fallback = `1688-${listing.offer_id}`
      const taken = new Set((await client.query('SELECT sku FROM products WHERE tenant_id=$1 AND sku=ANY($2::text[])', [tenant(request), [cargo, fallback].filter(Boolean)])).rows.map(r => r.sku))
      // A seller's 货号 is the natural SKU, unless another product already uses it.
      const sku = cargo && !taken.has(cargo) ? cargo : fallback
      if (taken.has(sku)) throw new IntegrationError('SKU_TAKEN', `SKU ${sku} 已被占用，请在“未上架”中修改或手动关联。`, 409)
      const images = asArray(info.image?.images).map(v => imageUrl(String(v)))
      const product = (await client.query(`INSERT INTO products(tenant_id,sku,name,category,base_price,base_currency,status,images)VALUES($1,$2,$3,$4,$5,'CNY','active',$6)RETURNING id`,
        [tenant(request), sku, String(listing.title || listing.offer_id).slice(0, 200), info.categoryName ? String(info.categoryName).slice(0, 120) : null, prices.length ? Math.min(...prices) : 0, JSON.stringify(images)])).rows[0]
      const bindings: { specId: string; variantId: string }[] = []
      for (const [position, raw] of rawSkus.entries()) {
        const attributes = Object.fromEntries(skuAttributes(raw).map(a => [a.name, a.value]))
        const price = String(raw.price ?? raw.consignPrice ?? '')
        const variant = (await client.query('INSERT INTO product_variants(tenant_id,product_id,position,label,attributes,unit_price,stock)VALUES($1,$2,$3,$4,$5,$6,$7)RETURNING id',
          [tenant(request), product.id, position, Object.values(attributes).join(' / ') || String(raw.specId ?? position + 1), JSON.stringify(attributes), NUMBER.test(price) ? Number(price) : 0, Number.isFinite(Number(raw.amountOnSale)) ? Number(raw.amountOnSale) : 0])).rows[0]
        if (raw.specId && skus.some(s => s.specId === raw.specId)) bindings.push({ specId: String(raw.specId), variantId: variant.id })
      }
      await client.query('UPDATE integration_1688_listings SET product_id=$3,sku_bindings=$4::jsonb,binding_revision=binding_revision+1 WHERE id=$1 AND tenant_id=$2', [id, tenant(request), product.id, JSON.stringify(bindings)])
      await client.query("INSERT INTO audit_logs(tenant_id,actor_id,action,entity_type,entity_id,after_data,request_id)VALUES($1,$2,'product.catalog.profile','product',$3,$4,$5)", [tenant(request), request.authUser.sub, product.id, JSON.stringify({ listingId: id, offerId: listing.offer_id, sku }), request.id])
      await client.query('COMMIT')
      return reply.code(201).send({ data: { productId: product.id, created: true } })
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  })
}
