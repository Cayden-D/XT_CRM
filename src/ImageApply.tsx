import { useEffect, useState } from 'react'
import { AlertCircle, ArrowRight, Check, ImageUp, LoaderCircle, Package, Plus, RotateCcw, Search, X } from 'lucide-react'
import { getCollectedProducts, type CollectedProductCard } from './api'
import { retryAgentQueueJob } from './1688Api'
import { applyAsset, getAlbums, getProductImages, uploadToAlbum, type AlbumShop, type ImageAsset, type ProductImage } from './imageApi'

const message = (cause:unknown) => cause instanceof Error ? cause.message : '操作未完成，请稍后重试。'

/**
 * 一键替换主图: uploads the generated picture to the shop's 1688 photo album (once) and puts the album picture into a
 * main-picture slot of the collected product (or appends it). The replaced picture is kept and can be restored.
 */
export default function ApplyDialog({asset, close, done}:{asset:ImageAsset;close:()=>void;done:(asset:ImageAsset, note:string)=>void}) {
  const [shops, setShops] = useState<AlbumShop[]>([]), [shopId, setShopId] = useState(asset.photo_connection_id ?? ''), [albumId, setAlbumId] = useState(asset.photo_album_id ?? '')
  const [product, setProduct] = useState<{id:string;title:string}|null>(asset.collected_product_id ? { id:asset.collected_product_id, title:asset.product_title ?? '' } : null)
  const [gallery, setGallery] = useState<ProductImage[]|null>(null), [placement, setPlacement] = useState<'replace'|'append'>('replace'), [index, setIndex] = useState(asset.replaces_index ?? 0)
  const [query, setQuery] = useState(''), [results, setResults] = useState<CollectedProductCard[]>([])
  const [confirmed, setConfirmed] = useState(false), [busy, setBusy] = useState(''), [error, setError] = useState(''), [result, setResult] = useState<{note:string;queueJob:{id:string;status:string}|null}|null>(null)
  const uploaded = asset.photo_status === 'uploaded' && Boolean(asset.photo_url)
  useEffect(() => {
    getAlbums().then(r => {
      setShops(r.data)
      const first = r.data.find(s => s.id === asset.photo_connection_id) ?? r.data.find(s => s.status === 'connected')
      if (first && !shopId) { setShopId(first.id); setAlbumId(first.album_id ?? '') }
    }).catch(cause => setError(message(cause)))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setGallery(null); if (product) getProductImages(product.id).then(r => { setGallery(r.data.gallery); if (index >= r.data.gallery.length) setIndex(0) }).catch(cause => setError(message(cause))) }, [product]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!query.trim()) { setResults([]); return }
    const timer = setTimeout(() => getCollectedProducts({ search:query.trim(), pageSize:8 }).then(r => setResults(r.data)).catch(() => {}), 300)
    return () => clearTimeout(timer)
  }, [query])
  const shop = shops.find(s => s.id === shopId)
  const albumOk = uploaded || (/^\d{1,20}$/.test(albumId) && shop?.status === 'connected')
  async function apply() {
    if (!product) return
    setBusy('apply'); setError('')
    try {
      const r = (await applyAsset(asset.id, { connectionId:uploaded ? undefined : shopId, albumId:uploaded ? undefined : albumId, collectedProductId:product.id, placement, index:placement === 'replace' ? index : undefined })).data
      const note = placement === 'replace' ? `已替换主图 ${r.applied.index + 1}${r.applied.productId ? '，正式产品图片已同步' : ''}` : `已追加为主图 ${r.applied.index + 1}`
      done(r.asset, note)
      setResult({ note, queueJob:r.queueJob && ['blocked', 'failed'].includes(r.queueJob.status) ? r.queueJob : null })
    } catch (cause) { setError(message(cause)) } finally { setBusy('') }
  }
  async function uploadOnly() {
    setBusy('upload'); setError('')
    try { const a = (await uploadToAlbum(asset.id, { connectionId:shopId, albumId })).data; done(a, '已上传到店铺相册'); setResult({ note:`已上传到店铺相册：${a.photo_url}`, queueJob:null }) }
    catch (cause) { setError(message(cause)) } finally { setBusy('') }
  }
  async function requeue(id:string) {
    setBusy('queue'); setError('')
    try { await retryAgentQueueJob(id); setResult(r => r && { ...r, queueJob:null, note:`${r.note}；已重新提交 Agent 队列` }) } catch (cause) { setError(message(cause)) } finally { setBusy('') }
  }
  return <div className="dialog-layer shop-dialog"><button className="drawer-scrim" aria-label="关闭" disabled={Boolean(busy)} onClick={close}/>
    <section className="shop-modal wide iw-apply" role="dialog" aria-modal="true" aria-label="替换商品主图">
      <header><h2>上传相册并替换主图</h2><button title="关闭" disabled={Boolean(busy)} onClick={close}><X size={18}/></button></header>
      <div className="shop-modal-body">
        {result ? <div className="iw-apply-done"><Check size={28}/><p>{result.note}</p>
          {result.queueJob && <><small>这件商品之前在 Agent 队列中{result.queueJob.status === 'blocked' ? '被拦截' : '处理失败'}，换图后可以重新提交。</small>
            <button className="shop-button primary" disabled={Boolean(busy)} onClick={() => void requeue(result.queueJob!.id)}>{busy === 'queue' ? <LoaderCircle size={15} className="spin"/> : <RotateCcw size={15}/>}重新提交 Agent 队列</button></>}
        </div> : <>
          <div className="iw-apply-grid">
            <figure className="iw-apply-new"><img src={asset.url!} alt={asset.label}/><figcaption>{asset.label}{asset.width ? ` · ${asset.width}×${asset.height}` : ''}</figcaption></figure>
            <div className="iw-apply-form">
              <h4>1 · 店铺相册</h4>
              {uploaded ? <p className="iw-note"><Check size={14}/><span>已上传到 {shops.find(s => s.id === asset.photo_connection_id)?.display_name ?? '店铺'} 的相册 {asset.photo_album_id}，不会重复上传。</span></p>
                : <div className="iw-row">
                  <label className="iw-field">店铺<select value={shopId} onChange={e => { setShopId(e.target.value); setAlbumId(shops.find(s => s.id === e.target.value)?.album_id ?? '') }}>{shops.map(s => <option key={s.id} value={s.id} disabled={s.status !== 'connected'}>{s.display_name}{s.status !== 'connected' ? '（未连接）' : ''}</option>)}</select></label>
                  <label className="iw-field">相册 ID<input value={albumId} inputMode="numeric" placeholder="店铺图片空间的相册编号" onChange={e => setAlbumId(e.target.value.trim())}/></label>
                </div>}
              {asset.photo_status === 'unknown' && <p className="iw-error"><AlertCircle size={14}/>上次上传结果未确认，请先到店铺相册核对，不能重复上传。</p>}
              <h4>2 · 替换哪件商品的哪张主图</h4>
              {product ? <div className="iw-chosen"><Package size={15}/><span title={product.title}>{product.title || '已选采集商品'}</span>{!asset.collected_product_id && <button onClick={() => setProduct(null)}>更换</button>}</div>
                : <div className="iw-product-search"><label className="iw-search"><Search size={15}/><input value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索采集商品名称或 1688 ID" aria-label="搜索采集商品"/></label>
                  {results.length > 0 && <ul className="iw-results">{results.map(r => <li key={r.id}><button onClick={() => { setProduct({ id:r.id, title:r.title }); setQuery(''); setResults([]) }}>{r.main_image_url ? <img src={r.main_image_url} alt="" referrerPolicy="no-referrer"/> : <Package size={18}/>}<span>{r.title}</span></button></li>)}</ul>}</div>}
              {product && !gallery && <p className="iw-empty"><LoaderCircle size={16} className="spin"/></p>}
              {gallery && <div className="iw-tiles iw-apply-slots">
                {gallery.map((g, i) => <button key={g.url} className={`iw-tile ${placement === 'replace' && index === i ? 'on' : ''}`} onClick={() => { setPlacement('replace'); setIndex(i) }} title={`替换主图 ${i + 1}`}>
                  <img src={g.url} alt="" referrerPolicy="no-referrer"/><span className="iw-tile-label">主图 {i + 1}{i === 0 ? ' · 首图' : ''}</span>{placement === 'replace' && index === i && <i><Check size={13}/></i>}</button>)}
                <button className={`iw-tile upload ${placement === 'append' ? 'on' : ''}`} disabled={gallery.length >= 10} onClick={() => setPlacement('append')}><Plus size={20}/><span className="iw-tile-label">追加为新主图</span></button>
              </div>}
              {gallery && placement === 'replace' && gallery[index] && <div className="iw-apply-swap"><img src={gallery[index].url} alt="原图" referrerPolicy="no-referrer"/><ArrowRight size={18}/><img src={asset.url!} alt="新图"/><small>原图保留记录，替换后可随时撤销</small></div>}
            </div>
          </div>
          <label className="shop-review-check"><input type="checkbox" checked={confirmed} disabled={Boolean(busy)} onChange={e => setConfirmed(e.target.checked)}/>确认把这张图上传到店铺相册（平台写入，不会发布商品），并{placement === 'replace' ? '替换' : '追加到'}采集商品主图；已转正式产品的会同步更新产品图片</label>
          {error && <p className="iw-error"><AlertCircle size={14}/>{error}</p>}
        </>}
      </div>
      <footer>{result ? <button className="shop-button primary" onClick={close}>完成</button> : <>
        <button className="shop-button" disabled={Boolean(busy)} onClick={close}>取消</button>
        {!uploaded && <button className="shop-button" disabled={Boolean(busy) || !confirmed || !albumOk || asset.photo_status === 'unknown'} onClick={() => void uploadOnly()}>{busy === 'upload' ? <LoaderCircle size={15} className="spin"/> : <ImageUp size={15}/>}仅上传相册</button>}
        <button className="shop-button primary" disabled={Boolean(busy) || !confirmed || !albumOk || !product || !gallery || asset.photo_status === 'unknown'} onClick={() => void apply()}>{busy === 'apply' ? <LoaderCircle size={15} className="spin"/> : <ImageUp size={15}/>}{uploaded ? '替换主图' : '上传并替换主图'}</button>
      </>}</footer>
    </section></div>
}
