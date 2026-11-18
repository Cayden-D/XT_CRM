import sharp from 'sharp'
import { teamOf } from '../integrations/teams.js'
import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { requirePermission, requireSuperAdmin } from '../auth.js'
import { config } from '../config.js'
import { db } from '../db.js'
import { IntegrationError } from '../integrations/1688.js'
import {
  cachedFindings, checkPrompt, download, editPrompt, flagged, imageUrl, productFacts, productImages, queueReplacements, readImage, removeImage,
  resizeImage, screen, storeImage, detailNames, HERO_BADGES, heroCopy, MAX_HERO_BADGES, type SuiteFacts, suiteDesign, suiteNames, SUITE_TYPES, toPng, usableSource,
} from '../integrations/image-workshop.js'
import { apimartConfigured } from '../llm/apimart-image.js'
import { imageGenerationSettings, imagePlanOf, imagePlanOptions, imagePlans } from '../integrations/image-generation-settings.js'
import { imageServiceMessage } from '../integrations/image-service-message.js'
import { brandById, checkBrandShop, defaultBrand, ownBrandNames } from '../integrations/brands.js'
import { imageAlbumRoutes } from './image-album.js'
import { brandRoutes } from './image-brands.js'
import { imageHeroTemplateRoutes } from './image-hero-templates.js'
import { heroDesignForShop } from '../integrations/shop-hero-templates.js'

const tenant = (request: FastifyRequest) => request.authUser.tenantId
const idParams = z.object({ id: z.string().uuid() })
const shopInput = z.string().uuid().nullable().optional()
const source = z.object({ url: z.string().max(2000).optional(), assetId: z.string().uuid().optional() }).strict().refine(s => Boolean(s.url) !== Boolean(s.assetId), '请选择一张图片。')
const RESIZE_PRESETS = { '800x800': [800, 800], '750x1000': [750, 1000], '1000x1000': [1000, 1000], '1080x1080': [1080, 1080], '1200x1200': [1200, 1200], '790x1000': [790, 1000] } as const
const operationNames: Record<string, string> = { upload: '上传', white_bg: '白底图', background: '换背景', resize: '改尺寸', ...suiteNames, ...detailNames }
const audit = (request: FastifyRequest, action: string, entityId: string, data: object) => db.query(
  "INSERT INTO audit_logs(tenant_id,actor_id,action,entity_type,entity_id,after_data,request_id)VALUES($1,$2,$3,'image_asset',$4,$5,$6)",
  [tenant(request), request.authUser.sub, action, entityId, JSON.stringify(data), request.id])

export async function present(row: Record<string, any>) {
  const { oss_key, tenant_id, task_id, lease_until, next_poll_at, reference_urls, model, provider, error, ...rest } = row
  const { heroFrameKey: _heroFrameKey, quality, resolution, ...options } = rest.options ?? {}
  return { ...rest, options, error: imageServiceMessage(error ?? null), canRetry: row.status === 'failed' && provider !== 'local', label: operationNames[row.operation] ?? row.operation, url: oss_key && row.status === 'completed' ? await imageUrl(oss_key, tenant_id) : null, risky: row.status === 'completed' && (!row.findings || flagged(row.findings)) }
}
export const assetColumns = 'id,tenant_id,collected_product_id,batch_id,operation,provider,model,source_url,reference_urls,replaces_index,options,status,task_id,lease_until,next_poll_at,oss_key,width,height,bytes,findings,error,cost,trigger,photo_status,photo_url,photo_connection_id,photo_album_id,photo_uploaded_at,applied_to,applied_at,created_at,updated_at'
async function settingsOf(tenantId: string) {
  return (await db.query('SELECT auto_replace,hero_badges,enabled_at,revision,updated_at FROM image_workshop_settings WHERE tenant_id=$1', [tenantId])).rows[0]
    ?? { auto_replace: false, hero_badges: HERO_BADGES, enabled_at: null, revision: 0, updated_at: null }
}
const RATIOS = [[1, 1], [4, 3], [3, 4], [3, 2], [2, 3]] as const
const nearestRatio = (size: { width: number; height: number } | null) => {
  if (!size?.width || !size.height) return '1:1'
  const target = Math.log(size.width / size.height)
  const [w, h] = RATIOS.reduce((best, r) => Math.abs(Math.log(r[0] / r[1]) - target) < Math.abs(Math.log(best[0] / best[1]) - target) ? r : best)
  return `${w}:${h}`
}
/** The source picture's size: stored for our own pictures, else read from the picture. */
async function sourceSize(tenantId: string, source: { assetId?: string }, url: string) {
  if (source.assetId) { const row = (await db.query('SELECT width,height FROM image_assets WHERE id=$1 AND tenant_id=$2', [source.assetId, tenantId])).rows[0]; if (row?.width) return row }
  try { const meta = await sharp(await download(url, 15_000_000)).metadata(); return meta.width && meta.height ? { width: meta.width, height: meta.height } : null } catch { return null }
}
async function ensureProduct(tenantId: string, id: string) {
  if (!(await db.query('SELECT 1 FROM collected_products WHERE id=$1 AND tenant_id=$2', [id, tenantId])).rows.length) throw new IntegrationError('NOT_FOUND', '采集商品不存在。', 404)
}

export async function imageWorkshopRoutes(app: FastifyInstance) {
  // Integration errors carry a code and a message meant for the user (also for 5xx: "not configured", model failures).
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof IntegrationError) return reply.code(error.statusCode).send({ error: error.code, message: error.message })
    if (error instanceof z.ZodError) { const issue = error.issues[0]; return reply.code(400).send({ error: 'VALIDATION_ERROR', message: issue?.code === 'custom' ? issue.message : `请求参数不正确${issue?.path.length ? `（${issue.path.join('.')}）` : ''}。` }) }
    const status = (error as { statusCode?: number }).statusCode
    if (status && status < 500) return reply.code(status).send({ error: 'REQUEST_ERROR', message: error instanceof Error ? error.message : '请求无效。' })
    request.log.error(error)
    return reply.code(500).send({ error: 'INTERNAL_SERVER_ERROR', message: '图片处理失败，请稍后重试。' })
  })
  app.get('/settings', { preHandler: requirePermission('collection:read') }, async request => ({
    data: await settingsOf(tenant(request)),
    services: { screening: Boolean(config.DASHSCOPE_API_KEY), generation: apimartConfigured(), oss: Boolean(config.OSS_BUCKET && config.OSS_ACCESS_KEY_ID) },
  }))

  app.get('/generation-settings', { preHandler: requireSuperAdmin }, async request => {
    const { model, ...settings } = await imageGenerationSettings(tenant(request))
    return { data: { ...settings, replacementPlan: imagePlanOf(model) }, plans: imagePlanOptions.filter(plan => plan.id !== 'image-c') }
  })

  app.put('/generation-settings', { preHandler: requireSuperAdmin }, async request => {
    const input = z.object({
      replacementPlan: z.enum(['image-a', 'image-b']),
      quality: z.enum(['low', 'medium', 'high', 'xhigh']),
      resolution: z.enum(['1k', '2k']),
      revision: z.number().int().nonnegative(),
    }).strict().parse(request.body)
    const { replacementPlan, quality, resolution, revision } = input
    const saved = (await db.query<{ revision: number }>(`
      WITH saved AS (
        INSERT INTO image_workshop_settings(tenant_id,suite_model,suite_quality,suite_resolution,updated_by)
        SELECT $1::uuid,$2::text,$3::text,$4::text,$5::uuid
        WHERE $6::int=0 OR EXISTS(SELECT 1 FROM image_workshop_settings WHERE tenant_id=$1)
        ON CONFLICT(tenant_id) DO UPDATE SET suite_model=excluded.suite_model,suite_quality=excluded.suite_quality,
          suite_resolution=excluded.suite_resolution,revision=image_workshop_settings.revision+1,updated_by=excluded.updated_by,updated_at=now()
        WHERE image_workshop_settings.revision=$6 RETURNING revision
      ), audited AS (
        INSERT INTO audit_logs(tenant_id,actor_id,action,entity_type,entity_id,after_data,request_id)
        SELECT $1,$5,'image.generation.settings.update','image_asset',$1,$7,$8 FROM saved
      )
      SELECT revision FROM saved`,
    [tenant(request), imagePlans[replacementPlan].model, quality, resolution, request.authUser.sub, revision,
      JSON.stringify({ replacementPlan, quality, resolution }), request.id])).rows[0]
    if (!saved) throw new IntegrationError('SETTINGS_CONFLICT', '设置已被他人修改，请刷新后重试。', 409)
    return { data: { replacementPlan, quality, resolution, revision: saved.revision } }
  })

  app.put('/settings', { preHandler: requirePermission('integration:manage') }, async request => {
    const input = z.object({ autoReplace: z.boolean(),
      // 1688 首图 core terms: each short and plain text, at most MAX_HERO_BADGES, no duplicates.
      heroBadges: z.array(z.string().trim().min(1, '优势不能为空。').max(12, '每条优势最多 12 个字。').regex(/^[^<>\n\r]+$/)).max(MAX_HERO_BADGES, `首图优势最多 ${MAX_HERO_BADGES} 条。`).refine(v => new Set(v).size === v.length, '首图优势有重复。').optional(),
      revision: z.number().int().min(0), confirmed: z.boolean().optional() }).strict().parse(request.body)
    // Consent is asked when switching on, not again for every later change while it stays on.
    const current = await settingsOf(tenant(request))
    if (input.autoReplace && !current.auto_replace && !input.confirmed) throw new IntegrationError('CONFIRM_REQUIRED', '开启前请确认图片资料发送至图片生成服务并产生费用。', 400)
    if (input.autoReplace && !apimartConfigured()) throw new IntegrationError('APIMART_NOT_CONFIGURED', '图片生成服务暂不可用，请联系管理员。', 503)
    for (const badge of input.heroBadges ?? []) checkPrompt(badge)
    const saved = (await db.query(`INSERT INTO image_workshop_settings(tenant_id,auto_replace,hero_badges,enabled_at,revision,updated_by)
      VALUES($1,$2,coalesce($5::jsonb,$6::jsonb),CASE WHEN $2 THEN now() END,1,$4)
      ON CONFLICT(tenant_id) DO UPDATE SET auto_replace=excluded.auto_replace,
      hero_badges=coalesce($5::jsonb,image_workshop_settings.hero_badges),
      enabled_at=CASE WHEN excluded.auto_replace AND NOT image_workshop_settings.auto_replace THEN now() WHEN excluded.auto_replace THEN image_workshop_settings.enabled_at END,
      revision=image_workshop_settings.revision+1,updated_by=excluded.updated_by,updated_at=now()
      WHERE image_workshop_settings.revision=$3 RETURNING tenant_id`,
    [tenant(request), input.autoReplace, input.revision, request.authUser.sub, input.heroBadges ? JSON.stringify(input.heroBadges) : null, JSON.stringify(HERO_BADGES)])).rows[0]
    if (!saved) throw new IntegrationError('SETTINGS_CONFLICT', '设置已被他人修改，请刷新后重试。', 409)
    await audit(request, 'image.settings.update', randomUUID(), { autoReplace: input.autoReplace, heroBadges: input.heroBadges })
    return { data: await settingsOf(tenant(request)) }
  })

  // Pictures of one collected product with cached screening results and the pictures made from it.
  app.get('/products/:id', { preHandler: requirePermission('collection:read') }, async request => {
    const { id } = idParams.parse(request.params)
    const { connectionId } = z.object({ connectionId: z.union([z.string().uuid(), z.literal('shared')]).optional() }).parse(request.query)
    const p = (await db.query(`SELECT p.main_image_url,p.gallery_images,p.detail_images,p.images_screened_at,coalesce(j.connection_id,p.target_connection_id) AS shop_id
      FROM collected_products p LEFT JOIN integration_1688_collection_queue_jobs j ON j.collected_product_id=p.id AND j.tenant_id=p.tenant_id AND j.status<>'cancelled'
      WHERE p.id=$1 AND p.tenant_id=$2`, [id, tenant(request)])).rows[0]
    if (!p) throw new IntegrationError('NOT_FOUND', '采集商品不存在。', 404)
    const { gallery, details } = productImages(p)
    const target = connectionId === 'shared' ? null : connectionId ?? p.shop_id
    await checkBrandShop(tenant(request), target)
    const findings = await cachedFindings(tenant(request), [...gallery, ...details], await ownBrandNames(tenant(request), target))
    const assets = (await db.query(`SELECT ${assetColumns} FROM image_assets WHERE collected_product_id=$1 AND tenant_id=$2 ORDER BY created_at DESC LIMIT 60`, [id, tenant(request)])).rows
    return { data: {
      gallery: gallery.map(url => ({ url, finding: findings.get(url) ?? null })),
      details: details.map(url => ({ url, finding: findings.get(url) ?? null })),
      screenedAt: p.images_screened_at, connectionId: target ?? null, assets: await Promise.all(assets.map(present)),
    } }
  })

  // Screens a product's pictures (main pictures, optionally detail pictures too); results are cached per picture.
  app.post('/products/:id/screen', { preHandler: requirePermission('collection:create') }, async request => {
    const { id } = idParams.parse(request.params)
    const { details: withDetails, connectionId } = z.object({ details: z.boolean().default(false), connectionId: shopInput }).strict().parse(request.body ?? {})
    const facts = await productFacts(tenant(request), id)
    const urls = [...facts.gallery, ...(withDetails ? facts.details.slice(0, 30) : [])]
    const target = connectionId === undefined ? facts.heroShopId : connectionId
    await checkBrandShop(tenant(request), target)
    const findings = await screen(tenant(request), urls, true, await ownBrandNames(tenant(request), target))
    await db.query('UPDATE collected_products SET images_screened_at=now() WHERE id=$1', [id])
    return { data: urls.map(url => ({ url, finding: findings.get(url) ?? null })) }
  })

  // Generates replacements for flagged main pictures from the product's unflagged pictures (same as the agent switch).
  app.post('/products/:id/replace-flagged', { preHandler: requirePermission('collection:create') }, async request => {
    const { id } = idParams.parse(request.params)
    const { connectionId } = z.object({ connectionId: z.string().uuid().nullable().optional() }).strict().parse(request.body ?? {})
    const settings = await imageGenerationSettings(tenant(request))
    const result = await queueReplacements(tenant(request), id, request.authUser.sub, 'manual', settings, connectionId)
    if (!result.flagged) return { data: { ...result, message: '主图中没有被标记的图片。' } }
    if (!result.clean) throw new IntegrationError('NO_CLEAN_REFERENCE', '全部主图都带有明确水印或品牌 Logo，没有可用作参考的干净图片；请上传有使用权的实拍图后用「电商套图」生成。', 409)
    if (!apimartConfigured()) throw new IntegrationError('APIMART_NOT_CONFIGURED', '图片生成服务暂不可用，请联系管理员。', 503)
    if (result.queued) await audit(request, 'image.replace.queue', id, result)
    return { data: { ...result, message: result.queued ? `已为 ${result.queued} 张被标记主图排队生成替代图` : '替代图已在生成或已生成。' } }
  })

  app.post('/uploads', { preHandler: requirePermission('collection:create'), bodyLimit: 12_000_000 }, async request => {
    const input = z.object({ content: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/).max(11_500_000), collectedProductId: z.string().uuid().optional() }).strict().parse(request.body)
    if (input.collectedProductId) await ensureProduct(tenant(request), input.collectedProductId)
    const { png, width, height } = await toPng(Buffer.from(input.content, 'base64'))
    const id = randomUUID()
    const key = await storeImage(tenant(request), id, png)
    const row = (await db.query(`INSERT INTO image_assets(id,tenant_id,collected_product_id,operation,provider,status,oss_key,width,height,bytes,created_by)
      VALUES($1,$2,$3,'upload','local','completed',$4,$5,$6,$7,$8) RETURNING ${assetColumns}`, [id, tenant(request), input.collectedProductId ?? null, key, width, height, png.length, request.authUser.sub])).rows[0]
    return { data: await present(row) }
  })

  // 白底图 / 换背景 (queued with the source as reference) and 改尺寸 (local, immediate).
  app.post('/edits', { preHandler: requirePermission('collection:create') }, async request => {
    const input = z.object({
      source, operation: z.enum(['white_bg', 'background', 'resize']), collectedProductId: z.string().uuid().optional(),
      scene: z.string().trim().min(2).max(300).optional(),
      preset: z.enum(Object.keys(RESIZE_PRESETS) as [keyof typeof RESIZE_PRESETS]).optional(), width: z.number().int().min(100).max(4000).optional(), height: z.number().int().min(100).max(4000).optional(),
      fit: z.enum(['pad', 'crop']).default('pad'), connectionId: shopInput,
    }).strict().parse(request.body)
    const product = input.collectedProductId ? await productFacts(tenant(request), input.collectedProductId) : null
    const connectionId = input.connectionId === undefined ? product?.heroShopId : input.connectionId
    await checkBrandShop(tenant(request), connectionId)
    if (input.operation === 'background') { if (!input.scene) throw new IntegrationError('SCENE_REQUIRED', '请描述新背景。', 400); checkPrompt(input.scene) }
    const picked = await usableSource(tenant(request), input.source, connectionId)
    const scope = { listingConnectionId: picked.connectionId, referenceShopId: picked.requiredShop }
    const id = randomUUID()
    if (input.operation === 'resize') {
      const [width, height] = input.preset ? RESIZE_PRESETS[input.preset] : [input.width, input.height]
      if (!width || !height) throw new IntegrationError('SIZE_REQUIRED', '请选择或填写目标尺寸。', 400)
      const bytes = input.source.assetId
        ? await readImage((await db.query('SELECT oss_key FROM image_assets WHERE id=$1 AND tenant_id=$2', [input.source.assetId, tenant(request)])).rows[0].oss_key, tenant(request))
        : await download(picked.url)
      const { png } = await resizeImage(bytes, width, height, input.fit)
      const key = await storeImage(tenant(request), id, png)
      const row = (await db.query(`INSERT INTO image_assets(id,tenant_id,collected_product_id,operation,provider,source_url,reference_urls,options,status,oss_key,width,height,bytes,findings,created_by)
        VALUES($1,$2,$3,'resize','local',$4,$5,$6,'completed',$7,$8,$9,$10,$11,$12) RETURNING ${assetColumns}`,
      [id, tenant(request), input.collectedProductId ?? null, picked.ref, JSON.stringify([picked.ref]), JSON.stringify({ ...scope, width, height, fit: input.fit }), key, width, height, png.length,
        JSON.stringify({ readable: true, watermark: false, rightsRisk: false, reason: '仅调整尺寸，原图已通过检查。' }), request.authUser.sub])).rows[0]
      return { data: await present(row) }
    }
    if (!apimartConfigured()) throw new IntegrationError('APIMART_NOT_CONFIGURED', '图片生成服务暂不可用，请联系管理员。', 503)
    const model = (await teamOf(tenant(request), request.authUser.sub)).imageModel
    const { quality, resolution } = await imageGenerationSettings(tenant(request))
    // The edited picture keeps the source's shape: the nearest ratio the model offers (white backgrounds are square main pictures).
    const size = input.operation === 'white_bg' ? '1:1' : nearestRatio(await sourceSize(tenant(request), input.source, picked.url))
    const row = (await db.query(`INSERT INTO image_assets(id,tenant_id,collected_product_id,operation,provider,model,source_url,reference_urls,options,prompt,created_by)
      VALUES($1,$2,$3,$4,'apimart',$5,$6,$7,$8,$9,$10) RETURNING ${assetColumns}`,
    [id, tenant(request), input.collectedProductId ?? null, input.operation, model, picked.ref, JSON.stringify([picked.ref]), JSON.stringify({ ...scope, ...(input.scene ? { scene: input.scene } : {}), size, quality, resolution }), editPrompt(input.operation, input.scene), request.authUser.sub])).rows[0]
    await audit(request, 'image.edit', id, { operation: input.operation, model })
    return { data: await present(row) }
  })

  // 电商套图: generate one image per selected type from the reference pictures.
  app.post('/suites', { preHandler: requirePermission('collection:create') }, async request => {
    const input = z.object({
      collectedProductId: z.string().uuid().optional(), title: z.string().trim().min(2).max(200).optional(), points: z.string().trim().max(400).optional(),
      references: z.array(source).min(1).max(4), types: z.array(z.enum(SUITE_TYPES)).min(1).max(SUITE_TYPES.length).default([...SUITE_TYPES]),
      size: z.enum(['1:1', '3:4']).default('1:1'),
      // Left out: the default brand. null: no brand on this suite.
      brandId: z.string().uuid().nullable().optional(),
      connectionId: z.string().uuid().nullable().optional(),
    }).strict().parse(request.body)
    if (!apimartConfigured()) throw new IntegrationError('APIMART_NOT_CONFIGURED', '图片生成服务暂不可用，请联系管理员。', 503)
    if (input.points) checkPrompt(input.points)
    const settings = await settingsOf(tenant(request))
    const product = input.collectedProductId ? await productFacts(tenant(request), input.collectedProductId, input.points) : null
    const facts: SuiteFacts | null = product ?? (input.title ? { title: input.title, category: null, attributes: {}, skus: [], points: input.points, badges: settings.hero_badges } : null)
    if (!facts) throw new IntegrationError('TITLE_REQUIRED', '请选择采集商品，或填写商品名称。', 400)
    const target = input.connectionId === undefined ? product?.heroShopId ?? null : input.connectionId
    await checkBrandShop(tenant(request), target)
    const brand = input.brandId === null ? null : input.brandId ? await brandById(tenant(request), input.brandId, target) : await defaultBrand(tenant(request), target)
    if (input.brandId && !brand) throw new IntegrationError('NOT_FOUND', '品牌不存在。', 404)
    const refs: string[] = []
    let referenceShopId: string | null = null
    for (const ref of input.references) {
      const picked = await usableSource(tenant(request), ref, target)
      refs.push(picked.ref)
      referenceShopId ??= picked.requiredShop
    }
    const team = await teamOf(tenant(request), request.authUser.sub)
    if (input.types.includes('suite_hero')) {
      const design = await heroDesignForShop(tenant(request), target)
      facts.heroReferenceFrame = design.frame
      facts.shopCopy = design.copy
      facts.heroCopy = await heroCopy(facts, team.textModel)
    }
    const batch = randomUUID(), model = team.imageModel
    const { quality, resolution } = await imageGenerationSettings(tenant(request))
    const rows = []
    for (const type of new Set(input.types)) {
      const { prompt, options } = suiteDesign(type, facts, brand)
      rows.push((await db.query(`INSERT INTO image_assets(tenant_id,collected_product_id,batch_id,operation,provider,model,reference_urls,options,prompt,created_by)
        VALUES($1,$2,$3,$4,'apimart',$5,$6,$7,$8,$9) RETURNING ${assetColumns}`,
      [tenant(request), input.collectedProductId ?? null, batch, type, model, JSON.stringify([...new Set(refs)]), JSON.stringify({ size: input.size, quality, resolution, title: facts.title, listingConnectionId: target, referenceShopId, ...options }), prompt, request.authUser.sub])).rows[0])
    }
    await audit(request, 'image.suite', batch, { types: input.types, model, quality, resolution, collectedProductId: input.collectedProductId ?? null, brandId: brand?.id ?? null, heroShopId: facts.heroReferenceFrame?.connectionId })
    return { data: { batchId: batch, assets: await Promise.all(rows.map(present)) } }
  })

  app.get('/assets', { preHandler: requirePermission('collection:read') }, async request => {
    const q = z.object({ kind: z.enum(['edit', 'suite', 'upload']).optional(), collectedProductId: z.string().uuid().optional(), batchId: z.string().uuid().optional(), ids: z.string().max(2000).optional(),
      page: z.coerce.number().int().min(1).max(1000).default(1), pageSize: z.coerce.number().int().min(1).max(60).default(24) }).parse(request.query)
    const where = ['tenant_id=$1'], values: unknown[] = [tenant(request)]
    const add = (sql: string, value: unknown) => { values.push(value); where.push(sql.replace('?', `$${values.length}`)) }
    if (q.kind === 'edit') where.push("operation IN ('white_bg','background','resize')")
    if (q.kind === 'suite') where.push("operation LIKE 'suite_%'")
    if (q.kind === 'upload') where.push("operation='upload'")
    if (q.collectedProductId) add('collected_product_id=?', q.collectedProductId)
    if (q.batchId) add('batch_id=?', q.batchId)
    if (q.ids) add('id=ANY(?::uuid[])', q.ids.split(',').filter(v => /^[0-9a-f-]{36}$/.test(v)))
    const total = (await db.query(`SELECT count(*)::int AS n FROM image_assets WHERE ${where.join(' AND ')}`, values)).rows[0].n
    const rows = (await db.query(`SELECT ${assetColumns} FROM image_assets WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`, values)).rows
    const titles = new Map((await db.query('SELECT id,title FROM collected_products WHERE id=ANY($1::uuid[])', [[...new Set(rows.map(r => r.collected_product_id).filter(Boolean))]])).rows.map(r => [r.id, r.title]))
    return { data: await Promise.all(rows.map(async r => ({ ...await present(r), product_title: titles.get(r.collected_product_id) ?? r.options?.title ?? null }))), total }
  })

  app.get('/assets/:id/file', { preHandler: requirePermission('collection:read') }, async (request, reply) => {
    const { id } = idParams.parse(request.params)
    const row = (await db.query("SELECT oss_key,operation FROM image_assets WHERE id=$1 AND tenant_id=$2 AND status='completed'", [id, tenant(request)])).rows[0]
    if (!row?.oss_key) throw new IntegrationError('NOT_FOUND', '图片不存在。', 404)
    const bytes = await readImage(row.oss_key, tenant(request))
    return reply.type('image/png').header('Content-Disposition', `attachment; filename="${row.operation}-${id.slice(0, 8)}.png"`).send(bytes)
  })

  app.post('/assets/:id/retry', { preHandler: requirePermission('collection:create') }, async request => {
    const { id } = idParams.parse(request.params)
    const row = (await db.query(`UPDATE image_assets SET status='pending',task_id=NULL,attempts=0,error=NULL,next_poll_at=now(),lease_until=NULL,created_at=now(),updated_at=now()
      WHERE id=$1 AND tenant_id=$2 AND status='failed' AND provider<>'local' RETURNING ${assetColumns}`, [id, tenant(request)])).rows[0]
    if (!row) throw new IntegrationError('NOT_RETRYABLE', '只有失败的 AI 任务可以重试。', 409)
    return { data: await present(row) }
  })

  app.delete('/assets/:id', { preHandler: requirePermission('collection:create') }, async request => {
    const { id } = idParams.parse(request.params)
    const row = (await db.query("DELETE FROM image_assets WHERE id=$1 AND tenant_id=$2 AND status<>'processing' RETURNING oss_key", [id, tenant(request)])).rows[0]
    if (!row) throw new IntegrationError('NOT_FOUND', '图片不存在，或仍在生成中。', 404)
    if (row.oss_key) await removeImage(row.oss_key, tenant(request)).catch(() => {})
    return { ok: true }
  })
  await imageAlbumRoutes(app)
  await brandRoutes(app)
  await imageHeroTemplateRoutes(app)
}
