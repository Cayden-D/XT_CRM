import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Note } from './ui'
import {
  AlertCircle, Bot, Check, Download, ImagePlus, ImageUp, Images, LoaderCircle, Maximize2, Package, Pencil, RefreshCw, RotateCcw, Search, ShieldAlert, Sparkles, Trash2, Undo2, Upload, Wand2, X,
} from 'lucide-react'
import { getCollectedProducts, type CollectedProductCard, type SessionUser } from './api'
import ApplyDialog from './ImageApply'
import Pagination from './Pagination'
import {
  createEdit, createSuite, deleteAsset, downloadAsset, fileToBase64, flagged, getAssets, getBrands, getImageSettings, getProductImages, openImageTool, replaceFlagged, resizePresets,
  retryAsset, revertAsset, saveImageSettings, screenProductImages, suiteTypes, uploadImage, type Brand, type ImageAsset, type ImageIntent, type ImageServices, type ImageSettings, type ImageSource,
  type ProductImage, type ProductImages, type SuiteType,
} from './imageApi'
import './imageWorkshop.css'

const message = (cause:unknown) => cause instanceof Error ? cause.message : '操作未完成，请稍后重试。'
const can = (user:SessionUser, permission:string) => (user.permissions || []).some(p => p === '*' || p === permission || p === `${permission.split(':')[0]}:*`)
const busyStatus = (a:ImageAsset) => a.status === 'pending' || a.status === 'processing'
const RIGHTS_NOTE = '带有他人公司/店铺水印或知名品牌 Logo 的图片不会被编辑或用作参考——去掉别人的水印和商标属于侵权。这类图片请用「电商套图」基于商品的其他干净图片重新生成。'

/** Keeps generating pictures up to date: polls only the ones still running. */
function useLiveAssets(assets:ImageAsset[], setAssets:(update:(list:ImageAsset[])=>ImageAsset[])=>void) {
  const running = assets.filter(busyStatus).map(a => a.id).join(',')
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => {
      getAssets({ ids:running.split(','), pageSize:60 }).then(r => {
        const fresh = new Map(r.data.map(a => [a.id, a]))
        setAssets(list => list.map(a => fresh.get(a.id) ?? a))
      }).catch(() => {})
    }, 3000)
    return () => clearInterval(timer)
  }, [running, setAssets])
}

export function Lightbox({src, close, children}:{src:string;close:()=>void;children?:ReactNode}) {
  useEffect(() => { const key = (e:KeyboardEvent) => { if (e.key === 'Escape') close() }; window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key) }, [close])
  return <div className="iw-lightbox" role="dialog" aria-modal="true" aria-label="查看大图"><button className="iw-lightbox-scrim" aria-label="关闭" onClick={close}/>
    <figure><img src={src} alt="" referrerPolicy="no-referrer"/>{children&&<figcaption>{children}</figcaption>}</figure>
    <button className="iw-lightbox-close" aria-label="关闭" onClick={close}><X size={20}/></button></div>
}

function FindingBadge({finding}:{finding:ProductImage['finding']}) {
  if (!finding) return null
  return flagged(finding) ? <span className="iw-badge risk" title={finding.reason}><ShieldAlert size={11}/>{!finding.readable ? '无法读取' : finding.watermark ? '他人水印' : '品牌 Logo'}</span>
    : <span className="iw-badge ok" title={finding.reason}><Check size={11}/>已检查</span>
}

/** What a card may do: edit further, and upload to the shop album / replace a main picture. */
type CardActions = { onEdit?:(a:ImageAsset)=>void; canApply?:boolean; onApplied?:()=>void }
function AssetCard({asset, onChange, onRemove, onEdit, canApply, onApplied}:{asset:ImageAsset;onChange:(a:ImageAsset)=>void;onRemove:(id:string)=>void}&CardActions) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [zoom, setZoom] = useState(false), [applying, setApplying] = useState(false), [note, setNote] = useState('')
  const run = async (work:()=>Promise<void>) => { setBusy(true); setError(''); try { await work() } catch (cause) { setError(message(cause)) } finally { setBusy(false) } }
  return <article className={`iw-asset ${asset.status}`}>
    <div className="iw-asset-media">
      {asset.url ? <button onClick={() => setZoom(true)} aria-label={`查看${asset.label}大图`}><img src={asset.url} alt={asset.label} loading="lazy"/></button>
        : asset.status === 'failed' ? <div className="iw-asset-state"><AlertCircle size={22}/><small>{asset.error || '生成失败'}</small></div>
        : <div className="iw-asset-state"><LoaderCircle size={22} className="spin"/><small>{asset.status === 'pending' ? '排队中…' : '生成中，约 20–60 秒'}</small>{asset.error && <small className="iw-asset-retry">{asset.error}</small>}</div>}
      <span className="iw-asset-label">{asset.replaces_index != null ? `替代主图 ${asset.replaces_index + 1}` : asset.label}</span>
      {asset.trigger === 'agent' && <span className="iw-asset-agent" title="Agent 自动生成"><Bot size={12}/></span>}
    </div>
    <div className="iw-asset-body">
      {asset.product_title && <p className="iw-asset-title" title={asset.product_title}>{asset.product_title}</p>}
      {asset.status === 'completed' && asset.risky && <p className="iw-asset-risk"><ShieldAlert size={12}/>{asset.findings?.reason || '复检未完成'}，请核对后再使用</p>}
      {asset.width && <small>{asset.width}×{asset.height}{asset.model ? ` · ${asset.model}` : ''}</small>}
      {asset.applied_to ? <p className="iw-asset-applied"><Check size={12}/>{asset.applied_to.placement === 'replace' ? `已替换主图 ${asset.applied_to.index + 1}` : asset.applied_to.placement === 'detail' ? `已用作详情图 ${asset.applied_to.index + 1}` : `已追加为主图 ${asset.applied_to.index + 1}`}</p>
        : asset.photo_status === 'uploaded' ? <p className="iw-asset-applied"><Check size={12}/>已上传店铺相册</p>
        : asset.photo_status === 'unknown' ? <p className="iw-asset-risk"><AlertCircle size={12}/>相册上传结果待核对</p> : null}
      {note && <p className="iw-asset-applied">{note}</p>}
      {error && <p className="iw-error">{error}</p>}
      <div className="iw-asset-actions">
        {asset.status === 'completed' && <button title="下载" aria-label="下载" disabled={busy} onClick={() => void run(() => downloadAsset(asset))}><Download size={14}/></button>}
        {asset.status === 'completed' && canApply && !asset.risky && asset.photo_status !== 'unknown' && <button title="上传相册并替换主图" aria-label="上传相册并替换主图" className="iw-apply-btn" disabled={busy} onClick={() => setApplying(true)}><ImageUp size={14}/>替换主图</button>}
        {asset.applied_to && <button title="撤销替换，恢复原主图" aria-label="撤销替换" disabled={busy} onClick={() => { if (window.confirm('撤销替换，恢复原来的主图？')) void run(async () => { onChange((await revertAsset(asset.id)).data); setNote('已恢复原主图'); onApplied?.() }) }}><Undo2 size={14}/></button>}
        {asset.status === 'completed' && onEdit && <button title="继续编辑" aria-label="继续编辑" disabled={busy} onClick={() => onEdit(asset)}><Pencil size={14}/></button>}
        {asset.status === 'failed' && asset.provider !== 'local' && <button title="重试" aria-label="重试" disabled={busy} onClick={() => void run(async () => onChange((await retryAsset(asset.id)).data))}><RotateCcw size={14}/></button>}
        {!busyStatus(asset) && <button title="删除" aria-label="删除" disabled={busy} onClick={() => { if (window.confirm('删除这张图片？')) void run(async () => { await deleteAsset(asset.id); onRemove(asset.id) }) }}><Trash2 size={14}/></button>}
      </div>
    </div>
    {zoom && asset.url && <Lightbox src={asset.url} close={() => setZoom(false)}>{asset.label}{asset.width ? ` · ${asset.width}×${asset.height}` : ''}</Lightbox>}
    {applying && <ApplyDialog asset={asset} close={() => setApplying(false)} done={(next, text) => { onChange({ ...next, product_title:asset.product_title }); setNote(text); onApplied?.() }}/>}
  </article>
}

function AssetGrid({assets, setAssets, empty, ...actions}:{assets:ImageAsset[];setAssets:(update:(list:ImageAsset[])=>ImageAsset[])=>void;empty:string}&CardActions) {
  useLiveAssets(assets, setAssets)
  if (!assets.length) return <p className="iw-empty">{empty}</p>
  return <div className="iw-assets">{assets.map(a => <AssetCard key={a.id} asset={a} {...actions}
    onChange={next => setAssets(list => list.map(x => x.id === next.id ? next : x))} onRemove={id => setAssets(list => list.filter(x => x.id !== id))}/>)}</div>
}

type Picked = { key:string; source:ImageSource; preview:string; label:string }
/** Picks pictures from a collected product, an upload, or earlier results. Flagged pictures cannot be picked. */
function SourcePicker({productId, setProduct, picked, setPicked, max}:{productId?:string;setProduct:(p:{id:string;title:string}|null)=>void;picked:Picked[];setPicked:(p:Picked[])=>void;max:number}) {
  const [query, setQuery] = useState(''), [results, setResults] = useState<CollectedProductCard[]>([]), [searching, setSearching] = useState(false)
  const [images, setImages] = useState<ProductImages|null>(null), [recent, setRecent] = useState<ImageAsset[]>([]), [busy, setBusy] = useState(''), [error, setError] = useState('')
  const file = useRef<HTMLInputElement>(null)
  useEffect(() => { getAssets({ pageSize:12 }).then(r => setRecent(r.data.filter(a => a.status === 'completed' && !a.risky))).catch(() => {}) }, [])
  useEffect(() => { setImages(null); if (productId) getProductImages(productId).then(r => setImages(r.data)).catch(cause => setError(message(cause))) }, [productId])
  useEffect(() => {
    if (!query.trim()) { setResults([]); return }
    const timer = setTimeout(() => { setSearching(true); getCollectedProducts({ search:query.trim(), pageSize:8 }).then(r => setResults(r.data)).catch(() => {}).finally(() => setSearching(false)) }, 300)
    return () => clearTimeout(timer)
  }, [query])
  const toggle = (item:Picked) => {
    if (picked.some(p => p.key === item.key)) setPicked(picked.filter(p => p.key !== item.key))
    else setPicked(max === 1 ? [item] : picked.length >= max ? picked : [...picked, item])
  }
  async function upload(list:FileList|null) {
    if (!list?.length) return
    setBusy('upload'); setError('')
    try {
      for (const f of [...list].slice(0, max)) {
        if (f.size > 8 * 1024 * 1024) throw new Error(`${f.name} 超过 8MB。`)
        const asset = (await uploadImage(await fileToBase64(f), productId)).data
        setRecent(r => [asset, ...r]); toggle({ key:asset.id, source:{ assetId:asset.id }, preview:asset.url!, label:'上传图片' })
      }
    } catch (cause) { setError(message(cause)) } finally { setBusy(''); if (file.current) file.current.value = '' }
  }
  async function screenAll() { if (!productId) return; setBusy('screen'); setError(''); try { await screenProductImages(productId, true); setImages((await getProductImages(productId)).data) } catch (cause) { setError(message(cause)) } finally { setBusy('') } }
  const tile = (url:string, finding:ProductImage['finding'], label:string) => {
    const bad = flagged(finding), on = picked.some(p => p.key === url)
    return <button key={url} className={`iw-tile ${on ? 'on' : ''} ${bad ? 'bad' : ''}`} disabled={bad} title={finding?.reason ?? label} onClick={() => toggle({ key:url, source:{ url }, preview:url, label })}>
      <img src={url} alt={label} loading="lazy" referrerPolicy="no-referrer"/><span className="iw-tile-label">{label}</span><FindingBadge finding={finding}/>{on && <i><Check size={13}/></i>}</button>
  }
  const unchecked = images ? [...images.gallery, ...images.details].some(i => !i.finding) : false
  return <div className="iw-picker">
    {picked.length > 0 && <div className="iw-picked" aria-label="已选图片">{picked.map(p => <span key={p.key}><img src={p.preview} alt={p.label} referrerPolicy="no-referrer"/><small>{p.label}</small>
      <button aria-label={`取消选择${p.label}`} onClick={() => setPicked(picked.filter(x => x.key !== p.key))}><X size={12}/></button></span>)}</div>}
    <div className="iw-product-search">
      {productId && images ? <div className="iw-chosen"><Package size={15}/><span>已选采集商品</span><button onClick={() => { setProduct(null); setPicked([]) }}>更换</button></div>
        : <label className="iw-search"><Search size={15}/><input value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索采集商品名称或 1688 ID" aria-label="搜索采集商品"/>{searching && <LoaderCircle size={14} className="spin"/>}</label>}
      {!productId && results.length > 0 && <ul className="iw-results">{results.map(r => <li key={r.id}><button onClick={() => { setProduct({ id:r.id, title:r.title }); setQuery(''); setResults([]) }}>
        {r.main_image_url ? <img src={r.main_image_url} alt="" referrerPolicy="no-referrer"/> : <Package size={18}/>}<span>{r.title}</span></button></li>)}</ul>}
    </div>
    {images && <>
      <div className="iw-picker-head"><b>主图</b><small>{picked.length}/{max} 已选</small>{unchecked && <button className="iw-link" disabled={Boolean(busy)} onClick={() => void screenAll()}>{busy === 'screen' ? <LoaderCircle size={13} className="spin"/> : <ShieldAlert size={13}/>}检测水印/Logo</button>}</div>
      <div className="iw-tiles">{images.gallery.map((g, i) => tile(g.url, g.finding, `主图 ${i + 1}`))}</div>
      {images.details.length > 0 && <><div className="iw-picker-head"><b>详情图</b></div><div className="iw-tiles small">{images.details.slice(0, 24).map((d, i) => tile(d.url, d.finding, `详情 ${i + 1}`))}</div></>}
    </>}
    <div className="iw-picker-head"><b>上传或已有图片</b></div>
    <div className="iw-tiles">
      <button className="iw-tile upload" disabled={Boolean(busy)} onClick={() => file.current?.click()}>{busy === 'upload' ? <LoaderCircle size={20} className="spin"/> : <Upload size={20}/>}<span className="iw-tile-label">上传图片</span></button>
      <input ref={file} type="file" accept="image/png,image/jpeg,image/webp" multiple={max > 1} hidden onChange={e => void upload(e.target.files)}/>
      {recent.slice(0, 11).map(a => <button key={a.id} className={`iw-tile ${picked.some(p => p.key === a.id) ? 'on' : ''}`} onClick={() => toggle({ key:a.id, source:{ assetId:a.id }, preview:a.url!, label:a.label })}>
        <img src={a.url!} alt={a.label} loading="lazy"/><span className="iw-tile-label">{a.label}</span>{picked.some(p => p.key === a.id) && <i><Check size={13}/></i>}</button>)}
    </div>
    {error && <p className="iw-error"><AlertCircle size={14}/>{error}</p>}
  </div>
}

function useServices() {
  const [services, setServices] = useState<ImageServices|null>(null), [settings, setSettings] = useState<ImageSettings|null>(null)
  useEffect(() => { getImageSettings().then(r => { setServices(r.services); setSettings(r.data) }).catch(() => {}) }, [])
  return { services, settings }
}

function Results({kind, title, refreshKey, onEdit, canApply}:{kind:'edit'|'suite';title:string;refreshKey:number;onEdit?:(a:ImageAsset)=>void;canApply:boolean}) {
  const [assets, setAssets] = useState<ImageAsset[]>([]), [total, setTotal] = useState(0), [page, setPage] = useState(1), [loading, setLoading] = useState(true), [error, setError] = useState('')
  const pageSize = kind === 'suite' ? 18 : 12
  const load = useCallback(async () => { setLoading(true); try { const r = await getAssets({ kind, page, pageSize }); setAssets(r.data); setTotal(r.total); setError('') } catch (cause) { setError(message(cause)) } finally { setLoading(false) } }, [kind, page, pageSize])
  useEffect(() => { void load() }, [load, refreshKey])
  return <section className="iw-results-panel">
    <header><h3>{title}</h3><span>{total}</span><button className="iw-link" onClick={() => void load()} disabled={loading}><RefreshCw size={13} className={loading ? 'spin' : ''}/>刷新</button></header>
    {error ? <p className="iw-error"><AlertCircle size={14}/>{error}</p> : <AssetGrid assets={assets} setAssets={setAssets} onEdit={onEdit} canApply={canApply} empty={kind === 'suite' ? '还没有生成过套图。' : '处理结果会出现在这里。'}/>}
    {total > pageSize && <Pagination page={page} pageSize={pageSize} total={total} onPage={setPage} unit="张"/>}
  </section>
}

const scenes = ['简约木质桌面，柔和自然光', '现代简约客厅，暖色调', '户外草地，晴天阳光', '浅灰色大理石台面，高级感', '干净的工作台与工具', '纯色渐变背景，柔光']
/** 图片编辑: 白底图 / 换背景 (Qwen) and 改尺寸 (local). */
export function ImageEditPage({user, intent}:{user:SessionUser;intent?:ImageIntent}) {
  const editable = can(user, 'collection:create')
  const { services } = useServices()
  const [product, setProduct] = useState<{id:string;title:string}|null>(intent?.productId ? { id:intent.productId, title:intent.productTitle ?? '' } : null)
  const [picked, setPicked] = useState<Picked[]>(intent?.sourceAsset ? [{ key:intent.sourceAsset.id, source:{ assetId:intent.sourceAsset.id }, preview:intent.sourceAsset.url, label:intent.sourceAsset.label }]
    : intent?.sourceUrl ? [{ key:intent.sourceUrl, source:{ url:intent.sourceUrl }, preview:intent.sourceUrl, label:'所选图片' }] : [])
  const [operation, setOperation] = useState<'white_bg'|'background'|'resize'>('white_bg'), [scene, setScene] = useState(scenes[0])
  const [preset, setPreset] = useState<string>('800x800'), [custom, setCustom] = useState({ width:800, height:800 }), [fit, setFit] = useState<'pad'|'crop'>('pad')
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [refresh, setRefresh] = useState(0)
  async function submit() {
    if (!picked[0]) return
    setBusy(true); setError('')
    try {
      await createEdit({ source:picked[0].source, operation, collectedProductId:product?.id, ...(operation === 'background' ? { scene } : {}), ...(operation !== 'resize' ? {} : preset === 'custom' ? { width:custom.width, height:custom.height, fit } : { preset, fit }) })
      setRefresh(n => n + 1)
    } catch (cause) { setError(message(cause)) } finally { setBusy(false) }
  }
  const aiMissing = operation !== 'resize' && services && !services.qwen
  return <div className="iw-page">
    <section className="iw-panel">
      <div className="iw-step"><span>1</span><h3>选择图片</h3></div>
      <SourcePicker productId={product?.id} setProduct={setProduct} picked={picked} setPicked={setPicked} max={1}/>
      <div className="iw-step"><span>2</span><h3>处理方式</h3></div>
      <div className="iw-ops" role="tablist">{([['white_bg','白底图','保留商品，换成纯白背景',Wand2],['background','换背景','把商品放进新场景',Images],['resize','改尺寸','裁切或补白到指定尺寸',Maximize2]] as const).map(([key, label, hint, Icon]) =>
        <button key={key} role="tab" aria-selected={operation === key} className={operation === key ? 'on' : ''} onClick={() => setOperation(key)}><Icon size={18}/><b>{label}</b><small>{hint}</small></button>)}</div>
      {operation === 'background' && <label className="iw-field">新背景<textarea rows={2} maxLength={300} value={scene} onChange={e => setScene(e.target.value)}/><div className="iw-chips">{scenes.map(s => <button key={s} className={s === scene ? 'on' : ''} onClick={() => setScene(s)}>{s}</button>)}</div></label>}
      {operation === 'resize' && <div className="iw-field">目标尺寸<div className="iw-chips">{resizePresets.map(([k, l]) => <button key={k} className={preset === k ? 'on' : ''} onClick={() => setPreset(k)}>{l}</button>)}<button className={preset === 'custom' ? 'on' : ''} onClick={() => setPreset('custom')}>自定义</button></div>
        {preset === 'custom' && <div className="iw-size"><input type="number" min={100} max={4000} aria-label="宽" value={custom.width} onChange={e => setCustom({ ...custom, width:Number(e.target.value) })}/>×<input type="number" min={100} max={4000} aria-label="高" value={custom.height} onChange={e => setCustom({ ...custom, height:Number(e.target.value) })}/>px</div>}
        <div className="iw-chips"><button className={fit === 'pad' ? 'on' : ''} onClick={() => setFit('pad')}>完整保留，空白处补白</button><button className={fit === 'crop' ? 'on' : ''} onClick={() => setFit('crop')}>铺满画面，智能裁切</button></div></div>}
      <Note label="图片使用规则">{RIGHTS_NOTE}</Note>
      {aiMissing && <p className="iw-error"><AlertCircle size={14}/>服务器未配置百炼 API Key，白底图和换背景暂不可用。</p>}
      {error && <p className="iw-error"><AlertCircle size={14}/>{error}</p>}
      <button className="catalog-primary iw-submit" disabled={!editable || busy || !picked[0] || Boolean(aiMissing) || (operation === 'background' && scene.trim().length < 2)} onClick={() => void submit()}>
        {busy ? <LoaderCircle size={16} className="spin"/> : <Sparkles size={16}/>}{operation === 'resize' ? '生成新尺寸' : '开始处理'}</button>
      {operation !== 'resize' && <small className="iw-cost">处理在后台进行，可离开本页。</small>}
    </section>
    <Results kind="edit" title="处理结果" refreshKey={refresh} canApply={can(user, 'integration:publish')} onEdit={a => { setPicked([{ key:a.id, source:{ assetId:a.id }, preview:a.url!, label:a.label }]); window.scrollTo({ top:0, behavior:'smooth' }) }}/>
  </div>
}

/** 电商套图: six main pictures generated with GPT-Image-2.5 from the product's pictures. */
export function ImageSuitePage({user, intent}:{user:SessionUser;intent?:ImageIntent}) {
  const editable = can(user, 'collection:create')
  const { services, settings } = useServices()
  const [product, setProduct] = useState<{id:string;title:string}|null>(intent?.productId ? { id:intent.productId, title:intent.productTitle ?? '' } : null)
  const [picked, setPicked] = useState<Picked[]>([]), [title, setTitle] = useState(''), [points, setPoints] = useState('')
  const [types, setTypes] = useState<SuiteType[]>(suiteTypes.map(t => t[0])), [quality, setQuality] = useState(''), [size, setSize] = useState<'1:1'|'3:4'>('1:1'), [resolution, setResolution] = useState<'1k'|'2k'>('1k')
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [refresh, setRefresh] = useState(0)
  const [brands, setBrands] = useState<Brand[]>([]), [brandId, setBrandId] = useState('')
  useEffect(() => { getBrands().then(r => { setBrands(r.data); setBrandId(r.data.find(b => b.is_default)?.id ?? '') }).catch(() => {}) }, [])
  const brand = brands.find(b => b.id === brandId)
  async function submit() {
    setBusy(true); setError('')
    try {
      await createSuite({ collectedProductId:product?.id, title:product ? undefined : title.trim(), points:points.trim() || undefined, references:picked.map(p => p.source), types, quality:quality || undefined, size, resolution, brandId:brandId || null })
      setRefresh(n => n + 1)
    } catch (cause) { setError(message(cause)) } finally { setBusy(false) }
  }
  return <div className="iw-page">
    <section className="iw-panel">
      <div className="iw-step"><span>1</span><h3>商品与参考图</h3><small>选 1–4 张清晰的实拍图，越能看清商品结构越好</small></div>
      <SourcePicker productId={product?.id} setProduct={p => { setProduct(p); setPicked([]) }} picked={picked} setPicked={setPicked} max={4}/>
      {!product && <label className="iw-field">商品名称<input value={title} maxLength={200} onChange={e => setTitle(e.target.value)} placeholder="未选择采集商品时必填，如：车载无线充气泵 便携式"/></label>}
      <label className="iw-field">卖点与参数（可选）<textarea rows={2} maxLength={400} value={points} onChange={e => setPoints(e.target.value)} placeholder="写在卖点图和规格图上的内容，如：12V 车充 / 30 秒充满 / 数显胎压 / 尺寸 15×7×5cm。只会使用这里和商品资料里的信息"/></label>
      <div className="iw-step"><span>2</span><h3>要生成的图</h3></div>
      <div className="iw-suite-types">{suiteTypes.map(([key, label, hint]) => <label key={key} className={types.includes(key) ? 'on' : ''}><input type="checkbox" checked={types.includes(key)} onChange={e => setTypes(e.target.checked ? suiteTypes.map(t => t[0]).filter(t => t === key || types.includes(t)) : types.filter(t => t !== key))}/><b>{label}</b><small>{hint}</small></label>)}</div>
      {brands.length > 0 && <div className="iw-brand-pick">
        {brand?.logo_url && <img src={brand.logo_url} alt={`${brand.name} Logo`}/>}
        <label className="iw-field">品牌<select aria-label="套图品牌" value={brandId} onChange={e => setBrandId(e.target.value)}><option value="">不使用品牌</option>{brands.map(b => <option key={b.id} value={b.id}>{b.name}{b.is_default ? '（默认）' : ''}</option>)}</select></label>
        {brand && <small>{brand.logo_url ? 'Logo 原样放在除白底图外每张图的左上角' : '未上传 Logo，品牌名只写在卖点图和规格图上'}</small>}
      </div>}
      <div className="iw-row">
        <label className="iw-field">质量<select value={quality} onChange={e => setQuality(e.target.value)}><option value="">默认（{settings?.suite_quality ?? 'medium'}）</option><option value="low">low</option><option value="medium">medium</option><option value="high">high</option><option value="xhigh">xhigh</option></select></label>
        <label className="iw-field">比例<select value={size} onChange={e => setSize(e.target.value as '1:1'|'3:4')}><option value="1:1">1:1 主图</option><option value="3:4">3:4 竖版</option></select></label>
        <label className="iw-field">分辨率<select value={resolution} onChange={e => setResolution(e.target.value as '1k'|'2k')}><option value="1k">1K</option><option value="2k">2K</option></select></label>
      </div>
      <Note label="图片使用规则">{RIGHTS_NOTE}</Note>
      {services && !services.apimart && <p className="iw-error"><AlertCircle size={14}/>服务器未配置 APIMART_API_KEY，电商套图暂不可用。</p>}
      {error && <p className="iw-error"><AlertCircle size={14}/>{error}</p>}
      <button className="catalog-primary iw-submit" disabled={!editable || busy || !picked.length || !types.length || (!product && title.trim().length < 2) || services?.apimart === false} onClick={() => void submit()}>
        {busy ? <LoaderCircle size={16} className="spin"/> : <Sparkles size={16}/>}生成 {types.length} 张套图</button>
      <small className="iw-cost">后台生成，可离开本页。</small>
    </section>
    <Results kind="suite" title="生成记录" refreshKey={refresh} canApply={can(user, 'integration:publish')} onEdit={a => openImageTool({ page:'imageEdit', sourceAsset:{ id:a.id, url:a.url!, label:a.label } })}/>
  </div>
}

/** Product detail: the main and detail pictures with screening results, and the pictures made from them. */
export function ProductImagesPanel({productId, title, user}:{productId:string;title:string;user:SessionUser}) {
  const editable = can(user, 'collection:create')
  const [data, setData] = useState<ProductImages|null>(null), [assets, setAssets] = useState<ImageAsset[]>([]), [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState(''), [zoom, setZoom] = useState<{url:string;label:string}|null>(null)
  const load = useCallback(async () => { try { const r = (await getProductImages(productId)).data; setData(r); setAssets(r.assets) } catch (cause) { setError(message(cause)) } }, [productId])
  useEffect(() => { void load() }, [load])
  // After a picture replaced a main picture: refresh the main pictures only (cards keep their own state).
  const reload = async () => { try { setData((await getProductImages(productId)).data) } catch (cause) { setError(message(cause)) } }
  const run = async (key:string, work:()=>Promise<void>) => { setBusy(key); setError(''); setNotice(''); try { await work() } catch (cause) { setError(message(cause)) } finally { setBusy('') } }
  if (!data) return <section className="iw-product"><p className="iw-empty">{error || '正在读取图片…'}</p></section>
  const bad = data.gallery.filter(g => flagged(g.finding)).length
  const unchecked = data.gallery.some(g => !g.finding)
  const tile = (img:ProductImage, label:string, main:boolean) => <figure key={img.url} className={`iw-ptile ${flagged(img.finding) ? 'bad' : ''}`}>
    <button onClick={() => setZoom({ url:img.url, label })} aria-label={`查看${label}`}><img src={img.url} alt={label} loading="lazy" referrerPolicy="no-referrer"/></button>
    <figcaption><span>{label}</span><FindingBadge finding={img.finding}/></figcaption>
    {editable && main && !flagged(img.finding) && <button className="iw-ptile-edit" title="编辑这张图" onClick={() => openImageTool({ page:'imageEdit', productId, productTitle:title, sourceUrl:img.url })}><Pencil size={12}/>编辑</button>}
  </figure>
  return <section className="iw-product">
    <div className="section-head"><div><p className="kicker">商品图片</p><h3>{data.gallery.length} 张主图 · {data.details.length} 张详情图</h3></div>
      {editable && <div className="iw-product-actions">
        {unchecked && <button className="shop-button" disabled={Boolean(busy)} onClick={() => void run('screen', async () => { await screenProductImages(productId); await load(); setNotice('主图检测完成') })}>{busy === 'screen' ? <LoaderCircle size={14} className="spin"/> : <ShieldAlert size={14}/>}检测水印/Logo</button>}
        {bad > 0 && <button className="shop-button" disabled={Boolean(busy)} onClick={() => void run('replace', async () => { setNotice((await replaceFlagged(productId)).data.message); await load() })}>{busy === 'replace' ? <LoaderCircle size={14} className="spin"/> : <Bot size={14}/>}生成替代图</button>}
        <button className="shop-button primary" onClick={() => openImageTool({ page:'imageSuite', productId, productTitle:title })}><ImagePlus size={14}/>生成电商套图</button>
      </div>}</div>
    {bad > 0 && <p className="iw-note warn"><ShieldAlert size={14}/><span>{bad} 张主图带有他人水印或品牌 Logo，不能直接使用。「生成替代图」会只用其余干净图片作参考，为这些位置重新生成新图，原图不做修改。</span></p>}
    {notice && <p className="iw-note"><Check size={14}/><span>{notice}</span></p>}
    {error && <p className="iw-error"><AlertCircle size={14}/>{error}</p>}
    <div className="iw-pgrid">{data.gallery.map((g, i) => tile(g, i === 0 ? '主图 1 · 首图' : `主图 ${i + 1}`, true))}</div>
    {assets.length > 0 && <><h4 className="iw-subhead">由该商品生成的图片</h4><AssetGrid assets={assets} setAssets={setAssets} empty="" canApply={can(user, 'integration:publish')} onApplied={() => void reload()}/></>}
    {data.details.length > 0 && <details className="iw-details"><summary>详情图（{data.details.length} 张）</summary><div className="iw-detail-list">{data.details.map((d, i) => tile(d, `详情 ${i + 1}`, false))}</div></details>}
    {zoom && <Lightbox src={zoom.url} close={() => setZoom(null)}>{zoom.label}</Lightbox>}
  </section>
}

/** 设置 → 自动上架: the agent switch that replaces flagged main pictures of newly collected products. */
export function ImageAutomationSettings({editable}:{editable:boolean}) {
  const [settings, setSettings] = useState<ImageSettings|null>(null), [services, setServices] = useState<ImageServices|null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [confirming, setConfirming] = useState(false), [agreed, setAgreed] = useState(false)
  useEffect(() => { getImageSettings().then(r => { setSettings(r.data); setServices(r.services) }).catch(cause => setError(message(cause))) }, [])
  async function save(next:Partial<{autoReplace:boolean;suiteModel:string;suiteQuality:string;heroBadges:string[]}>, confirmed?:boolean) {
    if (!settings) return
    setBusy(true); setError('')
    try { setSettings((await saveImageSettings({ autoReplace:settings.auto_replace, suiteModel:settings.suite_model, suiteQuality:settings.suite_quality, ...next, revision:settings.revision, confirmed })).data); setConfirming(false); setAgreed(false) }
    catch (cause) { setError(message(cause)) } finally { setBusy(false) }
  }
  return <section className="iw-settings">
    <h3><Wand2 size={18}/>AI 图片自动处理</h3>
    <Note>开启后，进入<b>采集自动上架</b>的商品<b>不再检查原图</b>：直接以原图为参考，用团队的 GPT-Image 模型生成 5 张主图（依次为 1688 首图、卖点、场景、规格尺寸、白底）和 3 张详情图（主海报、产品优势、产品特点），<b>生成图也不做水印/Logo 复检</b>，自动上传店铺相册后用于上架；SKU 图保持原样。生成失败时任务停下并写明原因。未进入自动上架队列的商品仍按原方式检查主图，并为带他人标识的位置生成替代图。</Note>
    {settings && <div className="iw-settings-grid">
      <label className="agent-switch"><input type="checkbox" role="switch" checked={settings.auto_replace} disabled={!editable || busy || (!settings.auto_replace && services?.apimart === false)} onChange={e => { if (e.target.checked) setConfirming(true); else void save({ autoReplace:false }) }}/><span>{settings.auto_replace ? '已开启' : '已关闭'}</span></label>
      <label>默认质量<select value={settings.suite_quality} disabled={!editable || busy} onChange={e => void save({ suiteQuality:e.target.value })}><option value="low">low</option><option value="medium">medium</option><option value="high">high</option><option value="xhigh">xhigh</option></select></label>
      <span className={`shop-status ${services?.apimart ? 'positive' : 'warning'}`}>{services?.apimart ? 'APIMart 已配置' : 'APIMart 未配置'}</span>
    </div>}
    {settings && <HeroBadges key={settings.hero_badges.join('|')} saved={settings.hero_badges} editable={editable} busy={busy} save={badges => void save({ heroBadges:badges })}/>}
    {settings?.auto_replace && settings.enabled_at && <p className="shop-note">自 {new Date(settings.enabled_at).toLocaleString('zh-CN')} 起采集的商品会自动检查。</p>}
    {error && <p className="iw-error"><AlertCircle size={14}/>{error}</p>}
    {confirming && <div className="dialog-layer shop-dialog"><button className="drawer-scrim" aria-label="取消" onClick={() => setConfirming(false)}/><section className="shop-modal" role="dialog" aria-modal="true" aria-label="开启 AI 图片自动处理">
      <header><h2>开启 AI 图片自动处理</h2><button title="关闭" onClick={() => setConfirming(false)}><X size={18}/></button></header>
      <div className="shop-modal-body"><p>采集自动上架的每件商品会生成 8 张新图，并上传 8 张到店铺相册，耗时约几分钟。</p><p>原图和生成图都不再检查水印或品牌 Logo：参考图里的他人标识可能被模型照搬到新图并直接发布，请自行确认商品和图片的使用权。</p>
        <label className="shop-review-check"><input type="checkbox" checked={agreed} onChange={e => setAgreed(e.target.checked)}/>确认图片资料发送至模型服务并产生费用</label></div>
      <footer><button className="shop-button" onClick={() => setConfirming(false)}>取消</button><button className="shop-button primary" disabled={!agreed || busy} onClick={() => void save({ autoReplace:true }, true)}><Bot size={16}/>开启</button></footer></section></div>}
  </section>
}

/** The core terms written in large type on the 1688 首图 (add, change, remove; at most 6, 12 characters each). */
function HeroBadges({ saved, editable, busy, save }:{ saved:string[]; editable:boolean; busy:boolean; save:(badges:string[]) => void }) {
  const [badges, setBadges] = useState(saved)
  const cleaned = badges.map(b => b.trim())
  const changed = cleaned.join('|') !== saved.join('|')
  const problem = cleaned.some(b => !b) ? '优势不能为空，不需要的请删除。' : cleaned.some(b => b.length > 12) ? '每条优势最多 12 个字。' : new Set(cleaned).size !== cleaned.length ? '优势有重复。' : ''
  return <div className="iw-hero-badges">
    <b>1688 首图核心优势</b><small>用大号字放在首图最显眼的位置，决定点击率；全部删除后首图只写商品名和已知卖点。</small>
    <div className="iw-hero-list">{badges.map((badge, i) => <span key={i} className="iw-hero-item">
      <input aria-label={`首图优势 ${i + 1}`} value={badge} maxLength={12} disabled={!editable || busy} onChange={e => setBadges(list => list.map((b, j) => j === i ? e.target.value : b))}/>
      <button type="button" title="删除" aria-label={`删除首图优势 ${badge || i + 1}`} disabled={!editable || busy} onClick={() => setBadges(list => list.filter((_, j) => j !== i))}><X size={13}/></button>
    </span>)}
      {badges.length < 6 && <button type="button" className="shop-button" disabled={!editable || busy} onClick={() => setBadges(list => [...list, ''])}>+ 添加</button>}
    </div>
    {problem && <small className="iw-error-text">{problem}</small>}
    {changed && <div className="iw-hero-actions"><button type="button" className="shop-button primary" disabled={!editable || busy || Boolean(problem)} onClick={() => save(cleaned)}><Check size={14}/>保存首图优势</button><button type="button" className="shop-button" disabled={busy} onClick={() => setBadges(saved)}>还原</button></div>}
  </div>
}
