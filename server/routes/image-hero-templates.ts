import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import sharp from 'sharp'
import { requirePermission } from '../auth.js'
import { db } from '../db.js'
import { IntegrationError } from '../integrations/1688.js'
import { CUSTOM_HERO_FRAME, prepareCustomHeroFrame } from '../integrations/hero-reference-frame.js'
import { heroShop, listHeroShops, SHOP_HERO_MODES } from '../integrations/shop-hero-templates.js'
import { imageUrl, removeImage, storeImage, toPng } from '../integrations/image-workshop.js'

async function present(shop: Awaited<ReturnType<typeof heroShop>>, tenantId: string) {
  return {
    id: shop.id, display_name: shop.display_name, mode: shop.mode, revision: shop.revision,
    hasCustom: Boolean(shop.custom_key),
    previewUrl: shop.custom_key ? await imageUrl(shop.custom_key, tenantId).catch(() => null) : null,
  }
}

export async function imageHeroTemplateRoutes(app: FastifyInstance) {
  app.get('/hero-templates', { preHandler: requirePermission('collection:read') }, async (request, reply) => {
    const { tenantId } = request.authUser
    reply.header('Cache-Control', 'private, no-store')
    return { data: await Promise.all((await listHeroShops(tenantId)).map(shop => present(shop, tenantId))) }
  })

  app.put('/hero-templates/:id', { preHandler: requirePermission('integration:manage'), bodyLimit: 12_000_000 }, async request => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const { mode, revision, content } = z.object({
      mode: z.enum(SHOP_HERO_MODES), revision: z.number().int().nonnegative(),
      content: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/).max(11_500_000).optional(),
    }).strict().parse(request.body)
    if (content && mode !== CUSTOM_HERO_FRAME) throw new IntegrationError('HERO_TEMPLATE_MODE', '上传图片时请选择自定义模板。', 400)
    const { tenantId, sub } = request.authUser
    const shop = await heroShop(tenantId, id)
    const stale = () => new IntegrationError('HERO_TEMPLATE_CONFLICT', '此店铺的模板已变更，请刷新后重试。', 409)
    if (revision !== shop.revision) throw stale()
    if (mode === CUSTOM_HERO_FRAME && !content && !shop.custom_key) throw new IntegrationError('HERO_TEMPLATE_FILE', '请先上传该店铺的模板图片。', 400)
    let uploaded: string | null = null
    if (content) {
      const input = Buffer.from(content, 'base64')
      const meta = await sharp(input, { limitInputPixels: 50_000_000 }).metadata().catch(() => null)
      if (!meta?.format || !['png', 'jpeg', 'webp'].includes(meta.format)) throw new IntegrationError('HERO_TEMPLATE_FILE', '请上传 PNG、JPG 或 WebP 图片。', 400)
      const { png, width, height } = await toPng(input)
      if (Math.min(width, height) < 300) throw new IntegrationError('HERO_TEMPLATE_SIZE', '模板图片短边至少需要 300 像素。', 400)
      uploaded = await storeImage(tenantId, randomUUID(), await prepareCustomHeroFrame(png, width, height))
    }
    const customKey = uploaded ?? shop.custom_key
    const client = await db.connect().catch(async error => {
      if (uploaded) await removeImage(uploaded, tenantId).catch(() => {})
      throw error
    })
    let savedRevision: number
    try {
      await client.query('BEGIN')
      const saved = (await client.query<{ revision: number }>(`INSERT INTO image_shop_hero_templates(connection_id,mode,custom_key)
        SELECT id,$3,$4 FROM integration_1688_connections WHERE id=$1 AND tenant_id=$2
        ON CONFLICT(connection_id) DO UPDATE SET mode=excluded.mode,custom_key=excluded.custom_key,
          revision=image_shop_hero_templates.revision+1,updated_at=now()
        WHERE image_shop_hero_templates.revision=$5 RETURNING revision`, [id, tenantId, mode, customKey, revision])).rows[0]
      if (!saved) throw stale()
      savedRevision = saved.revision
      await client.query(`INSERT INTO audit_logs(tenant_id,actor_id,action,entity_type,entity_id,after_data,request_id)
        VALUES($1,$2,'image.hero_template.update','1688_connection',$3,$4,$5)`,
      [tenantId, sub, id, JSON.stringify({ mode, uploaded: Boolean(uploaded), revision: savedRevision }), request.id])
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      if (uploaded) await removeImage(uploaded, tenantId).catch(() => {})
      throw error
    } finally { client.release() }
    // Previous uploads remain private and readable by jobs that captured their key before this update.
    return { data: await present({ ...shop, mode, custom_key: customKey, revision: savedRevision }, tenantId) }
  })
}
