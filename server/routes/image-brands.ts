import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import sharp from 'sharp'
import { z } from 'zod'
import { requirePermission } from '../auth.js'
import { db } from '../db.js'
import { IntegrationError } from '../integrations/1688.js'
import { checkPrompt, imageUrl, removeImage, screen, storeImage } from '../integrations/image-workshop.js'

const tenant = (request: FastifyRequest) => request.authUser.tenantId
const idParams = z.object({ id: z.string().uuid() })
const name = z.string().trim().min(1).max(40).regex(/^[^<>\n\r]+$/)
const logoContent = z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/).max(7_500_000)
const aliases = z.array(name).max(5)
const LOGO_FORMATS = ['png', 'jpeg', 'webp'], MIN_LOGO_SIDE = 120, MAX_LOGO_SIDE = 1024
const COLUMNS = 'id,tenant_id,name,aliases,logo_key,logo_width,logo_height,is_default,rights_confirmed_at,created_at,updated_at'

const audit = (request: FastifyRequest, action: string, entityId: string, data: object) => db.query(
  "INSERT INTO audit_logs(tenant_id,actor_id,action,entity_type,entity_id,after_data,request_id)VALUES($1,$2,$3,'brand',$4,$5,$6)",
  [tenant(request), request.authUser.sub, action, entityId, JSON.stringify(data), request.id])

async function present(row: Record<string, any>) {
  const { logo_key, tenant_id, ...rest } = row
  return { ...rest, logo_url: logo_key ? await imageUrl(logo_key, tenant_id) : null }
}

/** Decodes a logo (raster only, transparency kept), stores it, and refuses one that is plainly another famous brand's. */
async function storeLogo(tenantId: string, content: string, names: string[]) {
  let png: Buffer, width: number, height: number
  try {
    const bytes = Buffer.from(content, 'base64'), meta = await sharp(bytes, { limitInputPixels: 50_000_000 }).metadata()
    if (!meta.format || !LOGO_FORMATS.includes(meta.format)) throw new Error('format')
    const output = await sharp(bytes, { limitInputPixels: 50_000_000, failOn: 'error' }).rotate().resize({ width: MAX_LOGO_SIDE, height: MAX_LOGO_SIDE, fit: 'inside', withoutEnlargement: true }).png().toBuffer({ resolveWithObject: true })
    png = output.data; width = output.info.width; height = output.info.height
  } catch { throw new IntegrationError('INVALID_LOGO', 'Logo 无法解码，请上传 PNG、JPG 或 WebP 图片。', 400) }
  if (Math.max(width, height) < MIN_LOGO_SIDE) throw new IntegrationError('LOGO_TOO_SMALL', `Logo 太小，长边至少 ${MIN_LOGO_SIDE} 像素。`, 400)
  const id = randomUUID(), key = await storeImage(tenantId, id, png)
  let reason = ''
  try {
    const url = await imageUrl(key, tenantId), finding = (await screen(tenantId, [url], false, names)).get(url)
    if (!finding?.readable) reason = 'Logo 无法识别，请换一张清晰的图片。'
    else if (finding.rightsRisk || finding.watermark) reason = `${finding.reason} 这与填写的品牌名称不一致；请填写真实品牌名称，或换成自有 Logo。`
  } catch (error) { await removeImage(key, tenantId).catch(() => {}); throw error }
  if (reason) { await removeImage(key, tenantId).catch(() => {}); throw new IntegrationError('LOGO_RIGHTS', reason, 400) }
  return { key, width, height }
}

const conflict = (error: unknown) => (error as { code?: string }).code === '23505' ? new IntegrationError('BRAND_EXISTS', '已有同名品牌。', 409) : error
const pendingWork = async (tenantId: string, id: string) => Boolean((await db.query("SELECT 1 FROM image_assets WHERE tenant_id=$1 AND status IN ('pending','processing') AND options#>>'{brand,id}'=$2 AND options#>>'{brand,logo}'='true' LIMIT 1", [tenantId, id])).rows.length)

export async function brandRoutes(app: FastifyInstance) {
  app.get('/brands', { preHandler: requirePermission('collection:read') }, async request => {
    const rows = (await db.query(`SELECT ${COLUMNS} FROM brands WHERE tenant_id=$1 ORDER BY is_default DESC,created_at`, [tenant(request)])).rows
    return { data: await Promise.all(rows.map(present)) }
  })

  app.post('/brands', { preHandler: requirePermission('integration:manage'), bodyLimit: 8_000_000 }, async request => {
    const input = z.object({ name, aliases: aliases.default([]), logoContent: logoContent.optional(), isDefault: z.boolean().default(false), rightsConfirmed: z.literal(true, { error: '请确认拥有该品牌或已获授权。' }) }).strict().parse(request.body)
    checkPrompt(input.name)
    const logo = input.logoContent ? await storeLogo(tenant(request), input.logoContent, [input.name, ...input.aliases]) : null
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      const first = !(await client.query('SELECT 1 FROM brands WHERE tenant_id=$1 LIMIT 1', [tenant(request)])).rows.length
      if (input.isDefault) await client.query('UPDATE brands SET is_default=false WHERE tenant_id=$1 AND is_default', [tenant(request)])
      const row = (await client.query(`INSERT INTO brands(tenant_id,name,aliases,logo_key,logo_width,logo_height,is_default,rights_confirmed_by,rights_confirmed_at,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,now(),$8) RETURNING ${COLUMNS}`, [tenant(request), input.name, input.aliases, logo?.key ?? null, logo?.width ?? null, logo?.height ?? null, input.isDefault || first, request.authUser.sub])).rows[0]
      await client.query('COMMIT')
      await audit(request, 'brand.create', row.id, { name: input.name, aliases: input.aliases, logo: Boolean(logo), rightsConfirmed: true })
      return { data: await present(row) }
    } catch (error) {
      await client.query('ROLLBACK')
      if (logo) await removeImage(logo.key, tenant(request)).catch(() => {})
      throw conflict(error)
    } finally { client.release() }
  })

  app.patch('/brands/:id', { preHandler: requirePermission('integration:manage'), bodyLimit: 8_000_000 }, async request => {
    const { id } = idParams.parse(request.params)
    const input = z.object({ name: name.optional(), aliases: aliases.optional(), logoContent: logoContent.optional(), removeLogo: z.boolean().optional(), isDefault: z.literal(true).optional(), rightsConfirmed: z.boolean().optional() }).strict().parse(request.body)
    if (input.logoContent && input.removeLogo) throw new IntegrationError('BRAND_LOGO', '不能同时上传和移除 Logo。', 400)
    const current = (await db.query('SELECT name,aliases,logo_key FROM brands WHERE id=$1 AND tenant_id=$2', [id, tenant(request)])).rows[0]
    if (!current) throw new IntegrationError('NOT_FOUND', '品牌不存在。', 404)
    const identityChanged = input.name !== undefined && input.name !== current.name || input.aliases !== undefined || input.logoContent !== undefined
    if (identityChanged && input.rightsConfirmed !== true) throw new IntegrationError('RIGHTS_REQUIRED', '修改品牌名称或 Logo 前，请确认拥有该品牌或已获授权。', 400)
    if (input.name) checkPrompt(input.name)
    if ((input.logoContent || input.removeLogo) && await pendingWork(tenant(request), id)) throw new IntegrationError('BRAND_BUSY', '该品牌有套图正在生成，请完成后再更换 Logo。', 409)
    const nextName = input.name ?? current.name, nextAliases = input.aliases ?? current.aliases
    const logo = input.logoContent ? await storeLogo(tenant(request), input.logoContent, [nextName, ...nextAliases]) : null
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      if (input.isDefault) await client.query('UPDATE brands SET is_default=false WHERE tenant_id=$1 AND is_default AND id<>$2', [tenant(request), id])
      const row = (await client.query(`UPDATE brands SET name=$3,aliases=$4,is_default=is_default OR $5,
          logo_key=CASE WHEN $6 THEN NULL WHEN $7::text IS NOT NULL THEN $7 ELSE logo_key END,
          logo_width=CASE WHEN $6 THEN NULL WHEN $7::text IS NOT NULL THEN $8::int ELSE logo_width END,
          logo_height=CASE WHEN $6 THEN NULL WHEN $7::text IS NOT NULL THEN $9::int ELSE logo_height END,
          rights_confirmed_by=CASE WHEN $10 THEN $11::uuid ELSE rights_confirmed_by END,rights_confirmed_at=CASE WHEN $10 THEN now() ELSE rights_confirmed_at END,updated_at=now()
        WHERE id=$1 AND tenant_id=$2 RETURNING ${COLUMNS}`, [id, tenant(request), nextName, nextAliases, input.isDefault === true, input.removeLogo === true, logo?.key ?? null, logo?.width ?? null, logo?.height ?? null, identityChanged, request.authUser.sub])).rows[0]
      if (!row) throw new IntegrationError('NOT_FOUND', '品牌不存在。', 404)
      await client.query('COMMIT')
      if ((logo || input.removeLogo) && current.logo_key) await removeImage(current.logo_key, tenant(request)).catch(() => {})
      await audit(request, 'brand.update', id, { name: nextName, aliases: nextAliases, logoChanged: Boolean(logo || input.removeLogo), isDefault: input.isDefault === true })
      return { data: await present(row) }
    } catch (error) {
      await client.query('ROLLBACK')
      if (logo) await removeImage(logo.key, tenant(request)).catch(() => {})
      throw conflict(error)
    } finally { client.release() }
  })

  app.delete('/brands/:id', { preHandler: requirePermission('integration:manage') }, async request => {
    const { id } = idParams.parse(request.params)
    if (await pendingWork(tenant(request), id)) throw new IntegrationError('BRAND_BUSY', '该品牌有套图正在生成，请完成后再删除。', 409)
    const row = (await db.query('DELETE FROM brands WHERE id=$1 AND tenant_id=$2 RETURNING name,logo_key', [id, tenant(request)])).rows[0]
    if (!row) throw new IntegrationError('NOT_FOUND', '品牌不存在。', 404)
    if (row.logo_key) await removeImage(row.logo_key, tenant(request)).catch(() => {})
    await audit(request, 'brand.delete', id, { name: row.name })
    return { ok: true }
  })
}
