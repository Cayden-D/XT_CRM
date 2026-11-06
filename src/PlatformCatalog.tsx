import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, ExternalLink, Inbox, Package, Plus, RefreshCw, Search, SearchX, Square, X } from 'lucide-react'
import { ApiError, type SessionUser } from './api'
import { getShopListing, syncShop, syncNotice, type CatalogGroup, type CatalogItem, type CatalogShop, type CatalogSort, type PlatformListing } from './1688Api'
import { ListingViewer } from './1688Page'
import CatalogDetail from './CatalogDetail'
import { request } from './api'
import Pagination, { useDebounced } from './Pagination'
import { NeedShop } from './ui'
import { ago } from './ProductCollectionsPage'

const permission = (user: SessionUser, name: string) => (user.permissions || []).some(v => v === '*' || v === name || v === `${name.split(':')[0]}:*`)
const imageUrl = (value: string) => value.startsWith('img/') ? `https://cbu01.alicdn.com/${value}` : value
const yuan = (value: number) => `¥${value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const priceText = (item: CatalogItem) => item.price_min == null ? '价格待同步' : item.price_max != null && item.price_max > item.price_min ? `${yuan(item.price_min)}–${item.price_max.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : yuan(item.price_min)
/** 1688 stock is often a large placeholder; show it compactly. */
const compact = (n: number) => n >= 10_000 ? `${(n / 10_000).toLocaleString('zh-CN', { maximumFractionDigits: 1 })} 万` : n.toLocaleString('zh-CN')
const groupNames: Record<CatalogGroup, string> = { on_sale: '在售', expired: '已过期', other: '其他状态' }
const statusNames: Record<string, string> = { published: '在售', 'member expired': '已过期', expired: '已过期', auditing: '审核中', new: '新发布', TBD: '待处理' }
const sortNames: Record<CatalogSort, string> = { recent: '最近更新', sales: '近 30 天销量', price_asc: '价格从低到高', price_desc: '价格从高到低', stock: '库存从少到多' }
const message = (cause: unknown) => cause instanceof ApiError || cause instanceof Error ? cause.message : '操作失败，请重试。'

/** 在售商品: what is actually listed on the shop's 1688 storefront (as last synced), with 30-day sales. */
export default function PlatformCatalog({ user, onAdd }: { user: SessionUser; onAdd?: () => void }) {
  const canManage = permission(user, 'integration:manage'), canPublish = permission(user, 'integration:publish'), canSeeShop = permission(user, 'integration:read')
  const [detailId, setDetailId] = useState(''), [missingPackage, setMissingPackage] = useState(false)
  const [items, setItems] = useState<CatalogItem[]>([]), [facets, setFacets] = useState<Record<CatalogGroup, number>>({ on_sale: 0, expired: 0, other: 0 }), [shops, setShops] = useState<CatalogShop[]>([])
  const [group, setGroup] = useState<CatalogGroup>('on_sale'), [sort, setSort] = useState<CatalogSort>('recent'), [shop, setShop] = useState(''), [search, setSearch] = useState('')
  const [page, setPage] = useState(1), [pageSize, setPageSize] = useState(24), [total, setTotal] = useState(0)
  const [loaded, setLoaded] = useState(false), [loading, setLoading] = useState(true), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [syncing, setSyncing] = useState(false), [viewing, setViewing] = useState<PlatformListing | null>(null)
  const stop = useRef(false)
  const query = useDebounced(search.trim())
  useEffect(() => { setPage(1) }, [query, group, sort, shop, pageSize, missingPackage])
  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const params = new URLSearchParams(Object.entries({ connectionId: shop, group, search: query, sort, page: String(page), pageSize: String(pageSize), missingPackage: missingPackage ? 'true' : '' }).filter(([, v]) => v))
      const r = await request<{ data: CatalogItem[]; total: number; facets: Record<CatalogGroup, number>; shops: CatalogShop[] }>(`/api/products/catalog?${params}`)
      setItems(r.data); setFacets(r.facets); setShops(r.shops); setTotal(r.total); setLoaded(true)
      if (!r.data.length && page > 1 && r.total) setPage(Math.ceil(r.total / pageSize))
    } catch (cause) { setError(message(cause)) } finally { setLoading(false) }
  }, [shop, group, query, sort, page, pageSize, missingPackage])
  useEffect(() => { void load() }, [load])

  const connected = shops.filter(s => s.status === 'connected')
  // Incremental once every shop being synced has completed a pass.
  const incremental = connected.some(s => !shop || s.id === shop) && connected.filter(s => !shop || s.id === shop).every(s => s.listings_synced_through)
  const lastSync = shops.filter(s => !shop || s.id === shop).map(s => s.synced_at).filter(Boolean).sort().at(-1) ?? null
  // Reads the shop's offers through the product app (20 per call), by default only the
  // products modified since the last completed sync; a full pass re-reads everything.
  async function sync(requested: 'incremental' | 'full' = 'incremental') {
    const targets = shop ? connected.filter(s => s.id === shop) : connected
    if (!targets.length) { setError('没有已连接的店铺，请先在“设置 → 店铺授权”中授权商品应用。'); return }
    stop.current = false; setSyncing(true); setError(''); let count = 0
    try {
      const notices: string[] = []
      for (const target of targets) {
        const before = count
        const result = await syncShop(target.id, requested, (read, total, mode) => { count = before + read; setNotice(`${mode === 'incremental' ? '增量同步' : '全量同步'}${targets.length > 1 ? ` ${target.display_name ?? ''}` : ''}：已读取 ${read} / ${total} 件`) }, () => stop.current)
        notices.push(`${targets.length > 1 ? `${target.display_name ?? '未命名店铺'}：` : ''}${syncNotice(result)}`)
        if (result.stopped) break
      }
      setNotice(notices.join('；'))
    } catch (cause) { setError(`${message(cause)}（本轮已读取 ${count} 件，已保存的数据可继续查看）`) } finally { setSyncing(false); await load() }
  }
  const open = (item: CatalogItem) => setDetailId(item.id)
  async function openPlatform() { try { setViewing((await getShopListing(detailId)).data) } catch (cause) { setError(message(cause)) } }
  const changePage = (next: number) => { setPage(next); document.querySelector('.catalog-head')?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }
  const filtered = Boolean(query || shop || missingPackage)
  const noShops = loaded && !shops.length

  return <>
    {notice && <div className="inline-notice">{notice}<button onClick={() => setNotice('')} aria-label="关闭提示"><X size={14} /></button></div>}
    <section className="catalog-head">
      <div className="catalog-search"><Search size={16} /><input value={search} onChange={e => setSearch(e.target.value)} placeholder="搜索标题、1688 商品 ID 或货号" aria-label="搜索平台商品" />{search && <button onClick={() => setSearch('')} aria-label="清除搜索"><X size={14} /></button>}</div>
      {shops.length > 1 && <select className="catalog-select" value={shop} onChange={e => setShop(e.target.value)} aria-label="店铺"><option value="">全部店铺</option>{shops.map(s => <option key={s.id} value={s.id}>{s.display_name || '未命名店铺'}</option>)}</select>}
      <select className="catalog-select" value={sort} onChange={e => setSort(e.target.value as CatalogSort)} aria-label="排序">{(Object.keys(sortNames) as CatalogSort[]).map(k => <option key={k} value={k}>{sortNames[k]}</option>)}</select>
      <label className="catalog-check"><input type="checkbox" checked={missingPackage} onChange={e => setMissingPackage(e.target.checked)} />只看缺件重尺</label>
      {onAdd && <button className="catalog-secondary" onClick={onAdd}><Plus size={15} />手动添加</button>}
      {canManage && (syncing
        ? <button className="catalog-primary" onClick={() => { stop.current = true }}><Square size={14} />停止同步</button>
        : <><button className="catalog-primary" disabled={!connected.length} title={incremental ? '只读取上次同步后修改过的商品' : '首次同步会读取全部商品'} onClick={() => void sync()}><RefreshCw size={16} />{incremental ? '同步变动' : '同步平台商品'}</button>
          {incremental && <button className="catalog-secondary" onClick={() => void sync('full')} title="重新读取店铺全部商品，用于核对或同步曾中断时">全量同步</button>}</>)}
    </section>
    <div className="catalog-subhead">
      <div className="catalog-tabs" role="tablist" aria-label="平台状态">{(Object.keys(groupNames) as CatalogGroup[]).filter(k => k !== 'other' || facets.other > 0).map(k =>
        <button key={k} role="tab" aria-selected={group === k} className={group === k ? 'active' : ''} onClick={() => setGroup(k)}>{groupNames[k]}<span>{facets[k]}</span></button>)}</div>
      <span className="catalog-sync-note">{lastSync ? `同步于 ${ago(lastSync)}` : '尚未同步'}</span>
    </div>
    {error && <section className="state-card error-state compact"><AlertCircle size={25} /><h2>出了点问题</h2><p>{error}</p><button onClick={() => void load()}><RefreshCw size={15} />重新加载</button></section>}
    {!error && !loaded && <section className="card-grid" aria-busy="true">{Array.from({ length: 8 }, (_, i) => <div key={i} className="card-skeleton"><div /><span /><span /><span /></div>)}</section>}
    {!error && noShops && <NeedShop text="还没有连接 1688 店铺" />}
    {!error && loaded && !noShops && !items.length && (filtered
      ? <section className="state-card compact"><SearchX size={26} /><h2>没有符合条件的商品</h2><p>换个关键词，或切换店铺。</p><button onClick={() => { setSearch(''); setShop(''); setMissingPackage(false) }}>清除筛选</button></section>
      : <section className="state-card compact"><Inbox size={28} /><h2>{group === 'on_sale' ? '还没有在售商品' : `没有${groupNames[group]}的商品`}</h2>{canManage && connected.length > 0 && <button onClick={() => void sync()} disabled={syncing}><RefreshCw size={15} />同步平台商品</button>}</section>)}
    {!error && loaded && items.length > 0 && <section className={`card-grid ${loading ? 'is-loading' : ''}`}>{items.map(item => <article key={item.id} className="goods-card">
      <button className="goods-media" onClick={() => void open(item)} aria-label={`查看 ${item.title}`}><Package size={28} />{item.image_url && <img src={imageUrl(item.image_url)} alt="" loading="lazy" referrerPolicy="no-referrer" onError={e => { e.currentTarget.style.display = 'none' }} />}
        {item.category && <span className="goods-source">{item.category}</span>}<span className={`goods-stage ${item.status === 'published' ? 'product-active' : item.status.includes('expired') ? 'product-inactive' : 'product-draft'}`}>{statusNames[item.status] ?? item.status}</span></button>
      <div className="goods-body">
        <button className="goods-title" onClick={() => void open(item)} title={item.title}>{item.title}</button>
        <div className="goods-price"><strong>{priceText(item)}</strong><span>{item.sku_count ? `${item.sku_count} 个 SKU` : item.unit ? `按${item.unit}` : ''}</span></div>
        <div className="goods-stats">
          {item.sales_quantity != null && <span className={item.sales_quantity > 0 ? 'hot' : ''}>{item.sales_quantity > 0 ? <>近 30 天售 <b>{item.sales_quantity.toLocaleString('zh-CN')}</b>{item.unit ?? '件'} · {yuan(item.sales_amount)}</> : '近 30 天暂无成交'}</span>}
          {item.stock != null && <span>库存 {compact(item.stock)}</span>}
        </div>
        {item.package_weight_g != null ? <span className="goods-saved">已有件重尺</span> : <span className="goods-missing">缺件重尺</span>}
      </div>
      <footer className="goods-foot"><span className="goods-id" title={item.cargo_number ? `货号 ${item.cargo_number}` : undefined}>{item.cargo_number ? `货号 ${item.cargo_number}` : `ID ${item.offer_id}`}</span>
        <a className="goods-icon" href={`https://detail.1688.com/offer/${item.offer_id}.html`} target="_blank" rel="noreferrer" title="在 1688 查看" aria-label={`在 1688 查看 ${item.title}`}><ExternalLink size={14} /></a></footer>
    </article>)}</section>}
    {!error && loaded && items.length > 0 && <Pagination page={page} pageSize={pageSize} total={total} onPage={changePage} onPageSize={setPageSize} unit="件" />}
    {detailId && !viewing && <CatalogDetail user={user} listingId={detailId} close={() => setDetailId('')} changed={text => { if (text) setNotice(text); void load() }} openPlatform={canSeeShop ? () => void openPlatform() : undefined} />}
    {viewing && <ListingViewer initial={viewing} canManage={canManage} canPublish={canPublish} close={() => setViewing(null)} saved={() => void load()} />}
  </>
}
