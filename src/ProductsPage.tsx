import { useCallback,useEffect,useState,type FormEvent } from 'react'
import { AlertCircle,Box,Inbox,Pencil,Plus,RefreshCw,Search,SearchX,Trash2,X } from 'lucide-react'
import Pagination,{ useDebounced } from './Pagination'
import { ApiError,createProduct,deleteProduct,getProductPage,updateProduct,type Product,type ProductFacets,type ProductInput } from './api'
import { AttributeImportDialog,AttributeTemplatesDialog,ProductAttributesSections,useProductAttributes } from './ProductAttributes'

const money=(value:string|number)=>new Intl.NumberFormat('zh-CN',{style:'currency',currency:'CNY',maximumFractionDigits:2}).format(Number(value))
const statusNames={active:'在售',draft:'草稿',inactive:'停用'} as const
/** Card blurb: plain text of the description (1688 details are mostly <img> markup), else the first specifications. */
function blurb(product:Product){
 const text=(product.description??'').replace(/<[^>]*>/g,' ').replace(/&nbsp;/g,' ').replace(/\s+/g,' ').trim()
 if(text)return text
 const specs=Object.entries(product.specifications??{}).slice(0,3).map(([k,v])=>`${k}：${v}`)
 return specs.length?specs.join(' · '):''
}
const productEmpty:ProductInput={sku:'',name:'',category:'',description:'',specifications:{},basePrice:0,status:'active',prices:[]}

/** Internal product data (created from 1688 collection or by hand): specifications and tier prices used when publishing. */
export default function ProductLibrary(){
 const [products,setProducts]=useState<Product[]>([]),[facets,setFacets]=useState<ProductFacets>({all:0,active:0,draft:0,inactive:0}),[categories,setCategories]=useState<string[]>([]),[total,setTotal]=useState(0),[loaded,setLoaded]=useState(false),[loading,setLoading]=useState(true),[error,setError]=useState(''),[notice,setNotice]=useState(''),[search,setSearch]=useState(''),[productForm,setProductForm]=useState<Product|null|undefined>(undefined),[deletingProduct,setDeletingProduct]=useState<Product|null>(null)
 const [dialog,setDialog]=useState<'templates'|'import'|null>(null),[missingPackage,setMissingPackage]=useState(false)
 const [status,setStatus]=useState<''|Product['status']>(''),[category,setCategory]=useState(''),[page,setPage]=useState(1),[pageSize,setPageSize]=useState(24)
 const query=useDebounced(search.trim())
 useEffect(()=>{setPage(1)},[query,status,category,pageSize,missingPackage])
 const load=useCallback(async()=>{setLoading(true);setError('');try{const r=await getProductPage({search:query||undefined,status:status||undefined,category:category||undefined,missingPackage:missingPackage?'true':undefined,page,pageSize});setProducts(r.data);setFacets(r.facets);setCategories(r.categories);setTotal(r.total);setLoaded(true)
   if(!r.data.length&&page>1)setPage(Math.max(1,Math.ceil(r.total/pageSize)))}catch(cause){setError(cause instanceof ApiError?cause.message:'产品数据加载失败。')}finally{setLoading(false)}},[query,status,category,page,pageSize,missingPackage])
 useEffect(()=>{void load()},[load])
 const filtered=Boolean(query||status||category||missingPackage)
 const changePage=(next:number)=>{setPage(next);document.querySelector('.catalog-head')?.scrollIntoView({behavior:'smooth',block:'start'})}
 async function removeProduct(item:Product){try{await deleteProduct(item.id);setNotice('产品已停用并移出目录');await load()}catch(cause){setError(cause instanceof Error?cause.message:'删除产品失败。')}finally{setDeletingProduct(null)}}
 return <div className="commerce-page">
  {notice&&<div className="inline-notice">{notice}<button onClick={()=>setNotice('')}><X size={14}/></button></div>}
  <section className="catalog-head">
   <div className="catalog-search"><Search size={16}/><input value={search} onChange={e=>setSearch(e.target.value)} placeholder="搜索 SKU 或产品名称" aria-label="搜索产品"/>{search&&<button onClick={()=>setSearch('')} aria-label="清除搜索"><X size={14}/></button>}</div>
   {categories.length>0&&<select className="catalog-select" value={category} onChange={e=>setCategory(e.target.value)} aria-label="分类"><option value="">全部分类</option>{categories.map(c=><option key={c}>{c}</option>)}</select>}
   <div className="catalog-tools"><label><input type="checkbox" checked={missingPackage} onChange={e=>setMissingPackage(e.target.checked)}/>只看缺件重尺</label><button onClick={()=>setDialog('templates')}>属性模板</button><button onClick={()=>setDialog('import')}>导入导出</button></div>
   <button className="catalog-primary" onClick={()=>setProductForm(null)}><Plus size={16}/>新建产品</button>
  </section>
  <div className="catalog-tabs" role="tablist" aria-label="产品状态">{([['','全部',facets.all],['active','在售',facets.active],['draft','草稿',facets.draft],['inactive','停用',facets.inactive]] as [''|Product['status'],string,number][]).map(([key,label,count])=>
   <button key={key||'all'} role="tab" aria-selected={status===key} className={status===key?'active':''} onClick={()=>setStatus(key)}>{label}<span>{count}</span></button>)}</div>
  {error&&<section className="state-card error-state"><AlertCircle size={25}/><h2>数据暂时无法加载</h2><p>{error}</p><button onClick={()=>void load()}><RefreshCw size={15}/>重新加载</button></section>}
  {!error&&!loaded&&<section className="card-grid" aria-busy="true">{Array.from({length:8},(_,i)=><div key={i} className="card-skeleton"><div/><span/><span/><span/></div>)}</section>}
  {!error&&loaded&&!products.length&&(filtered
   ?<section className="state-card compact"><SearchX size={26}/><h2>没有符合条件的产品</h2><p>换个关键词，或清除筛选条件。</p><button onClick={()=>{setSearch('');setStatus('');setCategory('');setMissingPackage(false)}}>清除筛选</button></section>
   :<section className="state-card"><Inbox size={28}/><h2>建立第一件产品</h2><button onClick={()=>setProductForm(null)}><Plus size={15}/> 新建产品</button></section>)}
  {!error&&loaded&&products.length>0&&<section className={`card-grid ${loading?'is-loading':''}`}>{products.map(product=>{const text=blurb(product);return <article key={product.id} className="goods-card">
   <button className="goods-media" onClick={()=>setProductForm(product)} aria-label={`编辑 ${product.name}`}><Box size={28}/>{product.images?.[0]&&<img src={product.images[0]} alt="" loading="lazy" referrerPolicy="no-referrer" onError={e=>{e.currentTarget.style.display='none'}}/>}
    {product.category&&<span className="goods-source">{product.category}</span>}<span className={`goods-stage product-${product.status}`}>{statusNames[product.status]}</span></button>
   <div className="goods-body">
    <button className="goods-title" onClick={()=>setProductForm(product)} title={product.name}>{product.name}</button>
    <div className="goods-price"><strong>{money(product.base_price)}</strong><span>标准价</span></div>
    {product.prices.length>0&&<div className="goods-tiers">{product.prices.slice(0,2).map((price,index)=><span key={price.id??index}>≥{Number(price.min_quantity)} · {money(price.unit_price)}</span>)}{product.prices.length>2&&<span>+{product.prices.length-2}</span>}</div>}
    {text&&<p className="goods-desc" title={text}>{text}</p>}
    {product.package_weight_g==null&&<span className="goods-missing">缺件重尺</span>}
   </div>
   <footer className="goods-foot"><small className="goods-id" title={product.sku}>{product.sku}</small>
    <div><button className="goods-icon" onClick={()=>setProductForm(product)} aria-label={`编辑 ${product.name}`} title="编辑"><Pencil size={14}/></button><button className="goods-icon" onClick={()=>setDeletingProduct(product)} aria-label={`删除 ${product.name}`} title="删除"><Trash2 size={14}/></button></div></footer>
  </article>})}</section>}
  {!error&&loaded&&<Pagination page={page} pageSize={pageSize} total={total} onPage={changePage} onPageSize={setPageSize} unit="件"/>}
  {productForm!==undefined&&<ProductDrawer product={productForm} onClose={()=>setProductForm(undefined)} onSaved={async message=>{setProductForm(undefined);setNotice(message);await load()}}/>}
  {dialog==='templates'&&<AttributeTemplatesDialog categories={categories} close={()=>setDialog(null)}/>}
  {dialog==='import'&&<AttributeImportDialog close={()=>setDialog(null)} imported={()=>{setDialog(null);setNotice('属性已导入');void load()}}/>}
  {deletingProduct&&<Confirm title="删除这个产品？" text={`“${deletingProduct.name}”将被移除。`} action="删除产品" close={()=>setDeletingProduct(null)} confirm={()=>void removeProduct(deletingProduct)}/>}
 </div>
}

function Confirm({title,text,action,close,confirm}:{title:string;text:string;action:string;close:()=>void;confirm:()=>void}){return <div className="dialog-layer"><button className="drawer-scrim" onClick={close}/><section className="confirm-dialog"><div className="confirm-icon"><Trash2 size={20}/></div><h2>{title}</h2><p>{text}</p><div><button onClick={close}>取消</button><button className="danger" onClick={confirm}>{action}</button></div></section></div>}

function ProductDrawer({product,onClose,onSaved}:{product:Product|null;onClose:()=>void;onSaved:(message:string)=>Promise<void>}){
 const [form,setForm]=useState<ProductInput>(()=>product?{sku:product.sku,name:product.name,category:product.category,description:product.description,specifications:product.specifications,basePrice:Number(product.base_price),status:product.status,prices:product.prices.map(p=>({minQuantity:Number(p.min_quantity),unitPrice:Number(p.unit_price),customerLevel:p.customer_level,validFrom:p.valid_from,validUntil:p.valid_until}))}:productEmpty)
 const [saving,setSaving]=useState(false),[error,setError]=useState('')
 const attributes=useProductAttributes(product?.id??null)
 const set=(key:keyof ProductInput,value:unknown)=>setForm(current=>({...current,[key]:value}))
 function addPrice(){setForm(current=>({...current,prices:[...current.prices,{minQuantity:1,unitPrice:current.basePrice,customerLevel:null}]}))}
 function setPrice(index:number,key:string,value:unknown){setForm(current=>({...current,prices:current.prices.map((price,i)=>i===index?{...price,[key]:value}:price)}))}
 async function submit(event:FormEvent){event.preventDefault();setSaving(true);setError('');try{const {specifications:_,...data}=form;const id=product?(await updateProduct(product.id,data),product.id):(await createProduct(data)).data.id;await attributes.save(id);await onSaved(product?'产品已更新':'产品已创建')}catch(cause){setError(cause instanceof Error?cause.message:'保存产品失败。')}finally{setSaving(false)}}
 return <div className="drawer-layer"><button className="drawer-scrim" onClick={onClose}/><aside className="record-drawer product-drawer"><header><div><h2>{product?product.name:'新建产品'}</h2></div><button onClick={onClose}><X size={20}/></button></header><form onSubmit={submit}><div className="form-grid"><label><span>SKU *</span><input value={form.sku} onChange={e=>set('sku',e.target.value)} required/></label><label><span>产品名称 *</span><input value={form.name} onChange={e=>set('name',e.target.value)} required/></label><label><span>分类</span><input value={form.category??''} onChange={e=>set('category',e.target.value)}/></label><label><span>状态</span><select value={form.status} onChange={e=>set('status',e.target.value)}><option value="active">在售</option><option value="draft">草稿</option><option value="inactive">停用</option></select></label><label><span>标准价（元）</span><input type="number" min="0" step="0.01" value={form.basePrice} onChange={e=>set('basePrice',Number(e.target.value))}/></label><label><span>计价币种</span><input value="人民币 CNY" disabled/></label><label className="full"><span>产品描述</span><textarea value={form.description??''} onChange={e=>set('description',e.target.value)}/></label></div><ProductAttributesSections state={attributes} category={form.category}/><section className="price-tiers"><div><div><p className="kicker">阶梯价</p><h3>数量与客户分级价格</h3></div><button type="button" onClick={addPrice}><Plus size={14}/>添加价格</button></div>{!form.prices.length?<p className="tier-empty">未设置阶梯价，按标准价计算。</p>:form.prices.map((price,index)=><article key={index}><label><span>起订量</span><input type="number" min="0.0001" step="0.0001" value={price.minQuantity} onChange={e=>setPrice(index,'minQuantity',Number(e.target.value))}/></label><label><span>单价（元）</span><input type="number" min="0" step="0.01" value={price.unitPrice} onChange={e=>setPrice(index,'unitPrice',Number(e.target.value))}/></label><select aria-label="客户等级" value={price.customerLevel??''} onChange={e=>setPrice(index,'customerLevel',e.target.value||null)}><option value="">全部等级</option>{['A','B','C','D'].map(v=><option key={v}>{v}</option>)}</select><button type="button" onClick={()=>setForm(current=>({...current,prices:current.prices.filter((_,i)=>i!==index)}))}><Trash2 size={14}/></button></article>)}</section>{error&&<div className="form-error">{error}</div>}<footer><button type="button" onClick={onClose}>取消</button><button className="primary" disabled={saving}>{saving?'保存中…':product?'保存产品':'创建产品'}</button></footer></form></aside></div>
}
