import type { PoolClient } from 'pg'
import { db } from '../db.js'
import { logisticsOfferInfo, parseSizeMm, parseWeightGrams, specificationsOf, type Measurement, type ProductAttribute } from '../../shared/product-attributes.js'
import { validateLogistics } from '../../shared/1688-logistics.js'
import { attributeCategoryDefaults } from './1688-collected-attributes.js'

type Json = Record<string, any>
type Queryable = Pick<PoolClient, 'query'>

/** Products promoted from collection only have `specifications` until first read; those values were already in use, so they count as confirmed. */
async function backfillFromSpecifications(client: Queryable, tenantId: string, productId: string) {
  await client.query(`INSERT INTO product_attributes(tenant_id,product_id,label,value,source,confirmed_at)
    SELECT p.tenant_id,p.id,left(s.key,60),s.value,'legacy',now() FROM products p CROSS JOIN LATERAL jsonb_each_text(p.specifications) s
    WHERE p.id=$1 AND p.tenant_id=$2 AND btrim(s.key)<>'' AND btrim(coalesce(s.value,''))<>''
      AND NOT EXISTS(SELECT 1 FROM product_attributes a WHERE a.product_id=p.id) AND NOT EXISTS(SELECT 1 FROM product_measurements m WHERE m.product_id=p.id)
    ON CONFLICT DO NOTHING`, [productId, tenantId])
}

export async function loadProductData(tenantId: string, productId: string, client: Queryable = db) {
  await backfillFromSpecifications(client, tenantId, productId)
  const measurement = (await client.query<Measurement>('SELECT * FROM product_measurements WHERE product_id=$1 AND tenant_id=$2 AND variant_id IS NULL', [productId, tenantId])).rows[0] ?? null
  const attributes = (await client.query<ProductAttribute & { id: string }>('SELECT id,def_id,label,value,unit,group_name,position,source,confirmed_at FROM product_attributes WHERE product_id=$1 AND tenant_id=$2 ORDER BY position,label', [productId, tenantId])).rows
  return { measurement, attributes }
}

export async function saveProjection(client: Queryable, tenantId: string, productId: string) {
  const { measurement, attributes } = await loadProductData(tenantId, productId, client)
  await client.query('UPDATE products SET specifications=$3,updated_at=now() WHERE id=$1 AND tenant_id=$2', [productId, tenantId, JSON.stringify(specificationsOf(attributes, measurement))])
}

/** Writes from the plain product API: `specifications` replaces the confirmed attributes, keeping the richer data of unchanged ones. */
export async function syncAttributesFromSpecifications(client: Queryable, tenantId: string, productId: string, specifications: Record<string, string>) {
  const entries = Object.entries(specifications).map(([label, value]) => [label.trim().slice(0, 60), value.trim()] as const).filter(([label, value]) => label && value)
  await client.query("DELETE FROM product_attributes WHERE product_id=$1 AND tenant_id=$2 AND confirmed_at IS NOT NULL AND NOT (lower(label)=ANY($3::text[]))", [productId, tenantId, entries.map(([label]) => label.toLowerCase())])
  for (const [label, value] of entries) await client.query(`INSERT INTO product_attributes(tenant_id,product_id,label,value,source,confirmed_at)VALUES($1,$2,$3,$4,'manual',now())
    ON CONFLICT(product_id,lower(label)) DO UPDATE SET value=excluded.value,confirmed_at=coalesce(product_attributes.confirmed_at,now()),updated_at=now()
      WHERE product_attributes.value IS DISTINCT FROM excluded.value AND (product_attributes.unit IS NULL OR excluded.value<>product_attributes.value||product_attributes.unit)`, [tenantId, productId, label, value])
}

const SOURCE_NAMES: Record<string, string> = { collected: '采集', listing: '在售商品' }
const WEIGHT_LABELS = /^(净重|单件净重|重量|产品重量|商品重量)$/, SIZE_LABELS = /^(尺寸|外形尺寸|产品尺寸|商品尺寸|规格尺寸)$/
const PLACEHOLDER = /^(详情可咨询客服|详情咨询客服|请咨询客服|咨询客服|详询|暂无|未知|不详|[-—]+)$/

/**
 * What the shop's collected and live data say that the product does not have yet. Nothing is applied: a person accepts
 * each one, because the listing's text may describe something else (a "尺寸" can be a box size). No new platform calls.
 */
export async function attributeSuggestions(tenantId: string, productId: string) {
  const { measurement, attributes } = await loadProductData(tenantId, productId)
  const known = new Set(attributes.map(a => a.label.toLowerCase()))
  const found = new Map<string, { label: string; value: string; source: string; source_name: string }>()
  const add = (label: unknown, value: unknown, source: string) => {
    const name = String(label ?? '').trim().slice(0, 60), text = String(value ?? '').trim()
    if (name && text && text.length <= 200 && !PLACEHOLDER.test(text) && !known.has(name.toLowerCase()) && !found.has(name.toLowerCase())) found.set(name.toLowerCase(), { label: name, value: text, source, source_name: SOURCE_NAMES[source] })
  }
  const collected = (await db.query('SELECT attributes FROM collected_products WHERE tenant_id=$1 AND product_id=$2 ORDER BY updated_at DESC LIMIT 1', [tenantId, productId])).rows[0]
  for (const [label, value] of Object.entries((collected?.attributes ?? {}) as Json)) add(label, value, 'collected')
  const listings = (await db.query("SELECT snapshot->'attributes' AS attributes FROM integration_1688_listings WHERE tenant_id=$1 AND product_id=$2 ORDER BY synced_at DESC LIMIT 3", [tenantId, productId])).rows
  for (const listing of listings) if (Array.isArray(listing.attributes)) for (const row of listing.attributes) add(row?.attributeName, row?.value ?? row?.attributeValue, 'listing')
  const measurements: { field: string; value: number; from: string }[] = []
  const texts = [...attributes.map(a => ({ label: a.label, value: a.unit ? `${a.value}${a.unit}` : a.value })), ...found.values()]
  for (const { label, value } of texts) {
    if (!measurement?.net_weight_g && WEIGHT_LABELS.test(label)) { const grams = parseWeightGrams(value); if (grams && !measurements.some(m => m.field === 'net_weight_g')) measurements.push({ field: 'net_weight_g', value: grams, from: `${label}：${value}` }) }
    if (!measurement?.product_length_mm && SIZE_LABELS.test(label)) {
      const sides = parseSizeMm(value)
      if (sides && !measurements.some(m => m.field === 'product_length_mm')) (['product_length_mm', 'product_width_mm', 'product_height_mm'] as const).forEach((field, i) => measurements.push({ field, value: sides[i], from: `${label}：${value}` }))
    }
  }
  return { attributes: [...found.values()], measurements }
}

/** Confirmed product facts as label → text, for filling category attributes. */
const confirmedFacts = (data: Awaited<ReturnType<typeof loadProductData>>) => specificationsOf(data.attributes.filter(a => a.confirmed_at), data.measurement)
const usable = (fields: Json | undefined) => fields && fields.visible !== false && fields.readonly !== true
const emptyProperty = (value: unknown) => value == null || value === '' || (typeof value === 'object' && (value as Json).value == null && !Array.isArray(value))
const measured = (value: Json | undefined) => value != null && (Object.values(value.offerInfo ?? {}).some(v => v != null && v !== '' && v !== 0) || (Array.isArray(value.skuInfo) && value.skuInfo.length > 0))

/** New drafts and Agent runs: only empty fields are filled, so nothing a person entered is touched. */
export function fillFromProductData(schema: Json, values: Json, data: Awaited<ReturnType<typeof loadProductData>>) {
  const next: Json = { ...values }
  const defaults = attributeCategoryDefaults(schema, confirmedFacts(data))
  const catProp = { ...(values.catProp ?? {}) }
  for (const [name, value] of Object.entries(defaults)) if (emptyProperty(catProp[name])) catProp[name] = value
  if (Object.keys(catProp).length) next.catProp = catProp
  const offerInfo = logisticsOfferInfo(data.measurement), fields = schema.data?.officialLogistics?.fields
  if (offerInfo && usable(fields) && !measured(values.officialLogistics)) {
    const logistics = { ...values.officialLogistics, showLogisticsCategory: 'item', offerInfo }
    delete logistics.skuInfo
    if (!validateLogistics(fields, logistics).length) next.officialLogistics = logistics
  }
  return next
}

const show = (value: unknown): string => {
  if (value == null || value === '') return '（空）'
  if (typeof value === 'object') { const v = value as Json; return v.text != null ? String(v.text) : v.value != null ? String(v.value) : JSON.stringify(value) }
  return String(value)
}
const offerText = (info: Json | undefined) => !info || !info.weight ? '（空）' : `${info.weight}g${info.length ? ` · ${info.length}×${info.width}×${info.height}cm` : ''}`

/** Existing drafts: every field whose product value differs, to show side by side; the person picks what to bring in. */
export function draftProductChanges(schema: Json, values: Json, data: Awaited<ReturnType<typeof loadProductData>>) {
  const changes: { field: string; label: string; current: string; next: string; value: unknown }[] = []
  const labels = new Map<string, string>((schema.data?.catProp?.fields?.dataSource ?? []).map((f: Json) => [f.name, f.label]))
  for (const [name, value] of Object.entries(attributeCategoryDefaults(schema, confirmedFacts(data)))) {
    const current = values.catProp?.[name]
    if (show(current) !== show(value)) changes.push({ field: `catProp.${name}`, label: labels.get(name) ?? name, current: show(current), next: show(value), value })
  }
  const offerInfo = logisticsOfferInfo(data.measurement), fields = schema.data?.officialLogistics?.fields
  if (offerInfo && usable(fields)) {
    const logistics = { ...values.officialLogistics, showLogisticsCategory: 'item', offerInfo }
    delete logistics.skuInfo
    if (!validateLogistics(fields, logistics).length && offerText(values.officialLogistics?.offerInfo) !== offerText(offerInfo)) changes.push({ field: 'officialLogistics', label: '件重尺（含包装）', current: offerText(values.officialLogistics?.offerInfo), next: offerText(offerInfo), value: logistics })
  }
  return changes
}

export function applyDraftChanges(values: Json, changes: ReturnType<typeof draftProductChanges>, fields: string[]) {
  const next: Json = { ...values, catProp: { ...(values.catProp ?? {}) } }
  for (const change of changes) {
    if (!fields.includes(change.field)) continue
    if (change.field === 'officialLogistics') next.officialLogistics = change.value
    else next.catProp[change.field.slice('catProp.'.length)] = change.value
  }
  return next
}

