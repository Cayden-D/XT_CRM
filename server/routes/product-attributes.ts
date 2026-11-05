import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { PoolClient } from 'pg'
import { z } from 'zod'
import { requirePermission } from '../auth.js'
import { sendCsv } from '../csv.js'
import { db } from '../db.js'
import { attributeSuggestions, loadProductData, saveProjection } from '../integrations/product-attributes.js'
import { measurementFields, measurementLabels, parseCsv, type MeasurementField } from '../../shared/product-attributes.js'

const tenant = (request: FastifyRequest) => request.authUser.tenantId
const idParams = z.object({ id: z.string().uuid() })
const positive = z.number().int().positive().max(2_000_000_000).nullable().optional()
const measurementSchema = z.object({ revision: z.number().int().min(0), ...Object.fromEntries(measurementFields.map(field => [field, positive])) as Record<MeasurementField, typeof positive> }).strict()
const attributeSchema = z.object({
  defId: z.string().uuid().nullable().optional(),
  label: z.string().trim().min(1, '属性名称不能为空').max(60),
  value: z.string().trim().min(1, '属性内容不能为空').max(1000),
  unit: z.string().trim().max(20).nullable().optional(),
  groupName: z.string().trim().min(1).max(30).default('产品特性'),
  source: z.enum(['manual', 'legacy', 'collected', 'listing', 'ai', 'import']).default('manual'),
  confirmed: z.boolean().default(true),
}).strict()
const saveSchema = z.object({ measurement: measurementSchema.optional(), attributes: z.array(attributeSchema).max(200).optional() }).strict()
const defSchema = z.object({
  category: z.string().trim().max(120).nullable().optional(),
  label: z.string().trim().min(1).max(60),
  groupName: z.string().trim().min(1).max(30).default('产品特性'),
  valueType: z.enum(['text', 'number', 'select', 'multi_select', 'boolean']).default('text'),
  unit: z.string().trim().max(20).nullable().optional(),
  options: z.array(z.string().trim().min(1).max(100)).max(100).default([]),
  aliases: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
  position: z.number().int().min(0).max(100_000).default(0),
  active: z.boolean().default(true),
}).strict()

class AttributeError extends Error { constructor(message: string, public statusCode = 400, public code = 'VALIDATION_ERROR') { super(message) } }

async function checkProduct(client: Pick<PoolClient, 'query'>, tenantId: string, id: string) {
  const row = (await client.query('SELECT id FROM products WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL FOR UPDATE', [id, tenantId])).rows[0]
  if (!row) throw new AttributeError('产品不存在。', 404, 'NOT_FOUND')
}

async function writeMeasurement(client: Pick<PoolClient, 'query'>, tenantId: string, productId: string, actor: string, values: Partial<Record<MeasurementField, number | null>>, expected: number | null) {
  const current = (await client.query('SELECT id,revision FROM product_measurements WHERE product_id=$1 AND variant_id IS NULL', [productId])).rows[0]
  if (expected != null && (current?.revision ?? 0) !== expected) throw new AttributeError('尺寸数据已被他人修改，请刷新后重试。', 409, 'CONFLICT')
  const fields = measurementFields.filter(field => field in values)
  if (current) {
    if (fields.length) await client.query(`UPDATE product_measurements SET ${fields.map((field, i) => `${field}=$${i + 2}`).join(',')},revision=revision+1,updated_by=$${fields.length + 2},updated_at=now() WHERE id=$1`, [current.id, ...fields.map(field => values[field] ?? null), actor])
  } else if (fields.length) {
    await client.query(`INSERT INTO product_measurements(tenant_id,product_id,updated_by,${fields.join(',')})VALUES($1,$2,$3,${fields.map((_, i) => `$${i + 4}`).join(',')})`, [tenantId, productId, actor, ...fields.map(field => values[field] ?? null)])
  }
}

async function replaceAttributes(client: Pick<PoolClient, 'query'>, tenantId: string, productId: string, actor: string, attributes: z.infer<typeof attributeSchema>[]) {
  const seen = new Set<string>()
  for (const a of attributes) { const key = a.label.toLowerCase(); if (seen.has(key)) throw new AttributeError(`属性“${a.label}”重复了。`); seen.add(key) }
  await client.query('DELETE FROM product_attributes WHERE product_id=$1 AND tenant_id=$2', [productId, tenantId])
  for (const [position, a] of attributes.entries()) await client.query(`INSERT INTO product_attributes(tenant_id,product_id,def_id,label,value,unit,group_name,position,source,confirmed_at,confirmed_by)
    VALUES($1,$2,(SELECT id FROM product_attribute_defs WHERE id=$3 AND tenant_id=$1),$4,$5,$6,$7,$8,$9,CASE WHEN $10::boolean THEN now() END,CASE WHEN $10::boolean THEN $11::uuid END)`,
  [tenantId, productId, a.defId ?? null, a.label, a.value, a.unit || null, a.groupName, position, a.source, a.confirmed, actor])
}

const inTransaction = async <T>(work: (client: PoolClient) => Promise<T>) => {
  const client = await db.connect()
  try { await client.query('BEGIN'); const result = await work(client); await client.query('COMMIT'); return result } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}
const IMPORT_MAX_ROWS = 2000
const ATTRIBUTE_COLUMN = /^属性[:：](.+)$/

export async function productAttributeRoutes(app: FastifyInstance) {
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AttributeError) return reply.code(error.statusCode).send({ error: error.code, message: error.message })
    if (error instanceof z.ZodError) return reply.code(400).send({ error: 'VALIDATION_ERROR', message: error.issues[0]?.message ?? '内容格式不正确。' })
    throw error
  })

  app.get('/attribute-defs', { preHandler: requirePermission('product:read') }, async request => {
    const { category } = z.object({ category: z.string().trim().max(120).optional() }).parse(request.query)
    return { data: (await db.query(`SELECT * FROM product_attribute_defs WHERE tenant_id=$1 AND ($2::text IS NULL OR category IS NULL OR category=$2) ORDER BY group_name,position,label`, [tenant(request), category ?? null])).rows }
  })
  app.post('/attribute-defs', { preHandler: requirePermission('product:update') }, async (request, reply) => {
    const d = defSchema.parse(request.body)
    const row = (await db.query(`INSERT INTO product_attribute_defs(tenant_id,category,label,group_name,value_type,unit,options,aliases,position,active)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT DO NOTHING RETURNING *`, [tenant(request), d.category || null, d.label, d.groupName, d.valueType, d.unit || null, JSON.stringify(d.options), d.aliases, d.position, d.active])).rows[0]
    if (!row) throw new AttributeError('这个属性已经在模板里了。', 409, 'CONFLICT')
    return reply.code(201).send({ data: row })
  })
  app.put('/attribute-defs/:id', { preHandler: requirePermission('product:update') }, async request => {
    const { id } = idParams.parse(request.params), d = defSchema.parse(request.body)
    const row = (await db.query(`UPDATE product_attribute_defs SET category=$3,label=$4,group_name=$5,value_type=$6,unit=$7,options=$8,aliases=$9,position=$10,active=$11 WHERE id=$1 AND tenant_id=$2 RETURNING *`,
      [id, tenant(request), d.category || null, d.label, d.groupName, d.valueType, d.unit || null, JSON.stringify(d.options), d.aliases, d.position, d.active])).rows[0]
    if (!row) throw new AttributeError('属性模板不存在。', 404, 'NOT_FOUND')
    return { data: row }
  })

  // Unconfirmed values never reach a draft or the AI; empty cells leave a product's value as it is.
  app.get('/attributes/export', { preHandler: requirePermission('product:read') }, async (request, reply) => {
    const products = (await db.query('SELECT id,sku,name FROM products WHERE tenant_id=$1 AND deleted_at IS NULL ORDER BY sku LIMIT 5000', [tenant(request)])).rows
    const measurements = new Map((await db.query('SELECT * FROM product_measurements WHERE tenant_id=$1 AND variant_id IS NULL', [tenant(request)])).rows.map(m => [m.product_id, m]))
    const attributes = (await db.query('SELECT product_id,label,value FROM product_attributes WHERE tenant_id=$1 AND confirmed_at IS NOT NULL ORDER BY position,label', [tenant(request)])).rows
    const labels = [...new Set(attributes.map(a => a.label as string))]
    const byProduct = new Map<string, Map<string, string>>()
    for (const a of attributes) { if (!byProduct.has(a.product_id)) byProduct.set(a.product_id, new Map()); byProduct.get(a.product_id)!.set(a.label, a.value) }
    const rows = [['SKU', '产品名称', ...measurementFields.map(field => measurementLabels[field]), ...labels.map(label => `属性:${label}`)],
      ...products.map(p => [p.sku, p.name, ...measurementFields.map(field => measurements.get(p.id)?.[field] ?? ''), ...labels.map(label => byProduct.get(p.id)?.get(label) ?? '')])]
    await db.query("INSERT INTO audit_logs(tenant_id,actor_id,action,entity_type,after_data,request_id)VALUES($1,$2,'product.attributes.export','product',$3,$4)", [tenant(request), request.authUser.sub, JSON.stringify({ products: products.length }), request.id])
    return sendCsv(reply, '产品属性.csv', rows)
  })

  app.post('/attributes/import', { preHandler: requirePermission('product:update'), bodyLimit: 4 * 1024 * 1024 }, async request => {
    const { csv, dryRun } = z.object({ csv: z.string().min(1).max(3_000_000), dryRun: z.boolean().default(true) }).strict().parse(request.body)
    const [header, ...rows] = parseCsv(csv)
    const skuColumn = header?.findIndex(name => name.trim().toUpperCase() === 'SKU') ?? -1
    if (skuColumn < 0) throw new AttributeError('文件第一行需要有“SKU”列。')
    if (rows.length > IMPORT_MAX_ROWS) throw new AttributeError(`一次最多导入 ${IMPORT_MAX_ROWS} 行。`)
    const labelToField = new Map(measurementFields.map(field => [measurementLabels[field], field]))
    const columns = header.map((name, index) => ({ index, field: labelToField.get(name.trim()), attribute: name.trim().match(ATTRIBUTE_COLUMN)?.[1]?.trim().slice(0, 60) }))
    const unknown = header.filter((name, i) => i !== skuColumn && name.trim() && name.trim() !== '产品名称' && !columns[i].field && !columns[i].attribute)
    const skus = rows.map(row => (row[skuColumn] ?? '').trim())
    const products = new Map((await db.query('SELECT id,sku FROM products WHERE tenant_id=$1 AND deleted_at IS NULL AND sku=ANY($2::text[])', [tenant(request), skus])).rows.map(p => [p.sku, p.id]))
    const errors: { line: number; message: string }[] = [], plans: { productId: string; values: Partial<Record<MeasurementField, number>>; attributes: [string, string][] }[] = []
    const seen = new Set<string>()
    rows.forEach((row, i) => {
      const line = i + 2, sku = skus[i], productId = products.get(sku)
      if (!sku) { errors.push({ line, message: 'SKU 为空' }); return }
      if (!productId) { errors.push({ line, message: `找不到产品 ${sku}` }); return }
      if (seen.has(sku)) { errors.push({ line, message: `产品 ${sku} 重复` }); return }
      seen.add(sku)
      const plan = { productId, values: {} as Partial<Record<MeasurementField, number>>, attributes: [] as [string, string][] }
      for (const column of columns) {
        const text = (row[column.index] ?? '').trim()
        if (!text) continue
        if (column.field) {
          const value = Number(text)
          if (!Number.isInteger(value) || value <= 0 || value > 2_000_000_000) errors.push({ line, message: `${measurementLabels[column.field]} 须为正整数（当前：${text.slice(0, 20)}）` })
          else plan.values[column.field] = value
        } else if (column.attribute) {
          if (text.length > 1000) errors.push({ line, message: `属性“${column.attribute}”过长` })
          else plan.attributes.push([column.attribute, text])
        }
      }
      plans.push(plan)
    })
    const summary = { rows: rows.length, products: plans.length, measurements: plans.filter(p => Object.keys(p.values).length).length, attributes: plans.reduce((n, p) => n + p.attributes.length, 0), unknownColumns: unknown, errors: errors.slice(0, 100), errorCount: errors.length }
    if (dryRun || errors.length) return { data: { ...summary, applied: false } }
    await inTransaction(async client => {
      for (const plan of plans) {
        await checkProduct(client, tenant(request), plan.productId)
        await loadProductData(tenant(request), plan.productId, client)
        await writeMeasurement(client, tenant(request), plan.productId, request.authUser.sub, plan.values, null)
        for (const [label, value] of plan.attributes) await client.query(`INSERT INTO product_attributes(tenant_id,product_id,label,value,source,confirmed_at,confirmed_by)VALUES($1,$2,$3,$4,'import',now(),$5)
          ON CONFLICT(product_id,lower(label)) DO UPDATE SET value=excluded.value,source='import',confirmed_at=now(),confirmed_by=excluded.confirmed_by,updated_at=now()`, [tenant(request), plan.productId, label, value, request.authUser.sub])
        await saveProjection(client, tenant(request), plan.productId)
      }
      await client.query("INSERT INTO audit_logs(tenant_id,actor_id,action,entity_type,after_data,request_id)VALUES($1,$2,'product.attributes.import','product',$3,$4)", [tenant(request), request.authUser.sub, JSON.stringify({ rows: rows.length, products: plans.length }), request.id])
    })
    return { data: { ...summary, applied: true } }
  })

  app.get('/:id/attributes', { preHandler: requirePermission('product:read') }, async request => {
    const { id } = idParams.parse(request.params)
    await checkProduct(db, tenant(request), id)
    const [data, suggestions] = [await loadProductData(tenant(request), id), await attributeSuggestions(tenant(request), id)]
    return { data: { ...data, suggestions } }
  })

  app.put('/:id/attributes', { preHandler: requirePermission('product:update') }, async request => {
    const { id } = idParams.parse(request.params), input = saveSchema.parse(request.body)
    const saved = await inTransaction(async client => {
      await checkProduct(client, tenant(request), id)
      await loadProductData(tenant(request), id, client)
      if (input.measurement) {
        const { revision, ...values } = input.measurement
        const given = Object.fromEntries(measurementFields.filter(field => field in values).map(field => [field, values[field] ?? null])) as Partial<Record<MeasurementField, number | null>>
        await writeMeasurement(client, tenant(request), id, request.authUser.sub, given, revision)
      }
      if (input.attributes) await replaceAttributes(client, tenant(request), id, request.authUser.sub, input.attributes)
      await saveProjection(client, tenant(request), id)
      const data = await loadProductData(tenant(request), id, client)
      await client.query("INSERT INTO audit_logs(tenant_id,actor_id,action,entity_type,entity_id,after_data,request_id)VALUES($1,$2,'product.attributes.update','product',$3,$4,$5)", [tenant(request), request.authUser.sub, id, JSON.stringify(data), request.id])
      return data
    })
    return { data: saved }
  })
}
