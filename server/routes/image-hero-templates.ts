import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { PoolClient } from 'pg'
import { z } from 'zod'
import sharp from 'sharp'
import { requirePermission } from '../auth.js'
import { db } from '../db.js'
import { IntegrationError } from '../integrations/1688.js'
import { CUSTOM_HERO_FRAME, prepareCustomHeroFrame } from '../integrations/hero-reference-frame.js'
import { heroShop, listHeroShops, SHOP_HERO_MODES, type ShopHeroCopy, type ShopHeroMode } from '../integrations/shop-hero-templates.js'
import { imageUrl, removeImage, storeImage, toPng } from '../integrations/image-workshop.js'

const shopPath = z.object({ id: z.string().uuid() })
const templatePath = shopPath.extend({ templateId: z.string().uuid() })
const revisionBody = z.object({ revision: z.number().int().nonnegative() })
const nameInput = z.string().trim().min(1).max(80)
const imageInput = z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/).max(11_500_000)
const stale = () => new IntegrationError('HERO_TEMPLATE_CONFLICT', '此店铺的模板已变更，请刷新后重试。', 409)
const missingTemplate = () => new IntegrationError('HERO_TEMPLATE_NOT_FOUND', '该店铺没有这个自定义模板。', 404)
type Shop = Awaited<ReturnType<typeof heroShop>>
type Selection = { mode: ShopHeroMode; templateId: string | null; copy?: ShopHeroCopy }

async function present(shop: Shop, tenantId: string) {
  return {
    id: shop.id, display_name: shop.display_name, mode: shop.mode, revision: shop.revision, activeTemplateId: shop.active_template_id,
    heroOrigin: shop.hero_origin, heroNotes: shop.hero_notes,
    templates: await Promise.all(shop.templates.map(async template => ({
      id: template.id, name: template.name, adaptive: template.frame_insets !== null,
      previewUrl: await imageUrl(template.storage_key, tenantId).catch(() => null),
    }))),
  }
}

async function uploadTemplate(tenantId: string, content: string) {
  const input = Buffer.from(content, 'base64')
  const meta = await sharp(input, { limitInputPixels: 50_000_000 }).metadata().catch(() => null)
  if (!meta?.format || !['png', 'jpeg', 'webp'].includes(meta.format)) throw new IntegrationError('HERO_TEMPLATE_FILE', '请上传 PNG、JPG 或 WebP 图片。', 400)
  const { png, width, height } = await toPng(input)
  if (Math.min(width, height) < 300) throw new IntegrationError('HERO_TEMPLATE_SIZE', '模板图片短边至少需要 300 像素。', 400)
  const { frame, insets } = await prepareCustomHeroFrame(png, width, height)
  return { key: await storeImage(tenantId, randomUUID(), frame), insets }
}

async function mutateShop(
  request: FastifyRequest, id: string, revision: number, operation: string,
  change: (client: PoolClient, shop: Shop) => Promise<Selection | void>, uploaded?: string,
) {
  const { tenantId, sub } = request.authUser
  let client: PoolClient | undefined
  let committing = false
  let updated: Shop
  try {
    client = await db.connect()
    await client.query('BEGIN')
    const locked = await client.query('SELECT id FROM integration_1688_connections WHERE id=$1 AND tenant_id=$2 FOR UPDATE', [id, tenantId])
    if (!locked.rowCount) throw new IntegrationError('HERO_SHOP_NOT_FOUND', '店铺不存在。', 404)
    const shop = await heroShop(tenantId, id, client)
    if (shop.revision !== revision) throw stale()
    const selected: Selection = await change(client, shop) ?? { mode: shop.mode, templateId: shop.active_template_id }
    const copy = selected.copy ?? { origin: shop.hero_origin, notes: shop.hero_notes }
    await client.query(`INSERT INTO image_shop_hero_templates(connection_id,mode,active_template_id,hero_origin,hero_notes)
      VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(connection_id) DO UPDATE SET mode=excluded.mode,active_template_id=excluded.active_template_id,
        hero_origin=excluded.hero_origin,hero_notes=excluded.hero_notes,
        revision=image_shop_hero_templates.revision+1,updated_at=now()`, [id, selected.mode, selected.templateId, copy.origin, JSON.stringify(copy.notes)])
    await client.query(`INSERT INTO audit_logs(tenant_id,actor_id,action,entity_type,entity_id,after_data,request_id)
      VALUES($1,$2,'image.hero_template.update','1688_connection',$3,$4,$5)`,
    [tenantId, sub, id, JSON.stringify({ operation, ...selected, revision: revision + 1 }), request.id])
    updated = await heroShop(tenantId, id, client)
    committing = true
    await client.query('COMMIT')
  } catch (error) {
    await client?.query('ROLLBACK').catch(() => {})
    // An ambiguous commit may have saved the key, so keep the file in that case.
    if (uploaded && !committing) await removeImage(uploaded, tenantId).catch(() => {})
    if ((error as { constraint?: string }).constraint === 'image_shop_hero_custom_templates_name_unique') {
      throw new IntegrationError('HERO_TEMPLATE_NAME_TAKEN', '该店铺已有同名模板。', 409)
    }
    throw error
  } finally {
    client?.release()
  }
  return { data: await present(updated, tenantId) }
}

export async function imageHeroTemplateRoutes(app: FastifyInstance) {
  const manage = requirePermission('integration:manage')
  app.get('/hero-templates', { preHandler: requirePermission('collection:read') }, async (request, reply) => {
    const { tenantId } = request.authUser
    reply.header('Cache-Control', 'private, no-store')
    return { data: await Promise.all((await listHeroShops(tenantId)).map(shop => present(shop, tenantId))) }
  })

  app.put('/hero-templates/:id', { preHandler: manage }, async request => {
    const { id } = shopPath.parse(request.params)
    const { mode, templateId, revision } = revisionBody.extend({
      mode: z.enum(SHOP_HERO_MODES), templateId: z.string().uuid().optional(),
    }).strict().parse(request.body)
    if ((mode === CUSTOM_HERO_FRAME) !== Boolean(templateId)) throw new IntegrationError('HERO_TEMPLATE_MODE', '请选择对应的首图模板。', 400)
    return mutateShop(request, id, revision, 'select', async (_client, shop) => {
      if (templateId && !shop.templates.some(template => template.id === templateId)) throw missingTemplate()
      return { mode, templateId: templateId ?? null }
    })
  })

  app.put('/hero-templates/:id/copy', { preHandler: manage }, async request => {
    const { id } = shopPath.parse(request.params)
    const text = (max: number) => z.string().trim().min(1).max(max).regex(/^[^<>\r\n]+$/)
    const { revision, origin, notes } = revisionBody.extend({
      origin: text(24).nullable(), notes: z.array(text(16)).max(2).refine(items => new Set(items).size === items.length),
    }).strict().parse(request.body)
    return mutateShop(request, id, revision, 'copy', async (_client, shop) => ({
      mode: shop.mode, templateId: shop.active_template_id, copy: { origin, notes },
    }))
  })

  app.post('/hero-templates/:id/custom', { preHandler: manage, bodyLimit: 12_000_000 }, async (request, reply) => {
    const { id } = shopPath.parse(request.params)
    const { name, revision, content } = revisionBody.extend({
      name: nameInput, content: imageInput,
    }).strict().parse(request.body)
    const { tenantId } = request.authUser
    const shop = await heroShop(tenantId, id)
    if (shop.revision !== revision) throw stale()
    const { key, insets } = await uploadTemplate(tenantId, content)
    const saved = await mutateShop(request, id, revision, 'create', async client => {
      await client.query('INSERT INTO image_shop_hero_custom_templates(connection_id,name,storage_key,frame_insets) VALUES($1,$2,$3,$4)', [id, name, key, insets])
    }, key)
    return reply.code(201).send(saved)
  })

  app.patch('/hero-templates/:id/custom/:templateId', { preHandler: manage, bodyLimit: 12_000_000 }, async request => {
    const { id, templateId } = templatePath.parse(request.params)
    const { name, revision, content } = revisionBody.extend({ name: nameInput, content: imageInput.optional() }).strict().parse(request.body)
    const { tenantId } = request.authUser
    let image: Awaited<ReturnType<typeof uploadTemplate>> | undefined
    if (content) {
      const shop = await heroShop(tenantId, id)
      if (shop.revision !== revision) throw stale()
      if (!shop.templates.some(template => template.id === templateId)) throw missingTemplate()
      image = await uploadTemplate(tenantId, content)
    }
    return mutateShop(request, id, revision, 'edit', async client => {
      const updated = await client.query(`UPDATE image_shop_hero_custom_templates
        SET name=$3,storage_key=coalesce($4,storage_key),frame_insets=CASE WHEN $4 IS NULL THEN frame_insets ELSE $5 END
        WHERE connection_id=$1 AND id=$2`, [id, templateId, name, image?.key ?? null, image?.insets ?? null])
      if (!updated.rowCount) throw missingTemplate()
    }, image?.key)
  })

  app.delete('/hero-templates/:id/custom/:templateId', { preHandler: manage }, async request => {
    const { id, templateId } = templatePath.parse(request.params)
    const { revision } = revisionBody.strict().parse(request.body)
    return mutateShop(request, id, revision, 'delete', async (client, shop) => {
      // Jobs already queued may still need the image under its captured storage key.
      const deleted = await client.query('DELETE FROM image_shop_hero_custom_templates WHERE connection_id=$1 AND id=$2', [id, templateId])
      if (!deleted.rowCount) throw missingTemplate()
      if (shop.active_template_id === templateId) return { mode: 'none', templateId: null }
    })
  })
}
