import { useCallback, useEffect, useMemo, useState, type ChangeEvent, type FormEvent } from 'react'
import { Check, Download, LoaderCircle, Plus, Trash2, Upload, X } from 'lucide-react'
import { logisticsOfferInfo, measurementLabels, type Measurement, type MeasurementField } from '../shared/product-attributes'
import { createAttributeDef, exportProductAttributes, getAttributeDefs, getProductAttributes, importProductAttributes, saveProductAttributes, updateAttributeDef, type AttributeDef, type AttributeInput, type ImportResult, type ProductAttributeData } from './productAttributesApi'
import './productAttributes.css'

const message = (cause: unknown) => cause instanceof Error ? cause.message : '操作未完成，请稍后重试。'
type Row = { key: number; label: string; value: string; unit: string; groupName: string; defId: string | null; source: string; confirmed: boolean }
const CUSTOM_GROUP = '自定义', DEFAULT_GROUP = '产品特性'
let nextKey = 1
const toRow = (a: { label: string; value: string; unit?: string | null; group_name?: string; def_id?: string | null; source?: string; confirmed_at?: string | null }): Row => ({ key: nextKey++, label: a.label, value: a.value, unit: a.unit ?? '', groupName: a.group_name ?? DEFAULT_GROUP, defId: a.def_id ?? null, source: a.source ?? 'manual', confirmed: a.confirmed_at !== null })

type Unit = 'g' | 'cm' | 'count'
/** Stored as grams and millimetres; sizes are entered in centimetres, as on the 1688 form. */
const groups: { title: string; hint: string; fields: { field: MeasurementField; label: string; unit: Unit }[] }[] = [
  { title: '产品本体', hint: '不含包装；可带入发布草稿的“净重”“尺寸”类属性。', fields: [{ field: 'net_weight_g', label: '净重（g）', unit: 'g' }, { field: 'product_length_mm', label: '长（cm）', unit: 'cm' }, { field: 'product_width_mm', label: '宽（cm）', unit: 'cm' }, { field: 'product_height_mm', label: '高（cm）', unit: 'cm' }] },
  { title: '销售包装（件重尺）', hint: '单件含销售包装；带入发布草稿的件重尺，重量必填才会带入。', fields: [{ field: 'package_weight_g', label: '含包装重量（g）', unit: 'g' }, { field: 'package_length_mm', label: '长（cm）', unit: 'cm' }, { field: 'package_width_mm', label: '宽（cm）', unit: 'cm' }, { field: 'package_height_mm', label: '高（cm）', unit: 'cm' }] },
  { title: '外箱箱规', hint: '只保存在 CRM，不提交平台。', fields: [{ field: 'carton_quantity', label: '每箱数量', unit: 'count' }, { field: 'carton_gross_weight_g', label: '箱毛重（g）', unit: 'g' }, { field: 'carton_length_mm', label: '长（cm）', unit: 'cm' }, { field: 'carton_width_mm', label: '宽（cm）', unit: 'cm' }, { field: 'carton_height_mm', label: '高（cm）', unit: 'cm' }] },
]
const unitOf = Object.fromEntries(groups.flatMap(g => g.fields.map(f => [f.field, f.unit]))) as Record<MeasurementField, Unit>
const display = (field: MeasurementField, stored: number | null | undefined) => stored == null ? '' : String(unitOf[field] === 'cm' ? stored / 10 : stored)
function storedValue(field: MeasurementField, text: string): number | null | 'invalid' {
  const trimmed = text.trim()
  if (!trimmed) return null
  const value = Number(trimmed), stored = unitOf[field] === 'cm' ? value * 10 : value
  if (!Number.isFinite(stored) || stored <= 0 || Math.abs(stored - Math.round(stored)) > 1e-6) return 'invalid'
  return Math.round(stored)
}

/** The form state lives here so the drawer saves the product first and the attributes with the id it gets back. */
export function useProductAttributes(productId: string | null) {
  const [data, setData] = useState<ProductAttributeData | null>(null), [loading, setLoading] = useState(Boolean(productId)), [loadError, setLoadError] = useState('')
  const [texts, setTexts] = useState<Partial<Record<MeasurementField, string>>>({}), [rows, setRows] = useState<Row[]>([]), [dismissed, setDismissed] = useState<string[]>([])
  useEffect(() => {
    if (!productId) return
    let live = true
    getProductAttributes(productId).then(result => {
      if (!live) return
      const m = result.data.measurement
      setData(result.data)
      setTexts(Object.fromEntries((Object.keys(measurementLabels) as MeasurementField[]).map(field => [field, display(field, m?.[field])])))
      setRows(result.data.attributes.map(toRow))
    }).catch(cause => { if (live) setLoadError(message(cause)) }).finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [productId])
  const invalid = useMemo(() => (Object.keys(texts) as MeasurementField[]).filter(field => storedValue(field, texts[field] ?? '') === 'invalid'), [texts])
  const preview = useMemo(() => {
    const m: Measurement = {}
    for (const field of Object.keys(texts) as MeasurementField[]) { const value = storedValue(field, texts[field] ?? ''); if (typeof value === 'number') m[field] = value }
    return logisticsOfferInfo(m)
  }, [texts])
  const save = useCallback(async (id: string) => {
    if (loadError) throw new Error('属性数据没有加载成功，请关闭后重试。')
    if (invalid.length) throw new Error(`${invalid.map(f => measurementLabels[f]).join('、')} 的数值不正确（重量为正整数，尺寸最多一位小数）。`)
    const clean = rows.filter(r => r.label.trim() || r.value.trim())
    if (clean.some(r => !r.label.trim() || !r.value.trim())) throw new Error('属性的名称和内容都需要填写。')
    const measurement = { revision: data?.measurement?.revision ?? 0 } as Measurement & { revision: number }
    for (const field of Object.keys(texts) as MeasurementField[]) { const value = storedValue(field, texts[field] ?? ''); measurement[field] = value === 'invalid' ? null : value }
    const attributes: AttributeInput[] = clean.map(r => ({ defId: r.defId, label: r.label.trim(), value: r.value.trim(), unit: r.unit.trim() || null, groupName: r.groupName, source: r.source, confirmed: r.confirmed }))
    await saveProductAttributes(id, { ...(Object.keys(texts).length ? { measurement } : {}), attributes })
  }, [data, invalid, loadError, rows, texts])
  return { data, loading, loadError, texts, setTexts, rows, setRows, dismissed, setDismissed, invalid, preview, save }
}
type State = ReturnType<typeof useProductAttributes>

export function ProductAttributesSections({ state, category, hideListingSuggestions }: { state: State; category?: string | null; hideListingSuggestions?: boolean }) {
  const { data, loading, loadError, texts, setTexts, rows, setRows, dismissed, setDismissed, invalid, preview } = state
  const [defs, setDefs] = useState<AttributeDef[]>([])
  useEffect(() => { getAttributeDefs(category || undefined).then(r => setDefs(r.data.filter(d => d.active))).catch(() => setDefs([])) }, [category])
  const used = new Set(rows.map(r => r.label.trim().toLowerCase()))
  const available = defs.filter(d => !used.has(d.label.toLowerCase()))
  const add = (row: Partial<Row>) => setRows(current => [...current, { key: nextKey++, label: '', value: '', unit: '', groupName: DEFAULT_GROUP, defId: null, source: 'manual', confirmed: true, ...row }])
  const change = (key: number, patch: Partial<Row>) => setRows(current => current.map(r => r.key === key ? { ...r, ...patch } : r))
  const attributeSuggestions = (data?.suggestions.attributes ?? []).filter(s => !used.has(s.label.toLowerCase()) && !dismissed.includes(s.label) && !(hideListingSuggestions && s.source === 'listing'))
  const measurementSuggestions = (data?.suggestions.measurements ?? []).filter(s => !texts[s.field]?.trim() && !dismissed.includes(s.field))
  if (loading) return <section className="attr-section"><LoaderCircle size={18} className="spin" /></section>
  if (loadError) return <section className="attr-section"><p className="form-error">{loadError}</p></section>
  return <>
    <section className="attr-section" aria-label="尺寸重量与箱规">
      <div className="attr-head"><div><p className="kicker">尺寸重量</p><h3>尺寸、重量与箱规</h3></div></div>
      {groups.map(group => <fieldset key={group.title} className="attr-measure"><legend>{group.title}</legend><p>{group.hint}</p>
        <div>{group.fields.map(f => <label key={f.field} className={invalid.includes(f.field) ? 'invalid' : ''}><span>{f.label}</span><input aria-label={`${group.title} ${f.label}`} inputMode="decimal" value={texts[f.field] ?? ''} onChange={e => setTexts(current => ({ ...current, [f.field]: e.target.value }))} /></label>)}</div>
      </fieldset>)}
      {preview && <p className="attr-note">带入件重尺：{preview.weight}g{preview.length ? ` · ${preview.length}×${preview.width}×${preview.height}cm（平台要求长 ≥ 宽 ≥ 高，已自动排序）· 体积 ${preview.volume} cm³` : ' · 尺寸未填'}</p>}
      {measurementSuggestions.length > 0 && <div className="attr-suggest"><b>可从现有资料识别</b>{measurementSuggestions.map(s => <span key={s.field}>{measurementLabels[s.field]} = {s.value}<small>来自 {s.from}</small>
        <button type="button" aria-label={`采纳 ${measurementLabels[s.field]}`} onClick={() => setTexts(current => ({ ...current, [s.field]: display(s.field, s.value) }))}><Check size={13} />采纳</button>
        <button type="button" aria-label={`忽略 ${measurementLabels[s.field]}`} onClick={() => setDismissed(current => [...current, s.field])}><X size={13} /></button></span>)}</div>}
    </section>
    <section className="attr-section" aria-label="产品特性与自定义属性">
      <div className="attr-head"><div><p className="kicker">属性</p><h3>产品特性与自定义属性</h3></div>
        <div className="attr-actions">
          {available.length > 0 && <select aria-label="从模板添加" value="" onChange={e => { const def = available.find(d => d.id === e.target.value); if (def) add({ label: def.label, unit: def.unit ?? '', groupName: def.group_name, defId: def.id }) }}><option value="">从模板添加…</option>{available.map(d => <option key={d.id} value={d.id}>{d.group_name} · {d.label}</option>)}</select>}
          <button type="button" onClick={() => add({})}><Plus size={14} />添加特性</button>
          <button type="button" onClick={() => add({ groupName: CUSTOM_GROUP })}><Plus size={14} />自定义属性</button>
        </div></div>
      <p className="attr-note">名称与发布类目字段相同或同义、且取值能匹配时会带入草稿；其余只保存在 CRM。</p>
      {!rows.length && <p className="tier-empty">还没有属性。</p>}
      {rows.map(row => <article key={row.key} className={`attr-row ${row.confirmed ? '' : 'pending'}`}>
        <label><span>名称</span><input aria-label="属性名称" value={row.label} maxLength={60} onChange={e => change(row.key, { label: e.target.value })} /></label>
        <label><span>内容</span><input aria-label="属性内容" value={row.value} maxLength={1000} onChange={e => change(row.key, { value: e.target.value })} /></label>
        <label><span>单位</span><input aria-label="属性单位" value={row.unit} maxLength={20} onChange={e => change(row.key, { unit: e.target.value })} /></label>
        <label><span>分组</span><input aria-label="属性分组" value={row.groupName} maxLength={30} onChange={e => change(row.key, { groupName: e.target.value })} /></label>
        <button type="button" aria-label={`删除属性 ${row.label}`} onClick={() => setRows(current => current.filter(r => r.key !== row.key))}><Trash2 size={14} /></button>
        {!row.confirmed && <label className="attr-confirm"><input type="checkbox" onChange={e => change(row.key, { confirmed: e.target.checked })} />已核对（未核对的不会带入草稿）</label>}
      </article>)}
      {attributeSuggestions.length > 0 && <div className="attr-suggest"><b>采集或在售商品里还有这些属性，核对后可采纳</b>{attributeSuggestions.slice(0, 30).map(s => <span key={s.label}>{s.label}：{s.value}<small>{s.source_name}</small>
        <button type="button" aria-label={`采纳 ${s.label}`} onClick={() => add({ label: s.label, value: s.value, source: s.source })}><Check size={13} />采纳</button>
        <button type="button" aria-label={`忽略 ${s.label}`} onClick={() => setDismissed(current => [...current, s.label])}><X size={13} /></button></span>)}</div>}
    </section>
  </>
}

function Dialog({ title, close, children }: { title: string; close: () => void; children: React.ReactNode }) {
  return <div className="dialog-layer"><button className="drawer-scrim" onClick={close} aria-label="关闭" /><section className="attr-dialog" role="dialog" aria-modal="true" aria-label={title}><header><h2>{title}</h2><button onClick={close} aria-label="关闭"><X size={18} /></button></header>{children}</section></div>
}

/** 属性模板: the fields suggested when filling in a product, per category or for all. */
export function AttributeTemplatesDialog({ close, categories }: { close: () => void; categories: string[] }) {
  const [defs, setDefs] = useState<AttributeDef[]>([]), [error, setError] = useState(''), [form, setForm] = useState({ label: '', groupName: DEFAULT_GROUP, unit: '', category: '' }), [busy, setBusy] = useState(false)
  const load = useCallback(() => getAttributeDefs().then(r => setDefs(r.data)).catch(cause => setError(message(cause))), [])
  useEffect(() => { void load() }, [load])
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('')
    try { await createAttributeDef({ label: form.label, groupName: form.groupName, unit: form.unit || null, category: form.category || null }); setForm(current => ({ ...current, label: '', unit: '' })); await load() } catch (cause) { setError(message(cause)) } finally { setBusy(false) }
  }
  return <Dialog title="属性模板" close={close}>
    <p className="attr-note">模板决定填写产品时可以快速添加哪些属性；不会改动已有产品。</p>
    <form className="attr-def-form" onSubmit={submit}>
      <label><span>属性名称</span><input required maxLength={60} value={form.label} onChange={e => setForm({ ...form, label: e.target.value })} /></label>
      <label><span>分组</span><input required maxLength={30} value={form.groupName} onChange={e => setForm({ ...form, groupName: e.target.value })} /></label>
      <label><span>单位</span><input maxLength={20} value={form.unit} onChange={e => setForm({ ...form, unit: e.target.value })} /></label>
      <label><span>适用分类</span><select value={form.category} onChange={e => setForm({ ...form, category: e.target.value })}><option value="">全部分类</option>{categories.map(c => <option key={c}>{c}</option>)}</select></label>
      <button disabled={busy || !form.label.trim()}><Plus size={14} />添加</button>
    </form>
    {error && <p className="form-error">{error}</p>}
    <div className="attr-def-list">{defs.map(def => <div key={def.id} className={def.active ? '' : 'off'}><b>{def.label}{def.unit ? `（${def.unit}）` : ''}</b><span>{def.group_name} · {def.category ?? '全部分类'}</span>
      <button onClick={() => updateAttributeDef(def, !def.active).then(load).catch(cause => setError(message(cause)))}>{def.active ? '停用' : '启用'}</button></div>)}
      {!defs.length && <p className="tier-empty">还没有模板。</p>}</div>
  </Dialog>
}

/** CSV round trip: export, fill in with Excel, check, import. Nothing is written until the check is clean and confirmed. */
export function AttributeImportDialog({ close, imported }: { close: () => void; imported: () => void }) {
  const [csv, setCsv] = useState(''), [name, setName] = useState(''), [check, setCheck] = useState<ImportResult | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('')
  async function pick(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    setCheck(null); setError('')
    if (!file) return
    if (file.size > 3_000_000) { setError('文件不能超过 3MB。'); return }
    const text = await file.text()
    setCsv(text); setName(file.name); setBusy(true)
    try { setCheck((await importProductAttributes(text, true)).data) } catch (cause) { setError(message(cause)) } finally { setBusy(false) }
  }
  async function apply() {
    setBusy(true); setError('')
    try { await importProductAttributes(csv, false); imported() } catch (cause) { setError(message(cause)); setBusy(false) }
  }
  return <Dialog title="批量导入导出" close={close}>
    <ol className="attr-steps"><li>导出现有数据：<button onClick={() => exportProductAttributes().catch(cause => setError(message(cause)))}><Download size={14} />导出 CSV</button></li>
      <li>用 Excel 填写后另存为 CSV。重量单位是克，尺寸单位是毫米；新增属性时加一列，列名写“属性:名称”；留空的单元格不改动。</li>
      <li><label className="attr-file"><Upload size={14} />选择 CSV 文件<input type="file" accept=".csv,text/csv" onChange={pick} /></label>{name && <span>{name}</span>}</li></ol>
    {busy && <LoaderCircle size={18} className="spin" />}
    {error && <p className="form-error">{error}</p>}
    {check && <div className="attr-check"><p>共 {check.rows} 行：{check.measurements} 个产品更新尺寸，{check.attributes} 项属性。</p>
      {check.unknownColumns.length > 0 && <p>这些列不会导入：{check.unknownColumns.join('、')}</p>}
      {check.errorCount > 0 ? <><p className="form-error">有 {check.errorCount} 个问题，修正后才能导入：</p><ul>{check.errors.map((e, i) => <li key={i}>第 {e.line} 行：{e.message}</li>)}</ul></>
        : <button className="primary" disabled={busy} onClick={() => void apply()}>确认导入</button>}</div>}
  </Dialog>
}
