import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { AlertCircle, ArrowDownRight, ArrowUpRight, CheckCircle2, ChevronRight, Clock3, LoaderCircle, MessageSquareWarning, PackageX, RefreshCw, ShoppingCart, Store, UserRoundCheck, UsersRound, ShieldAlert } from 'lucide-react'
import type { SessionUser } from './api'
import { useAiFocusPart } from './aiFocus'
import { getDashboard, type Dashboard, type DashboardRange } from './dashboardApi'
import { navigate } from './navigation'
import { NeedShop, Note } from './ui'


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
  if (now==null || before==null || before===0) return <small className="dash-delta">—</small>
  const change = (now-before)/Math.abs(before)
  const up = change>0, good = change===0 ? null : up===goodWhenUp
  return <small className={`dash-delta ${good==null?'':good?'good':'bad'}`} title={label}>{up?<ArrowUpRight size={13}/>:<ArrowDownRight size={13}/>}{up?'+':''}{(change*100).toLocaleString('zh-CN',{maximumFractionDigits:1})}%</small>
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
  const height = 220, left = 44, bottom = 22, top = 8, plotW = Math.max(0, width-left-4), plotH = height-top-bottom
  const max = niceMax(Math.max(...points.map(p=>p.value),0)), step = points.length ? plotW/points.length : 0, bar = Math.max(2, Math.min(28, step-2))
  const labelEvery = Math.ceil(points.length/(width<420?5:8))
  if (!points.some(p=>p.value>0)) return <div className="home-chart" ref={ref}><p className="home-chart-empty">本期没有数据</p></div>
  return <div className="home-chart" ref={ref}>
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

type Todo = { key:string; icon:ReactNode; label:string; value:number; go:string; urgent?:boolean; title?:string }

function Stat({label,value,children,detail}:{label:string;value:string;children?:ReactNode;detail?:string}) {
  return <div className="home-stat" title={detail}><span>{label}</span><strong>{value}</strong>{children}</div>
}

export default function DashboardPage({user}:{user:SessionUser}) {
  const [range,setRange] = useState<DashboardRange>('7d'), [shop,setShop] = useState(''), [metric,setMetric] = useState<'paid'|'reception'>('paid'), [data,setData] = useState<Dashboard|null>(null), [loading,setLoading] = useState(true), [error,setError] = useState('')
  useAiFocusPart({ connectionId: shop || undefined })
  const load = useCallback(async()=>{setLoading(true);setError('');try{const r=(await getDashboard(range,shop||undefined)).data;setData(r);if(!shop&&r.connectionId)setShop(r.connectionId)}catch(cause){setError(message(cause))}finally{setLoading(false)}},[range,shop])
  useEffect(()=>{void load()},[load])
  if (error) return <section className="state-card error-state"><AlertCircle size={25}/><h2>数据暂时无法加载</h2><p>{error}</p><button onClick={()=>void load()}><RefreshCw size={15}/>重新加载</button></section>
  if (!data) return <section className="state-card"><LoaderCircle className="spin" size={27}/></section>
  const { kpis, trend, service, customers, listings, sync, buyerMix } = data
  const notes:string[] = []
  const historyFrom = sync ? new Date(Date.now()+8*3_600_000-(sync.history_days-1)*86_400_000).toISOString().slice(0,10) : null
  if (historyFrom && data.previous.from < historyFrom) notes.push(`对比期超出历史数据范围（近 ${sync!.history_days} 天，可在“设置 → 客服账号”调整）`)
  else if (sync?.orders_synced_from && data.previous.from < new Date(new Date(sync.orders_synced_from).getTime()+8*3_600_000).toISOString().slice(0,10)) notes.push('对比期的订单尚未完全同步')
  if (sync && sync.pending_sessions>0) notes.push(`${sync.pending_sessions.toLocaleString('zh-CN')} 个会话的消息仍在补齐，历史接待与转化会偏低`)
  const throttled = sync?.last_run?.status==='failed' && sync.last_run.errorCode?.startsWith('gw.Qos')
  const mixTotal = (buyerMix?.first_time??0)+(buyerMix?.returning??0)
  const blocked = listings?.queue.blocked ?? 0
  const all:(Todo|null|undefined|false)[] = [
    service && { key:'offsite', icon:<ShieldAlert size={16}/>, label:'站外交易风险', value:service.offsiteRisks, go:'performance/quality', urgent:true, title:'客服发出联系方式、外部链接或站外付款用语' },
    service && { key:'keywords', icon:<MessageSquareWarning size={16}/>, label:'退款 / 投诉', value:service.keywordAlerts, go:'performance/keywords', urgent:true, title:'命中“售后退款”“投诉差评”关键词的会话' },
    service && { key:'unanswered', icon:<MessageSquareWarning size={16}/>, label:'超时未回复', value:service.unanswered, go:'performance/comparison', urgent:true },
    customers && { key:'due', icon:<Clock3 size={16}/>, label:'待跟进客户', value:customers.due, go:'customers/due', title:customers.due_overdue?`其中 ${customers.due_overdue} 位超期未购`:undefined },
    customers && { key:'unpaid', icon:<ShoppingCart size={16}/>, label:'下单未付款', value:customers.unpaid, go:'customers/pool', title:`待付 ${yuan(customers.unpaid_amount)}` },
    customers && { key:'noorder', icon:<UsersRound size={16}/>, label:'咨询未下单', value:customers.recent_no_order, go:'customers/pool', title:'近 7 天' },
    listings && { key:'blocked', icon:<PackageX size={16}/>, label:'上架受阻', value:blocked, go:'products/queue', urgent:true, title:listings.blockedReasons[0]?.reason },
  ]
  const todos = (all.filter(Boolean) as Todo[]).filter(t=>t.value>0)
  const vs = range==='today' ? '较昨日全天' : '较上期'
  const nothing = !kpis && !customers && !listings

  return <div className="home">
    <div className="home-toolbar">
      <div className="perf-metric-tabs" role="tablist" aria-label="时间范围">{ranges.map(([id,text])=><button key={id} role="tab" aria-selected={range===id} className={range===id?'active':''} onClick={()=>setRange(id)}>{text}</button>)}</div>
      {data.shops.length>1 && <label className="shop-select"><Store size={16}/><select aria-label="店铺" value={shop} onChange={e=>setShop(e.target.value)}>{data.shops.map(s=><option key={s.id} value={s.id}>{s.display_name||'店铺'}{s.status==='connected'?'':' · 已停用'}</option>)}</select></label>}
      {loading && <LoaderCircle className="spin" size={16}/>}
      <span className="home-sync">
        {notes.length>0 && <Note label="环比仅供参考">{notes.join('；')}。</Note>}
        {sync && <span className={throttled?'warn':''} title={throttled?'今日平台调用额度已用完，进度已保存，次日自动继续':undefined}><i/>{throttled?'额度已用完 · ':'已同步 · '}{time(sync.last_success)}</span>}
      </span>
    </div>

    {!data.connectionId && !nothing && <NeedShop text="还没有授权绩效应用"/>}

    {(customers||service||listings) && (todos.length
      ? <section className="home-todos" aria-label="待处理">{todos.map(t=><button key={t.key} className={t.urgent?'urgent':''} title={t.title} onClick={()=>navigate(t.go)}><strong>{t.value.toLocaleString('zh-CN')}</strong><span>{t.icon}{t.label}</span></button>)}</section>
      : <p className="home-clear"><CheckCircle2 size={17}/>没有待处理的事项</p>)}

    {kpis && <section className="home-main">
      <div className="home-hero">
        <div className="home-hero-top">
          <div title={`付款 ${yuan(kpis.current.paidAmount)} − 退款 ${yuan(kpis.current.refundAmount)}`}><span>净成交额</span><strong>{yuan(kpis.current.netAmount)}</strong><Delta now={kpis.current.netAmount} before={kpis.previous.netAmount} label={vs}/></div>
          {trend && trend.length>0 && <div className="perf-metric-tabs" aria-label="趋势指标"><button className={metric==='paid'?'active':''} aria-pressed={metric==='paid'} onClick={()=>setMetric('paid')}>成交额</button><button className={metric==='reception'?'active':''} aria-pressed={metric==='reception'} onClick={()=>setMetric('reception')}>接待人数</button></div>}
        </div>
        {trend && trend.length>0 && (metric==='paid'
          ? <BarTrend title="每日成交额" points={trend.map(t=>({date:t.date,value:t.paid_amount}))} format={yuan} detail={i=>`${trend[i].paid_orders} 笔付款订单`}/>
          : <BarTrend title="每日接待人数" points={trend.map(t=>({date:t.date,value:t.reception}))} format={v=>`${v} 人`} detail={i=>`${trend[i].paid_orders} 笔当日付款`}/>)}
      </div>
      <div className="home-stats">
        <Stat label="付款订单" value={kpis.current.paidOrders.toLocaleString('zh-CN')} detail={`${kpis.current.paidBuyers} 位买家`}><Delta now={kpis.current.paidOrders} before={kpis.previous.paidOrders} label={vs}/></Stat>
        <Stat label="退款" value={yuan(kpis.current.refundAmount)} detail={`${kpis.current.refunds} 笔（含退运费）`}><Delta now={kpis.current.refundAmount} before={kpis.previous.refundAmount} goodWhenUp={false} label={vs}/></Stat>
        <Stat label="接待人次" value={kpis.current.reception.toLocaleString('zh-CN')} detail={`${kpis.current.inquired} 位买家咨询`}><Delta now={kpis.current.reception} before={kpis.previous.reception} label={vs}/></Stat>
        <Stat label="咨询转化" value={percent(kpis.current.conversionRate)} detail={`${kpis.current.converted} 位咨询后下单并付款`}><Delta now={kpis.current.conversionRate} before={kpis.previous.conversionRate} label={vs}/></Stat>
        <Stat label="首次响应" value={seconds(service?.firstResponseSeconds??null)} detail="按工作时段计"/>
      </div>
    </section>}

    {(service||customers) && <section className="home-pair">
      {service && <div className="home-card"><header><h2>客服</h2><button className="dash-link" onClick={()=>navigate('performance/comparison')}>客服对比<ChevronRight size={14}/></button></header>
        {service.agents.length?<div className="shop-table-scroll"><table className="dash-table"><thead><tr><th>客服</th><th>接待</th><th>付款买家</th><th>销售额</th><th>首次响应</th></tr></thead>
          <tbody>{service.agents.map(a=><tr key={a.agentId}><td><b>{a.userName||(a.isMain?'主账号':a.loginId.split(':').pop())}</b></td><td>{a.reception}</td><td>{a.paidBuyers}</td><td>{yuan(a.paidAmount)}</td><td>{seconds(a.firstResponseSeconds)}</td></tr>)}</tbody></table></div>
          :<p className="shop-note">本期没有接待。</p>}</div>}
      {customers && <div className="home-card"><header><h2>客户</h2><button className="dash-link" onClick={()=>navigate('customers/list')}>全部客户<ChevronRight size={14}/></button></header>
        {buyerMix && mixTotal>0 && <>
          <div className="dash-stack" role="img" aria-label={`首次购买 ${buyerMix.first_time} 位，复购 ${buyerMix.returning} 位`}><span className="first" style={{flexGrow:buyerMix.first_time}}/><span className="repeat" style={{flexGrow:buyerMix.returning}}/></div>
          <div className="dash-legend"><span><i className="first"/>首购 {buyerMix.first_time}</span><span><i className="repeat"/>复购 {buyerMix.returning}（{percent(buyerMix.returning/mixTotal)}）</span></div></>}
        <dl className="dash-facts">
          <div><dt>线上客户</dt><dd>{customers.total.toLocaleString('zh-CN')}</dd></div>
          <div><dt>已购买</dt><dd>{customers.buyers.toLocaleString('zh-CN')}</dd></div>
          <div><dt>复购占比</dt><dd>{percent(customers.buyers?customers.repeat_buyers/customers.buyers:null)}</dd></div>
          <div><dt>超期未购</dt><dd>{customers.overdue.toLocaleString('zh-CN')}</dd></div>
        </dl></div>}
    </section>}

    {listings && <section className="home-card"><header><h2>上架</h2><button className="dash-link" onClick={()=>navigate('products/queue')}>上架队列<ChevronRight size={14}/></button></header>
      <ol className="dash-funnel">
        <li><span>已采集</span><strong>{listings.collected}</strong></li>
        <li className={blocked?'warn':''}><span>受阻</span><strong>{blocked}</strong></li>
        <li><span>草稿</span><strong>{listings.drafts}</strong></li>
        <li><span>在售</span><strong>{listings.listings.published ?? 0}</strong></li>
        {(listings.listings['member expired'] ?? 0)>0 && <li className="warn"><span>会员过期下架</span><strong>{listings.listings['member expired']}</strong></li>}
      </ol>
    </section>}

    {nothing && <section className="state-card"><UserRoundCheck size={26}/><h2>{user.displayName}，当前账号还没有数据权限</h2><p>请联系管理员开通。</p></section>}
  </div>
}
