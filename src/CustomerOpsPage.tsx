import { buyerLabel } from './buyerLabel'
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import './1688.css'
import { AlertCircle, Sparkles, CheckCircle2, ChevronLeft, ChevronRight, Download, FileText, LoaderCircle, MessageSquareText, Paperclip, PenLine, Plus, Save, ListFilter, Search, ShieldCheck, Store, Tag as TagIcon, Trash2, X } from 'lucide-react'
import { getAccounts, type Account, type SessionUser } from './api'
import { DATA_CHANGED, openAi, useAiFocusPart } from './aiFocus'
import OrderDrawer from './OrderDrawer'
import { Note, ShopPicker } from './ui'
import { Drawer, Timeline, WangwangButton } from './PerformanceAnalysis'
import { getChatDetail, type ChatDetail } from './performanceApi'
import {
  addFollowup, attachmentMimes, bulkTag, createTag, deleteAttachment, deleteTag, exportCustomers, getAttachments, getCustomer, getCustomers, getCustomerSettings, getOptions, getShopAgents,
  saveCustomerSettings, saveProfile, setCustomerTags, uploadAttachment,
  type Attachment, type AttachmentLimits, type Customer, type CustomerDetail, type CustomerSettings, type Filters, type Options, type ProfileInput,
} from './customerOpsApi'

const message = (cause:unknown) => cause instanceof Error ? cause.message : '操作未完成，请稍后重试。'
const permission = (user:SessionUser,name:string) => (user.permissions||[]).some(v => v==='*'||v===name||v===`${name.split(':')[0]}:*`)
const yuan = (v:number|null) => v==null ? '—' : `¥${v.toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2})}`
const dateTime = (v:string|null) => v ? new Date(v).toLocaleString('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}) : '—'
const label = (c:{name:string|null;buyer_tail:string;buyer_nick?:string|null}) => buyerLabel(c)
const typeNames = { prospect:'未购买', new:'新客户', returning:'老客户', loyal:'忠诚客户' } as const
const levelNames = { normal:'普通客户', platinum:'白金客户', vip:'VIP 客户' } as const
const priceNames = { low:'低价值', mid:'一般价值', high:'高价值' } as const
const orderStatus:Record<string,string> = { waitbuyerpay:'待付款', waitsellersend:'待发货', waitbuyerreceive:'待收货', confirm_goods_but_not_fund:'已收货', success:'交易成功', cancel:'已取消' }
type View = 'list'|'pool'|'due'|'settings'

function Modal({title,close,children,wide,actions}:{title:string;close:()=>void;children:ReactNode;wide?:boolean;actions?:ReactNode}) {
  useEffect(()=>{const escape=(event:KeyboardEvent)=>{if(event.key==='Escape')close()};window.addEventListener('keydown',escape);return()=>window.removeEventListener('keydown',escape)},[close])
  return <div className="dialog-layer shop-dialog"><button className="drawer-scrim" onClick={close} aria-label="关闭"/><section role="dialog" aria-modal="true" aria-label={title} className={wide?'shop-modal wide':'shop-modal'}><header><h2>{title}</h2>{actions}<button title="关闭" onClick={close}><X size={18}/></button></header>{children}</section></div>
}

/** One filter row: "不限" plus multi-select chips, as on the shop's segmentation screen. */
function FilterRow({title,options,value,onChange,single}:{title:string;options:[string,string][];value:string[];onChange:(v:string[])=>void;single?:boolean}) {
  return <div className="co-filter-row"><span>{title}</span><div>
    <button className={!value.length?'active':''} aria-pressed={!value.length} onClick={()=>onChange([])}>不限</button>
    {options.map(([key,text])=><button key={key} aria-pressed={value.includes(key)} className={value.includes(key)?'active':''} onClick={()=>onChange(single?(value.includes(key)?[]:[key]):value.includes(key)?value.filter(v=>v!==key):[...value,key])}>{text}</button>)}
  </div></div>
}

export default function CustomerOpsPage({user,view}:{user:SessionUser;view:View}) {
  const canRead=permission(user,'customer_ops:read'),canUpdate=permission(user,'customer_ops:update'),canManage=permission(user,'customer_ops:manage')
  // Order detail, chat messages and Wangwang go through the performance app, so they need its read access.
  const canChat=permission(user,'performance:read')||permission(user,'performance:read_own')
  const [options,setOptions]=useState<Options|null>(null),[shop,setShop]=useState('')
  const [filters,setFilters]=useState<Filters>({}),[search,setSearch]=useState(''),[page,setPage]=useState(1)
  const [rows,setRows]=useState<Customer[]>([]),[total,setTotal]=useState(0),[loading,setLoading]=useState(true)
  const [error,setError]=useState(''),[notice,setNotice]=useState(''),[selected,setSelected]=useState<string[]>([])
  useAiFocusPart({ connectionId: shop || undefined, view })
  const [detail,setDetail]=useState<string|null>(null),[followupFor,setFollowupFor]=useState<Customer|null>(null),[showFilters,setShowFilters]=useState(false)
  const [customFollowups,setCustomFollowups]=useState(''),[customIdle,setCustomIdle]=useState('')
  const loadOptions=useCallback(async()=>{try{const r=await getOptions();setOptions(r.data);setShop(s=>s||r.data.shops.find(x=>x.status==='connected')?.id||r.data.shops[0]?.id||'')}catch(cause){setError(message(cause))}},[])
  useEffect(()=>{if(canRead)void loadOptions()},[canRead,loadOptions])
  // The segment panel only shows on the list tab, so the pool and due tabs apply just the search box.
  const [exporting,setExporting]=useState(false)
  async function doExport(){setExporting(true);setError('');try{await exportCustomers(shop,effective);setNotice('已导出当前筛选结果（含联系方式，请妥善保管）')}catch(cause){setError(message(cause))}finally{setExporting(false)}}
  const effective=useMemo<Filters>(()=>view==='pool'?{search:filters.search,page,pool:filters.pool??'any',sort:'unpaid_at'}:view==='due'?{search:filters.search,page,due:'yes',sort:'next_follow_up'}:{...filters,page},[filters,page,view])
  const load=useCallback(async()=>{
    if(!shop||view==='settings')return
    setLoading(true);try{const r=await getCustomers(shop,effective);setRows(r.data);setTotal(r.total);setSelected([])}catch(cause){setError(message(cause))}finally{setLoading(false)}
  },[shop,effective,view])
  useEffect(()=>{setPage(1);setShowFilters(false)},[view])
  useEffect(()=>{void load()},[load])
  useEffect(()=>{const reload=()=>void load();window.addEventListener(DATA_CHANGED,reload);return()=>window.removeEventListener(DATA_CHANGED,reload)},[load])
  const activeFilters=[filters.purchaseType,filters.customerType,filters.memberIdentity,filters.channel,filters.level,filters.priceTier,filters.tagId,filters.cycle].filter(v=>v?.length).length+[filters.minFollowups,filters.overdue,filters.idleDays].filter(v=>v!=null).length
  const set=(patch:Partial<Filters>)=>{setFilters(f=>({...f,...patch}));setPage(1)}
  async function bulk(tagId:string,action:'add'|'remove'){try{const r=await bulkTag(selected,tagId,action);setNotice(`${action==='add'?'已添加':'已移除'}标签（${r.data.changed} 位客户）`);await Promise.all([load(),loadOptions()])}catch(cause){setError(message(cause))}}
  if(!canRead)return <section className="state-card"><ShieldCheck size={28}/><h2>暂无客户经营访问权限</h2></section>
  if(!options)return <div className="shop-empty"><LoaderCircle size={26} className="spin"/><p>正在读取…</p></div>
  const tagName=new Map(options.tags.map(t=>[t.id,t.name]))
  return <div className="shop-workspace co-page">
    {notice&&<div className="shop-feedback" role="status"><CheckCircle2 size={16}/><span>{notice}</span><button title="关闭提示" onClick={()=>setNotice('')}><X size={15}/></button></div>}
    {error&&<div className="shop-feedback error" role="alert"><AlertCircle size={16}/><span>{error}</span><button title="关闭错误" onClick={()=>setError('')}><X size={15}/></button></div>}
    {view==='settings'?<SettingsView canManage={canManage} canUpdate={canUpdate} tags={options.tags} reload={loadOptions} setError={setError} setNotice={setNotice}/>:<>
      <div className="shop-controlbar">
        <form className="shop-search co-search" onSubmit={e=>{e.preventDefault();set({search:search.trim()||undefined})}}><Search size={16}/><input aria-label="搜索客户" placeholder="名称 / 旺旺 / 电话 / 订单号" value={search} onChange={e=>{setSearch(e.target.value);if(!e.target.value)set({search:undefined})}}/></form>
        <div className="shop-commandbar">
          <ShopPicker shops={options.shops} value={shop} onChange={id=>{setShop(id);setPage(1)}}/>
          {view==='list'&&<button className={`shop-button ${activeFilters?'co-filter-on':''}`} aria-expanded={showFilters} onClick={()=>setShowFilters(v=>!v)}><ListFilter size={15}/>筛选{activeFilters>0&&<b>{activeFilters}</b>}</button>}
        </div>
      </div>
      {view==='list'&&showFilters&&<section className="perf-chart-card co-filters" aria-label="客户筛选">
        <>
          <FilterRow title="购买类型" options={[['distribution','分销'],['procurement','采购']]} value={filters.purchaseType??[]} onChange={v=>set({purchaseType:v})}/>
          <FilterRow title="客户类型" options={Object.entries(typeNames)} value={filters.customerType??[]} onChange={v=>set({customerType:v})}/>
          <FilterRow title="会员身份" options={options.memberIdentities.map(x=>[x,x])} value={filters.memberIdentity??[]} onChange={v=>set({memberIdentity:v})}/>
          <FilterRow title="分销渠道" options={options.salesChannels.map(x=>[x,x])} value={filters.channel??[]} onChange={v=>set({channel:v})}/>
          <FilterRow title="客户等级" options={Object.entries(levelNames)} value={filters.level??[]} onChange={v=>set({level:v})}/>
          <FilterRow title="客单价" options={Object.entries(priceNames)} value={filters.priceTier??[]} onChange={v=>set({priceTier:v})}/>
          {options.tags.length>0&&<FilterRow title="通用标签" options={options.tags.map(t=>[t.id,t.name])} value={filters.tagId??[]} onChange={v=>set({tagId:v})}/>}
          <div className="co-filter-row"><span>回访次数</span><div>
            {[undefined,1,3,5].map(n=><button key={n??0} aria-pressed={filters.minFollowups===n} className={filters.minFollowups===n?'active':''} onClick={()=>set({minFollowups:n})}>{n?`${n} 次及以上`:'不限'}</button>)}
            <input aria-label="自定义回访次数" type="number" min={1} placeholder="自定义" value={customFollowups} onChange={e=>setCustomFollowups(e.target.value)} onBlur={()=>{const n=Number(customFollowups);if(Number.isInteger(n)&&n>0)set({minFollowups:n})}}/></div></div>
          <div className="co-filter-row"><span>超期未购</span><div>
            {([[undefined,'不限'],['no','未超期'],['yes','已超期']] as [Filters['overdue'],string][]).map(([v,text])=><button key={text} aria-pressed={filters.overdue===v&&!filters.idleDays} className={filters.overdue===v&&!filters.idleDays?'active':''} onClick={()=>set({overdue:v,idleDays:undefined})}>{text}</button>)}
            <input aria-label="自定义超期未购天数" type="number" min={1} placeholder="超过 N 天未购" value={customIdle} onChange={e=>setCustomIdle(e.target.value)} onBlur={()=>{const n=Number(customIdle);set({idleDays:Number.isInteger(n)&&n>0?n:undefined,overdue:undefined})}}/></div></div>
          <FilterRow title="购买周期" options={[['1-2','平均 1–2 天买一次'],['3-7','平均 3–7 天'],['8-30','平均 8–30 天'],['30+','平均 30 天以上']]} value={filters.cycle??[]} onChange={v=>set({cycle:v})}/>
        </>
      </section>}
      {view==='pool'&&<nav className="perf-metric-tabs" aria-label="未成交类型">{([['any','全部'],['unpaid','下单未付款'],['no_order','咨询未下单']] as const).map(([id,text])=><button key={id} aria-pressed={(filters.pool??'any')===id} className={(filters.pool??'any')===id?'active':''} onClick={()=>set({pool:id})}>{text}</button>)}</nav>}
      <div className="co-listbar"><span>共 {total} 位客户</span>
        {canManage&&total>0&&<button className="shop-button" disabled={exporting} onClick={()=>void doExport()}><Download size={15}/>{exporting?'正在导出…':'导出 CSV'}</button>}
        {canUpdate&&selected.length>0&&<span className="co-bulk">已选 {selected.length} 位：<select aria-label="批量添加标签" value="" onChange={e=>{if(e.target.value)void bulk(e.target.value,'add')}}><option value="">批量添加标签…</option>{options.tags.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select>
          <select aria-label="批量移除标签" value="" onChange={e=>{if(e.target.value)void bulk(e.target.value,'remove')}}><option value="">移除标签…</option>{options.tags.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select></span>}
        {view==='list'&&<select className="perf-select" aria-label="排序" value={filters.sort??'last_paid'} onChange={e=>set({sort:e.target.value})}><option value="last_paid">最近交易时间</option><option value="paid_amount">累计金额</option><option value="paid_orders">购买次数</option><option value="avg_order">客单价</option><option value="last_chat">最近咨询</option></select>}
      </div>
      {loading?<div className="shop-empty"><LoaderCircle size={26} className="spin"/><p>正在读取…</p></div>:<div className="shop-table-scroll"><table className="shop-table perf-table co-table"><thead><tr>
        {canUpdate&&<th><input type="checkbox" aria-label="全选本页" checked={rows.length>0&&selected.length===rows.length} onChange={e=>setSelected(e.target.checked?rows.map(r=>r.id):[])}/></th>}
        <th>客户资料</th>
        {view==='pool'?<><th>未成交类型</th><th>最新跟进时间</th><th>最近下单订单号 / 金额</th><th>下单时间</th><th>询单天数</th></>:<><th>购买周期</th><th>购买次数</th><th>客单价</th><th>累计金额</th><th>最近交易时间</th><th>首次交易时间</th></>}
        <th>跟进记录</th><th>操作</th></tr></thead>
        <tbody>{rows.map(r=><tr key={r.id}>
          {canUpdate&&<td><input type="checkbox" aria-label={`选择 ${label(r)}`} checked={selected.includes(r.id)} onChange={e=>setSelected(s=>e.target.checked?[...s,r.id]:s.filter(x=>x!==r.id))}/></td>}
          <td className="co-customer"><strong>{label(r)}</strong><small>{[typeNames[r.customer_type],r.level&&levelNames[r.level],r.member_identity].filter(Boolean).join(' · ')}</small>
            <span className="co-tags">{r.overdue&&<em className="warn">超期</em>}{r.tag_ids.map(id=><em key={id}>{tagName.get(id)}</em>)}</span></td>
          {view==='pool'?<><td><span className={`shop-status ${r.pool==='unpaid'?'warning':''}`}>{r.pool==='unpaid'?'下单未付款':'咨询未下单'}</span></td><td>{dateTime(r.last_followup?.created_at??null)}</td>
            <td>{r.unpaid_order_id?<><code>{r.unpaid_order_id}</code><small>{yuan(r.unpaid_amount)}</small></>:'—'}</td><td>{dateTime(r.unpaid_placed_at)}</td><td>{r.inquiry_days}</td></>
          :<><td>{r.cycle_known?`${Math.round(r.cycle)} 天`:'—'}{r.cycle_mode==='custom'&&<small>自定义</small>}</td><td>{r.paid_orders} 次</td><td>{yuan(r.avg_order_amount)}</td><td>{yuan(r.paid_amount)}</td><td>{dateTime(r.last_paid_at)}</td><td>{dateTime(r.first_paid_at)}</td></>}
          <td className="co-followup">{view==='due'&&r.due_reason==='overdue'&&<span className="shop-status warning">超期未购 · {dateTime(r.overdue_at).slice(0,10)} 起</span>}{r.last_followup?<><span>{r.last_followup.content}</span><small>{dateTime(r.last_followup.created_at)} · 共 {r.followups} 次{r.next_follow_up_at?` · 下次 ${dateTime(r.next_follow_up_at)}`:''}</small></>:<span className="perf-muted">暂无</span>}</td>
          <td><div className="co-actions"><button className="shop-button" onClick={()=>setDetail(r.id)}>资料</button>{canUpdate&&<button className="shop-button" onClick={()=>setFollowupFor(r)}><PenLine size={14}/>写跟进</button>}</div></td>
        </tr>)}</tbody></table>{!rows.length&&<div className="shop-empty"><Store size={28}/><p>没有符合条件的客户</p></div>}</div>}
      <div className="shop-pagination"><button className="shop-icon" title="上一页" disabled={loading||page===1} onClick={()=>setPage(p=>p-1)}><ChevronLeft size={17}/></button><span>第 {page} / {Math.max(1,Math.ceil(total/50))} 页</span><button className="shop-icon" title="下一页" disabled={loading||page*50>=total} onClick={()=>setPage(p=>p+1)}><ChevronRight size={17}/></button></div>
      <Note>购买数据来自已同步的 1688 订单（按订单修改时间同步，未补齐的历史订单不计入）；平台不提供买家姓名和联系方式，名称、电话等需在“资料”中手动维护。</Note>
    </>}
    {followupFor&&<FollowupModal customer={followupFor} close={()=>setFollowupFor(null)} saved={()=>{setFollowupFor(null);setNotice('跟进已记录');void load()}} setError={setError}/>}
    {detail&&<DetailDrawer id={detail} options={options} canUpdate={canUpdate} canChat={canChat} close={()=>setDetail(null)} changed={()=>{void load();void loadOptions()}} setError={setError} setNotice={setNotice}/>}
  </div>
}

function FollowupModal({customer,close,saved,setError}:{customer:Customer;close:()=>void;saved:()=>void;setError:(t:string)=>void}) {
  const [content,setContent]=useState(''),[method,setMethod]=useState<'wangwang'|'other'>('wangwang'),[need,setNeed]=useState(true),[next,setNext]=useState(''),[busy,setBusy]=useState(false)
  async function submit(){
    if(!content.trim())return setError('请填写跟进内容。')
    setBusy(true);try{await addFollowup(customer.id,{content:content.trim(),method,needFollowUp:need,nextFollowUpAt:need&&next?new Date(next).toISOString():null});saved()}catch(cause){setError(message(cause))}finally{setBusy(false)}
  }
  return <Modal title={`写跟进 · ${label(customer)}`} close={close}><div className="shop-modal-body co-form">
    <label>跟进内容<textarea rows={4} maxLength={500} value={content} onChange={e=>setContent(e.target.value)} placeholder="例如：用户有购买意愿，在纠结价格"/></label>
    <fieldset><legend>跟进方式</legend><label className="co-radio"><input type="radio" checked={method==='wangwang'} onChange={()=>setMethod('wangwang')}/>旺旺跟进</label><label className="co-radio"><input type="radio" checked={method==='other'} onChange={()=>setMethod('other')}/>其他方式跟进（包括微信、电话、QQ 等）</label></fieldset>
    <fieldset><legend>跟进情况</legend><label className="co-radio"><input type="radio" checked={need} onChange={()=>setNeed(true)}/>需要跟进</label><label className="co-radio"><input type="radio" checked={!need} onChange={()=>{setNeed(false);setNext('')}}/>不需要跟进</label></fieldset>
    <label>下次跟进时间<input type="datetime-local" disabled={!need} value={next} onChange={e=>setNext(e.target.value)}/></label>
  </div><footer><button className="shop-button" onClick={close}>关闭</button><button className="shop-button primary" disabled={busy} onClick={()=>void submit()}>提交</button></footer></Modal>
}

function DetailDrawer({id,options,canUpdate,canChat,close,changed,setError,setNotice}:{id:string;options:Options;canUpdate:boolean;canChat:boolean;close:()=>void;changed:()=>void;setError:(t:string)=>void;setNotice:(t:string)=>void}) {
  const [data,setData]=useState<CustomerDetail|null>(null),[form,setForm]=useState<ProfileInput|null>(null),[busy,setBusy]=useState(false)
  const [agents,setAgents]=useState<{id:string;login_id:string;is_main:boolean}[]>([]),[accountSearch,setAccountSearch]=useState(''),[accounts,setAccounts]=useState<Account[]>([]),[newTag,setNewTag]=useState('')
  const [tagIds,setTagIds]=useState<string[]>([]),[order,setOrder]=useState(''),[chat,setChat]=useState<{title:string;data:ChatDetail}|null>(null)
  async function openChat(c:CustomerDetail['chats'][number]){try{setChat({title:`${c.is_main?'主账号':c.login_id} · ${c.chat_date}`,data:(await getChatDetail(c.id)).data})}catch(cause){setError(message(cause))}}
  const load=useCallback(async()=>{try{const r=(await getCustomer(id)).data;const c=r.customer;setData(r);setTagIds(c.tag_ids)
    setForm({revision:c.revision,name:c.name,wangwangId:c.wangwang_id,phone:c.phone,wechat:c.wechat,email:c.email,qq:c.qq,address:c.address,memberIdentity:c.member_identity,purchaseType:c.purchase_type,salesChannels:c.sales_channels,cycleMode:c.cycle_mode,cycleDays:c.cycle_days,note:c.note,accountId:c.account_id,ownerAgentId:c.owner_source==='manual'?c.owner_agent_id:'auto'})
    setAgents((await getShopAgents(c.connection_id)).data)}catch(cause){setError(message(cause))}},[id,setError])
  useEffect(()=>{void load()},[load])
  useAiFocusPart({ customerId: id, customerName: data ? data.customer.name || data.customer.wangwang_id || buyerLabel(data.customer) : undefined })
  useEffect(()=>{if(!accountSearch.trim()){setAccounts([]);return};const timer=setTimeout(()=>{getAccounts({search:accountSearch.trim()}).then(r=>setAccounts(r.data)).catch(()=>setAccounts([]))},300);return()=>clearTimeout(timer)},[accountSearch])
  async function save(){if(!form)return;setBusy(true);try{await saveProfile(id,form);await setCustomerTags(id,tagIds);setNotice('客户资料已保存');changed();await load()}catch(cause){setError(message(cause))}finally{setBusy(false)}}
  async function addTag(){if(!newTag.trim())return;try{const t=(await createTag(newTag.trim())).data;setTagIds(v=>[...v,t.id]);setNewTag('');changed()}catch(cause){setError(message(cause))}}
  const field=(key:keyof ProfileInput,text:string,max=100,type='text')=><label>{text}<input type={type} maxLength={max} disabled={!canUpdate} value={(form?.[key] as string|null)??''} onChange={e=>setForm(f=>f&&({...f,[key]:e.target.value||null}))}/></label>
  return <Modal title={data?`客户资料 · ${label(data.customer)}`:'客户资料'} close={close} wide actions={data&&<button className="shop-button co-ask-ai" onClick={()=>openAi('分析这个客户，给出下一步跟进建议')}><Sparkles size={14}/>问 AI</button>}>{!data||!form?<div className="shop-empty"><LoaderCircle size={26} className="spin"/></div>:<>
    <div className="shop-modal-body co-detail">
      <div className="perf-kpis">
        <article><span>购买次数</span><strong>{data.customer.paid_orders}</strong><small>{typeNames[data.customer.customer_type]}{data.customer.level?` · ${levelNames[data.customer.level]}`:''}</small></article>
        <article><span>累计金额</span><strong>{yuan(data.customer.paid_amount)}</strong><small>客单价 {yuan(data.customer.avg_order_amount)}</small></article>
        <article><span>购买周期</span><strong>{data.customer.cycle_known?`${Math.round(data.customer.cycle)} 天`:'—'}</strong><small>{data.customer.overdue?'已超期未购':`最近交易 ${dateTime(data.customer.last_paid_at)}`}</small></article>
        <article><span>询单天数</span><strong>{data.customer.inquiry_days}</strong><small>最近咨询 {dateTime(data.customer.last_chat_at)}</small></article>
      </div>
      <h3 className="perf-chart-title">编辑资料</h3>
      <div className="shop-form-columns co-form">
        {field('name','客户名称')}{field('wangwangId','旺旺号')}{field('phone','电话号',30,'tel')}{field('wechat','微信账号',60)}{field('email','电子邮箱',120,'email')}{field('qq','QQ 号码',20)}
        <label className="co-span">地址<input maxLength={200} disabled={!canUpdate} value={form.address??''} onChange={e=>setForm(f=>f&&({...f,address:e.target.value||null}))}/></label>
        <label>会员身份<select disabled={!canUpdate} value={form.memberIdentity??''} onChange={e=>setForm(f=>f&&({...f,memberIdentity:e.target.value||null}))}><option value="">未设置</option>{options.memberIdentities.map(m=><option key={m}>{m}</option>)}</select></label>
        <label>购买类型<select disabled={!canUpdate} value={form.purchaseType??''} onChange={e=>setForm(f=>f&&({...f,purchaseType:(e.target.value||null) as ProfileInput['purchaseType']}))}><option value="">未设置</option><option value="distribution">分销</option><option value="procurement">采购</option></select></label>
        <label>所属客服<select disabled={!canUpdate} value={form.ownerAgentId??''} onChange={e=>setForm(f=>f&&({...f,ownerAgentId:e.target.value||null}))}>
          <option value="auto">自动：首次促成付款的客服{data.customer.owner_source==='auto'?`（当前 ${(a=>a?(a.is_main?'主账号':a.login_id):'—')(agents.find(a=>a.id===data.customer.owner_agent_id))}）`:''}</option>
          <option value="">不设置</option>{agents.map(a=><option key={a.id} value={a.id}>{a.is_main?'主账号':a.login_id}</option>)}</select></label>
        <fieldset className="co-span"><legend>购买周期</legend>
          <label className="co-radio"><input type="radio" disabled={!canUpdate} checked={form.cycleMode==='system'} onChange={()=>setForm(f=>f&&({...f,cycleMode:'system',cycleDays:null}))}/>系统默认规则（在 2 个以上不同日期购买时，周期 =（最后一次 − 首次购买日期）÷（购买天数 − 1），同一天多单算一次；否则用默认周期）</label>
          <label className="co-radio"><input type="radio" disabled={!canUpdate} checked={form.cycleMode==='custom'} onChange={()=>setForm(f=>f&&({...f,cycleMode:'custom',cycleDays:f.cycleDays??30}))}/>自定义 <input type="number" min={1} max={3650} disabled={!canUpdate||form.cycleMode!=='custom'} value={form.cycleDays??''} onChange={e=>setForm(f=>f&&({...f,cycleDays:e.target.value?Number(e.target.value):null}))}/> 天</label></fieldset>
        <fieldset className="co-span"><legend>分销渠道</legend><div className="co-chips">{options.salesChannels.map(ch=><button type="button" key={ch} disabled={!canUpdate} aria-pressed={form.salesChannels.includes(ch)} className={form.salesChannels.includes(ch)?'active':''} onClick={()=>setForm(f=>f&&({...f,salesChannels:f.salesChannels.includes(ch)?f.salesChannels.filter(x=>x!==ch):[...f.salesChannels,ch]}))}>{ch}</button>)}</div></fieldset>
        <fieldset className="co-span"><legend><TagIcon size={14}/> 通用标签</legend><div className="co-chips">{options.tags.map(t=><button type="button" key={t.id} disabled={!canUpdate} aria-pressed={tagIds.includes(t.id)} className={tagIds.includes(t.id)?'active':''} onClick={()=>setTagIds(v=>v.includes(t.id)?v.filter(x=>x!==t.id):[...v,t.id])}>{t.name}</button>)}
          {canUpdate&&<span className="co-newtag"><input aria-label="新标签" maxLength={30} placeholder="新标签" value={newTag} onChange={e=>setNewTag(e.target.value)}/><button type="button" className="shop-icon" title="添加标签" onClick={()=>void addTag()}><Plus size={15}/></button></span>}</div></fieldset>
        <label className="co-span">关联 CRM 客户{data.account&&form.accountId===data.account.id?<span className="co-linked"><strong>{data.account.name}</strong>{canUpdate&&<button type="button" className="shop-button" onClick={()=>setForm(f=>f&&({...f,accountId:null}))}>取消关联</button>}</span>
          :<><input disabled={!canUpdate} placeholder="搜索 CRM 客户名称后选择" value={accountSearch} onChange={e=>setAccountSearch(e.target.value)}/>{accounts.length>0&&<span className="co-chips">{accounts.slice(0,8).map(a=><button type="button" key={a.id} className={form.accountId===a.id?'active':''} onClick={()=>setForm(f=>f&&({...f,accountId:a.id}))}>{a.name}</button>)}</span>}</>}</label>
        <label className="co-span">备注信息<textarea rows={2} maxLength={100} disabled={!canUpdate} value={form.note??''} onChange={e=>setForm(f=>f&&({...f,note:e.target.value||null}))} placeholder="会员备注信息最多可以输入 100 字"/><small>{(form.note??'').length}/100</small></label>
      </div>
      <AttachmentsPanel buyerId={id} canUpdate={canUpdate} changed={changed} setError={setError} setNotice={setNotice}/>
      <h3 className="perf-chart-title">跟进记录（{data.followups.length}）</h3>
      {data.followups.length?<ul className="co-timeline">{data.followups.map(f=><li key={f.id}><time>{dateTime(f.created_at)}</time><span>{f.content}</span><small>{f.method==='wangwang'?'旺旺跟进':'其他方式'} · {f.created_by_name??''}{f.need_follow_up?` · 下次 ${dateTime(f.next_follow_up_at)}${f.superseded?'（已更新）':''}`:' · 无需跟进'}</small></li>)}</ul>:<p className="shop-note">暂无跟进记录。</p>}
      <h3 className="perf-chart-title">最近订单</h3>
      {data.orders.length?<div className="shop-table-scroll"><table className="shop-table perf-table"><thead><tr><th>订单号</th><th>下单 / 付款</th><th>商品</th><th>金额</th><th>状态</th></tr></thead><tbody>{data.orders.map(o=><tr key={o.order_id}><td>{canChat?<button className="perf-order-link" title="查看订单详情" onClick={()=>setOrder(o.order_id)}>{o.order_id}</button>:<code>{o.order_id}</code>}</td><td>{dateTime(o.placed_at)}<small>{o.paid_at?`付款 ${dateTime(o.paid_at)}`:'未付款'}</small></td><td>{o.items.slice(0,2).map((i,n)=><small key={n}>{i.name} × {i.quantity}</small>)}</td><td>{yuan(o.total_amount)}{o.refunded>0&&<small>退款 {yuan(o.refunded)}</small>}</td><td>{orderStatus[o.status]??o.status}</td></tr>)}</tbody></table></div>:<p className="shop-note">暂无订单。</p>}
      <h3 className="perf-chart-title co-chats-title">最近咨询{canChat&&data.chats.length>0&&<WangwangButton buyerId={id} setError={setError} label="旺旺联系"/>}</h3>
      {data.chats.length?<ul className="co-timeline">{data.chats.map(c=><li key={c.id}><time>{c.chat_date}</time><span>{c.is_main?'主账号':c.login_id} 接待</span><small>买家 {c.buyer_messages} 条 / 客服 {c.agent_messages} 条</small>
        {canChat&&<span className="co-chat-actions"><WangwangButton buyerId={id} setError={setError}/><button className="shop-icon" title="查看对话" aria-label={`查看 ${c.chat_date} 的对话`} onClick={()=>void openChat(c)}><MessageSquareText size={16}/></button></span>}</li>)}</ul>:<p className="shop-note">暂无咨询记录。</p>}
      {order&&<OrderDrawer connectionId={data.customer.connection_id} orderId={order} close={()=>setOrder('')} setError={setError}/>}
      {chat&&<Drawer title={chat.title} close={()=>setChat(null)}><div className="perf-drawer-actions"><WangwangButton buyerId={id} setError={setError} label="旺旺联系买家"/></div><Timeline data={chat.data}/></Drawer>}
    </div>
    {canUpdate&&<footer><button className="shop-button" onClick={close}>关闭</button><button className="shop-button primary" disabled={busy} onClick={()=>void save()}><Save size={16}/>保存资料</button></footer>}
  </>}</Modal>
}

function SettingsView({canManage,canUpdate,tags,reload,setError,setNotice}:{canManage:boolean;canUpdate:boolean;tags:Options['tags'];reload:()=>Promise<void>;setError:(t:string)=>void;setNotice:(t:string)=>void}) {
  const [settings,setSettings]=useState<CustomerSettings|null>(null),[draft,setDraft]=useState<Record<string,string>>({}),[newTag,setNewTag]=useState(''),[busy,setBusy]=useState(false)
  const [overdueFollowup,setOverdueFollowup]=useState(true)
  useEffect(()=>{getCustomerSettings().then(r=>{setSettings(r.data);setOverdueFollowup(r.data.overdue_followup);setDraft(Object.fromEntries(Object.entries(r.data).map(([k,v])=>[k,String(v)])))}).catch(cause=>setError(message(cause)))},[setError])
  async function save(){if(!settings)return;const n=(k:string)=>Number(draft[k]);setBusy(true)
    try{const r=await saveCustomerSettings({revision:settings.revision,levelPlatinum:n('level_platinum'),levelVip:n('level_vip'),priceMid:n('price_mid'),priceHigh:n('price_high'),loyalOrders:n('loyal_orders'),defaultCycleDays:n('default_cycle_days'),overdueFollowup});setSettings(r.data);setNotice('分层规则已保存，客户分层立即按新规则计算')}catch(cause){setError(message(cause))}finally{setBusy(false)}}
  if(!settings)return <div className="shop-empty"><LoaderCircle size={26} className="spin"/></div>
  const input=(key:string,text:string)=><label>{text}<input type="number" min={0} disabled={!canManage} value={draft[key]??''} onChange={e=>setDraft({...draft,[key]:e.target.value})}/></label>
  return <section className="perf-report co-settings">
    <div className="perf-chart-card"><h3 className="perf-chart-title">分层规则</h3>
      <div className="shop-form-columns co-form">{input('level_platinum','白金客户：累计交易金额 ≥（元）')}{input('level_vip','VIP 客户：累计交易金额 ≥（元）')}{input('price_mid','一般价值：客单价 ≥（元）')}{input('price_high','高价值：客单价 ≥（元）')}{input('loyal_orders','忠诚客户：购买次数 ≥')}{input('default_cycle_days','只买过一次的客户，超期判断周期（天）')}</div>
      <label className="perf-toggle"><input type="checkbox" checked={overdueFollowup} disabled={!canManage} onChange={e=>setOverdueFollowup(e.target.checked)}/>超期未购的客户自动进入“待跟进”（写跟进或约定下次跟进时间后移出）</label>
      <Note>低于白金门槛为普通客户；客单价低于一般价值门槛为低价值；购买 1 次为新客户，2 次及以上为老客户。修改后立即生效。</Note>
      {canManage&&<button className="shop-button primary" disabled={busy} onClick={()=>void save()}><Save size={16}/>保存分层规则</button>}</div>
    <div className="perf-chart-card"><h3 className="perf-chart-title">通用标签</h3>
      <div className="co-chips">{tags.map(t=><span key={t.id} className="co-tag-item">{t.name}<small>{t.customers}</small>{canManage&&<button className="shop-icon" title={`删除标签 ${t.name}`} aria-label={`删除标签 ${t.name}`} onClick={()=>void deleteTag(t.id).then(()=>{setNotice('标签已删除');return reload()}).catch(cause=>setError(message(cause)))}><Trash2 size={14}/></button>}</span>)}{!tags.length&&<span className="perf-muted">暂无标签</span>}</div>
      {canUpdate&&<form className="co-newtag" onSubmit={e=>{e.preventDefault();if(newTag.trim())void createTag(newTag.trim()).then(()=>{setNewTag('');setNotice('标签已创建');return reload()}).catch(cause=>setError(message(cause)))}}><input aria-label="新标签名称" maxLength={30} placeholder="新标签名称" value={newTag} onChange={e=>setNewTag(e.target.value)}/><button className="shop-button">添加标签</button></form>}
    </div>
  </section>
}

const fileSize = (n:number) => n<1024*1024 ? `${Math.max(1,Math.round(n/1024))} KB` : `${(n/1024/1024).toFixed(1)} MB`
const readBase64 = (file:File) => new Promise<string>((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(String(r.result).split(',')[1]||'');r.onerror=()=>reject(new Error('读取文件失败'));r.readAsDataURL(file)})

/** Customer images and files: private storage, previews through short-lived links. */
function AttachmentsPanel({buyerId,canUpdate,changed,setError,setNotice}:{buyerId:string;canUpdate:boolean;changed:()=>void;setError:(t:string)=>void;setNotice:(t:string)=>void}) {
  const [items,setItems]=useState<Attachment[]|null>(null),[limits,setLimits]=useState<AttachmentLimits|null>(null),[busy,setBusy]=useState(false)
  const load=useCallback(async()=>{try{const r=await getAttachments(buyerId);setItems(r.data);setLimits(r.limits)}catch(cause){setItems([]);setError(message(cause))}},[buyerId,setError])
  useEffect(()=>{void load()},[load])
  async function upload(files:FileList|null){
    if(!files?.length||!limits)return
    setBusy(true);setError('')
    try{
      for(const file of Array.from(files)){
        const mime=attachmentMimes[file.name.split('.').pop()?.toLowerCase()??'']
        if(!mime)throw new Error(`不支持的文件类型：${file.name}`)
        const kind=mime.startsWith('image/')?'image':'file'
        if(file.size>limits[kind].bytes)throw new Error(`${file.name} 超过 ${fileSize(limits[kind].bytes)}`)
        await uploadAttachment(buyerId,{name:file.name.slice(0,120),mime,content:await readBase64(file)})
      }
      setNotice('附件已上传');changed()
    }catch(cause){setError(message(cause))}finally{setBusy(false);await load()}
  }
  async function remove(a:Attachment){if(!window.confirm(`删除附件“${a.name}”？删除后无法恢复。`))return;setBusy(true);try{await deleteAttachment(buyerId,a.id);setNotice('附件已删除');changed()}catch(cause){setError(message(cause))}finally{setBusy(false);await load()}}
  const images=(items??[]).filter(a=>a.kind==='image'),files=(items??[]).filter(a=>a.kind==='file')
  return <>
    <h3 className="perf-chart-title">附件（图片 {images.length}/{limits?.image.count??10} · 文件 {files.length}/{limits?.file.count??10}）</h3>
    {items==null?<div className="shop-empty"><LoaderCircle size={20} className="spin"/></div>:<>
      {images.length>0&&<div className="co-attach-images">{images.map(a=><figure key={a.id}><a href={a.url} target="_blank" rel="noreferrer noopener"><img src={a.url} alt={a.name} loading="lazy"/></a>
        <figcaption><span title={a.name}>{a.name}</span>{canUpdate&&<button className="shop-icon" title={`删除 ${a.name}`} aria-label={`删除附件 ${a.name}`} disabled={busy} onClick={()=>void remove(a)}><Trash2 size={14}/></button>}</figcaption></figure>)}</div>}
      {files.length>0&&<ul className="co-attach-files">{files.map(a=><li key={a.id}><FileText size={16}/><a href={a.url} rel="noreferrer noopener">{a.name}</a><small>{fileSize(a.size)} · {dateTime(a.created_at)}{a.created_by_name?` · ${a.created_by_name}`:''}</small>
        {canUpdate&&<button className="shop-icon" title={`删除 ${a.name}`} aria-label={`删除附件 ${a.name}`} disabled={busy} onClick={()=>void remove(a)}><Trash2 size={14}/></button>}</li>)}</ul>}
      {!items.length&&<p className="shop-note">暂无附件。</p>}
      {canUpdate&&<label className="shop-button co-attach-upload"><Paperclip size={15}/>{busy?'正在处理…':'上传图片或文件'}
        <input type="file" multiple hidden disabled={busy} accept={Object.keys(attachmentMimes).map(e=>`.${e}`).join(',')} onChange={e=>{void upload(e.target.files);e.target.value=''}}/></label>}
      <Note>图片支持 JPG/PNG/GIF/WebP，单张 ≤ 2MB；文件支持 PDF/Word/Excel/TXT/CSV，单个 ≤ 1MB；各最多 10 个。附件私有存储，链接 10 分钟内有效。</Note>
    </>}
  </>
}
