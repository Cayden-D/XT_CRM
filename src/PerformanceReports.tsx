import { useCallback, useEffect, useMemo, useState } from 'react'
import { Note } from './ui'
import { LoaderCircle, RefreshCw, Store } from 'lucide-react'
import { getAssignableUsers, type AssignableUser } from './api'
import {
  attributionSchemeNames, type AttributionScheme, bindPerformanceAgent, getSyncStatus, saveHistoryDays, type HistoryDays, type SyncScope, type SyncStatus, getAgentMetrics, getHourlyReception, getPerformanceAgents, getPerformanceSyncRuns, startPerformanceSync,
  type AgentMetrics, type FlagRules, getFlagRules, saveFlagRules, type HourlyReception, type PerformanceAgent, type SyncRun,
} from './performanceApi'

const message = (cause:unknown) => cause instanceof Error ? cause.message : '操作未完成，请稍后重试。'
const time = (value:string|null) => value ? new Date(value).toLocaleString('zh-CN') : '—'
const seconds = (value:number|null) => value==null ? '—' : value<60 ? `${value} 秒` : `${Math.floor(value/60)} 分 ${value%60} 秒`
const percent = (part:number,whole:number) => whole ? `${Math.round(part/whole*1000)/10}%` : '—'
/** Main account shows as "主账号"; a sub-account "shop:小王" shows its suffix. */
export const agentLabel = (agent:{login_id:string;is_main:boolean;user_name:string|null}) => {
  const account = agent.is_main ? '主账号' : agent.login_id.includes(':') ? agent.login_id.slice(agent.login_id.indexOf(':')+1) : agent.login_id
  return agent.user_name ? `${agent.user_name}（${account}）` : account
}

const yuan = (value:number|null) => value==null ? '—' : `¥${value.toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2})}`
const conversion = (row:AgentMetrics) => row.inquiry ? row.paid_buyers/row.inquiry : null
type MetricKey = 'reception'|'effective_reception'|'first_response_seconds'|'avg_response_seconds'|'unanswered'|'inquiry'|'conversion'|'paid_amount'
const metricDefs: { key:MetricKey; label:string; lowerIsBetter?:boolean; value:(row:AgentMetrics)=>number|null; format:(v:number|null)=>string }[] = [
  { key:'reception', label:'总接待人数', value:r=>r.reception, format:v=>`${v??0} 人` },
  { key:'effective_reception', label:'有效接待人数', value:r=>r.effective_reception, format:v=>`${v??0} 人` },
  { key:'inquiry', label:'询单人数', value:r=>r.inquiry, format:v=>`${v??0} 人` },
  { key:'conversion', label:'询单→付款转化率', value:conversion, format:v=>v==null?'—':`${Math.round(v*1000)/10}%` },
  { key:'paid_amount', label:'绩效销售额', value:r=>r.paid_amount, format:yuan },
  { key:'first_response_seconds', label:'平均首次响应', lowerIsBetter:true, value:r=>r.first_response_seconds, format:seconds },
  { key:'avg_response_seconds', label:'平均响应时间', lowerIsBetter:true, value:r=>r.avg_response_seconds, format:seconds },
  { key:'unanswered', label:'未回复人次', lowerIsBetter:true, value:r=>r.unanswered, format:v=>`${v??0} 次` },
]

export function ComparisonView({connectionId,from,to,setError}:{connectionId:string;from:string;to:string;setError:(text:string)=>void}) {
  const [rows,setRows]=useState<AgentMetrics[]>([]),[syncedAt,setSyncedAt]=useState<string|null>(null),[scheme,setScheme]=useState<AttributionScheme>('order_first'),[loading,setLoading]=useState(true)
  const [metric,setMetric]=useState<MetricKey>('reception'),[showIdle,setShowIdle]=useState(false)
  useEffect(()=>{let live=true;setLoading(true)
    getAgentMetrics(connectionId,from,to).then(result=>{if(live){setRows(result.data);setSyncedAt(result.syncedAt);setScheme(result.scheme)}}).catch(cause=>live&&setError(message(cause))).finally(()=>live&&setLoading(false))
    return()=>{live=false}},[connectionId,from,to,setError])
  const def=metricDefs.find(d=>d.key===metric)!
  const visible=showIdle?rows:rows.filter(r=>r.reception>0||r.agent_messages>0||r.orders>0)
  const ranked=useMemo(()=>[...visible].sort((a,b)=>{
    const x=def.value(a),y=def.value(b)
    if(x==null&&y==null)return 0;if(x==null)return 1;if(y==null)return -1
    return def.lowerIsBetter?x-y:y-x
  }),[visible,def])
  const max=Math.max(metric==='conversion'?0.0001:1,...ranked.map(r=>def.value(r)??0))
  const totals=rows.reduce((sum,r)=>({reception:sum.reception+r.reception,inquiry:sum.inquiry+r.inquiry,paidBuyers:sum.paidBuyers+r.paid_buyers,paid:sum.paid+r.paid_amount,refund:sum.refund+r.refund_amount}),{reception:0,inquiry:0,paidBuyers:0,paid:0,refund:0})
  if(loading)return <div className="shop-empty"><LoaderCircle size={26} className="spin"/><p>正在统计…</p></div>
  return <section className="perf-report" aria-label="客服对比分析">
    <div className="perf-kpis">
      <article><span>总接待人数</span><strong>{totals.reception}</strong></article>
      <article><span>询单→付款转化率</span><strong>{percent(totals.paidBuyers,totals.inquiry)}</strong></article>
      <article><span>绩效销售额（已付款）</span><strong>{yuan(totals.paid)}</strong>{totals.refund>0&&<small>退款 {yuan(totals.refund)}</small>}</article>
      <article><span>数据截至</span><strong className="perf-kpi-time">{time(syncedAt)}</strong></article>
    </div>
    <div className="perf-chart-card">
      <div className="perf-chart-head">
        <nav className="perf-metric-tabs" aria-label="对比指标">{metricDefs.map(d=><button key={d.key} className={metric===d.key?'active':''} aria-pressed={metric===d.key} onClick={()=>setMetric(d.key)}>{d.label}</button>)}</nav>
        <label className="perf-toggle"><input type="checkbox" checked={showIdle} onChange={e=>setShowIdle(e.target.checked)}/>显示无数据的账号</label>
      </div>
      <h3 className="perf-chart-title">{def.label}{def.lowerIsBetter?'（越低越好）':''}</h3>
      {ranked.length?<ol className="perf-bars">{ranked.map(row=>{
        const value=def.value(row)
        return <li key={row.agent_id} title={`${agentLabel(row)}：${def.format(value)}`}>
          <span className="perf-bar-label">{agentLabel(row)}</span>
          <span className="perf-bar-track">{value!=null&&<i style={{width:`${Math.max(value?1.5:0,value/max*100)}%`}}/>}</span>
          <span className="perf-bar-value">{def.format(value)}</span>
        </li>})}</ol>:<div className="shop-empty"><Store size={28}/><p>所选日期内暂无数据</p></div>}
    </div>
    <div className="shop-table-scroll"><table className="shop-table perf-table"><thead><tr><th>客服</th><th>总接待</th><th>有效接待</th><th>询单</th><th>新客询盘</th><th>售后咨询</th><th>下单人数</th><th>付款人数</th><th>转化率</th><th>绩效订单</th><th>绩效销售额</th><th>退款</th><th>平均首响</th><th>平均响应</th><th>未回复</th><th>转接</th></tr></thead>
      <tbody>{ranked.map(row=><tr key={row.agent_id}><td><strong>{agentLabel(row)}</strong>{!row.present&&<small>已不在子账号列表</small>}</td><td>{row.reception}</td><td>{row.effective_reception}</td><td>{row.inquiry}</td><td>{row.new_customer_inquiry}</td><td>{row.after_sales}</td><td>{row.ordered_buyers}</td><td>{row.paid_buyers}</td><td>{percent(row.paid_buyers,row.inquiry)}</td>
        <td>{Number.isInteger(row.orders)?row.orders:row.orders.toFixed(2)}</td><td>{yuan(row.paid_amount)}</td><td>{row.refund_amount?yuan(row.refund_amount):'—'}</td><td>{seconds(row.first_response_seconds)}</td><td>{seconds(row.avg_response_seconds)}</td><td>{row.unanswered}</td><td>{row.transfers}</td></tr>)}</tbody></table></div>
    <Note>绩效订单和销售额按下单日期统计，归属方案：{attributionSchemeNames[scheme]}（分成方案按份额计）。询单为非售后的接待；售后咨询指该买家此前 90 天内有已付款订单；下单/付款人数指询单后在归属窗口内下单/付款的买家。新客判断仅基于已同步的订单历史。</Note>
  </section>
}

export function HourlyView({connectionId,from,to,setError}:{connectionId:string;from:string;to:string;setError:(text:string)=>void}) {
  const [data,setData]=useState<HourlyReception|null>(null),[agents,setAgents]=useState<PerformanceAgent[]>([]),[loading,setLoading]=useState(true)
  useEffect(()=>{let live=true;setLoading(true)
    Promise.all([getHourlyReception(connectionId,from,to),getPerformanceAgents(connectionId)]).then(([hourly,list])=>{if(live){setData(hourly.data);setAgents(list.data)}}).catch(cause=>live&&setError(message(cause))).finally(()=>live&&setLoading(false))
    return()=>{live=false}},[connectionId,from,to,setError])
  if(loading||!data)return <div className="shop-empty"><LoaderCircle size={26} className="spin"/><p>正在统计…</p></div>
  const cell=new Map(data.cells.map(c=>[`${c.agent_id}:${c.bucket}`,c.reception]))
  const active=agents.filter(a=>data.cells.some(c=>c.agent_id===a.id))
  const max=Math.max(1,...data.cells.map(c=>c.reception))
  const column=(bucket:number)=>active.reduce((sum,a)=>sum+(cell.get(`${a.id}:${bucket}`)||0),0)
  if(!active.length)return <div className="shop-empty"><Store size={28}/><p>所选日期内暂无接待数据</p></div>
  return <section className="perf-report" aria-label="分时接待">
    <div className="shop-table-scroll"><table className="shop-table perf-heat"><thead><tr><th>客服 / 时段</th>{data.buckets.map(b=><th key={b.key}>{b.label}</th>)}</tr></thead>
      <tbody>{active.map(agent=><tr key={agent.id}><td><strong>{agentLabel(agent)}</strong></td>{data.buckets.map(b=>{const value=cell.get(`${agent.id}:${b.key}`)||0;const share=value/max
        return <td key={b.key} title={`${agentLabel(agent)} ${b.label}：${value} 人`} style={value?{background:`color-mix(in srgb, #2763b8 ${Math.round(10+share*80)}%, #ffffff)`,color:share>0.5?'#fff':'#1d2f44'}:undefined}>{value||<span className="perf-zero">0</span>}</td>})}</tr>)}
        <tr className="perf-total"><td><strong>合计</strong></td>{data.buckets.map(b=><td key={b.key}>{column(b.key)}</td>)}</tr></tbody></table></div>
    <Note>按买家消息开始的时间（北京时间）统计，每格为该时段接待的买家人数（按日去重）；00:00–09:00 合并为一列。颜色越深人数越多。</Note>
  </section>
}

const scopeNames = { 1: '今天', 7: '近 7 天', 30: '近 30 天', all: '全部（含历史补齐）' } as const
const day = (value:string|null) => value ? new Date(Date.parse(value)+8*3_600_000).toISOString().slice(0,10) : '—'

export function AgentsView({connectionId,canManage,canPayroll,setError,setNotice}:{connectionId:string;canManage:boolean;canPayroll:boolean;setError:(text:string)=>void;setNotice:(text:string)=>void}) {
  const [agents,setAgents]=useState<PerformanceAgent[]>([]),[users,setUsers]=useState<AssignableUser[]>([]),[runs,setRuns]=useState<SyncRun[]>([])
  const [loading,setLoading]=useState(true),[busy,setBusy]=useState(''),[scope,setScope]=useState<SyncScope|'all'>(1),[status,setStatus]=useState<SyncStatus|null>(null)
  const load=useCallback(async()=>{
    try{
      const [list,history,progress]=await Promise.all([getPerformanceAgents(connectionId),canManage?getPerformanceSyncRuns(connectionId):Promise.resolve({data:[]}),getSyncStatus(connectionId)])
      setAgents(list.data);setRuns(history.data);setStatus(progress.data)
      if(canManage)setUsers((await getAssignableUsers()).data)
    }catch(cause){setError(message(cause))}finally{setLoading(false)}
  },[connectionId,canManage,setError])
  useEffect(()=>{setLoading(true);void load()},[load])
  const running=runs.some(r=>r.status==='queued'||r.status==='running')
  useEffect(()=>{if(!running)return;const timer=setInterval(()=>void load(),5000);return()=>clearInterval(timer)},[running,load])
  async function bind(agent:PerformanceAgent,userId:string){setBusy(agent.id);setError('');try{await bindPerformanceAgent(agent.id,userId||null,agent.binding_revision);setNotice(userId?'客服账号已绑定':'已解除绑定');await load()}catch(cause){setError(message(cause));await load()}finally{setBusy('')}}
  async function changeHistory(days:HistoryDays){
    if(status&&days<status.history_days&&!window.confirm(`改为近 ${days} 天后，更早的历史不再补齐（已同步的数据保留）。继续？`))return
    setBusy('history');setError('');try{await saveHistoryDays(connectionId,days);setNotice(`历史数据范围已改为近 ${days} 天，下次“全部”同步生效`);await load()}catch(cause){setError(message(cause))}finally{setBusy('')}
  }
  async function sync(){setBusy('sync');setError('');try{await startPerformanceSync(connectionId,scope==='all'?undefined:scope);setNotice(`${scopeNames[scope]}同步已加入队列，后台处理中`);await load()}catch(cause){setError(message(cause))}finally{setBusy('')}}
  if(loading)return <div className="shop-empty"><LoaderCircle size={26} className="spin"/><p>正在读取…</p></div>
  const boundElsewhere=new Map(agents.filter(a=>a.user_id).map(a=>[a.user_id!,a.id]))
  return <section className="perf-report" aria-label="客服账号">
    {canManage&&<div className="perf-sync-bar">
      <label>本次同步<select value={scope} disabled={Boolean(busy)||running} onChange={e=>setScope(e.target.value==='all'?'all':Number(e.target.value) as SyncScope)}>{(Object.keys(scopeNames) as (keyof typeof scopeNames)[]).map(k=><option key={k} value={k}>{scopeNames[k]}</option>)}</select></label>
      <button className="shop-button primary" disabled={Boolean(busy)||running} onClick={()=>void sync()}><RefreshCw size={16} className={running?'spin':''}/>{running?'同步中…':'立即同步'}</button>
      {status&&<label>历史数据范围<select value={status.history_days} disabled={Boolean(busy)} onChange={e=>void changeHistory(Number(e.target.value) as HistoryDays)}>{([7,30,60,90] as HistoryDays[]).map(d=><option key={d} value={d}>近 {d} 天</option>)}</select></label>}
      <Note>“今天 / 近 7 天 / 近 30 天”只拉取该时间段的订单、退款和会话，调用少、完成快；“全部”还会按历史数据范围由近及远补齐历史。后台每 15 分钟自动执行“全部”（近 7 天无会话的客服账号每 2 小时查一次）；平台限流或中断后在之后的同步中继续（平台只保留近 90 天聊天）。</Note></div>}
    {status&&<p className="perf-sync-status">历史数据范围：近 {status.history_days} 天（{status.history_from} 起）· 订单补齐至 {day(status.orders_synced_from)} · 会话补齐至 {day(status.chats_synced_from)}{status.pending_sessions>0?` · ${status.pending_sessions.toLocaleString('zh-CN')} 个会话待拉取消息`:' · 会话消息已全部拉取'}{status.skipped_sessions>0&&` · 范围外 ${status.skipped_sessions.toLocaleString('zh-CN')} 个不再拉取`} · 今日已调用 {status.calls_today.toLocaleString('zh-CN')} 次{status.calls_today>=status.daily_call_limit&&'（已达每日上限，自动同步明天 0 点后继续）'}</p>}
    <div className="shop-table-scroll"><table className="shop-table"><thead><tr><th>平台账号</th><th>类型</th><th>平台状态</th><th>绑定系统用户</th><th>会话同步至</th></tr></thead>
      <tbody>{agents.map(agent=><tr key={agent.id}><td><strong>{agent.login_id}</strong>{!agent.present&&<small>已不在子账号列表</small>}</td><td>{agent.is_main?'主账号':'子账号'}</td><td>{agent.platform_status||'—'}</td>
        <td>{canManage?<select aria-label={`绑定 ${agent.login_id}`} value={agent.user_id||''} disabled={Boolean(busy)} onChange={e=>void bind(agent,e.target.value)}><option value="">未绑定</option>{users.map(u=><option key={u.id} value={u.id} disabled={boundElsewhere.has(u.id)&&boundElsewhere.get(u.id)!==agent.id}>{u.display_name}{boundElsewhere.has(u.id)&&boundElsewhere.get(u.id)!==agent.id?'（已绑定其他账号）':''}</option>)}</select>:agent.user_name||'未绑定'}</td>
        <td>{time(agent.relations_synced_until)}</td></tr>)}</tbody></table>{!agents.length&&<div className="shop-empty"><Store size={28}/><p>尚未同步客服账号，点击“立即同步”</p></div>}</div>
    <FlagRulesPanel connectionId={connectionId} agents={agents} canEdit={canPayroll} setError={setError} setNotice={setNotice}/>
    {canManage&&<><h3 className="perf-chart-title">同步记录</h3><div className="shop-table-scroll"><table className="shop-table"><thead><tr><th>开始时间</th><th>方式</th><th>状态</th><th>会话 / 消息</th><th>耗时</th><th>错误</th></tr></thead>
      <tbody>{runs.map(run=><tr key={run.id}><td>{time(run.started_at||run.created_at)}</td><td>{run.trigger==='manual'?'手动':'自动'} · {run.scope_days?scopeNames[run.scope_days]:run.backfill_days?`补齐 ${run.backfill_days} 天`:'全部'}</td>
        <td><span className={`shop-status ${run.status==='succeeded'?'positive':run.status==='failed'?'warning':''}`}>{({queued:'排队中',running:'进行中',succeeded:'成功',failed:'失败'} as const)[run.status]}</span>{run.phase&&<small>{run.phase}</small>}</td>
        <td>{run.stats.sessions??0} / {run.stats.messages??0}</td><td>{run.finished_at&&run.started_at?`${Math.round((Date.parse(run.finished_at)-Date.parse(run.started_at))/1000)} 秒`:'—'}</td><td>{run.error_message||(run.stats.truncatedDays?`${run.stats.truncatedDays} 个账号日超过平台 2000 个会话上限，超出部分无法获取`:'—')}</td></tr>)}</tbody></table>{!runs.length&&<div className="shop-empty"><p>暂无同步记录</p></div>}</div></>}
  </section>
}

/** Scheme 5: which agent each order flag credits. Usage counts help match flag numbers to how the team flags orders. */
function FlagRulesPanel({connectionId,agents,canEdit,setError,setNotice}:{connectionId:string;agents:PerformanceAgent[];canEdit:boolean;setError:(text:string)=>void;setNotice:(text:string)=>void}) {
  const [data,setData]=useState<FlagRules|null>(null),[draft,setDraft]=useState<Record<number,string>>({}),[busy,setBusy]=useState(false)
  const load=useCallback(async()=>{try{const r=(await getFlagRules(connectionId)).data;setData(r);setDraft(Object.fromEntries(r.rules.map(x=>[x.flag,x.agent_id])))}catch(cause){setError(message(cause))}},[connectionId,setError])
  useEffect(()=>{void load()},[load])
  async function save(){setBusy(true);setError('');try{await saveFlagRules(connectionId,Object.entries(draft).filter(([,id])=>id).map(([flag,agentId])=>({flag:Number(flag),agentId})));setNotice('旗帜规则已保存，订单归属正在后台重算');await load()}catch(cause){setError(message(cause))}finally{setBusy(false)}}
  if(!data)return null
  const used=new Map(data.usage.map(u=>[u.flag,u.orders]))
  return <><h3 className="perf-chart-title">订单插旗归属（方案5）</h3>
    <Note>客服在 1688 订单备注里写“@客服名”（子账号冒号后的名字）时优先归给该客服；没有 @ 时按下面的旗帜对应客服。编号与颜色以 1688 订单页为准，可参考近 90 天各旗帜的订单数。近 90 天备注含 @ 的订单 {data.memoMentions} 单，方案5 已归属 {data.creditedOrders} 单。</Note>
    <div className="shop-table-scroll"><table className="shop-table"><thead><tr><th>旗帜编号</th><th>近 90 天订单</th><th>归属客服</th></tr></thead>
      <tbody>{[1,2,3,4,5].map(flag=><tr key={flag}><td>旗帜 {flag}</td><td>{used.get(flag)??0}</td>
        <td>{canEdit?<select aria-label={`旗帜 ${flag} 归属客服`} value={draft[flag]||''} disabled={busy} onChange={e=>setDraft(d=>({...d,[flag]:e.target.value}))}><option value="">不归属</option>
          {agents.map(a=><option key={a.id} value={a.id}>{a.is_main?`${a.login_id}（主账号）`:a.login_id}</option>)}</select>
          :(a=>a?a.login_id:'不归属')(agents.find(a=>a.id===draft[flag]))}</td></tr>)}</tbody></table></div>
    {canEdit&&<button className="shop-button primary" disabled={busy} onClick={()=>void save()}>保存旗帜规则</button>}</>
}
