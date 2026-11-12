import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { requirePermission } from '../auth.js'
import { db } from '../db.js'
import { IntegrationError } from '../integrations/1688.js'
import { applyAssetToProduct, ensurePhoto } from '../integrations/image-album.js'
import { galleryOf } from '../integrations/image-workshop.js'
import { assetColumns, present } from './image-workshop.js'

/**
 * Generated picture → 1688 shop photo album → main picture of a collected product. Album uploads are platform writes:
 * one at a time per picture, never retried automatically when the outcome is unknown. The replaced URL is kept so the
 * change can be undone; the formal product created from the collected product is updated the same way.
 */
const tenant = (request: FastifyRequest) => request.authUser.tenantId
const idParams = z.object({ id: z.string().uuid() })
const albumInput = { connectionId: z.string().uuid().optional(), albumId: z.string().regex(/^\d{1,20}$/, '相册 ID 只能是数字。').optional() }
const MAX_MAIN = 10
const audit = (request: FastifyRequest, action: string, entityId: string, data: object) => db.query(
  "INSERT INTO audit_logs(tenant_id,actor_id,action,entity_type,entity_id,after_data,request_id)VALUES($1,$2,$3,'image_asset',$4,$5,$6)",
  [tenant(request), request.authUser.sub, action, entityId, JSON.stringify(data), request.id])
const assetOf = async (tenantId: string, id: string) => {
  const row = (await db.query(`SELECT ${assetColumns} FROM image_assets WHERE id=$1 AND tenant_id=$2`, [id, tenantId])).rows[0]
  if (!row) throw new IntegrationError('NOT_FOUND', '图片不存在。', 404)
  return row
}

export async function imageAlbumRoutes(app: FastifyInstance) {
  // Connected shops with the album last used for each.
  app.get('/albums', { preHandler: requirePermission('collection:read') }, async request => ({
    data: (await db.query(`SELECT c.id,c.display_name,c.status,a.album_id FROM integration_1688_connections c LEFT JOIN integration_1688_album_settings a ON a.connection_id=c.id
      WHERE c.tenant_id=$1 ORDER BY c.status='connected' DESC,c.created_at`, [tenant(request)])).rows,
  }))

  app.post('/assets/:id/photo', { preHandler: [requirePermission('integration:publish'), requirePermission('collection:read')] }, async request => {
    const { id } = idParams.parse(request.params)
    const input = z.object({ ...albumInput, confirmed: z.literal(true) }).strict().parse(request.body)
    await ensurePhoto({ tenantId: tenant(request), actorId: request.authUser.sub, requestId: request.id }, await assetOf(tenant(request), id), input.connectionId, input.albumId)
    return { data: await present(await assetOf(tenant(request), id)) }
  })

  // One click: upload to the album (unless already uploaded) and put the album picture into the product's main pictures.
  app.post('/assets/:id/apply', { preHandler: [requirePermission('integration:publish'), requirePermission('collection:create')] }, async request => {
    const { id } = idParams.parse(request.params)
    const input = z.object({ ...albumInput, collectedProductId: z.string().uuid().optional(), placement: z.enum(['replace', 'append']), index: z.number().int().min(0).max(MAX_MAIN - 1).optional(), confirmed: z.literal(true) }).strict().parse(request.body)
    const asset = await assetOf(tenant(request), id)
    const productId = input.collectedProductId ?? asset.collected_product_id
    if (!productId) throw new IntegrationError('PRODUCT_REQUIRED', '请选择要替换主图的采集商品。', 400)
    if (input.placement === 'replace' && input.index === undefined) throw new IntegrationError('INDEX_REQUIRED', '请选择要替换的主图。', 400)
    if (!(await db.query('SELECT 1 FROM collected_products WHERE id=$1 AND tenant_id=$2', [productId, tenant(request)])).rows.length) throw new IntegrationError('NOT_FOUND', '采集商品不存在。', 404)
    const ctx = { tenantId: tenant(request), actorId: request.authUser.sub, requestId: request.id }
    const url = await ensurePhoto(ctx, asset, input.connectionId, input.albumId)
    const applied = await applyAssetToProduct(ctx, asset, productId, input.placement, input.index, url)
    const queueJob = (await db.query('SELECT id,status FROM integration_1688_collection_queue_jobs WHERE collected_product_id=$1', [productId])).rows[0] ?? null
    return { data: { asset: await present(await assetOf(tenant(request), id)), applied, queueJob } }
  })

  // Puts the replaced picture back (only while the slot still holds this picture).
  app.post('/assets/:id/revert', { preHandler: requirePermission('collection:create') }, async request => {
    const { id } = idParams.parse(request.params)
    const asset = await assetOf(tenant(request), id)
    const applied = asset.applied_to as { collectedProductId: string; previousUrl: string | null; productId: string | null } | null
    if (!applied || !asset.photo_url) throw new IntegrationError('NOT_APPLIED', '这张图片没有替换过主图。', 409)
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      const p = (await client.query('SELECT id,product_id,main_image_url,gallery_images FROM collected_products WHERE id=$1 AND tenant_id=$2 FOR UPDATE', [applied.collectedProductId, tenant(request)])).rows[0]
      if (!p) throw new IntegrationError('NOT_FOUND', '采集商品已删除。', 404)
      const list = galleryOf(p), index = list.indexOf(asset.photo_url)
      if (index < 0) throw new IntegrationError('CHANGED', '主图已被修改，这张图片不在主图中，无需撤销。', 409)
      if (applied.previousUrl && !list.includes(applied.previousUrl)) list[index] = applied.previousUrl
      else list.splice(index, 1)
      if (!list.length) throw new IntegrationError('LAST_IMAGE', '撤销后将没有主图，请先添加其他主图。', 409)
      await client.query('UPDATE collected_products SET main_image_url=$2,gallery_images=$3,updated_at=now() WHERE id=$1', [p.id, list[0], JSON.stringify(list)])
      if (p.product_id) {
        const product = (await client.query('SELECT images FROM products WHERE id=$1 AND tenant_id=$2 FOR UPDATE', [p.product_id, tenant(request)])).rows[0]
        const images: string[] = Array.isArray(product?.images) ? product.images : []
        if (product) await client.query('UPDATE products SET images=$2,updated_at=now() WHERE id=$1', [p.product_id, JSON.stringify(applied.previousUrl ? images.map(u => u === asset.photo_url ? applied.previousUrl : u) : images.filter(u => u !== asset.photo_url))])
      }
      await client.query('UPDATE image_assets SET applied_to=NULL,applied_at=NULL,updated_at=now() WHERE id=$1', [id])
      await client.query('COMMIT')
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
    await audit(request, 'image.revert', id, applied)
    return { data: await present(await assetOf(tenant(request), id)) }
  })
}
