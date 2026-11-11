import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, Check, ImagePlus, LoaderCircle, Star, Trash2, Upload } from 'lucide-react'
import { createBrand, deleteBrand, fileToBase64, getBrands, updateBrand, type Brand } from './imageApi'
import './imageWorkshop.css'

const message = (cause: unknown) => cause instanceof Error ? cause.message : '操作未完成，请稍后重试。'
const MAX_LOGO_BYTES = 5 * 1024 * 1024
type Form = { name: string; aliases: string; logo: File | null; preview: string; removeLogo: boolean; isDefault: boolean; confirmed: boolean }
const empty: Form = { name: '', aliases: '', logo: null, preview: '', removeLogo: false, isDefault: false, confirmed: false }
const splitAliases = (text: string) => [...new Set(text.split(/[,，、\n]/).map(v => v.trim()).filter(Boolean))]

/** 图片 → 品牌: the shop's own brand names and logos, used by image suites and the listing's brand attribute. */
export default function BrandsPage() {
  const [brands, setBrands] = useState<Brand[]>([]), [loading, setLoading] = useState(true), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [editing, setEditing] = useState<Brand | null>(null), [form, setForm] = useState<Form>(empty), [busy, setBusy] = useState('')
  const file = useRef<HTMLInputElement>(null)
  const load = useCallback(async () => { try { setBrands((await getBrands()).data); setError('') } catch (cause) { setError(message(cause)) } finally { setLoading(false) } }, [])
  useEffect(() => { void load() }, [load])

  const reset = () => { setEditing(null); setForm(empty); if (file.current) file.current.value = '' }
  const edit = (brand: Brand) => { setEditing(brand); setNotice(''); setError(''); setForm({ ...empty, name: brand.name, aliases: brand.aliases.join('、'), preview: brand.logo_url ?? '' }) }
  function pick(list: FileList | null) {
    const picked = list?.[0]
    if (!picked) return
    if (picked.size > MAX_LOGO_BYTES) { setError('Logo 不能超过 5MB。'); return }
    setError(''); setForm(f => ({ ...f, logo: picked, preview: URL.createObjectURL(picked), removeLogo: false }))
  }
  const run = async (key: string, work: () => Promise<string>) => { setBusy(key); setError(''); setNotice(''); try { setNotice(await work()); await load() } catch (cause) { setError(message(cause)) } finally { setBusy('') } }

  const aliases = splitAliases(form.aliases)
  const identityChanged = !editing || form.name.trim() !== editing.name || aliases.join('|') !== editing.aliases.join('|') || Boolean(form.logo)
  const canSave = form.name.trim().length > 0 && (!identityChanged || form.confirmed) && !busy
  async function save() {
    const logoContent = form.logo ? await fileToBase64(form.logo) : undefined
    if (editing) {
      await updateBrand(editing.id, { name: form.name.trim(), aliases, logoContent, removeLogo: form.removeLogo || undefined, rightsConfirmed: identityChanged ? true : undefined })
      reset(); return '品牌已更新'
    }
    await createBrand({ name: form.name.trim(), aliases, logoContent, isDefault: form.isDefault, rightsConfirmed: true })
    reset(); return '品牌已添加'
  }

  return <div className="br-page">
    <section className="br-panel">
      <h3>{editing ? `编辑 ${editing.name}` : '添加品牌'}</h3>
      <label className="iw-field">品牌名称<input aria-label="品牌名称" maxLength={40} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="写在商品属性和套图上的名称"/></label>
      <label className="iw-field">Logo 上的其他写法（可选）<input aria-label="品牌别名" value={form.aliases} onChange={e => setForm({ ...form, aliases: e.target.value })} placeholder="如英文名，多个用顿号分隔"/></label>
      <div className="iw-field">Logo（可选）
        <div className="br-logo-drop">
          {form.preview && !form.removeLogo ? <img src={form.preview} alt="Logo 预览"/> : <span className="br-logo-empty"><ImagePlus size={22}/></span>}
          <div className="br-actions">
            <button className="shop-button" type="button" onClick={() => file.current?.click()}><Upload size={14}/>{form.preview && !form.removeLogo ? '更换' : '上传'}</button>
            {editing?.logo_url && !form.logo && !form.removeLogo && <button className="shop-button" type="button" onClick={() => setForm({ ...form, removeLogo: true })}>移除</button>}
          </div>
          <input ref={file} type="file" accept="image/png,image/jpeg,image/webp" hidden aria-label="选择 Logo 文件" onChange={e => pick(e.target.files)}/>
        </div>
        <small>建议透明背景的 PNG，长边至少 120 像素，不超过 5MB。</small>
      </div>
      {!editing && <label className="br-check"><input type="checkbox" checked={form.isDefault} onChange={e => setForm({ ...form, isDefault: e.target.checked })}/>设为默认品牌（第一个品牌自动成为默认）</label>}
      {identityChanged && <label className="br-check"><input type="checkbox" aria-label="确认品牌权利" checked={form.confirmed} onChange={e => setForm({ ...form, confirmed: e.target.checked })}/>确认本店拥有该品牌和 Logo，或已获得授权。登记后，图片检测不再把它当作他人品牌。</label>}
      {error && <p className="iw-error"><AlertCircle size={14}/>{error}</p>}
      <div className="br-actions">
        {editing && <button className="shop-button" onClick={reset}>取消</button>}
        <button className="shop-button primary" disabled={!canSave} onClick={() => void run('save', save)}>{busy === 'save' ? <LoaderCircle size={15} className="spin"/> : <Check size={15}/>}{editing ? '保存' : '添加品牌'}</button>
      </div>
    </section>
    <section className="br-panel">
      <h3>本店品牌</h3>
      <small className="br-hint">默认品牌会自动用于电商套图、AI 替代图和上架时的品牌属性。Logo 原样放在除白底图外每张图的左上角。</small>
      {notice && <p className="iw-note"><Check size={14}/><span>{notice}</span></p>}
      {loading ? <p className="iw-empty">正在读取…</p> : !brands.length ? <p className="iw-empty">还没有品牌。添加后，新生成的套图会自动带上品牌。</p>
        : <ul className="br-list">{brands.map(brand => <li key={brand.id}>
          {brand.logo_url ? <img src={brand.logo_url} alt={`${brand.name} Logo`}/> : <span className="br-logo-empty"><ImagePlus size={18}/></span>}
          <div className="br-info"><b>{brand.name}</b>{brand.is_default && <span className="br-tag">默认</span>}<small>{brand.aliases.length ? `其他写法：${brand.aliases.join('、')}` : brand.logo_url ? '' : '未上传 Logo'}</small></div>
          <div className="br-actions">
            {!brand.is_default && <button className="shop-button" disabled={Boolean(busy)} onClick={() => void run(brand.id, async () => { await updateBrand(brand.id, { isDefault: true }); return `已将 ${brand.name} 设为默认品牌` })}><Star size={14}/>设为默认</button>}
            <button className="shop-button" disabled={Boolean(busy)} onClick={() => edit(brand)}>编辑</button>
            <button className="shop-button" aria-label={`删除 ${brand.name}`} disabled={Boolean(busy)} onClick={() => { if (window.confirm(`删除品牌“${brand.name}”？已生成的图片不受影响。`)) void run(brand.id, async () => { await deleteBrand(brand.id); if (editing?.id === brand.id) reset(); return '品牌已删除' }) }}><Trash2 size={14}/></button>
          </div>
        </li>)}</ul>}
    </section>
  </div>
}
