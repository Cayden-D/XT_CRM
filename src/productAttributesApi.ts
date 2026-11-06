import { download, request } from './api'
import type { Measurement, MeasurementField } from '../shared/product-attributes'

export type AttributeRow = { label: string; value: string; unit?: string | null; group_name?: string; source?: string; confirmed_at?: string | null; def_id?: string | null }
export type AttributeSuggestion = { label: string; value: string; source: string; source_name: string }
export type MeasurementSuggestion = { field: MeasurementField; value: number; from: string }
export type ProductAttributeData = { measurement: Measurement | null; attributes: AttributeRow[]; suggestions: { attributes: AttributeSuggestion[]; measurements: MeasurementSuggestion[] } }
export type AttributeDef = { id: string; category: string | null; label: string; group_name: string; value_type: string; unit: string | null; options: string[]; aliases: string[]; position: number; active: boolean }
export type AttributeInput = { defId?: string | null; label: string; value: string; unit?: string | null; groupName: string; source?: string; confirmed?: boolean }
export type ImportResult = { rows: number; products: number; measurements: number; attributes: number; unknownColumns: string[]; errors: { line: number; message: string }[]; errorCount: number; applied: boolean }
export type DraftChange = { field: string; label: string; current: string; next: string }

export const getProductAttributes = (id: string) => request<{ data: ProductAttributeData }>(`/api/products/${id}/attributes`)
export const saveProductAttributes = (id: string, body: { measurement?: Measurement & { revision: number }; attributes?: AttributeInput[] }) => request<{ data: ProductAttributeData }>(`/api/products/${id}/attributes`, { method: 'PUT', body: JSON.stringify(body) })
export const getAttributeDefs = (category?: string) => request<{ data: AttributeDef[] }>(`/api/products/attribute-defs${category ? `?category=${encodeURIComponent(category)}` : ''}`)
export const createAttributeDef = (body: { category?: string | null; label: string; groupName: string; unit?: string | null }) => request<{ data: AttributeDef }>('/api/products/attribute-defs', { method: 'POST', body: JSON.stringify(body) })
export const updateAttributeDef = (def: AttributeDef, active: boolean) => request<{ data: AttributeDef }>(`/api/products/attribute-defs/${def.id}`, { method: 'PUT', body: JSON.stringify({ category: def.category, label: def.label, groupName: def.group_name, valueType: def.value_type, unit: def.unit, options: def.options, aliases: def.aliases, position: def.position, active }) })
export const exportProductAttributes = () => download('/api/products/attributes/export', '产品属性.csv')
export const importProductAttributes = (csv: string, dryRun: boolean) => request<{ data: ImportResult }>('/api/products/attributes/import', { method: 'POST', body: JSON.stringify({ csv, dryRun }) })
export const previewDraftProductData = (draftId: string) => request<{ data: { revision: number; editable: boolean; changes: DraftChange[] } }>(`/api/integrations/1688/drafts/${draftId}/product-attributes/preview`, { method: 'POST', body: '{}' })

export type CatalogListingDetail = {
  listing: { id: string; connection_id: string; shop: string | null; offer_id: string; title: string; status: string; image_url: string | null; synced_at: string; product_id: string | null; images: string[]; category: string | null; cargo_number: string | null; unit: string | null; stock: number | null; min_order: number | null; price_ranges: { start: number | null; price: number | string | null }[]; reference_price: number | string | null; unit_weight: number | null; send_address: string | null; attributes: { name: string; value: string }[]; skus: { spec_id: string | null; attributes: { name: string; value: string }[]; price: number | string | null; stock: number | null }[] }
  product: { id: string; sku: string; name: string; category: string | null; status: string } | null
}
export const getCatalogListing = (id: string) => request<{ data: CatalogListingDetail }>(`/api/products/catalog/listings/${id}`)
export const createCatalogProfile = (id: string) => request<{ data: { productId: string; created: boolean } }>(`/api/products/catalog/listings/${id}/profile`, { method: 'POST', body: '{}' })
