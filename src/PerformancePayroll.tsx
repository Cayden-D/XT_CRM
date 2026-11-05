import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Note } from './ui'
import { Download, Heart, Lock, LoaderCircle, RefreshCw, Save, Store, Trash2, X } from 'lucide-react'
import { download } from './api'
import { agentLabel } from './PerformanceReports'
import {
  addPayrollAdjustment, attributionSchemeNames, calculatePayrollMonth, getAgentMetrics, getFavorites, getKpiRanking, getKpiScheme, getPaySettings, getPayroll, getPayrollLineItems,
  getPayrollPeriods, getPerformanceAgents, lockPayroll, metricsExportPath, payrollExportPath, recalculatePayroll, removePayrollAdjustment, saveFavorites, saveKpiScheme, savePaySettings,
  type AgentMetrics, type KpiItem, type KpiMetric, type KpiRow, type KpiScheme, type PayrollDetail, type PayrollLine, type PayrollLineItems, type PayrollPeriod, type PaySettings, type PerformanceAgent, type CommissionDetail, type CommissionTier,
} from './performanceApi'

const message = (cause:unknown) => cause instanceof Error ? cause.message : '操作未完成，请稍后重试。'
const yuan = (value:number) => `${value<0?'−':''}¥${Math.abs(value).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2})}`
const dateTime = (value:string|null) => value ? new Date(value).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}) : '—'
const formatKpiValue = (metric:KpiMetric, value:number|null|undefined) => value==null ? '—' : metric.endsWith('_rate')||metric==='conversion' ? `${Math.round(value*1000)/10}%` : metric==='paid_amount' ? yuan(value) : metric.endsWith('seconds') ? `${value} 秒` : String(value)
const Loading = () => <div className="shop-empty"><LoaderCircle size={26} className="spin"/><p>正在读取…</p></div>

function Drawer({title,close,children}:{title:string;close:()=>void;children:ReactNode}) {
  useEffect(()=>{const escape=(event:KeyboardEvent)=>{if(event.key==='Escape')close()};window.addEventListener('keydown',escape);return()=>window.removeEventListener('keydown',escape)},[close])
  return <div className="dialog-layer shop-dialog"><button className="drawer-scrim" onClick={close} aria-label="关闭"/><section role="dialog" aria-modal="true" aria-label={title} className="shop-modal wide"><header><h2>{title}</h2><button title="关闭" onClick={close}><X size={18}/></button></header><div className="shop-modal-body">{children}</div></section></div>
}

// ---------------- P4: KPI ranking ----------------
export function KpiView({connectionId,from,to,canManage,setError,setNotice}:{connectionId:string;from:string;to:string;canManage:boolean;setError:(t:string)=>void;setNotice:(t:string)=>void}) {
  const [scheme,setScheme]=useState<KpiScheme|null>(null),[rows,setRows]=useState<KpiRow[]>([]),[loading,setLoading]=useState(true)
  const [editing,setEditing]=useState(false),[draft,setDraft]=useState<Record<string,string>>({}),[busy,setBusy]=useState(false)
  const load=useCallback(async()=>{setLoading(true);try{const [s,r]=await Promise.all([getKpiScheme(),getKpiRanking(connectionId,from,to)]);setScheme(s.data);setRows(r.data)}catch(cause){setError(message(cause))}finally{setLoading(false)}},[connectionId,from,to,setError])
  useEffect(()=>{void load()},[load])
  function edit(){if(!scheme)return;setDraft(Object.fromEntries(scheme.metrics.map(m=>[m.key,String(scheme.items.find(i=>i.metric===m.key)?.weight??'')])));setEditing(true)}
  async function save(){
    if(!scheme)return
    const items:KpiItem[]=scheme.metrics.filter(m=>draft[m.key]).map(m=>({metric:m.key,weight:Number(draft[m.key])}))
    if(!items.length||items.some(i=>!Number.isInteger(i.weight)||i.weight<1||i.weight>100))return setError('权重需为 1–100 的整数，且至少选择一个指标。')
    setBusy(true);try{await saveKpiScheme(scheme.revision,items);setEditing(false);setNotice('KPI 方案已保存');await load()}catch(cause){setError(message(cause))}finally{setBusy(false)}
  }
  if(loading||!scheme)return <Loading/>
  const labels=Object.fromEntries(scheme.metrics.map(m=>[m.key,m.label]))
  const totalWeight=scheme.items.reduce((s,i)=>s+i.weight,0)
  return <section className="perf-report" aria-label="综合能力排行">
    <div className="perf-chart-card">
      <div className="perf-chart-head"><h3 className="perf-chart-title">综合能力指数</h3>{canManage&&!editing&&<button className="shop-button" onClick={edit}>调整指标与权重</button>}</div>
      <Note label="计分方式">{scheme.items.map(i=>`${labels[i.metric]} ${Math.round(i.weight/totalWeight*100)}%`).join(' · ')}。每项按同期最优者计 100 分（越低越好的指标取最小值为满分），再按权重加权。</Note>
      {editing&&<div className="perf-kpi-editor">{scheme.metrics.map(m=><label key={m.key}><span>{m.label}{m.higherIsBetter?'':'（越低越好）'}</span><input type="number" min={0} max={100} step={1} placeholder="不计入" value={draft[m.key]??''} onChange={e=>setDraft({...draft,[m.key]:e.target.value})}/></label>)}
        <div className="perf-editor-actions"><button className="shop-button" onClick={()=>setEditing(false)}>取消</button><button className="shop-button primary" disabled={busy} onClick={()=>void save()}><Save size={16}/>保存</button></div></div>}
      {rows.length?<ol className="perf-bars perf-rank">{rows.map(r=><li key={r.agent_id} title={`${agentLabel(r)}：${r.score} 分`}>
        <span className="perf-bar-label"><b className={`perf-medal rank-${r.rank}`}>{r.rank}</b>{agentLabel(r)}</span>
        <span className="perf-bar-track"><i style={{width:`${Math.max(r.score?1.5:0,r.score)}%`}}/></span><span className="perf-bar-value">{r.score.toFixed(1)}</span></li>)}</ol>:<div className="shop-empty"><Store size={28}/><p>所选日期内暂无可排名的客服</p></div>}
    </div>
    {rows.length>0&&<div className="shop-table-scroll"><table className="shop-table perf-table"><thead><tr><th>名次</th><th>客服</th><th>综合指数</th>{scheme.items.map(i=><th key={i.metric}>{labels[i.metric]}<small>权重 {i.weight}</small></th>)}</tr></thead>
      <tbody>{rows.map(r=><tr key={r.agent_id}><td>{r.rank}</td><td><strong>{agentLabel(r)}</strong></td><td><strong>{r.score.toFixed(2)}</strong></td>{scheme.items.map(i=><td key={i.metric}>{formatKpiValue(i.metric,r.values[i.metric])}<small>{r.parts[i.metric]??0} 分</small></td>)}</tr>)}</tbody></table></div>}
  </section>
}

// ---------------- P4: "我关注的" ----------------
export function FavoritesView({connectionId,from,to,setError,setNotice}:{connectionId:string;from:string;to:string;setError:(t:string)=>void;setNotice:(t:string)=>void}) {
  const [columns,setColumns]=useState<{key:string;label:string}[]>([]),[chosen,setChosen]=useState<string[]>([]),[rows,setRows]=useState<AgentMetrics[]>([]),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false)
  useEffect(()=>{let live=true;setLoading(true)
    Promise.all([getFavorites(),getAgentMetrics(connectionId,from,to)]).then(([f,m])=>{if(live){setColumns(f.data.columns);setChosen(f.data.metrics.length?f.data.metrics:['reception','inquiry','paid_amount','first_response_seconds','unanswered']);setRows(m.data)}}).catch(cause=>live&&setError(message(cause))).finally(()=>live&&setLoading(false))
    return()=>{live=false}},[connectionId,from,to,setError])
  async function toggle(key:string){const next=chosen.includes(key)?chosen.filter(k=>k!==key):[...chosen,key];setChosen(next);try{await saveFavorites(next)}catch(cause){setError(message(cause))}}
  async function exportCsv(){setBusy(true);try{await download(metricsExportPath(connectionId,from,to,chosen),'客服绩效.csv');setNotice('已导出 CSV')}catch(cause){setError(message(cause))}finally{setBusy(false)}}
  if(loading)return <Loading/>
  const cell=(row:AgentMetrics,key:string):string=>{
    if(key==='conversion')return row.inquiry?`${Math.round(row.paid_buyers/row.inquiry*1000)/10}%`:'—'
    const value=(row as unknown as Record<string,number|null>)[key]
    if(value==null)return '—'
    if(key==='paid_amount'||key==='refund_amount')return yuan(value)
    if(key.endsWith('seconds'))return `${value} 秒`
    return key==='orders'?String(Math.round(value*100)/100):String(value)
  }
  const visible=rows.filter(r=>r.reception>0||r.orders>0||r.agent_messages>0)
  return <section className="perf-report" aria-label="我关注的数据">
    <div className="perf-chart-card">
      <div className="perf-chart-head"><h3 className="perf-chart-title">选择关注的指标</h3><button className="shop-button primary" disabled={busy||!chosen.length} onClick={()=>void exportCsv()}><Download size={16}/>导出 CSV</button></div>
      <div className="perf-favorites">{columns.map(c=><button key={c.key} aria-pressed={chosen.includes(c.key)} className={chosen.includes(c.key)?'active':''} onClick={()=>void toggle(c.key)}><Heart size={14} fill={chosen.includes(c.key)?'currentColor':'none'}/>{c.label}</button>)}</div>
    </div>
    <div className="shop-table-scroll"><table className="shop-table perf-table"><thead><tr><th>客服</th>{chosen.map(k=><th key={k}>{columns.find(c=>c.key===k)?.label}</th>)}</tr></thead>
      <tbody>{visible.map(r=><tr key={r.agent_id}><td><strong>{agentLabel(r)}</strong></td>{chosen.map(k=><td key={k}>{cell(r,k)}</td>)}</tr>)}</tbody></table>{!visible.length&&<div className="shop-empty"><Store size={28}/><p>所选日期内暂无数据</p></div>}</div>
  </section>
}

// ---------------- P5: payroll ----------------
const thisMonth = () => new Date(Date.now()+8*3_600_000).toISOString().slice(0,7)
const lastMonth = () => { const [y,m]=thisMonth().split('-').map(Number); return m===1?`${y-1}-12`:`${y}-${String(m-1).padStart(2,'0')}` }

export function PayrollView({connectionId,canManage,setError,setNotice}:{connectionId:string;canManage:boolean;setError:(t:string)=>void;setNotice:(t:string)=>void}) {
  const [periods,setPeriods]=useState<PayrollPeriod[]>([]),[current,setCurrent]=useState<PayrollDetail|null>(null),[agents,setAgents]=useState<PerformanceAgent[]>([])
  const [month,setMonth]=useState(lastMonth()),[loading,setLoading]=useState(true),[busy,setBusy]=useState(''),[rulesOpen,setRulesOpen]=useState(false),[confirmLock,setConfirmLock]=useState(false)
  const [lineItems,setLineItems]=useState<{line:PayrollLine;data:PayrollLineItems}|null>(null),[adjust,setAdjust]=useState({agentId:'',amount:'',reason:''})
  const load=useCallback(async(selectId?:string)=>{
    try{const [list,agentList]=await Promise.all([getPayrollPeriods(connectionId),getPerformanceAgents(connectionId)]);setPeriods(list.data);setAgents(agentList.data)
      const id=selectId??list.data[0]?.id;setCurrent(id?(await getPayroll(id)).data:null)}catch(cause){setError(message(cause))}finally{setLoading(false)}
  },[connectionId,setError])
  useEffect(()=>{setLoading(true);void load()},[load])
  async function run(name:string,action:()=>Promise<{data:PayrollDetail|PayrollPeriod}>,success:string){setBusy(name);setError('');try{const r=await action();setNotice(success);await load(r.data.id)}catch(cause){setError(message(cause))}finally{setBusy('')}}
  async function openLine(line:PayrollLine){if(!current)return;try{setLineItems({line,data:(await getPayrollLineItems(current.id,line.agent_id)).data})}catch(cause){setError(message(cause))}}
  if(loading)return <Loading/>
  const draft=current?.status==='draft'
  const total=current?.lines.reduce((s,l)=>s+l.total,0)??0
  return <section className="perf-report" aria-label="工资管理">
    <div className="perf-sync-bar">
      <label>月份<input type="month" value={month} max={thisMonth()} onChange={e=>setMonth(e.target.value)}/></label>
      {canManage&&<button className="shop-button primary" disabled={Boolean(busy)||!month} onClick={()=>void run('calc',()=>calculatePayrollMonth(connectionId,month),`${month} 工资单已计算`)}><RefreshCw size={16} className={busy==='calc'?'spin':''}/>生成 / 重新计算</button>}
      {canManage&&<button className="shop-button" onClick={()=>setRulesOpen(true)}>工资规则</button>}
      {periods.length>0&&<select className="perf-select" aria-label="选择工资单" value={current?.id??''} onChange={e=>{setLoading(true);void load(e.target.value)}}>{periods.map(p=><option key={p.id} value={p.id}>{p.month.slice(0,7)} · {p.status==='locked'?'已锁定':'草稿'} · {yuan(p.total??0)}</option>)}</select>}
    </div>
    {!current?<div className="shop-empty"><Store size={28}/><p>{canManage?'选择月份后点击“生成 / 重新计算”':'暂无工资单'}</p></div>:<>
      <div className="perf-kpis">
        <article><span>{current.month.slice(0,7)} 工资合计</span><strong>{yuan(total)}</strong></article>
        <article><span>状态</span><strong className="perf-kpi-time">{draft?'草稿（可重新计算）':`已锁定 · ${current.locked_by_name??''}`}</strong>{!draft&&<small>{dateTime(current.locked_at)}</small>}</article>
        <article><span>绩效方案</span><strong className="perf-kpi-time">{attributionSchemeNames[current.scheme].split('：')[1]}</strong></article>
        <article><span>计算时间</span><strong className="perf-kpi-time">{dateTime(current.calculated_at)}</strong></article>
      </div>
      <div className="perf-sync-bar">
        <button className="shop-button" disabled={Boolean(busy)} onClick={()=>void download(payrollExportPath(current.id),'客服工资.csv').catch(cause=>setError(message(cause)))}><Download size={16}/>导出</button>
        {canManage&&draft&&<button className="shop-button" disabled={Boolean(busy)} onClick={()=>void run('recalc',()=>recalculatePayroll(current.id,current.revision),'已按最新规则重新计算')}><RefreshCw size={16}/>重新计算</button>}
        {canManage&&draft&&<button className="shop-button danger" disabled={Boolean(busy)} onClick={()=>setConfirmLock(true)}><Lock size={16}/>锁定工资单</button>}
      </div>
      <div className="shop-table-scroll"><table className="shop-table perf-table"><thead><tr><th>客服</th><th>基本工资</th><th>绩效销售额</th><th>退款</th><th>提成</th><th>KPI 名次</th><th>KPI 奖金</th><th>奖惩</th><th>工资总计</th><th/></tr></thead>
        <tbody>{current.lines.map(l=><tr key={l.agent_id}><td><strong>{agentLabel(l)}</strong></td><td>{yuan(l.base_salary)}</td><td>{yuan(l.paid_amount)}<small>{Math.round(l.credited_orders*100)/100} 单</small></td><td>{l.refund_amount?`−${yuan(l.refund_amount)}`:'—'}</td>
          <td>{yuan(l.commission)}<small>{l.commission_detail?.mode==='tiered'?'阶梯 · 实际 ':''}{Math.round(l.commission_rate*10000)/100}%{l.commission_detail?.floored?' · 已保底为 0':''}</small></td><td>{l.kpi_rank??'—'}{l.kpi_score!=null&&<small>{l.kpi_score} 分</small>}</td><td>{l.kpi_bonus?yuan(l.kpi_bonus):'—'}</td><td>{l.adjustments?yuan(l.adjustments):'—'}</td><td><strong>{yuan(l.total)}</strong></td>
          <td><button className="shop-button" onClick={()=>void openLine(l)}>明细</button></td></tr>)}</tbody></table></div>
      <h3 className="perf-chart-title">奖惩记录</h3>
      {canManage&&draft&&<form className="perf-adjust" onSubmit={e=>{e.preventDefault();const amount=Number(adjust.amount);if(!adjust.agentId||!Number.isFinite(amount)||!amount||!adjust.reason.trim())return setError('请选择客服并填写非零金额和原因。');void run('adjust',async()=>{const r=await addPayrollAdjustment(current.id,{revision:current.revision,agentId:adjust.agentId,amount,reason:adjust.reason.trim()});setAdjust({agentId:'',amount:'',reason:''});return r},'奖惩已记录')}}>
        <select className="perf-select" aria-label="奖惩客服" value={adjust.agentId} onChange={e=>setAdjust({...adjust,agentId:e.target.value})}><option value="">选择客服</option>{agents.map(a=><option key={a.id} value={a.id}>{agentLabel(a)}</option>)}</select>
        <input aria-label="奖惩金额" type="number" step="0.01" placeholder="金额（扣款填负数）" value={adjust.amount} onChange={e=>setAdjust({...adjust,amount:e.target.value})}/>
        <input aria-label="奖惩原因" maxLength={200} placeholder="原因" value={adjust.reason} onChange={e=>setAdjust({...adjust,reason:e.target.value})}/>
        <button className="shop-button primary" disabled={Boolean(busy)}>添加</button></form>}
      {current.adjustments?.length?<ul className="perf-adjust-list">{current.adjustments.map(j=><li key={j.id}><strong>{agentLabel({...j,user_name:null})}</strong><span className={j.amount<0?'negative':''}>{j.amount>0?'+':''}{yuan(j.amount)}</span><span>{j.reason}</span><small>{j.created_by_name} · {dateTime(j.created_at)}</small>
        {canManage&&draft&&<button className="shop-icon" title="删除奖惩" aria-label={`删除 ${j.reason}`} disabled={Boolean(busy)} onClick={()=>void run('remove',()=>removePayrollAdjustment(current.id,j.id,current.revision),'已删除')}><Trash2 size={15}/></button>}</li>)}</ul>:<p className="shop-note">暂无奖惩记录。</p>}
      <Note>工资 = 基本工资 + 提成 + KPI 名次奖金 + 奖惩。提成按（当月付款的绩效订单金额 − 当月退款成功金额）计算：按客服比例，或按店铺阶梯（超额/全额累进），可设置最低为 0；退款按原订单的归属份额扣减；KPI 按当月综合能力排行。锁定后不再变化，规则调整只影响未锁定的工资单。</Note>
    </>}
    {rulesOpen&&<PayRulesEditor connectionId={connectionId} agents={agents} close={()=>setRulesOpen(false)} saved={()=>{setRulesOpen(false);setNotice('工资规则已保存，重新计算草稿后生效')}} setError={setError}/>}
    {confirmLock&&current&&<Drawer title={`锁定 ${current.month.slice(0,7)} 工资单`} close={()=>setConfirmLock(false)}><p>锁定后工资单不能再重新计算或修改奖惩，合计 {yuan(total)}。</p>
      <div className="perf-editor-actions"><button className="shop-button" onClick={()=>setConfirmLock(false)}>取消</button><button className="shop-button danger" disabled={Boolean(busy)} onClick={()=>{setConfirmLock(false);void run('lock',()=>lockPayroll(current.id,current.revision),'工资单已锁定')}}><Lock size={16}/>确认锁定</button></div></Drawer>}
    {lineItems&&<Drawer title={`${agentLabel(lineItems.line)} · 明细`} close={()=>setLineItems(null)}>
      {lineItems.line.commission_detail&&<CommissionBreakdown detail={lineItems.line.commission_detail} commission={lineItems.line.commission}/>}
      <h3 className="perf-chart-title">付款订单（{lineItems.data.orders.length}）</h3>
      {lineItems.data.orders.length?<div className="shop-table-scroll"><table className="shop-table perf-table"><thead><tr><th>订单号</th><th>付款时间</th><th>订单金额</th><th>份额</th><th>计入金额</th></tr></thead><tbody>{lineItems.data.orders.map(o=><tr key={o.order_id}><td><code>{o.order_id}</code></td><td>{dateTime(o.paid_at)}</td><td>{yuan(o.total_amount)}</td><td>{Math.round(o.share*100)}%</td><td>{yuan(o.credited)}</td></tr>)}</tbody></table></div>:<p className="shop-note">无</p>}
      <h3 className="perf-chart-title">退款扣减（{lineItems.data.refunds.length}）</h3>
      {lineItems.data.refunds.length?<div className="shop-table-scroll"><table className="shop-table perf-table"><thead><tr><th>订单号</th><th>退款完成</th><th>退款金额</th><th>份额</th><th>扣减</th><th>原因</th></tr></thead><tbody>{lineItems.data.refunds.map(r=><tr key={r.refund_id}><td><code>{r.order_id}</code></td><td>{dateTime(r.completed_at)}</td><td>{yuan(r.refund_amount)}</td><td>{Math.round(r.share*100)}%</td><td>−{yuan(r.credited)}</td><td>{r.apply_reason||'—'}</td></tr>)}</tbody></table></div>:<p className="shop-note">无</p>}
    </Drawer>}
  </section>
}

function PayRulesEditor({connectionId,agents,close,saved,setError}:{connectionId:string;agents:PerformanceAgent[];close:()=>void;saved:()=>void;setError:(t:string)=>void}) {
  const [settings,setSettings]=useState<PaySettings|null>(null),[busy,setBusy]=useState(false)
  const [base,setBase]=useState(''),[rate,setRate]=useState(''),[bonuses,setBonuses]=useState(''),[overrides,setOverrides]=useState<Record<string,{base:string;rate:string}>>({})
  const [mode,setMode]=useState<'flat'|'tiered'>('flat'),[style,setStyle]=useState<'progressive'|'whole'>('progressive'),[tiers,setTiers]=useState<{from:string;rate:string}[]>([{from:'0',rate:''}]),[floorZero,setFloorZero]=useState(false),[sample,setSample]=useState('80000')
  const closeRef=useRef(close);closeRef.current=close
  useEffect(()=>{getPaySettings(connectionId).then(r=>{const s=r.data;setSettings(s);setBase(String(s.defaultRule.base_salary));setRate(String(Math.round(s.defaultRule.commission_rate*10000)/100));setBonuses(s.rankBonuses.join(', '))
    setMode(s.commissionMode);setStyle(s.tierStyle);setFloorZero(s.floorZero);setTiers(s.tiers.length?s.tiers.map(t=>({from:String(t.from),rate:String(Math.round(t.rate*10000)/100)})):[{from:'0',rate:''}])
    setOverrides(Object.fromEntries(s.rules.map(rule=>[rule.agent_id!,{base:String(rule.base_salary),rate:String(Math.round(rule.commission_rate*10000)/100)}])))}).catch(cause=>{setError(message(cause));closeRef.current()})},[connectionId,setError])
  async function save(){
    if(!settings)return
    const num=(v:string)=>v.trim()===''?NaN:Number(v)
    const rankBonuses=bonuses.split(/[,，\s]+/).filter(Boolean).map(Number)
    const rules=Object.entries(overrides).filter(([,o])=>o.base!==''||o.rate!=='').map(([agentId,o])=>({agentId,baseSalary:o.base===''?num(base):num(o.base),commissionRate:(o.rate===''?num(rate):num(o.rate))/100}))
    const bad=[num(base),num(rate),...rankBonuses,...rules.flatMap(r=>[r.baseSalary,r.commissionRate])].some(v=>!Number.isFinite(v)||v<0)||num(rate)>100||rules.some(r=>r.commissionRate>1)||rankBonuses.length>10
    if(bad)return setError('请填写有效的非负金额；提成比例在 0–100% 之间；名次奖金最多 10 档。')
    const parsedTiers=mode==='tiered'?tiers.map(t=>({from:num(t.from),rate:num(t.rate)/100})):[]
    if(mode==='tiered'&&(parsedTiers.some(t=>!Number.isFinite(t.from)||!Number.isFinite(t.rate)||t.from<0||t.rate<0||t.rate>1)||parsedTiers[0]?.from!==0||parsedTiers.some((t,i)=>i>0&&t.from<=parsedTiers[i-1].from)))
      return setError('阶梯需从 0 元开始、起点逐档递增，比例在 0–100% 之间。')
    setBusy(true);try{await savePaySettings({connectionId,revision:settings.revision,rankBonuses,defaultRule:{baseSalary:num(base),commissionRate:num(rate)/100},rules,commissionMode:mode,tierStyle:style,tiers:parsedTiers,floorZero});saved()}catch(cause){setError(message(cause))}finally{setBusy(false)}
  }
  return <Drawer title="工资规则" close={close}>{!settings?<Loading/>:<>
    <div className="shop-form-columns perf-rule-form">
      <label>默认基本工资（元）<input type="number" min={0} step="0.01" value={base} onChange={e=>setBase(e.target.value)}/></label>
      {mode==='flat'&&<label>默认提成比例（%）<input type="number" min={0} max={100} step="0.01" value={rate} onChange={e=>setRate(e.target.value)}/></label>}
      <label>KPI 名次奖金（元，按第 1、2、3… 名，逗号分隔）<input value={bonuses} placeholder="例如 150, 100, 50" onChange={e=>setBonuses(e.target.value)}/></label>
    </div>
    <h3 className="perf-chart-title">提成方式</h3>
    <div className="perf-metric-tabs" role="radiogroup" aria-label="提成方式">{([['flat','按客服比例'],['tiered','阶梯提成']] as const).map(([id,text])=><button key={id} role="radio" aria-checked={mode===id} className={mode===id?'active':''} onClick={()=>setMode(id)}>{text}</button>)}</div>
    {mode==='tiered'&&<>
      <label className="perf-inline-field">计算方式<select className="perf-select" value={style} onChange={e=>setStyle(e.target.value as 'progressive'|'whole')}><option value="progressive">超额累进：每段销售额按所在档比例</option><option value="whole">全额累进：达到某档后全部销售额按该档比例</option></select></label>
      <div className="shop-table-scroll"><table className="shop-table perf-table"><thead><tr><th>当月绩效净销售额 ≥（元）</th><th>提成比例（%）</th><th></th></tr></thead>
        <tbody>{tiers.map((t,i)=><tr key={i}><td><input className="perf-cell-input" aria-label={`第 ${i+1} 档起点`} type="number" min={0} step="0.01" value={t.from} disabled={i===0} onChange={e=>setTiers(tiers.map((x,j)=>j===i?{...x,from:e.target.value}:x))}/></td>
          <td><input className="perf-cell-input" aria-label={`第 ${i+1} 档比例`} type="number" min={0} max={100} step="0.01" value={t.rate} onChange={e=>setTiers(tiers.map((x,j)=>j===i?{...x,rate:e.target.value}:x))}/></td>
          <td>{i>0&&<button className="shop-icon" title="删除此档" aria-label={`删除第 ${i+1} 档`} onClick={()=>setTiers(tiers.filter((_,j)=>j!==i))}><Trash2 size={15}/></button>}</td></tr>)}</tbody></table></div>
      {tiers.length<10&&<button className="shop-button" onClick={()=>setTiers([...tiers,{from:'',rate:''}])}>添加一档</button>}
      <TierPreview amount={sample} setAmount={setSample} style={style} tiers={tiers.map(t=>({from:Number(t.from),rate:Number(t.rate)/100}))} floorZero={floorZero}/>
    </>}
    <label className="perf-toggle"><input type="checkbox" checked={floorZero} onChange={e=>setFloorZero(e.target.checked)}/>提成最低为 0（当月退款多于销售时不倒扣提成）</label>
    <h3 className="perf-chart-title">按客服单独设置（留空则使用默认{mode==='tiered'?'；阶梯提成时只用基本工资':''}）</h3>
    <div className="shop-table-scroll"><table className="shop-table perf-table"><thead><tr><th>客服</th><th>基本工资</th><th>提成比例（%）</th></tr></thead>
      <tbody>{agents.map(a=><tr key={a.id}><td><strong>{agentLabel(a)}</strong>{!a.present&&<small>已不在子账号列表</small>}</td>
        <td><input className="perf-cell-input" aria-label={`${agentLabel(a)} 基本工资`} type="number" min={0} step="0.01" placeholder={base} value={overrides[a.id]?.base??''} onChange={e=>setOverrides({...overrides,[a.id]:{base:e.target.value,rate:overrides[a.id]?.rate??''}})}/></td>
        <td><input className="perf-cell-input" aria-label={`${agentLabel(a)} 提成比例`} type="number" min={0} max={100} step="0.01" disabled={mode==='tiered'} placeholder={mode==='tiered'?'按阶梯':rate} value={overrides[a.id]?.rate??''} onChange={e=>setOverrides({...overrides,[a.id]:{base:overrides[a.id]?.base??'',rate:e.target.value}})}/></td></tr>)}</tbody></table></div>
    <div className="perf-editor-actions"><button className="shop-button" onClick={close}>取消</button><button className="shop-button primary" disabled={busy} onClick={()=>void save()}><Save size={16}/>保存规则</button></div>
  </>}</Drawer>
}

/** Same rules as the server (commissionFor): used only to preview a sample amount while editing. */
function previewCommission(net:number,style:'progressive'|'whole',tiers:CommissionTier[],floorZero:boolean){
  const sorted=tiers.filter(t=>Number.isFinite(t.from)&&Number.isFinite(t.rate)).sort((a,b)=>a.from-b.from)
  if(!sorted.length)return 0
  let value:number
  if(net<=0)value=net*sorted[0].rate
  else if(style==='whole')value=net*(sorted.filter(t=>t.from<=net).at(-1)??sorted[0]).rate
  else value=sorted.reduce((sum,t,i)=>sum+Math.max(0,Math.min(net,sorted[i+1]?.from??Infinity)-t.from)*t.rate,0)
  value=Math.round(value*100)/100
  return floorZero&&value<0?0:value
}
function TierPreview({amount,setAmount,style,tiers,floorZero}:{amount:string;setAmount:(v:string)=>void;style:'progressive'|'whole';tiers:CommissionTier[];floorZero:boolean}) {
  const net=Number(amount)
  return <p className="shop-note perf-tier-preview">试算：当月绩效净销售额 <input className="perf-cell-input" aria-label="试算金额" type="number" step="100" value={amount} onChange={e=>setAmount(e.target.value)}/> 元 → 提成 <strong>{Number.isFinite(net)?yuan(previewCommission(net,style,tiers,floorZero)):'—'}</strong></p>
}
function CommissionBreakdown({detail,commission}:{detail:CommissionDetail;commission:number}) {
  const range=(b:CommissionDetail['bands'][number])=>b.to==null?`${yuan(b.from)} 以上`:`${yuan(b.from)}–${yuan(b.to)}`
  return <><h3 className="perf-chart-title">提成计算</h3>
    <p className="shop-note">绩效净销售额 {yuan(detail.net)} · {detail.mode==='tiered'?(detail.style==='whole'?'阶梯（全额累进）':'阶梯（超额累进）'):'按客服比例'}{detail.floored?' · 退款多于销售，提成保底为 0':''}</p>
    <div className="shop-table-scroll"><table className="shop-table perf-table"><thead><tr><th>档位</th><th>计入金额</th><th>比例</th><th>提成</th></tr></thead>
      <tbody>{detail.bands.map((b,i)=><tr key={i}><td>{detail.mode==='tiered'?range(b):'—'}</td><td>{yuan(b.amount)}</td><td>{Math.round(b.rate*10000)/100}%</td><td>{yuan(Math.round(b.amount*b.rate*100)/100)}</td></tr>)}
        <tr><td colSpan={3}><strong>合计</strong></td><td><strong>{yuan(commission)}</strong></td></tr></tbody></table></div></>
}
