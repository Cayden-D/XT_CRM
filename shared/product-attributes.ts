/**
 * Product measurements are stored in grams and millimetres. Three things must never be mixed up:
 *   net weight / product size   the product itself     → category attributes (净重, 尺寸…)
 *   package weight / size       one sales package      → 件重尺 (officialLogistics)
 *   carton                      the outer shipping box → CRM only, not sent to the platform
 */
export const measurementFields = [
  'net_weight_g', 'product_length_mm', 'product_width_mm', 'product_height_mm',
  'package_weight_g', 'package_length_mm', 'package_width_mm', 'package_height_mm',
  'carton_quantity', 'carton_gross_weight_g', 'carton_length_mm', 'carton_width_mm', 'carton_height_mm',
] as const
export type MeasurementField = typeof measurementFields[number]
export type Measurement = Partial<Record<MeasurementField, number | null>> & { revision?: number }
export type ProductAttribute = { label: string; value: string; unit?: string | null; group_name?: string; position?: number; source?: string; confirmed_at?: string | null; def_id?: string | null }

export const measurementLabels: Record<MeasurementField, string> = {
  net_weight_g: '净重(g)', product_length_mm: '产品长(mm)', product_width_mm: '产品宽(mm)', product_height_mm: '产品高(mm)',
  package_weight_g: '含包装重量(g)', package_length_mm: '包装长(mm)', package_width_mm: '包装宽(mm)', package_height_mm: '包装高(mm)',
  carton_quantity: '每箱数量', carton_gross_weight_g: '箱毛重(g)', carton_length_mm: '外箱长(mm)', carton_width_mm: '外箱宽(mm)', carton_height_mm: '外箱高(mm)',
}

const sizeText = (a?: number | null, b?: number | null, c?: number | null) => a && b && c ? `${a / 10}×${b / 10}×${c / 10}cm` : null

/** Measurements as text, under the names the category attributes use. Package and carton stay out: they are not the product. */
export function measurementAttributes(m: Measurement | null | undefined): Record<string, string> {
  const result: Record<string, string> = {}
  if (m?.net_weight_g) result['净重'] = `${m.net_weight_g}g`
  const size = sizeText(m?.product_length_mm, m?.product_width_mm, m?.product_height_mm)
  if (size) result['尺寸'] = size
  return result
}

/** `specifications`, which the Agent and the catalogue cards read, generated from the structured data. */
export function specificationsOf(attributes: ProductAttribute[], m: Measurement | null | undefined) {
  const result = measurementAttributes(m)
  for (const a of attributes) if (a.confirmed_at !== null) result[a.label] = a.unit && !a.value.endsWith(a.unit) ? `${a.value}${a.unit}` : a.value
  return result
}

/**
 * 件重尺 from the sales package: grams, centimetres with one decimal, longest side first as the platform requires.
 * No weight means nothing is filled: the platform requires it, and dimensions alone would only look complete.
 */
export function logisticsOfferInfo(m: Measurement | null | undefined) {
  if (!m?.package_weight_g) return null
  const sides = [m.package_length_mm, m.package_width_mm, m.package_height_mm]
  const complete = sides.every(side => typeof side === 'number' && side > 0)
  const [length, width, height] = complete ? (sides as number[]).slice().sort((a, b) => b - a).map(mm => mm / 10) : [0, 0, 0]
  return { weight: m.package_weight_g, length, width, height, volume: complete ? Number((length * width * height).toFixed(6)) : 0 }
}

const NUMBER = '(\\d+(?:\\.\\d+)?)'
/** A weight in grams from text such as "1.2kg", "500克" or "1.2公斤"; null when it has no clear unit. */
export function parseWeightGrams(text: string): number | null {
  const match = text.trim().match(new RegExp(`^${NUMBER}\\s*(kg|千克|公斤|g|克|斤)$`, 'i'))
  if (!match) return null
  const factor = { kg: 1000, 千克: 1000, 公斤: 1000, g: 1, 克: 1, 斤: 500 }[match[2].toLowerCase() as 'kg' | '千克' | '公斤' | 'g' | '克' | '斤']
  const grams = Math.round(Number(match[1]) * factor)
  return grams > 0 ? grams : null
}
/** Three sides in millimetres from text such as "30*20*10cm" or "300x200x100mm"; null when the unit is missing. */
export function parseSizeMm(text: string): [number, number, number] | null {
  const match = text.trim().match(new RegExp(`^${NUMBER}\\s*(?:cm|mm|厘米|毫米)?\\s*[*xX×]\\s*${NUMBER}\\s*(?:cm|mm|厘米|毫米)?\\s*[*xX×]\\s*${NUMBER}\\s*(cm|mm|厘米|毫米)$`))
  if (!match) return null
  const factor = /cm|厘米/.test(match[4]) ? 10 : 1
  const sides = [match[1], match[2], match[3]].map(value => Math.round(Number(value) * factor))
  return sides.every(side => side > 0) ? sides as [number, number, number] : null
}

/** A plain RFC 4180 CSV reader (Excel's dialect); strips the BOM and the quote our exports put in front of formula characters. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = [], cell = '', quoted = false
  const input = text.replace(/^﻿/, '')
  for (let i = 0; i < input.length; i++) {
    const char = input[i]
    if (quoted) {
      if (char === '"' && input[i + 1] === '"') { cell += '"'; i++ }
      else if (char === '"') quoted = false
      else cell += char
    } else if (char === '"' && !cell) quoted = true
    else if (char === ',') { row.push(cell); cell = '' }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && input[i + 1] === '\n') i++
      row.push(cell); cell = ''
      if (row.some(value => value.trim())) rows.push(row)
      row = []
    } else cell += char
  }
  row.push(cell)
  if (row.some(value => value.trim())) rows.push(row)
  return rows.map(cells => cells.map(value => value.replace(/^'(?=[=+\-@])/, '')))
}
