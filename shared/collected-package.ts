/**
 * The source listing's 件重尺 (per-SKU length/width/height in cm, weight in g) as the collector stores it in
 * raw_data.packageInfo, turned into the product's packaged measurements. One set for the whole product: the heaviest SKU,
 * so the freight is never under-declared. Sides are sorted longest first (the platform requires length ≥ width ≥ height).
 */
export type PackageRow = { skuId: string | null; spec: string | null; lengthCm: number | null; widthCm: number | null; heightCm: number | null; weightG: number }
const positive = (value: unknown) => { const n = Number(value); return Number.isFinite(n) && n > 0 ? n : null }

export function collectedPackageRows(raw: unknown): PackageRow[] {
  const rows = (raw as { packageInfo?: unknown } | null)?.packageInfo
  if (!Array.isArray(rows)) return []
  return rows.slice(0, 500).flatMap(row => {
    const weightG = positive(row?.weightG)
    if (!weightG) return []
    return [{ skuId: row?.skuId == null ? null : String(row.skuId), spec: typeof row?.spec === 'string' ? row.spec : null, lengthCm: positive(row?.lengthCm), widthCm: positive(row?.widthCm), heightCm: positive(row?.heightCm), weightG }]
  })
}

export function packageMeasurement(rows: PackageRow[]) {
  if (!rows.length) return null
  const heaviest = rows.reduce((a, b) => (b.weightG > a.weightG ? b : a))
  const weight = Math.round(heaviest.weightG)
  if (weight <= 0) return null
  const sides = [heaviest.lengthCm, heaviest.widthCm, heaviest.heightCm]
  const mm = sides.every(side => side != null) ? (sides as number[]).map(cm => Math.max(1, Math.round(cm * 10))).sort((a, b) => b - a) : null
  return { package_weight_g: weight, package_length_mm: mm?.[0] ?? null, package_width_mm: mm?.[1] ?? null, package_height_mm: mm?.[2] ?? null }
}
