import { useCallback, useEffect, useState } from 'react'
import { ExternalLink, LoaderCircle, Plus, X } from 'lucide-react'
import { ApiError, type SessionUser } from './api'
import { createCatalogProfile, getCatalogListing, type CatalogListingDetail } from './productAttributesApi'
import { ProductAttributesSections, useProductAttributes } from './ProductAttributes'
import './productAttributes.css'

const message = (cause: unknown) => cause instanceof ApiError || cause instanceof Error ? cause.message : '操作未完成，请稍后重试。'
const can = (user: SessionUser, name: string) => (user.permissions || []).some(v => v === '*' || v === name || v === `${name.split(':')[0]}:*`)
const statusNames: Record<string, string> = { published: '在售', 'member expired': '已过期', expired: '已过期', auditing: '审核中', new: '新发布', TBD: '待处理' }

/** What the shop adds to a platform product: mounted once the CRM record exists. */
function ProfileEditor({ productId, category, canEdit, onSaved, setError }: { productId: string; category: string | null; canEdit: boolean; onSaved: (text: string) => void; setError: (text: string) => void }) {
  const state = useProductAttributes(productId), [saving, setSaving] = useState(false)
  async function save() {
    setSaving(true); setError('')
    try { await state.save(productId); onSaved('资料已保存，只保存在 CRM，不会改动 1688 上的商品。') } catch (cause) { setError(message(cause)) } finally { setSaving(false) }
  }
  return <>
    {/* The platform's own attributes are already listed above; only what they can fill in is suggested here. */}
    <fieldset className="catalog-profile" disabled={!canEdit}><ProductAttributesSections state={state} category={category} hideListingSuggestions /></fieldset>
    {canEdit && <footer className="catalog-detail-foot"><button className="catalog-primary" disabled={saving || state.loading} onClick={() => void save()}>{saving ? '保存中…' : '保存资料'}</button></footer>}
  </>
}

/** One product of the catalogue: 1688's data, read-only, and the details the shop keeps on top of it. */
export default function CatalogDetail({ user, listingId, close, changed, openPlatform }: { user: SessionUser; listingId: string; close: () => void; changed: (notice?: string) => void; openPlatform?: () => void }) {
  const [detail, setDetail] = useState<CatalogListingDetail | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const load = useCallback(() => getCatalogListing(listingId).then(r => setDetail(r.data)).catch(cause => setError(message(cause))), [listingId])
  useEffect(() => { void load() }, [load])
  useEffect(() => { const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') close() }; window.addEventListener('keydown', escape); return () => window.removeEventListener('keydown', escape) }, [close])
  const canCreate = can(user, 'product:create'), canEdit = can(user, 'product:update')
  async function start() {
    setBusy(true); setError('')
    try { await createCatalogProfile(listingId); await load(); changed() } catch (cause) { setError(message(cause)) } finally { setBusy(false) }
  }
  const l = detail?.listing
  return <div className="drawer-layer"><button className="drawer-scrim" onClick={close} aria-label="关闭" /><aside className="record-drawer product-drawer catalog-detail" role="dialog" aria-modal="true" aria-label={l?.title ?? '产品详情'}>
    <header><div><h2>{l?.title ?? '产品详情'}</h2></div><button onClick={close} aria-label="关闭"><X size={20} /></button></header>
    <div className="catalog-detail-body">
      {error && <div className="form-error" role="alert">{error}</div>}
      {!detail && !error && <div className="shop-empty"><LoaderCircle size={24} className="spin" /></div>}
      {l && <>
        <section className="attr-section" aria-label="平台信息">
          <div className="attr-head"><div><p className="kicker">1688 · 同步于 {new Date(l.synced_at).toLocaleString('zh-CN')}</p><h3>平台信息</h3></div>
            <div className="attr-actions"><a className="catalog-link" href={`https://detail.1688.com/offer/${l.offer_id}.html`} target="_blank" rel="noreferrer"><ExternalLink size={14} />在 1688 查看</a>{openPlatform && <button type="button" onClick={openPlatform}>库存与平台操作</button>}</div></div>
          {l.images.length > 0 && <div className="catalog-images">{l.images.slice(0, 8).map(url => <img key={url} src={url} alt="" loading="lazy" referrerPolicy="no-referrer" />)}</div>}
          <dl className="catalog-facts">
            <div><dt>状态</dt><dd>{statusNames[l.status] ?? l.status}</dd></div><div><dt>店铺</dt><dd>{l.shop ?? '—'}</dd></div><div><dt>商品 ID</dt><dd>{l.offer_id}</dd></div><div><dt>货号</dt><dd>{l.cargo_number ?? '—'}</dd></div><div><dt>类目</dt><dd>{l.category ?? '—'}</dd></div>
            <div><dt>库存</dt><dd>{l.stock ?? '—'}{l.unit ?? ''}</dd></div><div><dt>起订量</dt><dd>{l.min_order ?? '—'}</dd></div><div><dt>发货地</dt><dd>{l.send_address ?? '—'}</dd></div>
            {l.price_ranges.length > 0 ? <div><dt>阶梯价</dt><dd>{l.price_ranges.map(p => `≥${p.start ?? 1} ¥${p.price}`).join('；')}</dd></div> : <div><dt>参考价</dt><dd>{l.reference_price != null ? `¥${l.reference_price}` : '—'}</dd></div>}
          </dl>
          {l.attributes.length > 0 && <><h4 className="catalog-subtitle">平台属性（{l.attributes.length}）</h4><dl className="catalog-attrs">{l.attributes.map((a, i) => <div key={`${a.name}-${i}`}><dt>{a.name}</dt><dd>{a.value}</dd></div>)}</dl></>}
          {l.skus.length > 0 && <><h4 className="catalog-subtitle">规格（{l.skus.length}）</h4><div className="shop-table-scroll"><table className="shop-table"><thead><tr><th>规格</th><th>价格</th><th>库存</th></tr></thead><tbody>{l.skus.map((s, i) => <tr key={s.spec_id ?? i}><td>{s.attributes.map(a => a.value).join(' / ') || s.spec_id || '—'}</td><td>{s.price != null ? `¥${s.price}` : '—'}</td><td>{s.stock ?? '—'}</td></tr>)}</tbody></table></div></>}
        </section>
        {detail.product
          ? <ProfileEditor key={detail.product.id} productId={detail.product.id} category={detail.product.category} canEdit={canEdit} setError={setError} onSaved={text => { changed(text); close() }} />
          : <section className="attr-section catalog-start" aria-label="补充资料"><h3>长宽高、重量、箱规和其他资料</h3>
            <p>平台没有提供的信息可以在这里补充。保存在 CRM，不会改动 1688 上的商品。</p>
            {canCreate ? <button className="catalog-primary" disabled={busy} onClick={() => void start()}><Plus size={15} />{busy ? '正在建立…' : '补充资料'}</button> : <p className="attr-note">当前账号没有新建产品的权限，只能查看。</p>}</section>}
      </>}
    </div>
  </aside></div>
}
