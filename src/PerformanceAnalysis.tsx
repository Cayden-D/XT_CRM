import { useEffect, useState, type ReactNode } from 'react'
import { ChevronLeft, ChevronRight, LoaderCircle, MessageSquareText, Search, ShieldAlert, Store, X } from 'lucide-react'
import { agentLabel } from './PerformanceReports'
import wangwangIcon from './assets/wangwang.png'
import OrderDrawer from './OrderDrawer'
import {
  attributionSchemeNames, availableSchemes, chatCategoryNames, creditBasisNames, flagNames, getChatDetail, getChatSessions, getCreditedOrders, getPerformanceAgents, getReplyQuality, OFFSITE_FLAGS, wangwangLinks,
  type AttributionScheme, type ChatCategory, type ChatDetail, type ChatSession, type CreditedOrder, type PerformanceAgent, type ReplyQuality,
} from './performanceApi'

const message = (cause:unknown) => cause instanceof Error ? cause.message : '操作未完成，请稍后重试。'
const clock = (value:string|null) => value ? new Date(value).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',second:'2-digit'}) : '—'
const dateTime = (value:string|null) => value ? new Date(value).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}) : '—'
const seconds = (value:number|null) => value==null ? '—' : value<60 ? `${value} 秒` : `${Math.floor(value/60)} 分 ${value%60} 秒`
const yuan = (value:number) => `¥${value.toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2})}`
const orderStatus:Record<string,string> = { waitbuyerpay:'待付款', waitsellersend:'待发货', waitbuyerreceive:'待收货', confirm_goods_but_not_fund:'已收货待到账', send_goods_but_not_fund:'已发货待到账', success:'交易成功', cancel:'已取消', terminated:'已终止', waitbuyerrepayment:'待还款' }

function Pager({page,setPage,more,loading}:{page:number;setPage:(update:(page:number)=>number)=>void;more:boolean;loading:boolean}) {
  return <div className="shop-pagination"><button className="shop-icon" title="上一页" disabled={loading||page===1} onClick={()=>setPage(p=>p-1)}><ChevronLeft size={17}/></button><span>第 {page} 页</span><button className="shop-icon" title="下一页" disabled={loading||!more} onClick={()=>setPage(p=>p+1)}><ChevronRight size={17}/></button></div>
}
export function Drawer({title,close,children}:{title:string;close:()=>void;children:ReactNode}) {
  useEffect(()=>{const escape=(event:KeyboardEvent)=>{if(event.key==='Escape')close()};window.addEventListener('keydown',escape);return()=>window.removeEventListener('keydown',escape)},[close])
  return <div className="dialog-layer shop-dialog"><button className="drawer-scrim" onClick={close} aria-label="关闭"/><section role="dialog" aria-modal="true" aria-label={title} className="shop-modal wide"><header><h2>{title}</h2><button title="关闭" onClick={close}><X size={18}/></button></header><div className="shop-modal-body">{children}</div></section></div>
}
// 1688 returns no content for "其他消息": pictures, stickers, product/order cards, auto-replies and system notices.
const OTHER_HINT='1688 不提供这类消息的内容：图片、表情、商品/订单卡片、自动回复或系统提示等'
const nonText=(m:ChatDetail['messages'][number])=>m.message_types.includes('其他消息')&&!m.length
/**
 * 旺旺联系: the window opens on the click itself (so it is not blocked as a popup) and is pointed at the 1688 chat once
 * the platform has decrypted the buyer for this one click. The buyer's nickname is never shown on our pages.
 */
export function WangwangButton({buyerId,setError,label}:{buyerId:string;setError:(text:string)=>void;label?:string}) {
  const [busy,setBusy]=useState(false)
  async function open(){
    const win=window.open('about:blank','_blank')
    // Without a window (popups blocked) nothing is decrypted: the platform allows decryption only to open a chat.
    if(!win)return setError('浏览器拦截了新窗口：请允许本站弹出窗口后再点「旺旺联系」。')
    win.document.title='正在打开旺旺…'
    setBusy(true)
    try{win.location.href=(await wangwangLinks(buyerId)).data.web}
    catch(cause){win.close();setError(message(cause))}finally{setBusy(false)}
  }
  return <button className={label?'shop-button':'shop-icon'} title="用旺旺联系买家" aria-label="用旺旺联系买家" disabled={busy} onClick={()=>void open()}>{busy?<LoaderCircle size={16} className="spin"/>:<img className="wangwang-icon" src={wangwangIcon} alt="" width={18} height={18}/>}{label}</button>
}

/** Message timeline of one session: buyer text is masked by the platform; agent text is shown masked, with risk flags. */
export function Timeline({data,focus}:{data:ChatDetail;focus?:string}) {
  return <><ol className="perf-timeline">{data.messages.map(m=><li key={m.uuid} className={`${m.direction===1?'buyer':'agent'} ${m.uuid===focus?'focus':''}`}>
    <time>{clock(m.sent_at)}</time><span>{m.text_masked?<q>{m.text_masked}</q>:`${m.direction===1?'买家':'客服'}${nonText(m)?'发送了图片/卡片等':`消息${m.length?`（${m.length} 字）`:''}`}`}</span>
    {m.message_types.filter(t=>t!=='正常消息').map(t=>t==='其他消息'?<em key={t} title={OTHER_HINT}>内容不可见</em>:<em key={t}>{t}</em>)}{m.keywords.map(k=><em key={k.word} className="keyword">{k.word}</em>)}
    {(m.flags??[]).filter(f=>f!=='short'&&f!=='image').map(f=><em key={f} className={(OFFSITE_FLAGS as readonly string[]).includes(f)?'risk':'keyword'}>{flagNames[f]??f}</em>)}</li>)}</ol>
  {!data.messages.length&&<p className="shop-note">该会话没有消息记录。</p>}</>
}

function useAgents(connectionId:string,setError:(text:string)=>void) {
  const [agents,setAgents]=useState<PerformanceAgent[]>([])
  useEffect(()=>{getPerformanceAgents(connectionId).then(r=>setAgents(r.data)).catch(cause=>setError(message(cause)))},[connectionId,setError])
  return agents
}

export function ChatAnalysisView({connectionId,from,to,setError}:{connectionId:string;from:string;to:string;setError:(text:string)=>void}) {
  const agents=useAgents(connectionId,setError)
  const [category,setCategory]=useState<ChatCategory|''>(''),[agentId,setAgentId]=useState(''),[page,setPage]=useState(1)
  const [rows,setRows]=useState<ChatSession[]>([]),[counts,setCounts]=useState<Partial<Record<ChatCategory,number>>>({}),[loading,setLoading]=useState(true)
  const [detail,setDetail]=useState<{row:ChatSession;data:ChatDetail}|null>(null),[order,setOrder]=useState('')
  useEffect(()=>{setPage(1)},[connectionId,from,to,category,agentId])
  useEffect(()=>{let live=true;setLoading(true)
    getChatSessions({connectionId,from,to,category:category||undefined,agentId:agentId||undefined,page}).then(r=>{if(live){setRows(r.data);setCounts(r.counts)}}).catch(cause=>live&&setError(message(cause))).finally(()=>live&&setLoading(false))
    return()=>{live=false}},[connectionId,from,to,category,agentId,page,setError])
  async function open(row:ChatSession){try{setDetail({row,data:(await getChatDetail(row.id)).data})}catch(cause){setError(message(cause))}}
  const total=Object.values(counts).reduce((a,b)=>a+(b||0),0)
  return <section className="perf-report" aria-label="聊天分析">
    <div className="perf-chart-head">
      <nav className="perf-metric-tabs" aria-label="聊天分类">{([['','全部',total],...(Object.keys(chatCategoryNames) as ChatCategory[]).map(c=>[c,chatCategoryNames[c],counts[c]||0])] as [ChatCategory|'',string,number][]).map(([id,label,n])=>
        <button key={id||'all'} aria-pressed={category===id} className={category===id?'active':''} onClick={()=>setCategory(id)}>{label} <span className="perf-count">{n}</span></button>)}</nav>
      <select className="perf-select" aria-label="筛选客服" value={agentId} onChange={e=>setAgentId(e.target.value)}><option value="">全部客服</option>{agents.map(a=><option key={a.id} value={a.id}>{agentLabel(a)}</option>)}</select>
    </div>
    {loading?<div className="shop-empty"><LoaderCircle size={26} className="spin"/><p>正在读取…</p></div>:<div className="shop-table-scroll"><table className="shop-table perf-table"><thead><tr><th>客服</th><th>日期</th><th>买家</th><th>分类</th><th>买家 / 客服消息</th><th>首次响应</th><th>未回复</th><th>相关订单</th><th/></tr></thead>
      <tbody>{rows.map(row=><tr key={row.id}><td><strong>{agentLabel(row)}</strong></td><td>{row.chat_date}<small>{clock(row.started_at)} 起</small></td><td>…{row.buyer_tail}{row.new_customer&&<small>新客</small>}</td>
        <td><span className={`shop-status ${row.category==='paid'?'positive':row.category==='no_order'?'':row.category==='after_sales'?'':'warning'}`}>{chatCategoryNames[row.category]}</span></td>
        <td>{row.buyer_messages} / {row.agent_messages}{row.other_agent_messages?<small>其他 {row.other_agent_messages}</small>:null}</td><td>{seconds(row.first_response_seconds)}</td><td>{row.unanswered||'—'}</td>
        <td>{row.orders_after?.length?row.orders_after.map(id=><small key={id}><button className="perf-order-link" title="查看订单详情" onClick={()=>setOrder(id)}>{id}</button>{row.paid_after?.includes(id)?' 已付款':''}</small>):'—'}</td>
        <td className="perf-row-actions"><WangwangButton buyerId={row.buyer_id} setError={setError}/><button className="shop-icon" title="查看消息记录" aria-label={`查看 ${row.chat_date} 会话`} onClick={()=>void open(row)}><ChevronRight size={17}/></button></td></tr>)}</tbody></table>
      {!rows.length&&<div className="shop-empty"><Store size={28}/><p>没有符合条件的会话</p></div>}</div>}
    <Pager page={page} setPage={setPage} more={rows.length===50} loading={loading}/>
    <p className="shop-note">分类按会话首轮买家消息后的归属窗口内是否下单、付款判断；售后指此前 90 天内有已付款订单。平台不提供买家消息原文，只显示时间与字数；客服消息显示遮盖了联系方式的文本（保留 90 天，文本采集上线前的消息没有文本）。</p>
    {detail&&<Drawer title={`${agentLabel(detail.row)} · ${detail.row.chat_date} · 买家 …${detail.row.buyer_tail}`} close={()=>setDetail(null)}>
      <div className="perf-drawer-actions"><WangwangButton buyerId={detail.row.buyer_id} setError={setError} label="旺旺联系买家"/>
        {detail.row.orders_after?.length?<span className="perf-drawer-orders">相关订单：{detail.row.orders_after.map(id=><button key={id} className="perf-order-link" onClick={()=>setOrder(id)}>{id}</button>)}</span>:null}</div>
      <Timeline data={detail.data}/>
    </Drawer>}
    {order&&<OrderDrawer connectionId={connectionId} orderId={order} close={()=>setOrder('')} setError={setError}/>}
  </section>
}

export function OrdersView({connectionId,from,to,setError}:{connectionId:string;from:string;to:string;setError:(text:string)=>void}) {
  const agents=useAgents(connectionId,setError)
  const [scheme,setScheme]=useState<AttributionScheme|''>(''),[agentId,setAgentId]=useState(''),[attributed,setAttributed]=useState<''|'yes'|'no'>(''),[search,setSearch]=useState(''),[orderId,setOrderId]=useState('')
  const [page,setPage]=useState(1),[rows,setRows]=useState<CreditedOrder[]>([]),[active,setActive]=useState<AttributionScheme>('order_first'),[pending,setPending]=useState(0),[loading,setLoading]=useState(true)
  useEffect(()=>{setPage(1)},[connectionId,from,to,scheme,agentId,attributed,orderId])
  useEffect(()=>{let live=true;setLoading(true)
    getCreditedOrders({connectionId,from,to,scheme:scheme||undefined,agentId:agentId||undefined,attributed:attributed||undefined,orderId:orderId||undefined,page})
      .then(r=>{if(live){setRows(r.data);setActive(r.scheme);setPending(r.pendingAttribution)}}).catch(cause=>live&&setError(message(cause))).finally(()=>live&&setLoading(false))
    return()=>{live=false}},[connectionId,from,to,scheme,agentId,attributed,orderId,page,setError])
  return <section className="perf-report" aria-label="订单归属">
    <div className="perf-chart-head perf-order-filters">
      <select className="perf-select" aria-label="归属方案" value={scheme} onChange={e=>setScheme(e.target.value as AttributionScheme|'')}><option value="">默认方案</option>{availableSchemes.map(s=><option key={s} value={s}>{attributionSchemeNames[s]}</option>)}</select>
      <select className="perf-select" aria-label="筛选客服" value={agentId} onChange={e=>setAgentId(e.target.value)}><option value="">全部客服</option>{agents.map(a=><option key={a.id} value={a.id}>{agentLabel(a)}</option>)}</select>
      <select className="perf-select" aria-label="归属状态" value={attributed} onChange={e=>setAttributed(e.target.value as ''|'yes'|'no')}><option value="">全部订单</option><option value="yes">已归属客服</option><option value="no">无咨询 / 未归属</option></select>
      <form className="shop-search" onSubmit={e=>{e.preventDefault();setOrderId(/^\d{1,30}$/.test(search.trim())?search.trim():'')}}><Search size={16}/><input aria-label="订单号" inputMode="numeric" placeholder="订单号" value={search} onChange={e=>{setSearch(e.target.value);if(!e.target.value)setOrderId('')}}/></form>
    </div>
    {pending>0&&<p className="shop-note">有 {pending} 个订单正在按新口径重新计算归属，稍后刷新。</p>}
    {loading?<div className="shop-empty"><LoaderCircle size={26} className="spin"/><p>正在读取…</p></div>:<div className="shop-table-scroll"><table className="shop-table perf-table"><thead><tr><th>订单号</th><th>下单 / 付款</th><th>商品</th><th>金额</th><th>状态</th><th>归属客服（{attributionSchemeNames[active].split('：')[0]}）</th></tr></thead>
      <tbody>{rows.map(o=><tr key={o.id}><td><code>{o.order_id}</code></td><td>{dateTime(o.placed_at)}<small>{o.paid_at?`付款 ${dateTime(o.paid_at)}`:'未付款'}</small></td>
        <td className="perf-items">{o.items.slice(0,2).map((item,i)=><small key={i}>{item.name} × {item.quantity}</small>)}{o.items.length>2&&<small>等 {o.items.length} 件</small>}</td>
        <td>{yuan(o.total_amount)}{o.refunded>0&&<small>退款 {yuan(o.refunded)}</small>}</td><td>{orderStatus[o.status]||o.status}</td>
        <td>{o.credits.length?o.credits.map(c=><div key={c.agent_id} className="perf-credit"><strong>{agentLabel(c)}</strong>{c.share<1&&<span>{Math.round(c.share*100)}%</span>}<small>{creditBasisNames[c.basis]}{c.basis_at?` ${dateTime(c.basis_at)}`:''}</small></div>):<span className="perf-muted">无咨询记录</span>}</td></tr>)}</tbody></table>
      {!rows.length&&<div className="shop-empty"><Store size={28}/><p>没有符合条件的订单</p></div>}</div>}
    <Pager page={page} setPage={setPage} more={rows.length===50} loading={loading}/>
    <p className="shop-note">归属依据为买家在归属窗口内收到的最后一条人工回复；“无咨询记录”表示下单前窗口内没有聊天（直接下单或聊天早于已同步范围）。切换方案仅用于对比，默认方案在“指标口径”中由财务设置。</p>
  </section>
}

const pct = (value:number|null) => value==null ? '—' : `${Math.round(value*100)}%`
/** 回复质量: agent reply length, one-word replies, pictures, curt wording, and off-platform trading alerts. */
export function QualityView({connectionId,from,to,setError}:{connectionId:string;from:string;to:string;setError:(text:string)=>void}) {
  const [data,setData]=useState<ReplyQuality|null>(null),[loading,setLoading]=useState(true),[detail,setDetail]=useState<{title:string;focus:string;data:ChatDetail}|null>(null)
  useEffect(()=>{setLoading(true);getReplyQuality(connectionId,from,to).then(r=>setData(r.data)).catch(cause=>setError(message(cause))).finally(()=>setLoading(false))},[connectionId,from,to,setError])
  async function open(sessionId:string,focus:string,title:string){try{setDetail({title,focus,data:(await getChatDetail(sessionId)).data})}catch(cause){setError(message(cause))}}
  if(loading&&!data)return <div className="shop-empty"><LoaderCircle size={26} className="spin"/><p>正在读取…</p></div>
  if(!data)return null
  const captured=data.agents.reduce((n,a)=>n+a.text_replies,0)
  const avg=captured?data.agents.reduce((n,a)=>n+(a.avg_chars??0)*a.text_replies,0)/captured:null
  const short=captured?data.agents.reduce((n,a)=>n+a.short_replies,0)/captured:null
  return <section className="perf-report" aria-label="回复质量">
    <div className="perf-quality-kpis">
      <article className={data.totals.offsite?'warn':''}><span><ShieldAlert size={15}/>站外交易风险</span><strong>{data.totals.offsite}</strong><small>客服发出手机号、微信、QQ、外部链接或站外付款用语</small></article>
      <article><span>平均回复字数</span><strong>{avg==null?'—':avg.toFixed(1)}</strong><small>不含链接、标点与图片</small></article>
      <article><span>极短回复占比</span><strong>{pct(short)}</strong><small>“嗯 / 是的 / 好” 等 3 字以内</small></article>
      <article><span>文本覆盖率</span><strong>{pct(data.coverage)}</strong><small>本期客服消息中已采集文本的比例</small></article>
    </div>
    {data.coverage!=null&&data.coverage<.8&&<p className="shop-note">客服消息文本从本版本开始随同步采集，此前已同步的消息没有文本；覆盖率较低时，各项指标仅供参考。</p>}
    <div className="shop-table-scroll"><table className="shop-table"><thead><tr><th>客服</th><th>人工消息</th><th>平均字数</th><th>极短回复</th><th>图片/卡片</th><th>生硬用语</th><th>站外风险</th></tr></thead>
      <tbody>{data.agents.map(a=><tr key={a.agent_id}><td><strong>{agentLabel({login_id:a.login_id,is_main:a.is_main} as PerformanceAgent)}</strong>{a.user_name&&<small>{a.user_name}</small>}</td>
        <td>{a.messages}{a.captured<a.messages&&<small>{a.captured} 条有文本</small>}</td><td>{a.avg_chars??'—'}</td><td>{a.text_replies?pct(a.short_replies/a.text_replies):'—'}</td><td>{a.images}</td>
        <td>{a.curt?<span className="shop-status warning">{a.curt}</span>:'0'}</td><td>{a.offsite?<span className="shop-status warning">{a.offsite}</span>:<span className="shop-status positive">0</span>}</td></tr>)}</tbody></table>
      {!data.agents.length&&<div className="shop-empty"><Store size={28}/><p>本期没有客服消息</p></div>}</div>
    <h3 className="perf-chart-title"><ShieldAlert size={17}/>站外交易风险记录</h3>
    {data.risks.length?<div className="shop-table-scroll"><table className="shop-table"><thead><tr><th>时间</th><th>客服</th><th>买家</th><th>风险</th><th>客服消息（已遮盖）</th><th/></tr></thead>
      <tbody>{data.risks.map(r=><tr key={r.uuid}><td>{dateTime(r.sent_at)}</td><td>{r.login_id.split(':').pop()}</td><td>{r.buyer_name??`买家 …${r.buyer_tail}`}</td>
        <td>{r.flags.filter(f=>(OFFSITE_FLAGS as readonly string[]).includes(f)).map(f=><span key={f} className="shop-status warning" style={{marginRight:4}}>{flagNames[f]}</span>)}</td>
        <td className="perf-quote">{r.text_masked??'—'}</td>
        <td><button className="shop-icon" title="查看会话" aria-label={`查看 ${r.chat_date} 会话`} onClick={()=>void open(r.session_id,r.uuid,`${r.login_id.split(':').pop()} · ${r.chat_date} · ${r.buyer_name??`买家 …${r.buyer_tail}`}`)}><MessageSquareText size={16}/></button></td></tr>)}</tbody></table></div>
      :<p className="shop-note">本期没有发现客服发送联系方式、外部链接或站外付款用语。</p>}
    {data.curt.length>0&&<><h3 className="perf-chart-title">生硬用语（供复盘参考）</h3><ul className="perf-quote-list">{data.curt.slice(0,12).map(c=><li key={c.uuid}><time>{dateTime(c.sent_at)}</time><b>{c.login_id.split(':').pop()}</b><q>{c.text_masked}</q>
      <button className="shop-icon" title="查看会话" aria-label="查看会话" onClick={()=>void open(c.session_id,c.uuid,`${c.login_id.split(':').pop()} · 会话记录`)}><MessageSquareText size={15}/></button></li>)}</ul></>}
    <p className="shop-note">检测规则：手机号、带“微信 / VX / QQ”的账号、“加微信”“微信同号”等邀请、“微信转账 / 私下交易 / 不走平台”等用语、1688 / 淘宝 / 阿里系以外的链接。手机号、微信号、QQ 号及 6 位以上数字在保存前已遮盖，文本保留 90 天。生硬用语与极短回复只作复盘提示，不计入绩效。</p>
    {detail&&<Drawer title={detail.title} close={()=>setDetail(null)}><Timeline data={detail.data} focus={detail.focus}/></Drawer>}
  </section>
}
