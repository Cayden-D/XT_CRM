import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requirePermission } from '../auth.js'
import { db } from '../db.js'

/**
 * 产品目录: the shop's offers as last synced from the 1688 product app (integration_1688_listings), with price, stock and
 * SKU figures read from the stored snapshot and 30-day sales matched from synced orders by offer id. Reads local data only.
 */
const groups = {
  on_sale: `l.status='published'`,
  expired: `l.status ILIKE '%expired%'`,
  other: `l.status<>'published' AND l.status NOT ILIKE '%expired%'`,
} as const
const sorts = {
  recent: `coalesce(l.snapshot->>'lastUpdateTime',l.snapshot->>'approvedTime','') DESC,l.offer_id DESC`,
  sales: 'coalesce(s.quantity,0) DESC,coalesce(s.amount,0) DESC,l.offer_id DESC',
  price_asc: 'price_min ASC NULLS LAST,l.offer_id',
  price_desc: 'price_min DESC NULLS LAST,l.offer_id',
  stock: 'stock ASC NULLS LAST,l.offer_id',
} as const
export const catalogListQuery = z.object({
  connectionId: z.string().uuid().optional(), group: z.enum(['on_sale', 'expired', 'other']).default('on_sale'), search: z.string().trim().max(100).optional(),
  sort: z.enum(['recent', 'sales', 'price_asc', 'price_desc', 'stock']).default('recent'),
  page: z.coerce.number().int().min(1).max(10000).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(24), missingPackage: z.enum(['true']).optional(),
  category: z.string().trim().min(1).max(200).optional(),
})
// Lowest/highest SKU price, else the price ladder, else the reference price.
const priceSql = (agg: 'min' | 'max') => `coalesce(
  (SELECT ${agg}((x->>'price')::numeric) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(l.snapshot->'skuInfos')='array' THEN l.snapshot->'skuInfos' ELSE '[]' END) x WHERE x->>'price' ~ '^[0-9]+(\\.[0-9]+)?$'),
  (SELECT ${agg}((x->>'price')::numeric) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(l.snapshot->'saleInfo'->'priceRanges')='array' THEN l.snapshot->'saleInfo'->'priceRanges' ELSE '[]' END) x WHERE x->>'price' ~ '^[0-9]+(\\.[0-9]+)?$'),
  CASE WHEN l.snapshot->>'referencePrice' ~ '^[0-9]+(\\.[0-9]+)?$' THEN (l.snapshot->>'referencePrice')::numeric END)::float`

export async function queryCatalog(tenantId: string, q: z.infer<typeof catalogListQuery>) {
    const values: unknown[] = [tenantId]
    const where = [`l.tenant_id=$1`, `l.status<>'deleted'`, `coalesce(l.deletion_state,'') NOT IN ('deleted','deleting')`]
    if (q.connectionId) { values.push(q.connectionId); where.push(`l.connection_id=$${values.length}`) }
    if (q.missingPackage) where.push(`NOT EXISTS(SELECT 1 FROM product_measurements pm WHERE pm.product_id=l.product_id AND pm.variant_id IS NULL AND pm.package_weight_g IS NOT NULL)`)
    if (q.search) {
      values.push(`%${q.search.replace(/[\\%_]/g, m => `\\${m}`)}%`, q.search)
      where.push(`(l.title ILIKE $${values.length - 1} OR l.offer_id=$${values.length} OR l.snapshot->>'productCargoNumber' ILIKE $${values.length - 1})`)
    }
    // Category choices follow the other filters and the tab, but not the category itself, so every choice stays reachable.
    const categories = (await db.query(`SELECT l.snapshot->>'categoryName' AS name,count(*)::int AS count FROM integration_1688_listings l
      WHERE ${where.join(' AND ')} AND ${groups[q.group]} AND coalesce(l.snapshot->>'categoryName','')<>'' GROUP BY 1 ORDER BY count(*) DESC,1 LIMIT 200`, values)).rows
    if (q.category) { values.push(q.category); where.push(`l.snapshot->>'categoryName'=$${values.length}`) }
    const base = `WITH sales AS (
        SELECT i->>'productId' AS offer_id,sum(coalesce((i->>'quantity')::numeric,0))::float AS quantity,sum(coalesce((i->>'amount')::numeric,0))::float AS amount,count(DISTINCT o.order_id)::int AS orders
        FROM perf_orders o CROSS JOIN LATERAL jsonb_array_elements(o.items) i
        WHERE o.tenant_id=$1 AND o.paid_at>=now()-interval '30 days' GROUP BY 1)
      SELECT l.id,l.connection_id,c.display_name AS shop,l.offer_id,l.title,l.status,l.image_url,l.synced_at,l.product_id,p.sku AS product_sku,p.name AS product_name,
        (SELECT pm.package_weight_g FROM product_measurements pm WHERE pm.product_id=l.product_id AND pm.variant_id IS NULL) AS package_weight_g,
        l.snapshot->>'categoryName' AS category,l.snapshot->>'productCargoNumber' AS cargo_number,l.snapshot->'saleInfo'->>'unit' AS unit,
        l.snapshot->>'lastUpdateTime' AS updated_on_platform,l.snapshot->>'expireTime' AS expires_on_platform,
        ${priceSql('min')} AS price_min,${priceSql('max')} AS price_max,
        CASE WHEN l.snapshot->'saleInfo'->>'amountOnSale' ~ '^[0-9]+$' THEN (l.snapshot->'saleInfo'->>'amountOnSale')::float END AS stock,
        CASE WHEN jsonb_typeof(l.snapshot->'skuInfos')='array' THEN jsonb_array_length(l.snapshot->'skuInfos') ELSE 0 END AS sku_count,
        coalesce(s.quantity,0) AS sales_quantity,coalesce(s.amount,0) AS sales_amount,coalesce(s.orders,0) AS sales_orders
      FROM integration_1688_listings l JOIN integration_1688_connections c ON c.id=l.connection_id LEFT JOIN products p ON p.id=l.product_id LEFT JOIN sales s ON s.offer_id=l.offer_id
      WHERE ${where.join(' AND ')}`
    const listValues = [...values, q.pageSize, (q.page - 1) * q.pageSize]
    const rows = (await db.query(`SELECT * FROM (${base} AND ${groups[q.group]} ORDER BY ${sorts[q.sort]}) x LIMIT $${listValues.length - 1} OFFSET $${listValues.length}`, listValues)).rows
    // Group counts ignore the group filter so each tab shows what it would return.
    const facets = (await db.query(`SELECT count(*) FILTER (WHERE ${groups.on_sale})::int AS on_sale,count(*) FILTER (WHERE ${groups.expired})::int AS expired,
        count(*) FILTER (WHERE ${groups.other})::int AS other FROM integration_1688_listings l WHERE ${where.join(' AND ')}`, values)).rows[0]
    const shops = (await db.query(`SELECT c.id,c.display_name,c.status,max(l.synced_at) AS synced_at,c.listings_synced_through FROM integration_1688_connections c LEFT JOIN integration_1688_listings l ON l.connection_id=c.id
      WHERE c.tenant_id=$1 GROUP BY c.id ORDER BY c.created_at`, [tenantId])).rows
    return { data: rows, total: facets[q.group], page: q.page, pageSize: q.pageSize, facets, shops, categories }
}

export async function catalogRoutes(app: FastifyInstance) {
  app.get('/catalog', { preHandler: requirePermission('integration:read') }, request => queryCatalog(request.authUser.tenantId, catalogListQuery.parse(request.query)))
}
