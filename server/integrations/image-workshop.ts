import { randomUUID } from 'node:crypto'
import sharp from 'sharp'
import { config } from '../config.js'
import { db } from '../db.js'
import { IntegrationError } from './1688.js'
import { inspectPublishingImages } from './1688-agent.js'
import { imagePreviewClient, requireImageStorage } from './oss-images.js'
import { generateQwenImage, generatedImageUrl, type ImageModel } from '../llm/qwen-image.js'
import { apimartConfigured, getImageTask, resultUrl, submitImageTask, type SuiteModel, type SuiteQuality } from '../llm/apimart-image.js'

/**
 * Image workshop. Two rules hold everywhere:
 *  - A picture that shows a clearly readable company/shop watermark or a famous brand logo is never edited or used as a
 *    reference: removing someone else's watermark or logo strips their rights information. Such pictures are replaced
 *    by newly generated ones made only from the product's unflagged pictures.
 *  - Generated pictures are screened again before they are offered for use.
 */
export const EDIT_OPERATIONS = ['white_bg', 'background', 'resize'] as const
export const SUITE_TYPES = ['suite_white', 'suite_scene', 'suite_detail', 'suite_model', 'suite_selling', 'suite_spec'] as const
export type SuiteType = typeof SUITE_TYPES[number]
export const suiteNames: Record<SuiteType, string> = { suite_white: '白底图', suite_scene: '场景氛围图', suite_detail: '细节图', suite_model: '模特场景图', suite_selling: '卖点图', suite_spec: '规格尺寸图' }
type Json = Record<string, any>
export type Finding = { readable: boolean; watermark: boolean; rightsRisk: boolean; reason: string }
export const flagged = (f: Finding | null | undefined) => Boolean(f && (!f.readable || f.watermark || f.rightsRisk))
const RIGHTS_PROMPT = /(?:去|除|删|擦|消|抹|隐藏|遮).{0,6}(?:水印|商标|版权|logo|标志|品牌)|(?:remove|erase|hide|clean).{0,15}(?:watermark|copyright|logo|brand|trademark)/i
export function checkPrompt(text: string) {
  if (RIGHTS_PROMPT.test(text)) throw new IntegrationError('IMAGE_RIGHTS', '不能用 AI 去除水印、商标或品牌标识。带有他人水印/Logo 的图片请更换，或用「电商套图」基于干净图片重新生成。', 400)
}

// ---------- storage ----------
const prefix = 'image-workshop/'
const keyOf = (tenantId: string, id: string) => `${prefix}${tenantId}/${id}.png`
function checkedKey(key: string, tenantId: string) {
  if (!new RegExp(`^${prefix}${tenantId}/[a-f0-9-]{36}\\.png$`).test(key)) throw new IntegrationError('OSS_IMAGE_KEY', '图片存储标识无效。', 400)
  return key
}
export async function storeImage(tenantId: string, id: string, png: Buffer) {
  const key = keyOf(tenantId, id)
  try { await requireImageStorage().put(key, png, { mime: 'image/png', headers: { 'x-oss-object-acl': 'private', 'Cache-Control': 'private, max-age=3600' } }) }
  catch (error) { if (error instanceof IntegrationError) throw error; throw new IntegrationError('OSS_IMAGE_UPLOAD', '图片保存到 OSS 失败。', 502) }
  return key
}
export const imageUrl = async (key: string, tenantId: string) => imagePreviewClient().signatureUrlV4('GET', 3600, undefined, checkedKey(key, tenantId))
export async function readImage(key: string, tenantId: string) {
  try {
    const result = await requireImageStorage().get(checkedKey(key, tenantId))
    if (!Buffer.isBuffer(result.content)) throw new Error('unexpected content')
    return result.content as Buffer
  } catch { throw new IntegrationError('OSS_IMAGE_READ', '无法读取已保存的图片。', 502) }
}
export const removeImage = (key: string, tenantId: string) => requireImageStorage().delete(checkedKey(key, tenantId))

/** Decodes any supported picture and returns a PNG no larger than 4096 px per side. */
export async function toPng(bytes: Buffer) {
  try {
    const image = sharp(bytes, { limitInputPixels: 50_000_000, failOn: 'error' }).rotate()
    const png = await image.resize({ width: 4096, height: 4096, fit: 'inside', withoutEnlargement: true }).png().toBuffer()
    const meta = await sharp(png).metadata()
    if (!meta.width || !meta.height) throw new Error('no size')
    return { png, width: meta.width, height: meta.height }
  } catch { throw new IntegrationError('INVALID_IMAGE', '图片无法解码，请换一张 JPG/PNG/WebP 图片。', 400) }
}

/** Resize to an exact canvas: pad keeps the whole picture on white, crop fills the canvas around the subject. */
export async function resizeImage(bytes: Buffer, width: number, height: number, fit: 'pad' | 'crop') {
  const png = await sharp(bytes, { limitInputPixels: 50_000_000 }).rotate()
    .resize({ width, height, fit: fit === 'pad' ? 'contain' : 'cover', position: fit === 'crop' ? sharp.strategy.attention : 'centre', background: '#ffffff' })
    .flatten({ background: '#ffffff' }).png().toBuffer()
  return { png, width, height }
}

export async function download(url: string, limit = 25_000_000) {
  let response: Response
  try { response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(60_000) }) } catch { throw new IntegrationError('IMAGE_DOWNLOAD_FAILED', '生成图片下载失败。', 502) }
  if (!response.ok || !response.body) throw new IntegrationError('IMAGE_DOWNLOAD_FAILED', '生成图片已失效或无法读取。', 502)
  if (Number(response.headers.get('content-length') || 0) > limit) throw new IntegrationError('IMAGE_TOO_LARGE', '图片超过下载上限。', 400)
  const reader = response.body.getReader(), parts: Uint8Array[] = []
  let length = 0
  try { while (true) { const { done, value } = await reader.read(); if (done) break; length += value.length; if (length > limit) throw new IntegrationError('IMAGE_TOO_LARGE', '图片超过下载上限。', 400); parts.push(value) } } finally { reader.releaseLock() }
  return Buffer.concat(parts.map(p => Buffer.from(p)))
}

// ---------- sources & screening ----------
/** Product pictures from Alibaba's image CDN (the only external source accepted). */
export function sourceUrl(raw: string) {
  let url: URL
  try { url = new URL(raw.startsWith('//') ? `https:${raw}` : raw) } catch { throw new IntegrationError('IMAGE_SOURCE', '图片地址无效。', 400) }
  if (url.protocol === 'http:') url.protocol = 'https:'
  const host = /^cbu\d+\.alicdn\.com$/.test(url.hostname) || ['img.alicdn.com', 'gw.alicdn.com', 'sc04.alicdn.com', 's.alicdn.com'].includes(url.hostname)
  if (url.protocol !== 'https:' || !host || url.username || url.password || url.port) throw new IntegrationError('IMAGE_SOURCE', `只能使用阿里商品图片或已上传的图片（被拦截：${url.hostname}）。`, 400)
  return url.href
}

/** Screening results by URL; checks only what is not cached yet. Asset links are signed, so they are not cached. */
export async function screen(tenantId: string, urls: string[], cache = true): Promise<Map<string, Finding>> {
  const result = new Map<string, Finding>()
  if (cache && urls.length) {
    const rows = (await db.query('SELECT url,readable,watermark,rights_risk,reason FROM image_inspections WHERE tenant_id=$1 AND url=ANY($2::text[])', [tenantId, urls])).rows
    for (const r of rows) result.set(r.url, { readable: r.readable, watermark: r.watermark, rightsRisk: r.rights_risk, reason: r.reason })
  }
  const missing = [...new Set(urls.filter(u => !result.has(u)))]
  if (missing.length) {
    const findings = await inspectPublishingImages(missing)
    for (const f of findings) {
      const finding = { readable: f.readable, watermark: f.watermark, rightsRisk: f.rightsRisk, reason: f.reason }
      result.set(f.url, finding)
      if (cache) await db.query(`INSERT INTO image_inspections(tenant_id,url,readable,watermark,rights_risk,reason) VALUES($1,$2,$3,$4,$5,$6)
        ON CONFLICT(tenant_id,url) DO UPDATE SET readable=excluded.readable,watermark=excluded.watermark,rights_risk=excluded.rights_risk,reason=excluded.reason,checked_at=now()`,
      [tenantId, f.url, f.readable, f.watermark, f.rightsRisk, f.reason])
    }
  }
  return result
}

export async function cachedFindings(tenantId: string, urls: string[]) {
  if (!urls.length) return new Map<string, Finding>()
  const rows = (await db.query('SELECT url,readable,watermark,rights_risk,reason FROM image_inspections WHERE tenant_id=$1 AND url=ANY($2::text[])', [tenantId, urls])).rows
  return new Map(rows.map(r => [r.url as string, { readable: r.readable, watermark: r.watermark, rightsRisk: r.rights_risk, reason: r.reason } as Finding]))
}

/** Resolves a picture chosen by the user to a URL the models can read, and refuses flagged pictures. */
export async function usableSource(tenantId: string, source: { url?: string; assetId?: string }) {
  if (source.assetId) {
    const asset = (await db.query("SELECT id,oss_key,findings FROM image_assets WHERE id=$1 AND tenant_id=$2 AND status='completed'", [source.assetId, tenantId])).rows[0]
    if (!asset?.oss_key) throw new IntegrationError('IMAGE_SOURCE', '图片不存在或尚未生成完成。', 404)
    const url = await imageUrl(asset.oss_key, tenantId)
    let finding = asset.findings as Finding | null
    if (!finding) {
      finding = (await screen(tenantId, [url], false)).get(url) ?? null
      if (finding) await db.query('UPDATE image_assets SET findings=$2 WHERE id=$1', [asset.id, JSON.stringify(finding)])
    }
    if (flagged(finding)) throw new IntegrationError('IMAGE_SOURCE_RISK', `这张图片不能用于 AI 处理：${finding!.reason}`, 400)
    return { url, ref: `asset:${asset.id}` }
  }
  const url = sourceUrl(source.url ?? '')
  const finding = (await screen(tenantId, [url])).get(url)
  if (flagged(finding)) throw new IntegrationError('IMAGE_SOURCE_RISK', `这张图片不能用于 AI 处理：${finding!.reason} 请更换图片，或用「电商套图」基于其他干净图片重新生成。`, 400)
  return { url, ref: url }
}

/** A stored reference is either an Alibaba CDN URL or "asset:<id>" (signed again when the task runs). */
async function referenceUrl(tenantId: string, ref: string) {
  if (!ref.startsWith('asset:')) return ref
  const asset = (await db.query("SELECT oss_key FROM image_assets WHERE id=$1 AND tenant_id=$2 AND status='completed'", [ref.slice(6), tenantId])).rows[0]
  if (!asset?.oss_key) throw new IntegrationError('IMAGE_SOURCE', '参考图片已被删除。', 409)
  return imageUrl(asset.oss_key, tenantId)
}

// ---------- prompts ----------
const KEEP = '商品主体必须与参考图完全一致：形状、结构、颜色、材质、比例、商品本身的文字和图案都不改变，不增加或删除部件。'
const CLEAN = '画面中不要出现任何水印、店铺名、二维码、联系方式或其他品牌 Logo。'
export function editPrompt(operation: 'white_bg' | 'background', scene?: string) {
  if (operation === 'white_bg') return `${KEEP}把背景换成纯白色（#FFFFFF）摄影棚背景，商品居中、完整、占画面约 80%，加柔和自然的接地阴影，光线均匀，适合作为电商主图。${CLEAN}`
  return `${KEEP}把背景换成：${scene}。光线方向、色温和透视与商品一致，商品自然融入场景，主体清晰突出，真实摄影质感。${CLEAN}`
}

export type SuiteFacts = { title: string; category?: string | null; attributes: Record<string, string>; skus: string[]; points?: string }
export function suitePrompt(type: SuiteType, facts: SuiteFacts) {
  const attrs = Object.entries(facts.attributes).filter(([k, v]) => k && v && String(v).length <= 60).slice(0, 15).map(([k, v]) => `${k}：${v}`).join('；')
  const base = `商品：${facts.title}${facts.category ? `（类目：${facts.category}）` : ''}。${attrs ? `已知参数：${attrs}。` : ''}${facts.skus.length ? `规格：${facts.skus.slice(0, 8).join('、')}。` : ''}参考图是该商品的实拍图，${KEEP}`
  const noFake = '不得编造未提供的参数、认证、销量、功效或获奖信息。'
  const text = '画面中的文字一律使用简体中文，字体清晰、排版整齐，不出现乱码。'
  switch (type) {
    case 'suite_white': return `${base}生成电商白底主图：纯白背景（#FFFFFF），商品完整居中占画面约 80%，正面或 45° 最佳展示角度，柔和自然投影，高清摄影质感，不加任何文字。${CLEAN}`
    case 'suite_scene': return `${base}生成场景氛围图：把商品放在最符合其用途的真实使用环境中，环境干净有质感，光线自然温暖，商品是视觉焦点，不加文字。${CLEAN}`
    case 'suite_detail': return `${base}生成细节特写图：近距离微距展示商品最能体现做工与材质的部位（如表面纹理、接口、缝线、按键或结构细节），浅景深，质感清晰，可加 1–2 个简短的中文细节标注（只用已知信息）。${text}${noFake}${CLEAN}`
    case 'suite_model': return `${base}生成模特场景图：一位真实自然的亚洲模特在合适的生活或工作场景中正常使用或展示该商品，商品清晰可辨、比例真实，人物姿态自然，商业摄影风格。${CLEAN}`
    case 'suite_selling': return `${base}生成卖点图：商品放在画面一侧或中央，配 3–4 条简短卖点文字和简洁图标，卖点只能来自以下信息：${facts.points?.trim() || attrs || facts.title}。版式清爽、层次分明，适合 1688 主图。${text}${noFake}${CLEAN}`
    case 'suite_spec': return `${base}生成规格尺寸图：浅色干净背景，商品居中，用细线和箭头标注尺寸，并在一侧列出规格参数表。只能标注已知参数中出现的尺寸和规格，没有的数值不要标注、不要估算。${text}${noFake}${CLEAN}`
  }
}

export async function productFacts(tenantId: string, collectedProductId: string, points?: string): Promise<SuiteFacts & { gallery: string[]; details: string[] }> {
  const p = (await db.query('SELECT id,title,category_path,attributes,main_image_url,gallery_images,detail_images FROM collected_products WHERE id=$1 AND tenant_id=$2', [collectedProductId, tenantId])).rows[0]
  if (!p) throw new IntegrationError('NOT_FOUND', '采集商品不存在。', 404)
  const skus = (await db.query('SELECT label FROM collected_product_variants WHERE collected_product_id=$1 ORDER BY position LIMIT 12', [collectedProductId])).rows.map(r => r.label as string)
  return { title: p.title, category: p.category_path, attributes: p.attributes ?? {}, skus, points, ...productImages(p) }
}
const cleanUrls = (list: unknown) => (Array.isArray(list) ? list : []).filter((u): u is string => typeof u === 'string').flatMap(u => { try { return [sourceUrl(u)] } catch { return [] } })
/** All main pictures of a collected product, main image first, deduplicated. */
export const galleryOf = (p: Json) => [...new Set(cleanUrls([p.main_image_url, ...(p.gallery_images ?? [])]))]
/** Main pictures (first 6) and detail pictures of a collected product. */
export function productImages(p: Json) {
  return { gallery: galleryOf(p).slice(0, 6), details: [...new Set(cleanUrls(p.detail_images))] }
}

/** JPEG accepted by the 1688 photo album (≤ 2 MB, ≤ 1500 px, white instead of transparency). */
export async function albumJpeg(png: Buffer) {
  const meta = await sharp(png).metadata()
  if (!meta.width || !meta.height || Math.min(meta.width, meta.height) < 300) throw new IntegrationError('IMAGE_TOO_SMALL', '图片短边小于 300 像素，不适合作为商品主图。', 400)
  for (const quality of [90, 80, 70, 60]) {
    const bytes = await sharp(png, { limitInputPixels: 50_000_000 }).resize({ width: 1500, height: 1500, fit: 'inside', withoutEnlargement: true }).flatten({ background: '#ffffff' }).jpeg({ quality, mozjpeg: true }).toBuffer()
    if (bytes.length <= 2 * 1024 * 1024) return bytes
  }
  throw new IntegrationError('IMAGE_TOO_LARGE', '图片无法压缩到店铺相册 2MB 限制以内。', 400)
}

// ---------- worker ----------
type Asset = { id: string; tenant_id: string; operation: string; provider: string; model: string | null; reference_urls: string[]; source_url: string | null; options: Json; prompt: string | null; status: string; task_id: string | null; attempts: number; created_at: Date }
const retryable = (error: unknown) => error instanceof IntegrationError && ['APIMART_RATE_LIMIT', 'APIMART_NETWORK', 'IMAGE_MODEL_NETWORK', 'IMAGE_MODEL_TIMEOUT', 'APIMART_FAILED'].includes(error.code)

async function complete(asset: Asset, png: Buffer, cost?: number) {
  const { png: normalized, width, height } = await toPng(png)
  const key = await storeImage(asset.tenant_id, asset.id, normalized)
  let finding: Finding | undefined
  try { const url = await imageUrl(key, asset.tenant_id); finding = (await screen(asset.tenant_id, [url], false)).get(url) }
  catch { finding = { readable: false, watermark: false, rightsRisk: false, reason: '生成结果未能完成复检，请人工确认后再使用。' } }
  await db.query("UPDATE image_assets SET status='completed',oss_key=$2,width=$3,height=$4,bytes=$5,findings=$6,cost=$7,error=NULL,lease_until=NULL,updated_at=now() WHERE id=$1",
    [asset.id, key, width, height, normalized.length, JSON.stringify(finding ?? null), cost ?? null])
}
async function fail(asset: Asset, error: unknown) {
  const message = error instanceof IntegrationError ? error.message : '图片处理失败，请重试。'
  if (retryable(error) && asset.attempts < 4 && Date.now() - new Date(asset.created_at).getTime() < 20 * 60_000) {
    await db.query("UPDATE image_assets SET next_poll_at=now()+($2::int*interval '20 seconds'),lease_until=NULL,error=$3,updated_at=now() WHERE id=$1", [asset.id, asset.attempts, message])
    return
  }
  await db.query("UPDATE image_assets SET status='failed',error=$2,lease_until=NULL,updated_at=now() WHERE id=$1", [asset.id, message])
}

async function step(asset: Asset) {
  try {
    if (asset.provider === 'qwen') {
      const source = await referenceUrl(asset.tenant_id, asset.reference_urls[0])
      const generated = await generateQwenImage({ model: (asset.model ?? 'qwen-image-3.0') as ImageModel, prompt: asset.prompt!, sourceUrl: source })
      await complete(asset, await download(generatedImageUrl(generated)))
      return
    }
    if (asset.status === 'pending') {
      const refs = await Promise.all(asset.reference_urls.map(r => referenceUrl(asset.tenant_id, r)))
      const taskId = await submitImageTask({ model: asset.model as SuiteModel, prompt: asset.prompt!, imageUrls: refs, size: asset.options.size ?? '1:1', resolution: asset.options.resolution ?? '1k', quality: asset.options.quality ?? 'medium' })
      await db.query("UPDATE image_assets SET status='processing',task_id=$2,next_poll_at=now()+interval '8 seconds',lease_until=NULL,error=NULL,updated_at=now() WHERE id=$1", [asset.id, taskId])
      return
    }
    const task = await getImageTask(asset.task_id!)
    if (task.status === 'completed') { await complete(asset, await download(resultUrl(task.url!)), task.cost); return }
    if (task.status === 'failed') { await db.query("UPDATE image_assets SET status='failed',error=$2,lease_until=NULL,updated_at=now() WHERE id=$1", [asset.id, `生成失败：${task.error}`]); return }
    if (Date.now() - new Date(asset.created_at).getTime() > 20 * 60_000) { await db.query("UPDATE image_assets SET status='failed',error='生成超时（超过 20 分钟），请重试。',lease_until=NULL,updated_at=now() WHERE id=$1", [asset.id]); return }
    await db.query("UPDATE image_assets SET next_poll_at=now()+interval '4 seconds',lease_until=NULL,updated_at=now() WHERE id=$1", [asset.id])
  } catch (error) { await fail(asset, error) }
}

async function claim(limit: number) {
  return (await db.query(`WITH next AS (SELECT id FROM image_assets WHERE status IN ('pending','processing') AND next_poll_at<=now() AND (lease_until IS NULL OR lease_until<now())
      ORDER BY next_poll_at LIMIT $1 FOR UPDATE SKIP LOCKED)
    UPDATE image_assets a SET lease_until=now()+interval '12 minutes',attempts=a.attempts+CASE WHEN a.status='pending' THEN 1 ELSE 0 END FROM next WHERE a.id=next.id RETURNING a.*`, [limit])).rows as Asset[]
}

/**
 * Agent replacement: screens the main pictures of newly collected products (collected after the switch was turned on)
 * and, for each flagged picture, queues a newly generated picture of the same slot made only from unflagged pictures.
 */
export async function screenNextProduct() {
  if (!apimartConfigured()) return false
  const p = (await db.query(`SELECT cp.id,cp.tenant_id,s.suite_model,s.suite_quality FROM collected_products cp JOIN image_workshop_settings s ON s.tenant_id=cp.tenant_id AND s.auto_replace
    WHERE cp.images_screened_at IS NULL AND cp.collected_at>=s.enabled_at ORDER BY cp.collected_at LIMIT 1 FOR UPDATE OF cp SKIP LOCKED`)).rows[0]
  if (!p) return false
  await db.query('UPDATE collected_products SET images_screened_at=now() WHERE id=$1', [p.id])
  await queueReplacements(p.tenant_id, p.id, null, 'agent', p.suite_model, p.suite_quality)
  return true
}

/** Returns how many flagged main pictures there are and how many replacements were queued. */
export async function queueReplacements(tenantId: string, productId: string, actorId: string | null, trigger: 'manual' | 'agent', model: SuiteModel, quality: SuiteQuality) {
  const facts = await productFacts(tenantId, productId)
  const findings = await screen(tenantId, facts.gallery)
  const bad = facts.gallery.map((url, index) => ({ url, index })).filter(g => flagged(findings.get(g.url)))
  const clean = facts.gallery.filter(url => !flagged(findings.get(url)))
  if (!bad.length || !clean.length || !apimartConfigured()) return { flagged: bad.length, queued: 0, clean: clean.length }
  const existing = new Set((await db.query("SELECT replaces_index FROM image_assets WHERE collected_product_id=$1 AND replaces_index IS NOT NULL AND status<>'failed'", [productId])).rows.map(r => r.replaces_index))
  const batch = randomUUID()
  let queued = 0
  for (const { index } of bad) {
    if (existing.has(index)) continue
    const type = SUITE_TYPES[Math.min(index, SUITE_TYPES.length - 1)]
    await db.query(`INSERT INTO image_assets(tenant_id,collected_product_id,batch_id,operation,provider,model,reference_urls,replaces_index,options,prompt,trigger,created_by)
      VALUES($1,$2,$3,$4,'apimart',$5,$6,$7,$8,$9,$10,$11)`, [tenantId, productId, batch, type, model, JSON.stringify(clean.slice(0, 4)), index, JSON.stringify({ size: '1:1', resolution: '1k', quality }), suitePrompt(type, facts), trigger, actorId])
    queued++
  }
  return { flagged: bad.length, queued, clean: clean.length }
}

export function startImageWorker(onError: (error: unknown) => void = () => {}) {
  let stopped = false, ticking = false
  const active = new Set<Promise<unknown>>()
  const tick = async () => {
    if (stopped || ticking) return
    ticking = true
    try {
      const free = config.IMAGE_WORKER_CONCURRENCY - active.size
      if (free > 0) for (const asset of await claim(free)) {
        const task = step(asset).catch(onError).finally(() => active.delete(task))
        active.add(task)
      }
      await screenNextProduct()
    } finally { ticking = false }
  }
  const timer = setInterval(() => void tick().catch(onError), config.IMAGE_WORKER_POLL_MS)
  void tick().catch(onError)
  return async () => {
    stopped = true; clearInterval(timer)
    await Promise.race([Promise.allSettled([...active]), new Promise(resolve => setTimeout(resolve, 15_000))])
  }
}
export const runImageWorkerOnce = async () => { const assets = await claim(8); await Promise.all(assets.map(step)); return assets.length }
