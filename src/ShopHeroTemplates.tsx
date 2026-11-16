import { useEffect, useRef, useState } from 'react'
import { ImageUp } from 'lucide-react'
import { fileToBase64, getHeroTemplateShops, saveHeroTemplate, type HeroTemplateMode, type HeroTemplateShop } from './imageApi'

const modes: Record<HeroTemplateMode, string> = { none: '普通首图', 'tuoyang-v1': '拓洋黑金模板', 'custom-v1': '自定义模板' }
const errorMessage = (error:unknown) => error instanceof Error ? error.message : '首图模板操作失败，请重试。'

function useHeroTemplateShops() {
  const [shops, setShops] = useState<HeroTemplateShop[]|null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let current = true
    getHeroTemplateShops().then(({ data }) => { if (current) setShops(data) })
      .catch(cause => { if (current) setError(errorMessage(cause)) })
    return () => { current = false }
  }, [])
  return { shops, setShops, error }
}

export function HeroShopPicker({ shopId, change, followProduct, disabled, label = '首图店铺' }:{
  shopId?:string|null; change:(id:string|null|undefined)=>void; followProduct:boolean; disabled?:boolean; label?:string
}) {
  const { shops, error } = useHeroTemplateShops()
  const value = shopId === undefined && followProduct ? 'product' : shopId ?? ''
  return <label className="iw-field iw-hero-shop-picker">{label}
    <select value={value} disabled={disabled || !shops} onChange={e => change(e.target.value === 'product' ? undefined : e.target.value || null)}>
      {followProduct && <option value="product">跟随商品的目标店铺</option>}
      <option value="">企业通用</option>
      {shops?.map(s => <option value={s.id} key={s.id}>{s.display_name} · {modes[s.mode]}</option>)}
    </select>
    {error && <small className="iw-error" role="status">{error}</small>}
  </label>
}

function ShopTemplateRow({ shop, editable, changed }:{shop:HeroTemplateShop;editable:boolean;changed:(next:HeroTemplateShop)=>void}) {
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  async function save(mode:HeroTemplateMode, file?:File) {
    setBusy(true); setError(''); setNotice('')
    try {
      if (file && file.size > 8 * 1024 * 1024) throw new Error('模板图片需在 8 MB 以内。')
      const content = file ? await fileToBase64(file) : undefined
      changed((await saveHeroTemplate(shop.id, { mode, revision:shop.revision, content })).data)
      setNotice(file ? '已上传并启用' : '已保存')
    } catch (cause) { setError(errorMessage(cause)) } finally { setBusy(false) }
  }
  return <li className="iw-shop-template" aria-busy={busy}>
    <div className="iw-shop-template-name">
      {shop.previewUrl && <img src={shop.previewUrl} loading="lazy" alt="已上传的模板边框" referrerPolicy="no-referrer"/>}
      <strong>{shop.display_name}</strong>
    </div>
    <select aria-label={`${shop.display_name} 首图模板`} value={shop.mode} disabled={!editable || busy} onChange={e => void save(e.target.value as HeroTemplateMode)}>
      {Object.entries(modes).map(([mode, label]) => <option key={mode} value={mode} disabled={mode === 'custom-v1' && !shop.hasCustom}>{label}</option>)}
    </select>
    {editable && <>
      <button className="shop-button" type="button" disabled={busy} onClick={() => input.current?.click()} aria-label={`${shop.display_name} ${shop.hasCustom ? '更换模板' : '上传模板'}`}>
        <ImageUp size={15} aria-hidden="true"/>{busy ? '正在保存…' : shop.hasCustom ? '更换模板' : '上传模板'}
      </button>
      <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={e => {
        const file = e.target.files?.[0]
        e.target.value = ''
        if (file) void save('custom-v1', file)
      }}/>
    </>}
    {error && <small className="iw-error iw-shop-template-message" role="alert">{error}</small>}
    {notice && <small className="iw-shop-template-message" role="status">{notice}</small>}
  </li>
}

export default function ShopHeroTemplates({ editable }:{ editable:boolean }) {
  const { shops, setShops, error } = useHeroTemplateShops()
  return <section className="iw-shop-templates" aria-labelledby="iw-shop-templates-title">
    <h4 id="iw-shop-templates-title">1688 首图参考模板</h4>
    <p>每家店铺单独选择。自定义模板支持 PNG、JPG、WebP，上传后保留上方 12% 和下方 20% 的边框、文字和 Logo，中间用于展示商品和卖点。</p>
    {error ? <p className="iw-error" role="alert">{error}</p> : shops === null ? <p role="status">正在读取店铺…</p> : shops.length === 0 ? <p>还没有授权商品应用的店铺。</p> :
      <ul>{shops.map(shop => <ShopTemplateRow key={shop.id} shop={shop} editable={editable}
        changed={next => setShops(list => list?.map(row => row.id === next.id ? next : row) ?? null)}/>)}</ul>}
  </section>
}
