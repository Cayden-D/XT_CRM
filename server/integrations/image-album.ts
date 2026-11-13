import type { PoolClient } from 'pg'
import { db } from '../db.js'
import { callProductApi, IntegrationError, uploadPhoto } from './1688.js'
import { publishingImages } from './1688-agent.js'
import { albumJpeg, download, flagged, galleryOf, readImage, sourceUrl, type Finding } from './image-workshop.js'

/**
 * Generated picture → 1688 shop photo album → main picture of a collected product. Album uploads are platform writes:
 * one at a time per picture, never retried automatically when the outcome is unknown. Used by the image workshop (a
 * person clicks) and by the collection queue (AI replacements of flagged main pictures).
 */
export type AlbumContext = { tenantId: string; actorId: string; requestId: string }
const MAX_MAIN = 10
const audit = (ctx: AlbumContext, action: string, entityId: string, data: object) => db.query(
  "INSERT INTO audit_logs(tenant_id,actor_id,action,entity_type,entity_id,after_data,request_id)VALUES($1,$2,$3,'image_asset',$4,$5,$6)",
  [ctx.tenantId, ctx.actorId, action, entityId, JSON.stringify(data), ctx.requestId])

/** Uploads the picture to the shop album once; returns the album URL (reuses an earlier upload to the same shop). */
export async function ensurePhoto(ctx: AlbumContext, asset: Record<string, any>, connectionId?: string, albumId?: string) {
  if (asset.photo_status === 'uploaded' && asset.photo_url && (!connectionId || connectionId === asset.photo_connection_id)) return asset.photo_url as string
  if (asset.photo_status === 'unknown') throw new IntegrationError('PHOTO_UPLOAD_UNKNOWN', '上次上传相册的结果未确认，请先到店铺相册核对，避免重复上传。', 409)
  if (asset.photo_status === 'uploading') throw new IntegrationError('PHOTO_UPLOADING', '这张图片正在上传相册，请稍候。', 409)
  if (asset.status !== 'completed' || !asset.oss_key) throw new IntegrationError('IMAGE_NOT_READY', '图片尚未生成完成。', 409)
  if (!asset.findings || flagged(asset.findings as Finding)) throw new IntegrationError('IMAGE_RISK', '这张图片复检未通过（或复检未完成），不能上传到店铺相册。', 409)
  if (!connectionId || !albumId) throw new IntegrationError('ALBUM_REQUIRED', '请选择店铺并填写相册 ID。', 400)
  const shop = (await db.query("SELECT id,status FROM integration_1688_connections WHERE id=$1 AND tenant_id=$2", [connectionId, ctx.tenantId])).rows[0]
  if (!shop) throw new IntegrationError('NOT_FOUND', '店铺不存在。', 404)
  if (shop.status !== 'connected') throw new IntegrationError('CONNECTION_INACTIVE', '店铺未连接或需要重新授权。', 409)
  const bytes = await albumJpeg(await readImage(asset.oss_key, ctx.tenantId))
  const claimed = await db.query("UPDATE image_assets SET photo_status='uploading',updated_at=now() WHERE id=$1 AND (photo_status IS NULL OR photo_status='uploaded') RETURNING id", [asset.id])
  if (!claimed.rows.length) throw new IntegrationError('PHOTO_UPLOADING', '这张图片正在上传相册，请稍候。', 409)
  let photo: { url?: string; id?: string } | undefined
  try { photo = await uploadPhoto(connectionId, ctx.tenantId, ctx.actorId, albumId, `ai-${String(asset.operation).replace('suite_', '')}-${asset.id.slice(0, 8)}.jpg`, bytes, 'image/jpeg', ctx.requestId) as { url?: string; id?: string } }
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
    ON CONFLICT(connection_id) DO UPDATE SET album_id=excluded.album_id,updated_by=excluded.updated_by,updated_at=now()`, [connectionId, ctx.tenantId, albumId, ctx.actorId])
  // The album copy is the same picture that passed screening.
  const f = asset.findings as Finding
  await db.query(`INSERT INTO image_inspections(tenant_id,url,readable,watermark,rights_risk,reason) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(tenant_id,url) DO NOTHING`,
    [ctx.tenantId, url, f.readable, f.watermark, f.rightsRisk, f.reason])
  await audit(ctx, 'image.album.upload', asset.id, { connectionId, albumId, photoId: photo?.id ?? null })
  return url
}

/** Replaces `previous` with `next` (or appends) in a list of picture URLs. */
const swap = (list: string[], previous: string | null, next: string) => previous && list.includes(previous) ? list.map(u => u === previous ? next : u) : list.includes(next) ? list : [...list, next]

/** Puts an uploaded album picture into the product's main pictures (replacing slot `requested`, or appended). */
export async function applyAssetToProduct(ctx: AlbumContext, asset: Record<string, any>, productId: string, placement: 'replace' | 'append', requested: number | undefined, url: string, onApplied?: (client: PoolClient) => Promise<void>) {
    const client = await db.connect()
    let applied: Record<string, unknown>
    try {
      await client.query('BEGIN')
      const p = (await client.query('SELECT id,product_id,main_image_url,gallery_images FROM collected_products WHERE id=$1 AND tenant_id=$2 FOR UPDATE', [productId, ctx.tenantId])).rows[0]
      const list = galleryOf(p)
      let index = requested ?? list.length, previous: string | null = null
      if (placement === 'replace') {
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
        const product = (await client.query('SELECT images FROM products WHERE id=$1 AND tenant_id=$2 FOR UPDATE', [p.product_id, ctx.tenantId])).rows[0]
        if (product) await client.query('UPDATE products SET images=$2,updated_at=now() WHERE id=$1', [p.product_id, JSON.stringify(swap(Array.isArray(product.images) ? product.images : [], previous, url))])
      }
      applied = { collectedProductId: productId, index, placement: placement, previousUrl: previous, productId: p.product_id ?? null }
      await client.query('UPDATE image_assets SET applied_to=$2,applied_at=now(),updated_at=now() WHERE id=$1', [asset.id, JSON.stringify(applied)])
      if (onApplied) await onApplied(client)
      await client.query('COMMIT')
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  await audit(ctx, 'image.apply', asset.id, applied)
  return applied
}

/** Album that receives generated pictures when the shop has none chosen yet: found by name, otherwise created (private). */
export const AUTO_ALBUM_NAME = '销途 AI 生图'
type Album = { albumID?: unknown; name?: unknown }
// The album APIs report success with an error code of "0" (or an empty one) next to the data.
const OK_CODES = new Set(['', '0', 'success', 'SUCCESS'])
const platformError = (data: Record<string, unknown>) => {
  const code = String(data.errCode ?? data.errorCode ?? '').trim(), message = String(data.errMsg ?? data.errorMsg ?? '').trim()
  if (OK_CODES.has(code) && (!message || OK_CODES.has(message))) return null
  return new IntegrationError(code && !OK_CODES.has(code) ? code : 'ALBUM_ERROR', `1688 相册接口返回错误：${message || code}`, 502)
}
export async function ensureAlbum(ctx: AlbumContext, connectionId: string) {
  const chosen = (await db.query('SELECT album_id FROM integration_1688_album_settings WHERE connection_id=$1', [connectionId])).rows[0]?.album_id as string | undefined
  if (chosen) return chosen
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    // One album per shop even when several jobs reach this point together.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`photobank-album:${connectionId}`])
    const again = (await client.query('SELECT album_id FROM integration_1688_album_settings WHERE connection_id=$1', [connectionId])).rows[0]?.album_id as string | undefined
    if (again) { await client.query('COMMIT'); return again }
    const listed = await callProductApi(connectionId, ctx.tenantId, ctx.actorId, 'alibaba.photobank.album.getList', { webSite: '1688', albumType: 'CUSTOM' }, ctx.requestId) as Record<string, unknown>
    const body = (listed.result && typeof listed.result === 'object' ? listed.result : listed) as Record<string, unknown>
    const listError = platformError(body)
    if (listError) throw listError
    const albums = (Array.isArray(body.albumInfos) ? body.albumInfos : []) as Album[]
    let albumId = albums.find(a => a?.name === AUTO_ALBUM_NAME && /^\d{1,20}$/.test(String(a.albumID ?? '')))?.albumID as string | number | undefined
    let created = false
    if (albumId == null) {
      const made = await callProductApi(connectionId, ctx.tenantId, ctx.actorId, 'alibaba.photobank.album.add', { name: AUTO_ALBUM_NAME, description: '销途 CRM 自动上架生成的商品图片', authority: 0, webSite: '1688' }, ctx.requestId) as Record<string, unknown>
      const answer = (made.result && typeof made.result === 'object' ? made.result : made) as Record<string, unknown>
      const addError = platformError(answer)
      if (addError) throw addError
      albumId = answer.albumID as string | number | undefined
      if (!/^\d{1,20}$/.test(String(albumId ?? ''))) throw new IntegrationError('ALBUM_UNKNOWN', '创建相册后平台没有返回相册编号，请到店铺相册核对。', 502)
      created = true
    }
    await client.query(`INSERT INTO integration_1688_album_settings(connection_id,tenant_id,album_id,updated_by) VALUES($1,$2,$3,$4)
      ON CONFLICT(connection_id) DO UPDATE SET album_id=excluded.album_id,updated_by=excluded.updated_by,updated_at=now()`, [connectionId, ctx.tenantId, String(albumId), ctx.actorId])
    await client.query("INSERT INTO audit_logs(tenant_id,actor_id,action,entity_type,entity_id,after_data,request_id)VALUES($1,$2,'image.album.auto','1688_connection',$3,$4,$5)",
      [ctx.tenantId, ctx.actorId, connectionId, JSON.stringify({ albumId: String(albumId), name: AUTO_ALBUM_NAME, created }), ctx.requestId])
    await client.query('COMMIT')
    return String(albumId)
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}

/**
 * Copies a picture from Alibaba's CDN (e.g. a SKU picture of the collected listing) into the shop's own album and returns
 * the album address: the platform shows only pictures from the shop's own album.
 */
export async function rehostToAlbum(ctx: AlbumContext, connectionId: string, albumId: string, url: string, name: string) {
  const bytes = await albumJpeg(await download(sourceUrl(url), 15_000_000))
  const photo = await uploadPhoto(connectionId, ctx.tenantId, ctx.actorId, albumId, name, bytes, 'image/jpeg', ctx.requestId) as { url?: string } | undefined
  if (typeof photo?.url !== 'string') throw new IntegrationError('PHOTO_UPLOAD_UNKNOWN', '相册上传未返回图片地址。', 502)
  return publishingImages({ image: photo.url })[0]
}
