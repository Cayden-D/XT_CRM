import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { requirePermission } from '../auth.js'
import { db } from '../db.js'
import { IntegrationError, uploadPhoto } from '../integrations/1688.js'
import { publishingImages } from '../integrations/1688-agent.js'
import { albumJpeg, flagged, galleryOf, readImage, type Finding } from '../integrations/image-workshop.js'
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

/** Uploads the picture to the shop album once; returns the album URL (reuses an earlier upload to the same shop). */
async function ensurePhoto(request: FastifyRequest, asset: Record<string, any>, connectionId?: string, albumId?: string) {
  if (asset.photo_status === 'uploaded' && asset.photo_url && (!connectionId || connectionId === asset.photo_connection_id)) return asset.photo_url as string
  if (asset.photo_status === 'unknown') throw new IntegrationError('PHOTO_UPLOAD_UNKNOWN', '上次上传相册的结果未确认，请先到店铺相册核对，避免重复上传。', 409)
  if (asset.photo_status === 'uploading') throw new IntegrationError('PHOTO_UPLOADING', '这张图片正在上传相册，请稍候。', 409)
  if (asset.status !== 'completed' || !asset.oss_key) throw new IntegrationError('IMAGE_NOT_READY', '图片尚未生成完成。', 409)
  if (!asset.findings || flagged(asset.findings as Finding)) throw new IntegrationError('IMAGE_RISK', '这张图片复检未通过（或复检未完成），不能上传到店铺相册。', 409)
  if (!connectionId || !albumId) throw new IntegrationError('ALBUM_REQUIRED', '请选择店铺并填写相册 ID。', 400)
  const shop = (await db.query("SELECT id,status FROM integration_1688_connections WHERE id=$1 AND tenant_id=$2", [connectionId, tenant(request)])).rows[0]
  if (!shop) throw new IntegrationError('NOT_FOUND', '店铺不存在。', 404)
  if (shop.status !== 'connected') throw new IntegrationError('CONNECTION_INACTIVE', '店铺未连接或需要重新授权。', 409)
  const bytes = await albumJpeg(await readImage(asset.oss_key, tenant(request)))
  const claimed = await db.query("UPDATE image_assets SET photo_status='uploading',updated_at=now() WHERE id=$1 AND (photo_status IS NULL OR photo_status='uploaded') RETURNING id", [asset.id])
  if (!claimed.rows.length) throw new IntegrationError('PHOTO_UPLOADING', '这张图片正在上传相册，请稍候。', 409)
  let photo: { url?: string; id?: string } | undefined
  try { photo = await uploadPhoto(connectionId, tenant(request), request.authUser.sub, albumId, `ai-${String(asset.operation).replace('suite_', '')}-${asset.id.slice(0, 8)}.jpg`, bytes, 'image/jpeg', request.id) as { url?: string; id?: string } }
  catch (error) {
    // A rejection reported by the platform (or a token problem before the call) stored nothing: the picture may be uploaded
    // again. A network failure or unreadable answer may have stored it: mark unknown and never retry automatically.
    const known = error instanceof IntegrationError && !['NETWORK_ERROR', 'INVALID_RESPONSE', 'PARTIAL_FAILURE'].includes(error.code)
    await db.query(`UPDATE image_assets SET photo_status=${known ? 'NULL' : "'unknown'"},updated_at=now() WHERE id=$1`, [asset.id])
    if (known) throw error
    throw new IntegrationError('PHOTO_UPLOAD_UNKNOWN', '相册上传结果未确认，请到店铺相册核对后再处理，勿重复上传。', 409)
  }
  let url: string
  try { if (typeof photo?.url !== 'string') throw new Error('no url'); url = publishingImages({ image: photo.url })[0] }
  catch {
    await db.query("UPDATE image_assets SET photo_status='unknown',updated_at=now() WHERE id=$1", [asset.id])
    throw new IntegrationError('PHOTO_UPLOAD_UNKNOWN', '相册上传未返回可用的图片地址，请到店铺相册核对，勿重复上传。', 409)
  }
  await db.query("UPDATE image_assets SET photo_status='uploaded',photo_url=$2,photo_connection_id=$3,photo_album_id=$4,photo_uploaded_at=now(),updated_at=now() WHERE id=$1", [asset.id, url, connectionId, albumId])
  await db.query(`INSERT INTO integration_1688_album_settings(connection_id,tenant_id,album_id,updated_by) VALUES($1,$2,$3,$4)
    ON CONFLICT(connection_id) DO UPDATE SET album_id=excluded.album_id,updated_by=excluded.updated_by,updated_at=now()`, [connectionId, tenant(request), albumId, request.authUser.sub])
  // The album copy is the same picture that passed screening.
  const f = asset.findings as Finding
  await db.query(`INSERT INTO image_inspections(tenant_id,url,readable,watermark,rights_risk,reason) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(tenant_id,url) DO NOTHING`,
    [tenant(request), url, f.readable, f.watermark, f.rightsRisk, f.reason])
  await audit(request, 'image.album.upload', asset.id, { connectionId, albumId, photoId: photo?.id ?? null })
  return url
}

/** Replaces `previous` with `next` (or appends) in a list of picture URLs. */
const swap = (list: string[], previous: string | null, next: string) => previous && list.includes(previous) ? list.map(u => u === previous ? next : u) : list.includes(next) ? list : [...list, next]

export async function imageAlbumRoutes(app: FastifyInstance) {
  // Connected shops with the album last used for each.
  app.get('/albums', { preHandler: requirePermission('collection:read') }, async request => ({
    data: (await db.query(`SELECT c.id,c.display_name,c.status,a.album_id FROM integration_1688_connections c LEFT JOIN integration_1688_album_settings a ON a.connection_id=c.id
      WHERE c.tenant_id=$1 ORDER BY c.status='connected' DESC,c.created_at`, [tenant(request)])).rows,
  }))

  app.post('/assets/:id/photo', { preHandler: [requirePermission('integration:publish'), requirePermission('collection:read')] }, async request => {
    const { id } = idParams.parse(request.params)
    const input = z.object({ ...albumInput, confirmed: z.literal(true) }).strict().parse(request.body)
    await ensurePhoto(request, await assetOf(tenant(request), id), input.connectionId, input.albumId)
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
    const url = await ensurePhoto(request, asset, input.connectionId, input.albumId)
    const client = await db.connect()
    let applied: Record<string, unknown>
    try {
      await client.query('BEGIN')
      const p = (await client.query('SELECT id,product_id,main_image_url,gallery_images FROM collected_products WHERE id=$1 AND tenant_id=$2 FOR UPDATE', [productId, tenant(request)])).rows[0]
      const list = galleryOf(p)
      let index = input.index ?? list.length, previous: string | null = null
      if (input.placement === 'replace') {
        if (index >= list.length) throw new IntegrationError('INDEX_INVALID', '要替换的主图不存在，请刷新后重试。', 409)
        previous = list[index]
        if (previous === url) throw new IntegrationError('ALREADY_APPLIED', '这个位置已经是这张图片。', 409)
        if (list.includes(url)) throw new IntegrationError('ALREADY_APPLIED', `这张图片已经是主图 ${list.indexOf(url) + 1}，请先撤销。`, 409)
        list[index] = url
      } else {
        if (list.includes(url)) throw new IntegrationError('ALREADY_APPLIED', '主图中已经有这张图片。', 409)
        if (list.length >= MAX_MAIN) throw new IntegrationError('IMAGE_LIMIT', `主图最多 ${MAX_MAIN} 张，请改为替换。`, 409)
        index = list.length; list.push(url)
      }
      await client.query('UPDATE collected_products SET main_image_url=$2,gallery_images=$3,updated_at=now() WHERE id=$1', [productId, list[0], JSON.stringify(list)])
      if (p.product_id) {
        const product = (await client.query('SELECT images FROM products WHERE id=$1 AND tenant_id=$2 FOR UPDATE', [p.product_id, tenant(request)])).rows[0]
        if (product) await client.query('UPDATE products SET images=$2,updated_at=now() WHERE id=$1', [p.product_id, JSON.stringify(swap(Array.isArray(product.images) ? product.images : [], previous, url))])
      }
      applied = { collectedProductId: productId, index, placement: input.placement, previousUrl: previous, productId: p.product_id ?? null }
      await client.query('UPDATE image_assets SET applied_to=$2,applied_at=now(),updated_at=now() WHERE id=$1', [id, JSON.stringify(applied)])
      await client.query('COMMIT')
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
    await audit(request, 'image.apply', id, applied)
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
