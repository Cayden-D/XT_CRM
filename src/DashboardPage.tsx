import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { AlertCircle, ArrowDownRight, ArrowUpRight, ChevronRight, Clock3, LoaderCircle, MessageSquareWarning, PackageX, RefreshCw, ShoppingCart, Store, UserRoundCheck, UsersRound, ShieldAlert } from 'lucide-react'
import type { SessionUser } from './api'
import { useAiFocusPart } from './aiFocus'
import { getDashboard, type Dashboard, type DashboardRange, type PeriodTotals } from './dashboardApi'

export type DashboardTarget = { page:'customerOps'; view:'list'|'pool'|'due' } | { page:'performance'; view:'comparison'|'chats'|'quality'|'keywords'|'orders' } | { page:'queue' } | { page:'shop' }

const message = (cause:unknown) => cause instanceof Error ? cause.message : '看板数据暂时无法加载。'
const yuan = (v:number) => `¥${v.toLocaleString('zh-CN',{minimumFractionDigits:0,maximumFractionDigits:0})}`
const compact = (v:number) => v>=10000 ? `${(v/10000).toLocaleString('zh-CN',{maximumFractionDigits:1})}万` : v.toLocaleString('zh-CN',{maximumFractionDigits:0})
const percent = (v:number|null) => v==null ? '—' : `${(v*100).toLocaleString('zh-CN',{maximumFractionDigits:1})}%`
const seconds = (v:number|null) => v==null ? '—' : v<60 ? `${v} 秒` : v<3600 ? `${Math.floor(v/60)} 分 ${v%60} 秒` : `${Math.floor(v/3600)} 时 ${Math.round(v%3600/60)} 分`
const time = (v:string|null) => v ? new Date(v).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}) : '—'
const day = (iso:string) => iso.slice(5).replace('-','/')
const ranges:[DashboardRange,string][] = [['today','今天'],['7d','近 7 天'],['30d','近 30 天']]

/** Change against the comparison period; `goodWhenUp` decides whether a rise is shown as good. */
function Delta({now,before,goodWhenUp=true,label}:{now:number|null;before:number|null;goodWhenUp?:boolean;label:string}) {
  if (now==null || before==null || before===0) return <small className="dash-delta">{label}：—</small>
  const change = (now-before)/Math.abs(before)
  const up = change>0, good = change===0 ? null : up===goodWhenUp
  return <small className={`dash-delta ${good==null?'':good?'good':'bad'}`}>{up?<ArrowUpRight size={13}/>:<ArrowDownRight size={13}/>}{label} {up?'+':''}{(change*100).toLocaleString('zh-CN',{maximumFractionDigits:1})}%</small>
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null), [width,setWidth] = useState(0)
  useLayoutEffect(() => {
    if (!ref.current) return
    const observer = new ResizeObserver(entries => setWidth(Math.floor(entries[0].contentRect.width)))
    observer.observe(ref.current)
    return () => observer.disconnect()
  }, [])
  return [ref, width] as const
}
function niceMax(v:number) { if (v<=0) return 1; const p = 10**Math.floor(Math.log10(v)), n = v/p; return (n<=1?1:n<=2?2:n<=5?5:10)*p }

/** Single-series daily bars: one hue, thin marks with rounded data ends, recessive grid, hover tooltip. */
function BarTrend({title,points,format,detail}:{title:string;points:{date:string;value:number}[];format:(v:number)=>string;detail:(i:number)=>string}) {
  const [ref,width] = useWidth<HTMLDivElement>(), [hover,setHover] = useState<number|null>(null)
  const height = 190, left = 44, bottom = 22, top = 8, plotW = Math.max(0, width-left-4), plotH = height-top-bottom
  const max = niceMax(Math.max(...points.map(p=>p.value),0)), step = points.length ? plotW/points.length : 0, bar = Math.max(2, Math.min(28, step-2))
  const labelEvery = Math.ceil(points.length/(width<420?5:8))
  return <div className="dash-chart" ref={ref}>
    <h3>{title}</h3>
    {width>0 && <svg width={width} height={height} role="img" aria-label={`${title}，共 ${points.length} 天`}>
      {[0,.5,1].map(f => <g key={f}><line x1={left} x2={width-4} y1={top+plotH*(1-f)} y2={top+plotH*(1-f)} className="dash-grid"/><text x={left-6} y={top+plotH*(1-f)+4} textAnchor="end" className="dash-axis">{compact(max*f)}</text></g>)}
      {points.map((p,i) => {
        const h = p.value>0 ? Math.max(2, p.value/max*plotH) : 0, x = left+i*step+(step-bar)/2, y = top+plotH-h, r = Math.min(4, h, bar/2)
        return <g key={p.date}>
          {h>0 && <path className={hover===i?'dash-bar active':'dash-bar'} d={`M${x},${top+plotH} V${y+r} Q${x},${y} ${x+r},${y} H${x+bar-r} Q${x+bar},${y} ${x+bar},${y+r} V${top+plotH} Z`}/>}
          {i%labelEvery===0 && <text x={left+i*step+step/2} y={height-6} textAnchor="middle" className="dash-axis">{day(p.date)}</text>}
          <rect x={left+i*step} y={top} width={step} height={plotH} fill="transparent" onMouseEnter={()=>setHover(i)} onMouseLeave={()=>setHover(null)}/>
        </g>
      })}
    </svg>}
    {hover!=null && points[hover] && <div className="dash-tooltip" style={{left:Math.min(width-150, Math.max(0,left+hover*step+step/2-75))}}><b>{points[hover].date}</b><span>{format(points[hover].value)}</span><small>{detail(hover)}</small></div>}
    <details className="dash-table-toggle"><summary>查看数据表</summary><table><thead><tr><th>日期</th><th>{title}</th></tr></thead><tbody>{points.map((p,i)=><tr key={p.date}><td>{p.date}</td><td>{format(p.value)}<small> · {detail(i)}</small></td></tr>)}</tbody></table></details>
  </div>
}

function Kpis({current,previous,today,firstResponse,unanswered}:{current:PeriodTotals;previous:PeriodTotals;today:boolean;firstResponse:number|null;unanswered:number}) {
  const vs = today ? '较昨日全天' : '较上期'
  return <section className="dash-kpis" aria-label="关键指标">
    <article><span>净成交额</span><strong>{yuan(current.netAmount)}</strong><small>付款 {yuan(current.paidAmount)} − 退款 {yuan(current.refundAmount)}</small><Delta now={current.netAmount} before={previous.netAmount} label={vs}/></article>
    <article><span>付款订单</span><strong>{current.paidOrders.toLocaleString('zh-CN')}</strong><small>{current.paidBuyers} 位买家</small><Delta now={current.paidOrders} before={previous.paidOrders} label={vs}/></article>
    <article><span>退款成功</span><strong>{yuan(current.refundAmount)}</strong><small>{current.refunds} 笔（含退运费）</small><Delta now={current.refundAmount} before={previous.refundAmount} goodWhenUp={false} label={vs}/></article>
    <article><span>接待人次</span><strong>{current.reception.toLocaleString('zh-CN')}</strong><small>{current.inquired} 位买家咨询</small><Delta now={current.reception} before={previous.reception} label={vs}/></article>
    <article><span>咨询转化率</span><strong>{percent(current.conversionRate)}</strong><small>{current.converted} 位咨询后下单并付款</small><Delta now={current.conversionRate} before={previous.conversionRate} label={vs}/></article>
    <article><span>平均首次响应</span><strong>{seconds(firstResponse)}</strong><small>按工作时段计 · {unanswered} 次超时未回复</small></article>
  </section>
}

export default function DashboardPage({user,go}:{user:SessionUser;go:(target:DashboardTarget)=>void}) {
  const [range,setRange] = useState<DashboardRange>('7d'), [shop,setShop] = useState(''), [data,setData] = useState<Dashboard|null>(null), [loading,setLoading] = useState(true), [error,setError] = useState('')
  useAiFocusPart({ connectionId: shop || undefined })
  const load = useCallback(async()=>{setLoading(true);setError('');try{const r=(await getDashboard(range,shop||undefined)).data;setData(r);if(!shop&&r.connectionId)setShop(r.connectionId)}catch(cause){setError(message(cause))}finally{setLoading(false)}},[range,shop])
  useEffect(()=>{void load()},[load])
  if (error) return <section className="state-card error-state"><AlertCircle size={25}/><h2>看板数据暂时无法加载</h2><p>{error}</p><button onClick={()=>void load()}><RefreshCw size={15}/>重新加载</button></section>
  if (!data) return <section className="state-card"><LoaderCircle className="spin" size={27}/><p>正在汇总经营数据…</p></section>
  const { kpis, trend, service, customers, listings, sync, buyerMix } = data
  const notes:string[] = []
  const historyFrom = sync ? new Date(Date.now()+8*3_600_000-(sync.history_days-1)*86_400_000).toISOString().slice(0,10) : null
  if (historyFrom && data.previous.from < historyFrom) notes.push(`对比期超出历史数据范围（近 ${sync!.history_days} 天，可在“客服绩效 → 客服账号”调整），环比仅供参考`)
  else if (sync?.orders_synced_from && data.previous.from < new Date(new Date(sync.orders_synced_from).getTime()+8*3_600_000).toISOString().slice(0,10)) notes.push('对比期的订单尚未完全同步，环比仅供参考')
  if (sync && sync.pending_sessions>0) notes.push(`${sync.pending_sessions.toLocaleString('zh-CN')} 个会话的消息仍在补齐，历史接待与转化会偏低`)
  const throttled = sync?.last_run?.status==='failed' && sync.last_run.errorCode?.startsWith('gw.Qos')
  const mixTotal = (buyerMix?.first_time??0)+(buyerMix?.returning??0)
  const blocked = listings?.queue.blocked ?? 0
  const todos = [
    customers && { key:'due', icon:<Clock3 size={17}/>, label:'待跟进客户', value:customers.due, note:customers.due_overdue?`其中 ${customers.due_overdue} 位超期未购`:'今天到期的跟进计划', go:{page:'customerOps',view:'due'} as DashboardTarget },
    customers && { key:'unpaid', icon:<ShoppingCart size={17}/>, label:'下单未付款', value:customers.unpaid, note:`待付 ${yuan(customers.unpaid_amount)}`, go:{page:'customerOps',view:'pool'} as DashboardTarget },
    customers && { key:'noorder', icon:<UsersRound size={17}/>, label:'近 7 天咨询未下单', value:customers.recent_no_order, note:'趁热跟进转化', go:{page:'customerOps',view:'pool'} as DashboardTarget },
    service && service.keywordAlerts > 0 && { key:'keywords', icon:<MessageSquareWarning size={17}/>, label:'买家提到退款/投诉', value:service.keywordAlerts, note:'命中“售后退款”“投诉差评”关键词的会话', go:{page:'performance',view:'keywords'} as DashboardTarget },
    service && service.offsiteRisks > 0 && { key:'offsite', icon:<ShieldAlert size={17}/>, label:'站外交易风险', value:service.offsiteRisks, note:'客服发出联系方式、外部链接或站外付款用语', go:{page:'performance',view:'quality'} as DashboardTarget },
    service && { key:'unanswered', icon:<MessageSquareWarning size={17}/>, label:'超时未回复', value:service.unanswered, note:'本期超过未回复阈值的应答', go:{page:'performance',view:'comparison'} as DashboardTarget },
    listings && { key:'blocked', icon:<PackageX size={17}/>, label:'上架受阻商品', value:blocked, note:listings.blockedReasons[0]?.reason ?? '无', go:{page:'queue'} as DashboardTarget },
  ].filter(Boolean) as {key:string;icon:ReactNode;label:string;value:number;note:string;go:DashboardTarget}[]

  return <div className="dash">
    <div className="dash-toolbar">
      <div className="perf-metric-tabs" role="tablist" aria-label="时间范围">{ranges.map(([id,text])=><button key={id} role="tab" aria-selected={range===id} className={range===id?'active':''} onClick={()=>setRange(id)}>{text}</button>)}</div>
      {data.shops.length>0 && <label className="dash-shop"><Store size={16}/><select className="perf-select" aria-label="店铺" value={shop} onChange={e=>setShop(e.target.value)}>{data.shops.map(s=><option key={s.id} value={s.id}>{s.display_name||'店铺'}{s.status==='connected'?'':' · 已停用'}</option>)}</select></label>}
      <span className="dash-period">{data.period.from===data.period.to?data.period.from:`${data.period.from} 至 ${data.period.to}`}</span>
      {sync && <span className={`shop-status ${throttled?'warning':'positive'}`} title={throttled?'开发测试阶段应用流量为 5000 次/天，上线后 10 万次/天；进度已保存，次日自动继续':undefined}>{throttled?'今日平台调用额度已用完 · ':'已同步 · '}最近成功 {time(sync.last_success)}</span>}
      {loading && <LoaderCircle className="spin" size={16}/>}
    </div>
    {notes.length>0 && <p className="dash-note"><AlertCircle size={15}/>{notes.join('；')}。</p>}
    {!data.connectionId && <section className="state-card"><UserRoundCheck size={26}/><h2>尚未连接 1688 绩效应用</h2><p>在“客服绩效 → 绩效应用授权”完成授权后，这里会显示成交、接待与客户数据。</p></section>}
    {kpis && <Kpis current={kpis.current} previous={kpis.previous} today={range==='today'} firstResponse={service?.firstResponseSeconds??null} unanswered={service?.unanswered??0}/>}
    {trend && trend.length>0 && <section className="dash-grid2">
      <BarTrend title={range==='today'?'每日成交额（近 30 天）':'每日成交额'} points={trend.map(t=>({date:t.date,value:t.paid_amount}))} format={yuan} detail={i=>`${trend[i].paid_orders} 笔付款订单`}/>
      <BarTrend title={range==='today'?'每日接待人数（近 30 天）':'每日接待人数'} points={trend.map(t=>({date:t.date,value:t.reception}))} format={v=>`${v} 人`} detail={i=>`${trend[i].paid_orders} 笔当日付款`}/>
    </section>}
    <section className="dash-grid3">
      {todos.length>0 && <div className="dash-card"><h3>待处理</h3><ul className="dash-todos">{todos.map(t=><li key={t.key}><button onClick={()=>go(t.go)}>{t.icon}<span><b>{t.label}</b><small>{t.note}</small></span><strong>{t.value.toLocaleString('zh-CN')}</strong><ChevronRight size={15}/></button></li>)}</ul></div>}
      {service && <div className="dash-card"><div className="dash-card-head"><h3>客服表现</h3><button className="dash-link" onClick={()=>go({page:'performance',view:'comparison'})}>客服对比<ChevronRight size={14}/></button></div>
        {service.agents.length?<div className="shop-table-scroll"><table className="dash-table"><thead><tr><th>客服</th><th>接待</th><th>付款买家</th><th>绩效销售额</th><th>首次响应</th></tr></thead>
          <tbody>{service.agents.map(a=><tr key={a.agentId}><td><b>{a.userName||(a.isMain?'主账号':a.loginId.split(':').pop())}</b></td><td>{a.reception}</td><td>{a.paidBuyers}</td><td>{yuan(a.paidAmount)}</td><td>{seconds(a.firstResponseSeconds)}</td></tr>)}</tbody></table></div>
          :<p className="shop-note">本期暂无接待数据。</p>}
        <p className="shop-note">绩效销售额按默认绩效方案归属；首次响应按工作时段计算。</p></div>}
      {customers && <div className="dash-card"><div className="dash-card-head"><h3>客户结构</h3><button className="dash-link" onClick={()=>go({page:'customerOps',view:'list'})}>客户经营<ChevronRight size={14}/></button></div>
        {buyerMix && mixTotal>0 && <><p className="dash-mix-title">本期付款买家 {mixTotal.toLocaleString('zh-CN')} 位</p>
          <div className="dash-stack" role="img" aria-label={`首次购买 ${buyerMix.first_time} 位，复购 ${buyerMix.returning} 位`}><span className="first" style={{flexGrow:buyerMix.first_time}}/><span className="repeat" style={{flexGrow:buyerMix.returning}}/></div>
          <div className="dash-legend"><span><i className="first"/>首次购买 {buyerMix.first_time}（{percent(buyerMix.first_time/mixTotal)}）</span><span><i className="repeat"/>复购 {buyerMix.returning}（{percent(buyerMix.returning/mixTotal)}）</span></div></>}
        <dl className="dash-facts">
          <div><dt>线上客户</dt><dd>{customers.total.toLocaleString('zh-CN')}</dd></div>
          <div><dt>已购买客户</dt><dd>{customers.buyers.toLocaleString('zh-CN')}</dd></div>
          <div><dt>复购客户占比</dt><dd>{percent(customers.buyers?customers.repeat_buyers/customers.buyers:null)}</dd></div>
          <div><dt>超期未购</dt><dd>{customers.overdue.toLocaleString('zh-CN')}</dd></div>
        </dl>
        <p className="shop-note">购买统计基于已同步的订单，历史补齐后更准确。</p></div>}
    </section>
    {listings && <section className="dash-card"><div className="dash-card-head"><h3>商品上架</h3><button className="dash-link" onClick={()=>go({page:'queue'})}>上架队列<ChevronRight size={14}/></button></div>
      <ol className="dash-funnel">
        <li><span>已采集</span><strong>{listings.collected}</strong></li>
        <li className={blocked?'warn':''}><span>队列受阻</span><strong>{blocked}</strong></li>
        <li><span>发布草稿</span><strong>{listings.drafts}</strong></li>
        <li><span>店铺在售</span><strong>{listings.listings.published ?? 0}</strong></li>
        {(listings.listings['member expired'] ?? 0)>0 && <li className="warn"><span>会员过期下架</span><strong>{listings.listings['member expired']}</strong></li>}
      </ol>
      {listings.blockedReasons.length>0 && <ul className="dash-reasons">{listings.blockedReasons.map(r=><li key={r.reason}><span>{r.reason}</span><b>{r.n}</b></li>)}</ul>}
    </section>}
    {!kpis && !customers && !listings && <section className="state-card"><UserRoundCheck size={26}/><h2>暂无可查看的看板数据</h2><p>{user.displayName}，当前账号没有客服绩效、客户经营或店铺的查看权限，请联系管理员开通。</p></section>}
  </div>
}
