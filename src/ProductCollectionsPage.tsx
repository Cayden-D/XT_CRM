import { useCallback,useEffect,useState } from 'react'
import Pagination,{ useDebounced } from './Pagination'
import { AlertCircle,Bot,Box,Copy,Database,ExternalLink,Inbox,KeyRound,RefreshCw,Search,SearchX,Trash2,TriangleAlert,X } from 'lucide-react'
import { ApiError,COLLECTOR_SCRIPT_URL,createCollectorKey,deleteCollectedProduct,getCollectedProduct,getCollectedProducts,type CollectedProductCard,type CollectedProductDetail,type CollectionFacets,type CollectionStage,type SessionUser } from './api'
import CollectionPromotion from './CollectionPromotion'
import { enqueueCollectedProduct } from './1688Api'
import { ProductImagesPanel } from './ImageWorkshop'

const money=(value:string|number)=>new Intl.NumberFormat('zh-CN',{style:'currency',currency:'CNY',maximumFractionDigits:2}).format(Number(value))
const queueNames:Record<NonNullable<CollectedProductCard['queue_status']>,string>={queued:'排队中',processing:'Agent 处理中',blocked:'需核对',failed:'处理失败',published:'已提交平台',unknown:'结果待核对',cancelled:'已取消'}
const stageNames:Record<CollectionStage,string>={pending:'待处理',queue:'队列中',attention:'需核对',promoted:'已转正式产品',published:'已提交平台'}
const collectionStatus=(item:CollectedProductCard)=>item.queue_status&&item.queue_status!=='cancelled'?queueNames[item.queue_status]:stageNames[item.stage]
const priceText=(item:CollectedProductCard)=>item.min_price==null?'价格待确认':Number(item.min_price)===Number(item.max_price)?money(item.min_price):`${money(item.min_price)} 起`
/** "3 分钟前" up to a week, then the date. */
export function ago(value:string){const minutes=Math.round((Date.now()-Date.parse(value))/60000);if(minutes<1)return '刚刚';if(minutes<60)return `${minutes} 分钟前`;if(minutes<1440)return `${Math.floor(minutes/60)} 小时前`;if(minutes<10080)return `${Math.floor(minutes/1440)} 天前`;return new Date(value).toLocaleDateString('zh-CN')}
const emptyFacets:CollectionFacets={all:0,pending:0,queue:0,attention:0,promoted:0,published:0}

export default function ProductCollectionsPage({user}:{user:SessionUser}){
 const [promoting,setPromoting]=useState<CollectedProductDetail|null>(null)
 const canCreate=(user.permissions||[]).some(p=>p==='*'||p==='product:*'||p==='product:create')
 const [collections,setCollections]=useState<CollectedProductCard[]>([]),[facets,setFacets]=useState<CollectionFacets>(emptyFacets),[total,setTotal]=useState(0),[loaded,setLoaded]=useState(false),[loading,setLoading]=useState(true),[error,setError]=useState(''),[notice,setNotice]=useState(''),[search,setSearch]=useState(''),[collectionDetail,setCollectionDetail]=useState<CollectedProductDetail|null>(null),[collectorSetup,setCollectorSetup]=useState(false),[deletingCollection,setDeletingCollection]=useState<CollectedProductCard|null>(null)
 const [stage,setStage]=useState<CollectionStage|''>(''),[source,setSource]=useState<''|'1688'|'alibaba'>(''),[page,setPage]=useState(1),[pageSize,setPageSize]=useState(24)
 const query=useDebounced(search.trim())
 useEffect(()=>{setPage(1)},[query,stage,source,pageSize])
 const load=useCallback(async()=>{setLoading(true);setError('');try{const r=await getCollectedProducts({search:query||undefined,stage:stage||undefined,source:source||undefined,page,pageSize});setCollections(r.data);setFacets(r.facets);setTotal(r.total);setLoaded(true)
   // A deletion can leave the last page empty: step back.
   if(!r.data.length&&page>1)setPage(Math.max(1,Math.ceil(r.total/pageSize)))}catch(cause){setError(cause instanceof ApiError?cause.message:'采集商品数据加载失败。')}finally{setLoading(false)}},[query,stage,source,page,pageSize])
 useEffect(()=>{void load()},[load])
 const filtered=Boolean(query||stage||source)
 const changePage=(next:number)=>{setPage(next);document.querySelector('.catalog-head')?.scrollIntoView({behavior:'smooth',block:'start'})}
 async function removeCollection(item:CollectedProductCard){try{await deleteCollectedProduct(item.id);setNotice('采集记录已删除');await load()}catch(cause){setError(cause instanceof Error?cause.message:'删除采集记录失败。')}finally{setDeletingCollection(null)}}
 async function openCollection(item:CollectedProductCard){try{setCollectionDetail((await getCollectedProduct(item.id)).data)}catch(cause){setError(cause instanceof Error?cause.message:'采集详情加载失败。')}}
 async function enqueue(item:CollectedProductDetail){try{await enqueueCollectedProduct(item.product.id);setCollectionDetail(null);setNotice('已加入 Agent 队列');await load()}catch(cause){setError(cause instanceof Error?cause.message:'加入队列失败。')}}
 return <div className="commerce-page collection-page">
  {notice&&<div className="inline-notice">{notice}<button onClick={()=>setNotice('')}><X size={14}/></button></div>}
  <section className="catalog-head">
   <div className="catalog-search"><Search size={16}/><input value={search} onChange={e=>setSearch(e.target.value)} placeholder="搜索商品名称或 1688 商品 ID" aria-label="搜索采集商品"/>{search&&<button onClick={()=>setSearch('')} aria-label="清除搜索"><X size={14}/></button>}</div>
   <select className="catalog-select" value={source} onChange={e=>setSource(e.target.value as typeof source)} aria-label="来源"><option value="">全部来源</option><option value="1688">1688</option><option value="alibaba">Alibaba</option></select>
   <button className="catalog-secondary catalog-end" onClick={()=>setCollectorSetup(true)}><KeyRound size={16}/>配置采集器</button>
  </section>
  <div className="catalog-tabs" role="tablist" aria-label="处理阶段">{([['','全部',facets.all],...(Object.keys(stageNames) as CollectionStage[]).map(k=>[k,stageNames[k],facets[k]])] as [CollectionStage|'',string,number][]).map(([key,label,count])=>
   <button key={key||'all'} role="tab" aria-selected={stage===key} className={`${stage===key?'active':''} ${key==='attention'&&count>0?'warn':''}`} onClick={()=>setStage(key)}>{label}<span>{count}</span></button>)}</div>
  {error&&<section className="state-card error-state"><AlertCircle size={25}/><h2>数据暂时无法加载</h2><p>{error}</p><button onClick={()=>void load()}><RefreshCw size={15}/>重新加载</button></section>}
  {!error&&!loaded&&<section className="card-grid" aria-busy="true">{Array.from({length:8},(_,i)=><div key={i} className="card-skeleton"><div/><span/><span/><span/></div>)}</section>}
  {!error&&loaded&&!collections.length&&(filtered
   ?<section className="state-card compact"><SearchX size={26}/><h2>没有符合条件的采集商品</h2><p>换个关键词，或清除筛选条件。</p><button onClick={()=>{setSearch('');setStage('');setSource('')}}>清除筛选</button></section>
   :<section className="state-card"><Inbox size={28}/><h2>采集第一件 1688 商品</h2><button onClick={()=>setCollectorSetup(true)}><KeyRound size={15}/>配置采集器</button></section>)}
  {!error&&loaded&&collections.length>0&&<section className={`card-grid ${loading?'is-loading':''}`}>{collections.map(item=><article key={item.id} className="goods-card">
   <button className="goods-media" onClick={()=>void openCollection(item)} aria-label={`查看 ${item.title}`}><Database size={28}/>{item.main_image_url&&<img src={item.main_image_url} alt="" loading="lazy" referrerPolicy="no-referrer" onError={e=>{e.currentTarget.style.display='none'}}/>}
    <span className="goods-source">{item.source==='1688'?'1688':'Alibaba'}</span><span className={`goods-stage stage-${item.stage}`}>{collectionStatus(item)}</span></button>
   <div className="goods-body">
    <button className="goods-title" onClick={()=>void openCollection(item)} title={item.title}>{item.title}</button>
    <div className="goods-price"><strong>{priceText(item)}</strong><span>{item.variant_count} 个 SKU</span></div>
    <small className="goods-id">ID {item.source_product_id}</small>
    {item.stage==='attention'&&item.queue_message&&<p className="goods-alert" title={item.queue_message}><TriangleAlert size={13}/>{item.queue_message}</p>}
   </div>
   <footer className="goods-foot"><span title={new Date(item.collected_at).toLocaleString('zh-CN')}>{item.collector_name?`${item.collector_name} · `:''}{ago(item.collected_at)}</span>
    <button className="goods-icon" onClick={()=>setDeletingCollection(item)} aria-label={`删除 ${item.title}`} title="删除"><Trash2 size={15}/></button></footer>
  </article>)}</section>}
  {!error&&loaded&&<Pagination page={page} pageSize={pageSize} total={total} onPage={changePage} onPageSize={setPageSize} unit="件"/>}
  {collectionDetail&&<><CollectionPreview detail={collectionDetail} user={user} onClose={()=>setCollectionDetail(null)}/><div className="collection-promote-actions">{canCreate&&!collectionDetail.product.product_id&&!['queued','processing','unknown'].includes(collectionDetail.product.queue_status||'')&&<button className="shop-button" onClick={()=>{setPromoting(collectionDetail);setCollectionDetail(null)}}>审核并创建正式产品</button>}{collectionDetail.product.source==='1688'&&!collectionDetail.product.product_id&&!collectionDetail.product.queue_status&&<button className="shop-button primary" onClick={()=>void enqueue(collectionDetail)}><Bot size={16}/>加入 Agent 队列</button>}</div></>}
  {promoting&&<CollectionPromotion detail={promoting} close={()=>setPromoting(null)} saved={()=>{setPromoting(null);setNotice('正式产品已创建，可在「发布草稿」中上架');void load()}}/>}
  {collectorSetup&&<CollectorSetup onClose={()=>setCollectorSetup(false)} onNotice={setNotice}/>}
  {deletingCollection&&<Confirm title="删除这条采集记录？" text={`“${deletingCollection.title}”及其 SKU 快照将被永久删除。`} action="删除记录" close={()=>setDeletingCollection(null)} confirm={()=>void removeCollection(deletingCollection)}/>}
 </div>
}

function CollectorSetup({onClose,onNotice}:{onClose:()=>void;onNotice:(message:string)=>void}){
 const [key,setKey]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('')
 async function generate(){setBusy(true);setError('');try{setKey((await createCollectorKey()).data.key)}catch(cause){setError(cause instanceof Error?cause.message:'生成采集密钥失败。')}finally{setBusy(false)}}
 async function copy(){await navigator.clipboard.writeText(key);onNotice('采集密钥已复制，请粘贴到脚本的 CRM 设置中。')}
 return <div className="dialog-layer"><button className="drawer-scrim" onClick={onClose}/><section className="collector-setup"><header><div><p className="kicker">1688 商品采集</p><h2>配置商品采集器</h2></div><button onClick={onClose}><X size={18}/></button></header><ol><li><b>安装商品采集器</b><span>通过 Tampermonkey 打开并安装完整商品采集脚本。</span><a href={COLLECTOR_SCRIPT_URL} target="_blank" rel="noreferrer">打开脚本 <ExternalLink size={13}/></a></li><li><b>生成专用密钥</b><span>新密钥只显示一次；重新生成会立即吊销旧密钥。</span>{key?<div className="collector-key"><code>{key}</code><button onClick={()=>void copy()}><Copy size={14}/>复制</button></div>:<button className="generate-key" disabled={busy} onClick={()=>void generate()}><KeyRound size={14}/>{busy?'生成中…':'生成采集密钥'}</button>}</li><li><b>直接采集商品</b><span>打开商品详情页，点击右下角采集器，填写 CRM API 地址与密钥，然后点击“采集此商品”；列表页也支持批量采集。</span></li></ol>{error&&<div className="form-error">{error}</div>}</section></div>
}

function CollectionPreview({detail,user,onClose}:{detail:CollectedProductDetail;user:SessionUser;onClose:()=>void}){const p=detail.product;return <div className="drawer-layer"><button className="drawer-scrim" onClick={onClose}/><aside className="record-drawer collection-drawer"><header><div><p className="kicker">{p.source} 原始商品</p><h2>{p.title}</h2></div><button onClick={onClose}><X size={20}/></button></header><div className="collection-detail"><div className="collection-hero">{p.main_image_url&&<img src={p.main_image_url} alt="" referrerPolicy="no-referrer"/>}<div><span>源商品 ID</span><b>{p.source_product_id}</b>{p.seller_name&&<small>{p.seller_name}</small>}{p.category_path&&<small>{p.category_path}</small>}<a href={p.source_url} target="_blank" rel="noreferrer">查看源页面 <ExternalLink size={13}/></a></div></div><div className="collection-facts"><span>{Object.keys(p.attributes).length} 项属性</span>{p.video_url&&<a href={p.video_url} target="_blank" rel="noreferrer">主图视频 <ExternalLink size={12}/></a>}</div><ProductImagesPanel productId={p.id} title={p.title} user={user}/><section><div className="section-head"><div><p className="kicker">原始 SKU 快照</p><h3>{detail.variants.length} 个款式</h3></div></div>{detail.variants.length?<div className="variant-list">{detail.variants.map(v=><article key={v.id}>{v.image_url?<img src={v.image_url} alt="" referrerPolicy="no-referrer"/>:<div className="variant-image-empty"><Box size={17}/></div>}<div><b>{v.label}</b><small>{Object.entries(v.attributes).map(([k,val])=>`${k}: ${val}`).join(' · ')||'暂无规格属性'}</small></div><strong>{v.price==null?(v.price_text||'—'):money(v.price)}</strong><span>{v.stock_text||'库存未知'}</span></article>)}</div>:<p className="tier-empty">该来源商品没有独立 SKU 组合，商品级信息已完整保存。</p>}</section></div></aside></div>}

function Confirm({title,text,action,close,confirm}:{title:string;text:string;action:string;close:()=>void;confirm:()=>void}){return <div className="dialog-layer"><button className="drawer-scrim" onClick={close}/><section className="confirm-dialog"><div className="confirm-icon"><Trash2 size={20}/></div><h2>{title}</h2><p>{text}</p><div><button onClick={close}>取消</button><button className="danger" onClick={confirm}>{action}</button></div></section></div>}
