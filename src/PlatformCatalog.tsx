import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, ExternalLink, Inbox, Link2, Package, RefreshCw, Search, SearchX, Square, X } from 'lucide-react'
import { ApiError, type SessionUser } from './api'
import { getCatalog, getShopListing, syncShopPage, type CatalogGroup, type CatalogItem, type CatalogShop, type CatalogSort, type PlatformListing } from './1688Api'
import { ListingViewer } from './1688Page'
import Pagination, { useDebounced } from './Pagination'
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

/** 产品目录: what is actually listed on the shop's 1688 storefront (as last synced), with 30-day sales. */
export default function PlatformCatalog({ user, openShop }: { user: SessionUser; openShop?: () => void }) {
  const canManage = permission(user, 'integration:manage'), canPublish = permission(user, 'integration:publish')
  const [items, setItems] = useState<CatalogItem[]>([]), [facets, setFacets] = useState<Record<CatalogGroup, number>>({ on_sale: 0, expired: 0, other: 0 }), [shops, setShops] = useState<CatalogShop[]>([])
  const [group, setGroup] = useState<CatalogGroup>('on_sale'), [sort, setSort] = useState<CatalogSort>('recent'), [shop, setShop] = useState(''), [search, setSearch] = useState('')
  const [page, setPage] = useState(1), [pageSize, setPageSize] = useState(24), [total, setTotal] = useState(0)
  const [loaded, setLoaded] = useState(false), [loading, setLoading] = useState(true), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [syncing, setSyncing] = useState(false), [viewing, setViewing] = useState<PlatformListing | null>(null)
  const stop = useRef(false)
  const query = useDebounced(search.trim())
  useEffect(() => { setPage(1) }, [query, group, sort, shop, pageSize])
  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const r = await getCatalog({ connectionId: shop || undefined, group, search: query || undefined, sort, page, pageSize })
      setItems(r.data); setFacets(r.facets); setShops(r.shops); setTotal(r.total); setLoaded(true)
      if (!r.data.length && page > 1 && r.total) setPage(Math.ceil(r.total / pageSize))
    } catch (cause) { setError(message(cause)) } finally { setLoading(false) }
  }, [shop, group, query, sort, page, pageSize])
  useEffect(() => { void load() }, [load])

  const connected = shops.filter(s => s.status === 'connected')
  const lastSync = shops.filter(s => !shop || s.id === shop).map(s => s.synced_at).filter(Boolean).sort().at(-1) ?? null
  // Reads the shop's offers page by page through the product app (20 per call), as the 1688 店铺 page does.
  async function sync() {
    const targets = shop ? connected.filter(s => s.id === shop) : connected
    if (!targets.length) { setError('没有已连接的 1688 店铺，请先在“1688 店铺”中授权。'); return }
    stop.current = false; setSyncing(true); setError(''); let count = 0
    try {
      for (const target of targets) {
        let hasMore = true
        for (let pageNo = 1; hasMore && !stop.current; pageNo++) {
          if (pageNo > 1000) throw new Error('本轮同步达到分页上限。')
          const r = await syncShopPage(target.id, pageNo); count += r.data.count; hasMore = r.data.hasMore
          setNotice(`正在同步${targets.length > 1 ? ` ${target.display_name ?? ''}` : ''}：已读取 ${count} / ${r.data.total || '—'} 件`)
        }
      }
      setNotice(stop.current ? `已停止，本轮读取 ${count} 件` : `同步完成，本轮读取 ${count} 件`)
    } catch (cause) { setError(`${message(cause)}（本轮已读取 ${count} 件，已保存的数据可继续查看）`) } finally { setSyncing(false); await load() }
  }
  async function open(item: CatalogItem) { try { setViewing((await getShopListing(item.id)).data) } catch (cause) { setError(message(cause)) } }
  const changePage = (next: number) => { setPage(next); document.querySelector('.catalog-head')?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }
  const filtered = Boolean(query || shop)
  const noShops = loaded && !shops.length

  return <>
    {notice && <div className="inline-notice">{notice}<button onClick={() => setNotice('')} aria-label="关闭提示"><X size={14} /></button></div>}
    <section className="catalog-head">
      <div className="catalog-search"><Search size={16} /><input value={search} onChange={e => setSearch(e.target.value)} placeholder="搜索标题、1688 商品 ID 或货号" aria-label="搜索平台商品" />{search && <button onClick={() => setSearch('')} aria-label="清除搜索"><X size={14} /></button>}</div>
      {shops.length > 1 && <select className="catalog-select" value={shop} onChange={e => setShop(e.target.value)} aria-label="店铺"><option value="">全部店铺</option>{shops.map(s => <option key={s.id} value={s.id}>{s.display_name || '未命名店铺'}</option>)}</select>}
      <select className="catalog-select" value={sort} onChange={e => setSort(e.target.value as CatalogSort)} aria-label="排序">{(Object.keys(sortNames) as CatalogSort[]).map(k => <option key={k} value={k}>{sortNames[k]}</option>)}</select>
      {canManage && (syncing
        ? <button className="catalog-primary" onClick={() => { stop.current = true }}><Square size={14} />停止同步</button>
        : <button className="catalog-primary" disabled={!connected.length} onClick={() => void sync()}><RefreshCw size={16} />同步平台商品</button>)}
    </section>
    <div className="catalog-subhead">
      <div className="catalog-tabs" role="tablist" aria-label="平台状态">{(Object.keys(groupNames) as CatalogGroup[]).filter(k => k !== 'other' || facets.other > 0).map(k =>
        <button key={k} role="tab" aria-selected={group === k} className={group === k ? 'active' : ''} onClick={() => setGroup(k)}>{groupNames[k]}<span>{facets[k]}</span></button>)}</div>
      <span className="catalog-sync-note">{lastSync ? `平台数据同步于 ${ago(lastSync)}` : '尚未同步平台商品'} · 近 30 天销量来自已同步订单</span>
    </div>
    {error && <section className="state-card error-state compact"><AlertCircle size={25} /><h2>出了点问题</h2><p>{error}</p><button onClick={() => void load()}><RefreshCw size={15} />重新加载</button></section>}
    {!error && !loaded && <section className="card-grid" aria-busy="true">{Array.from({ length: 8 }, (_, i) => <div key={i} className="card-skeleton"><div /><span /><span /><span /></div>)}</section>}
    {!error && noShops && <section className="state-card"><Link2 size={28} /><h2>还没有连接 1688 店铺</h2><p>连接店铺并同步后，这里会展示店铺在 1688 上架的商品、价格、库存和近 30 天销量。</p>{openShop && <button onClick={openShop}>去连接店铺</button>}</section>}
    {!error && loaded && !noShops && !items.length && (filtered
      ? <section className="state-card compact"><SearchX size={26} /><h2>没有符合条件的商品</h2><p>换个关键词，或切换店铺。</p><button onClick={() => { setSearch(''); setShop('') }}>清除筛选</button></section>
      : <section className="state-card compact"><Inbox size={28} /><h2>{group === 'on_sale' ? '还没有在售商品' : `没有${groupNames[group]}的商品`}</h2><p>{lastSync ? '平台数据可能已变化，可以重新同步。' : '点击“同步平台商品”读取店铺在 1688 上架的商品。'}</p>{canManage && connected.length > 0 && <button onClick={() => void sync()} disabled={syncing}><RefreshCw size={15} />同步平台商品</button>}</section>)}
    {!error && loaded && items.length > 0 && <section className={`card-grid ${loading ? 'is-loading' : ''}`}>{items.map(item => <article key={item.id} className="goods-card">
      <button className="goods-media" onClick={() => void open(item)} aria-label={`查看 ${item.title}`}><Package size={28} />{item.image_url && <img src={imageUrl(item.image_url)} alt="" loading="lazy" referrerPolicy="no-referrer" onError={e => { e.currentTarget.style.display = 'none' }} />}
        {item.category && <span className="goods-source">{item.category}</span>}<span className={`goods-stage ${item.status === 'published' ? 'product-active' : item.status.includes('expired') ? 'product-inactive' : 'product-draft'}`}>{statusNames[item.status] ?? item.status}</span></button>
      <div className="goods-body">
        <button className="goods-title" onClick={() => void open(item)} title={item.title}>{item.title}</button>
        <div className="goods-price"><strong>{priceText(item)}</strong><span>{item.sku_count ? `${item.sku_count} 个 SKU` : item.unit ? `按${item.unit}` : ''}</span></div>
        <div className="goods-stats">
          <span className={item.sales_quantity > 0 ? 'hot' : ''}>{item.sales_quantity > 0 ? <>近 30 天售 <b>{item.sales_quantity.toLocaleString('zh-CN')}</b>{item.unit ?? '件'} · {yuan(item.sales_amount)}</> : '近 30 天暂无成交'}</span>
          {item.stock != null && <span>库存 {compact(item.stock)}</span>}
        </div>
        {item.product_sku && <span className="goods-link" title={item.product_name ?? ''}><Link2 size={12} />已关联 {item.product_sku}</span>}
      </div>
      <footer className="goods-foot"><span className="goods-id" title={item.cargo_number ? `货号 ${item.cargo_number}` : undefined}>{item.cargo_number ? `货号 ${item.cargo_number}` : `ID ${item.offer_id}`}</span>
        <a className="goods-icon" href={`https://detail.1688.com/offer/${item.offer_id}.html`} target="_blank" rel="noreferrer" title="在 1688 查看" aria-label={`在 1688 查看 ${item.title}`}><ExternalLink size={14} /></a></footer>
    </article>)}</section>}
    {!error && loaded && items.length > 0 && <Pagination page={page} pageSize={pageSize} total={total} onPage={changePage} onPageSize={setPageSize} unit="件" />}
    {viewing && <ListingViewer initial={viewing} canManage={canManage} canPublish={canPublish} close={() => setViewing(null)} saved={() => void load()} />}
  </>
}
