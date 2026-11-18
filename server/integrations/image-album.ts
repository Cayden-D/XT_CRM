import type { PoolClient } from 'pg'
import { db } from '../db.js'
import { callProductApi, IntegrationError, isPhotoUploadRejection, uploadPhoto } from './1688.js'
import { publishingImages } from './1688-agent.js'
import { albumJpeg, assetShop, checkAssetFinding, download, flagged, galleryOf, readImage, rememberFinding, sourceUrl, type Finding } from './image-workshop.js'

/**
 * Generated picture → 1688 shop photo album → main picture of a collected product. Album uploads are platform writes,
 * one at a time per picture. A person clicking (image workshop) is never retried automatically when the outcome is
 * unknown; the collection queue retries (`retry`), because a duplicate picture in the album costs less than a stuck listing.
 */
export type AlbumContext = { tenantId: string; actorId: string; requestId: string }
const MAX_MAIN = 10
export const UPLOAD_ATTEMPTS = 3
const UPLOAD_RETRY_MS = Number(process.env.ALBUM_UPLOAD_RETRY_MS ?? 3000)
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
/** Failures where the picture may still arrive on a later try (unconfirmed, network, rate limit). */
export const retryableUpload = (error: unknown) => error instanceof IntegrationError && (['36', 'PHOTO_UPLOAD_UNKNOWN', 'PHOTO_UPLOADING', 'PHOTO_UNREACHABLE', 'NETWORK_ERROR', 'INVALID_RESPONSE', 'PARTIAL_FAILURE'].includes(error.code) || error.code.startsWith('gw.Qos'))

/** Checks that the album address really serves the picture (CDN copies can lag a moment behind the upload). */
async function reachable(url: string) {
  for (let i = 0; i < UPLOAD_ATTEMPTS; i++) {
    try { await download(sourceUrl(url), 15_000_000); return true } catch { if (i < UPLOAD_ATTEMPTS - 1) await sleep(UPLOAD_RETRY_MS) }
  }
  return false
}
const audit = (ctx: AlbumContext, action: string, entityId: string, data: object) => db.query(
  "INSERT INTO audit_logs(tenant_id,actor_id,action,entity_type,entity_id,after_data,request_id)VALUES($1,$2,$3,'image_asset',$4,$5,$6)",
  [ctx.tenantId, ctx.actorId, action, entityId, JSON.stringify(data), ctx.requestId])

/**
 * Uploads the picture to the shop album once; returns the album URL (reuses an earlier upload to the same shop).
 * With `retry` (the collection queue), an unconfirmed upload is tried again up to UPLOAD_ATTEMPTS times, and each result
 * is checked by reading the picture back from its album address.
 */
export async function ensurePhoto(ctx: AlbumContext, asset: Record<string, any>, connectionId?: string, albumId?: string, options: { retry?: boolean } = {}) {
  const frameShop = assetShop(asset.options)
  const destination = connectionId ?? asset.photo_connection_id
  if (frameShop && destination && frameShop !== destination) {
    const hero = Boolean(asset.options?.heroShopId)
    throw new IntegrationError(hero ? 'HERO_SHOP_MISMATCH' : 'BRAND_SHOP_MISMATCH', hero ? '请为首图选择模板所属的店铺相册。' : '请选择品牌所属的店铺相册。', 409)
  }
  const reusablePhoto = asset.photo_status === 'uploaded' && asset.photo_url && (!connectionId || connectionId === asset.photo_connection_id)
  if (asset.photo_status === 'unknown' && !options.retry) throw new IntegrationError('PHOTO_UPLOAD_UNKNOWN', '上次上传相册的结果未确认，请先到店铺相册核对，避免重复上传。', 409)
  if (asset.photo_status === 'uploading') throw new IntegrationError('PHOTO_UPLOADING', '这张图片正在上传相册，请稍候。', 409)
  if (asset.status !== 'completed' || !asset.oss_key) throw new IntegrationError('IMAGE_NOT_READY', '图片尚未生成完成。', 409)
  if (!asset.findings || flagged(asset.findings as Finding)) throw new IntegrationError('IMAGE_RISK', '这张图片复检未通过（或复检未完成），不能上传到店铺相册。', 409)
  const finding = asset.options?.unchecked ? asset.findings as Finding
    : await checkAssetFinding(ctx.tenantId, { oss_key: asset.oss_key, findings: asset.findings, options: asset.options }, destination ?? null)
  if (!finding || flagged(finding)) throw new IntegrationError('IMAGE_RISK', '这张图片未通过目标店铺的复检。', 409)
  if (reusablePhoto) {
    if (options.retry && asset.photo_connection_id && asset.photo_album_id) {
      await confirmAlbumRollover(ctx, asset.photo_connection_id, asset.photo_album_id)
    }
    return asset.photo_url as string
  }
  if (!connectionId || !albumId) throw new IntegrationError('ALBUM_REQUIRED', '请选择店铺并填写相册 ID。', 400)
  const shop = (await db.query("SELECT id,status FROM integration_1688_connections WHERE id=$1 AND tenant_id=$2", [connectionId, ctx.tenantId])).rows[0]
  if (!shop) throw new IntegrationError('NOT_FOUND', '店铺不存在。', 404)
  if (shop.status !== 'connected') throw new IntegrationError('CONNECTION_INACTIVE', '店铺未连接或需要重新授权。', 409)
  const bytes = await albumJpeg(await readImage(asset.oss_key, ctx.tenantId))
  const claimed = await db.query(`UPDATE image_assets SET photo_status='uploading',updated_at=now() WHERE id=$1 AND (photo_status IS NULL OR photo_status='uploaded'${options.retry ? " OR photo_status='unknown'" : ''}) RETURNING id`, [asset.id])
  if (!claimed.rows.length) throw new IntegrationError('PHOTO_UPLOADING', '这张图片正在上传相册，请稍候。', 409)
  const attempts = options.retry ? UPLOAD_ATTEMPTS : 1
  let photo: { url?: string; id?: string } | undefined, url = '', lastError: IntegrationError | null = null
  let usedAlbum = albumId
  let rolloverPending = false
  let uncertainUpload = asset.photo_status === 'unknown'
  for (let attempt = 1; attempt <= attempts && !url; attempt++) {
    if (attempt > 1) await sleep(UPLOAD_RETRY_MS * (attempt - 1))
    const name = `ai-${String(asset.operation).replace('suite_', '')}-${asset.id.slice(0, 8)}.jpg`
    try {
      if (options.retry) {
        const uploaded = await uploadToAvailableAlbum(ctx, connectionId, albumId, name, bytes)
        photo = uploaded.photo
        usedAlbum = uploaded.album.album_id
        rolloverPending = uploaded.album.rollover_pending
      } else {
        photo = await uploadPhoto(connectionId, ctx.tenantId, ctx.actorId, albumId, name, bytes, 'image/jpeg', ctx.requestId) as typeof photo
      }
    }
    catch (error) {
      // A rejection reported by the platform (or a token problem before the call) stored nothing. A network failure or
      // unreadable answer may have stored it: unknown, tried again only with `retry`.
      const uncertain = !(error instanceof IntegrationError) || ['NETWORK_ERROR', 'INVALID_RESPONSE', 'PARTIAL_FAILURE'].includes(error.code)
      uncertainUpload ||= uncertain
      if (!uncertain && !(options.retry && retryableUpload(error))) { await db.query('UPDATE image_assets SET photo_status=$2,updated_at=now() WHERE id=$1', [asset.id, uncertainUpload ? 'unknown' : null]); throw error }
      lastError = uncertain ? new IntegrationError('PHOTO_UPLOAD_UNKNOWN', '相册上传结果未确认，请到店铺相册核对后再处理，勿重复上传。', 409) : error as IntegrationError
      continue
    }
    let candidate = ''
    try { if (typeof photo?.url !== 'string') throw new Error('no url'); candidate = publishingImages({ image: photo.url })[0] }
    catch { uncertainUpload = true; lastError = new IntegrationError('PHOTO_UPLOAD_UNKNOWN', '相册上传未返回可用的图片地址，请到店铺相册核对，勿重复上传。', 409); continue }
    if (options.retry && !(await reachable(candidate))) { uncertainUpload = true; lastError = new IntegrationError('PHOTO_UNREACHABLE', '相册返回的图片地址暂时打不开。', 409); continue }
    url = candidate
  }
  if (!url) {
    await db.query('UPDATE image_assets SET photo_status=$2,updated_at=now() WHERE id=$1', [asset.id, uncertainUpload || !isPhotoUploadRejection(lastError) ? 'unknown' : null])
    if (options.retry && lastError) throw new IntegrationError(lastError.code, `${lastError.message.replace(/，?请到店铺相册核对[^。]*。?$/, '')}（已自动重试 ${attempts} 次）`, lastError.statusCode, lastError.detail)
    throw lastError ?? new IntegrationError('PHOTO_UPLOAD_UNKNOWN', '相册上传结果未确认，请到店铺相册核对后再处理，勿重复上传。', 409)
  }
  await db.query("UPDATE image_assets SET photo_status='uploaded',photo_url=$2,photo_connection_id=$3,photo_album_id=$4,photo_uploaded_at=now(),updated_at=now() WHERE id=$1", [asset.id, url, connectionId, usedAlbum])
  if (rolloverPending) await confirmAlbumRollover(ctx, connectionId, usedAlbum)
  // A photo accepted by the old album while another worker switches must not make the old album active again.
  if (!options.retry) await withAlbumLock(connectionId, client => saveChosenAlbum(client, ctx, connectionId, usedAlbum))
  // The album copy is the same picture that passed screening.
  await rememberFinding(ctx.tenantId, url, finding)
  await audit(ctx, 'image.album.upload', asset.id, { connectionId, albumId: usedAlbum, photoId: photo?.id ?? null })
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
async function withAlbumLock<T>(connectionId: string, action: (client: PoolClient) => Promise<T>) {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`photobank-album:${connectionId}`])
    const result = await action(client)
    await client.query('COMMIT')
    return result
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}

type ChosenAlbum = { album_id: string; rollover_pending: boolean }

async function chosenAlbum(client: PoolClient | typeof db, ctx: AlbumContext, connectionId: string): Promise<ChosenAlbum | undefined> {
  return (await client.query<ChosenAlbum>('SELECT album_id,rollover_pending FROM integration_1688_album_settings WHERE connection_id=$1 AND tenant_id=$2', [connectionId, ctx.tenantId])).rows[0]
}

async function saveChosenAlbum(client: PoolClient, ctx: AlbumContext, connectionId: string, albumId: string, rolloverPending = false) {
  const { rows } = await client.query<ChosenAlbum>(`INSERT INTO integration_1688_album_settings AS current(connection_id,tenant_id,album_id,updated_by,rollover_pending)
    VALUES($1,$2,$3,$4,$5)
    ON CONFLICT(connection_id) DO UPDATE SET album_id=excluded.album_id,updated_by=excluded.updated_by,updated_at=now(),
      rollover_pending=excluded.rollover_pending OR (current.album_id=excluded.album_id AND current.rollover_pending)
    RETURNING album_id,rollover_pending`, [connectionId, ctx.tenantId, albumId, ctx.actorId, rolloverPending])
  return rows[0]
}

async function confirmAlbumRollover(ctx: AlbumContext, connectionId: string, albumId: string) {
  // The album marker and the queue update commit together. Concurrent uploaders can only consume it once.
  await db.query(`WITH confirmed AS (
    UPDATE integration_1688_album_settings SET rollover_pending=false
    WHERE tenant_id=$1 AND connection_id=$2 AND album_id=$3 AND rollover_pending
    RETURNING connection_id
  ), sources AS MATERIALIZED (
    SELECT p.id,p.updated_at FROM confirmed
    JOIN collection_listing_shops shop ON shop.connection_id=confirmed.connection_id AND shop.tenant_id=$1
    JOIN integration_1688_collection_queue_jobs j ON j.connection_id=shop.connection_id AND j.tenant_id=$1
    JOIN collected_products p ON p.id=j.collected_product_id AND p.tenant_id=$1
    WHERE p.product_id IS NULL AND j.product_id IS NULL AND j.draft_id IS NULL
      AND j.phase='screening' AND j.status IN ('blocked','failed')
      AND coalesce(j.report->>'albumErrorCode',
        CASE WHEN j.message LIKE 'AI 新图上传店铺相册失败：%'
          AND j.message ~ '1688 (接口调用失败（13）|错误码 13）)' THEN '13' END)='13'
    ORDER BY p.id FOR UPDATE OF p
  ), resumed AS (
    UPDATE integration_1688_collection_queue_jobs j SET status='queued',attempts=0,available_at=now(),
      source_updated_at=p.updated_at,message='新相册已验证，已重新入队续传。',
      report=(j.report-'uploadRounds'-'imageWaitSince'-'storageRevivals'-'albumErrorCode'-'autoResumes') || '{"resumeAlbumUpload":true}'::jsonb,
      worker_id=NULL,lease_until=NULL,updated_at=now()
    FROM sources p WHERE j.collected_product_id=p.id AND j.tenant_id=$1 AND j.connection_id=$2
      AND j.phase='screening' AND j.status IN ('blocked','failed') AND j.product_id IS NULL AND j.draft_id IS NULL
    RETURNING j.collected_product_id
  )
  UPDATE collected_products p SET processing_status='ai_processing'
    FROM resumed r WHERE p.id=r.collected_product_id AND p.tenant_id=$1`, [ctx.tenantId, connectionId, albumId])
}

async function albumRequest(ctx: AlbumContext, connectionId: string, method: 'getList' | 'getProfile' | 'add', input: Record<string, unknown> = {}) {
  const data = await callProductApi(connectionId, ctx.tenantId, ctx.actorId, `alibaba.photobank.album.${method}`, { webSite: '1688', ...input }, ctx.requestId) as Record<string, unknown>
  const nested = data.result && typeof data.result === 'object' ? data.result as Record<string, unknown> : data
  const error = platformError(data) ?? platformError(nested)
  if (error) throw error
  return nested
}

async function selectOrCreateAlbum(client: PoolClient, ctx: AlbumContext, connectionId: string, name: string, previousAlbumId?: string) {
  const listed = await albumRequest(ctx, connectionId, 'getList', { albumType: 'CUSTOM' })
  const albums = (Array.isArray(listed.albumInfos) ? listed.albumInfos : []) as Album[]
  const existing = albums.find(a => a?.name === name && /^\d{1,20}$/.test(String(a.albumID ?? '')) && String(a.albumID) !== previousAlbumId)?.albumID
  const albumId = String(existing ?? (await albumRequest(ctx, connectionId, 'add', {
    name, description: '销途 CRM 自动上架生成的商品图片', authority: 0,
  })).albumID ?? '')
  if (!/^\d{1,20}$/.test(albumId) || albumId === previousAlbumId) throw new IntegrationError('ALBUM_UNKNOWN', '平台未返回可用的新相册编号，请到店铺相册核对。', 502)
  const chosen = await saveChosenAlbum(client, ctx, connectionId, albumId, previousAlbumId !== undefined)
  await client.query("INSERT INTO audit_logs(tenant_id,actor_id,action,entity_type,entity_id,after_data,request_id)VALUES($1,$2,'image.album.auto','1688_connection',$3,$4,$5)",
    [ctx.tenantId, ctx.actorId, connectionId, JSON.stringify({ albumId, name, created: existing == null, previousAlbumId }), ctx.requestId])
  return chosen
}

export async function ensureAlbum(ctx: AlbumContext, connectionId: string) {
  const album = await chosenAlbum(db, ctx, connectionId) ?? await withAlbumLock(connectionId, async client =>
    await chosenAlbum(client, ctx, connectionId) ?? await selectOrCreateAlbum(client, ctx, connectionId, AUTO_ALBUM_NAME))
  return album.album_id
}

function albumBytes(value: unknown) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value)
  if (typeof value === 'string' && /^\d{1,20}$/.test(value)) return BigInt(value)
  return null
}

async function switchFullAlbum(ctx: AlbumContext, connectionId: string, fullAlbumId: string) {
  return withAlbumLock(connectionId, async client => {
    const current = await chosenAlbum(client, ctx, connectionId)
    if (current && current.album_id !== fullAlbumId) return current
    const profile = await albumRequest(ctx, connectionId, 'getProfile')
    const used = albumBytes(profile.usedSpace), standard = albumBytes(profile.defaultSpace), extra = albumBytes(profile.externalSpace)
    const total = standard !== null && extra !== null ? standard + extra : null
    const measured = used !== null && total !== null
    if (profile.full === true || profile.full === 'true' || (measured && used >= total)) {
      throw new IntegrationError('ALBUM_STORAGE_FULL', '店铺相册总空间已满，创建新相册无法增加容量，请释放空间或扩容后重试。', 409)
    }
    if (profile.full !== false && profile.full !== 'false' && !measured) {
      throw new IntegrationError('ALBUM_PROFILE_INVALID', '1688 未返回有效的店铺相册空间信息，请核对后重试。', 502)
    }
    // A timed-out album creation can be found by the same name on the next attempt.
    return selectOrCreateAlbum(client, ctx, connectionId, `${AUTO_ALBUM_NAME}-${fullAlbumId}`, fullAlbumId)
  })
}

async function uploadToAvailableAlbum(ctx: AlbumContext, connectionId: string, albumId: string, name: string, bytes: Uint8Array) {
  let active = await chosenAlbum(db, ctx, connectionId) ?? { album_id: albumId, rollover_pending: false }
  const upload = () => uploadPhoto(connectionId, ctx.tenantId, ctx.actorId, active.album_id, name, bytes, 'image/jpeg', ctx.requestId)
  let photo: unknown
  try { photo = await upload() } catch (error) {
    if (!(error instanceof IntegrationError) || error.code !== '13') throw error
    active = await switchFullAlbum(ctx, connectionId, active.album_id)
    photo = await upload()
  }
  return { photo: photo as { url?: string; id?: string } | undefined, album: active }
}

/**
 * Copies a picture from Alibaba's CDN (e.g. a SKU picture of the collected listing) into the shop's own album and returns
 * the album address: the platform shows only pictures from the shop's own album.
 */
export async function rehostToAlbum(ctx: AlbumContext, connectionId: string, albumId: string, url: string, name: string) {
  const bytes = await albumJpeg(await download(sourceUrl(url), 15_000_000))
  const { photo, album } = await uploadToAvailableAlbum(ctx, connectionId, albumId, name, bytes)
  if (typeof photo?.url !== 'string') throw new IntegrationError('PHOTO_UPLOAD_UNKNOWN', '相册上传未返回图片地址。', 502)
  const uploaded = publishingImages({ image: photo.url })[0]
  if (album.rollover_pending) {
    if (!(await reachable(uploaded))) throw new IntegrationError('PHOTO_UNREACHABLE', '相册返回的图片地址暂时打不开。', 409)
    await confirmAlbumRollover(ctx, connectionId, album.album_id)
  }
  return uploaded
}
