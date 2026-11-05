import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { AgentsView, ComparisonView, HourlyView } from './PerformanceReports'
import { ChatAnalysisView, OrdersView, QualityView } from './PerformanceAnalysis'
import { KeywordsView } from './PerformanceKeywords'
import { FavoritesView, KpiView, PayrollView } from './PerformancePayroll'
import { AgentCoachingView } from './AgentCoaching'
import './1688.css'
import ConnectionDelete from './ConnectionDelete'
import { AlertCircle, CheckCircle2, ChevronLeft, ChevronRight, ExternalLink, Link2, LoaderCircle, Power, RefreshCw, Save, ShieldCheck, Store, Trash2, X } from 'lucide-react'
import type { SessionUser } from './api'
import { useAiFocusPart } from './aiFocus'
import {
  attributionSchemeNames, availableSchemes, completePerformanceAuthorization, deletePerformanceConnection, disablePerformanceConnection, getPerformanceConnectionUsage, getPerformanceConnections, getPerformanceOperations, getPerformanceSettings,
  refreshPerformanceToken, savePerformanceSettings, startPerformanceAuthorization, testPerformanceConnection,
  type AttributionScheme, type PerformanceConnection, type PerformanceOperation, type PerformanceSettings,
} from './performanceApi'

const time = (value:string|null) => value ? new Date(value).toLocaleString('zh-CN') : '—'
const message = (cause:unknown) => cause instanceof Error ? cause.message : '操作未完成，请稍后重试。'
const permission = (user:SessionUser,name:string) => (user.permissions||[]).some(value => value==='*'||value===name||value===`${name.split(':')[0]}:*`)
const statusNames:Record<string,string> = { connected:'已连接',reauthorize:'需重新授权',disabled:'已停用',available:'可用',unavailable:'不可用',unknown:'未验证',success:'成功',failed:'失败',main:'主账号',sub:'子账号' }
export type View='coaching'|'comparison'|'kpi'|'favorites'|'hourly'|'chats'|'quality'|'keywords'|'orders'|'payroll'|'agents'|'connections'|'settings'|'operations'
type Preset='today'|'yesterday'|'7d'|'30d'
const reportViews:View[]=['coaching','comparison','kpi','favorites','hourly','chats','quality','keywords','orders','payroll','agents']
const datedViews:View[]=['comparison','kpi','favorites','hourly','chats','orders']
const tabs:[View,string][]=[['comparison','客服对比'],['coaching','业务员复盘'],['kpi','综合排行'],['favorites','我关注的'],['hourly','分时接待'],['quality','回复质量'],['keywords','关键词'],['orders','订单归属'],['payroll','工资管理'],['agents','客服账号'],['connections','绩效应用授权'],['settings','指标口径'],['operations','调用记录']]
const presets:[Preset,string][]=[['today','今天'],['yesterday','昨天'],['7d','近 7 天'],['30d','近 30 天']]
const beijingDate=(offsetDays=0)=>new Date(Date.now()+8*3_600_000+offsetDays*86_400_000).toISOString().slice(0,10)
function presetRange(preset:Preset){
  if(preset==='today')return {from:beijingDate(),to:beijingDate()}
  if(preset==='yesterday')return {from:beijingDate(-1),to:beijingDate(-1)}
  return {from:beijingDate(preset==='7d'?-6:-29),to:beijingDate()}
}
const duration = (seconds:number) => seconds % 60 ? `${Math.floor(seconds/60)} 分 ${seconds%60} 秒` : `${seconds/60} 分钟`

function Status({value}:{value:string}) {return <span className={`shop-status ${['failed','unavailable','reauthorize','sub'].includes(value)?'warning':['connected','available','success','main'].includes(value)?'positive':''}`}>{statusNames[value]||value}</span>}
function Modal({title,children,close}:{title:string;children:ReactNode;close:()=>void}) {
  useEffect(()=>{const escape=(event:KeyboardEvent)=>{if(event.key==='Escape')close()};window.addEventListener('keydown',escape);return()=>window.removeEventListener('keydown',escape)},[close])
  return <div className="dialog-layer shop-dialog"><button className="drawer-scrim" onClick={close} aria-label="关闭对话框"/><section role="dialog" aria-modal="true" aria-label={title} className="shop-modal"><header><h2>{title}</h2><button title="关闭" onClick={close}><X size={18}/></button></header>{children}</section></div>
}

export default function PerformancePage({user,initialView='comparison'}:{user:SessionUser;initialView?:View}) {
  const [view,setView]=useState<View>(initialView)
  const [shop,setShop]=useState(''),[range,setRange]=useState(()=>presetRange('7d')),[preset,setPreset]=useState<Preset|'custom'>('7d')
  useAiFocusPart({ connectionId: shop || undefined, view })
  const [connections,setConnections]=useState<PerformanceConnection[]>([]),[configured,setConfigured]=useState(false)
  const [operations,setOperations]=useState<PerformanceOperation[]>([]),[page,setPage]=useState(1)
  const [settings,setSettings]=useState<PerformanceSettings|null>(null),[draft,setDraft]=useState({windowHours:'',thresholdSeconds:'',countOther:false,workHours:true,workStart:'09:00',workEnd:'22:00',scheme:'order_first' as AttributionScheme,orderShare:'50',ownerShare:'50',autoOwner:true})
  const [loading,setLoading]=useState(true),[busy,setBusy]=useState(''),[error,setError]=useState(''),[notice,setNotice]=useState('')
  const [authUrl,setAuthUrl]=useState(''),[callbackUrl,setCallbackUrl]=useState(''),[disable,setDisable]=useState<PerformanceConnection|null>(null),[remove,setRemove]=useState<PerformanceConnection|null>(null)
  const canRead=permission(user,'performance:read')||permission(user,'performance:read_own'),canReadAll=permission(user,'performance:read'),canPayrollRead=permission(user,'payroll:read'),canManage=permission(user,'performance:manage'),canPayroll=permission(user,'payroll:manage')
  const applySettings=(data:PerformanceSettings)=>{setSettings(data);setDraft({windowHours:String(data.attribution_window_hours),thresholdSeconds:String(data.unanswered_threshold_seconds),countOther:data.count_other_as_reply,workHours:data.work_hours_enabled,workStart:data.work_start,workEnd:data.work_end,scheme:data.default_scheme,orderShare:String(Math.round(data.split_order_share*100)),ownerShare:String(Math.round(data.owner_share*100)),autoOwner:data.auto_assign_owner})}
  const load=useCallback(async()=>{
    if(!canRead){setLoading(false);return}
    setLoading(true);setError('')
    try {
      if(view==='connections'||reportViews.includes(view)){const result=await getPerformanceConnections();setConnections(result.data);setConfigured(result.configured)
        setShop(current=>result.data.some(c=>c.id===current)?current:(result.data.find(c=>c.status==='connected')||result.data[0])?.id||'')}
      if(view==='settings')applySettings((await getPerformanceSettings()).data)
      if(view==='operations')setOperations((await getPerformanceOperations(page)).data)
    } catch(cause){setError(message(cause))} finally {setLoading(false)}
  },[canRead,view,page])
  useEffect(()=>{void load()},[load])
  async function action(name:string,run:()=>Promise<unknown>,success:string){setBusy(name);setError('');try{await run();setNotice(success);await load()}catch(cause){setError(message(cause));await load()}finally{setBusy('')}}
  async function authorize(){setBusy('authorize');setError('');try{setAuthUrl((await startPerformanceAuthorization()).data.authorizationUrl);setCallbackUrl('')}catch(cause){setError(message(cause))}finally{setBusy('')}}
  async function save(part:'metrics'|'scheme'){
    if(!settings)return
    const windowHours=Number(draft.windowHours),thresholdSeconds=Number(draft.thresholdSeconds)
    if(part==='metrics'&&(!Number.isInteger(windowHours)||windowHours<1||windowHours>720))return setError('询单归属窗口需为 1–720 之间的整数小时。')
    if(part==='metrics'&&(!Number.isInteger(thresholdSeconds)||thresholdSeconds<10||thresholdSeconds>86400))return setError('未回复判定需为 10–86400 之间的整数秒。')
    if(part==='metrics'&&draft.workHours&&!(draft.workStart<draft.workEnd))return setError('上班时间需早于下班时间。')
    const orderShare=Number(draft.orderShare),ownerShare=Number(draft.ownerShare)
    if(part==='scheme'&&[orderShare,ownerShare].some(v=>!Number.isInteger(v)||v<10||v>90))return setError('分成比例需为 10–90 之间的整数百分比。')
    setBusy(part);setError('')
    try{
      applySettings((await savePerformanceSettings(part==='metrics'?{revision:settings.revision,attributionWindowHours:windowHours,unansweredThresholdSeconds:thresholdSeconds,countOtherAsReply:draft.countOther,workHoursEnabled:draft.workHours,workStart:draft.workStart,workEnd:draft.workEnd}:{revision:settings.revision,defaultScheme:draft.scheme,splitOrderShare:orderShare/100,ownerShare:ownerShare/100,autoAssignOwner:draft.autoOwner})).data)
      setNotice(part==='metrics'?'指标口径已保存':'绩效方案已保存，订单归属正在后台重算')
    }catch(cause){setError(message(cause))}finally{setBusy('')}
  }
  if(!canRead)return <section className="state-card"><ShieldCheck size={28}/><h2>暂无客服绩效访问权限</h2></section>
  return <div className="shop-workspace performance-page">
    <div className="shop-toolbar"><nav className="shop-tabs" aria-label="客服绩效视图">{tabs.filter(([id])=>id==='payroll'?canPayrollRead:canReadAll||reportViews.includes(id)).map(([id,label])=><button key={id} aria-current={view===id?'page':undefined} className={view===id?'active':''} onClick={()=>{setView(id);setPage(1)}}>{label}</button>)}</nav></div>
    {notice&&<div className="shop-feedback" role="status"><CheckCircle2 size={16}/><span>{notice}</span><button title="关闭提示" onClick={()=>setNotice('')}><X size={15}/></button></div>}
    {error&&<div className="shop-feedback error" role="alert"><AlertCircle size={16}/><span>{error}</span><button title="关闭错误" onClick={()=>setError('')}><X size={15}/></button></div>}
    {reportViews.includes(view)&&!loading&&<div className="shop-controlbar perf-filters">
      <div className="shop-select"><Store size={17}/><select aria-label="店铺" value={shop} onChange={e=>setShop(e.target.value)}>{!connections.length&&<option value="">暂无授权店铺</option>}{connections.map(c=><option key={c.id} value={c.id}>{c.display_name}</option>)}</select></div>
      {datedViews.includes(view)&&<div className="perf-range"><nav className="perf-metric-tabs" aria-label="日期范围">{presets.map(([id,label])=><button key={id} aria-pressed={preset===id} className={preset===id?'active':''} onClick={()=>{setPreset(id);setRange(presetRange(id))}}>{label}</button>)}</nav>
        <input type="date" aria-label="开始日期" value={range.from} max={range.to} onChange={e=>{if(e.target.value){setPreset('custom');setRange({...range,from:e.target.value})}}}/><span>至</span><input type="date" aria-label="结束日期" value={range.to} min={range.from} max={presetRange('today').to} onChange={e=>{if(e.target.value){setPreset('custom');setRange({...range,to:e.target.value})}}}/></div>}
    </div>}
    {reportViews.includes(view)&&!loading&&!shop&&<div className="shop-empty"><Store size={28}/><p>请先在“绩效应用授权”中授权店铺</p></div>}
    {view==='coaching'&&!loading&&shop&&<AgentCoachingView user={user} connectionId={shop} setError={setError}/>}
    {reportViews.includes(view)&&view!=='coaching'&&!loading&&shop&&(view==='comparison'?<ComparisonView connectionId={shop} from={range.from} to={range.to} setError={setError}/>:view==='hourly'?<HourlyView connectionId={shop} from={range.from} to={range.to} setError={setError}/>:view==='kpi'?<KpiView connectionId={shop} from={range.from} to={range.to} canManage={canManage} setError={setError} setNotice={setNotice}/>:view==='favorites'?<FavoritesView connectionId={shop} from={range.from} to={range.to} setError={setError} setNotice={setNotice}/>:view==='payroll'?<PayrollView connectionId={shop} canManage={canPayroll} setError={setError} setNotice={setNotice}/>:view==='chats'?<ChatAnalysisView connectionId={shop} from={range.from} to={range.to} setError={setError}/>:view==='quality'?<QualityView connectionId={shop} from={range.from} to={range.to} setError={setError}/>:view==='keywords'?<KeywordsView connectionId={shop} from={range.from} to={range.to} canManage={canManage} setError={setError} setNotice={setNotice}/>:view==='orders'?<OrdersView connectionId={shop} from={range.from} to={range.to} setError={setError}/>:<AgentsView connectionId={shop} canManage={canManage} canPayroll={canPayroll} setError={setError} setNotice={setNotice}/>)}
    {view==='connections'&&<div className="shop-controlbar"><p className="shop-note">绩效应用独立于商品应用，需要用店铺<b>主账号</b>单独授权；两者的令牌互不通用。</p><div className="shop-commandbar">
      {canManage&&<button className="shop-button primary" disabled={!configured||Boolean(busy)} onClick={()=>void authorize()}><Link2 size={16}/>授权绩效应用</button>}
      <button className="shop-icon" title="刷新当前视图" aria-label="刷新当前视图" disabled={Boolean(busy)} onClick={()=>void load()}><RefreshCw size={17}/></button>
    </div></div>}
    {view==='connections'&&!loading&&!configured&&<p className="shop-note">服务器尚未配置绩效应用（ALI1688_PERFORMANCE_*），配置后重启 API。</p>}
    {loading?<div className="shop-empty"><LoaderCircle size={26} className="spin"/><p>正在读取…</p></div>:!reportViews.includes(view)&&<>
      {view==='connections'&&<div className="shop-table-scroll"><table className="shop-table"><thead><tr><th>店铺 / 账号</th><th>连接状态</th><th>账号类型</th><th>子账号</th><th>接口验证</th><th>访问令牌有效期</th><th>操作</th></tr></thead><tbody>{connections.map(c=><tr key={c.id}>
        <td><strong>{c.display_name}</strong><small>{c.login_id||c.member_id}</small></td><td><Status value={c.status}/></td><td><Status value={c.account_role}/></td>
        <td>{c.sub_account_count??'—'}</td><td><Status value={c.member_capability}/><small>{time(c.last_tested_at)}</small></td><td>{time(c.access_expires_at)}</td>
        <td><div className="shop-row-actions">{canManage&&<>
          <button title="验证主账号与子账号接口" aria-label={`验证 ${c.display_name}`} disabled={Boolean(busy)||c.status!=='connected'} onClick={()=>void action(c.id,()=>testPerformanceConnection(c.id),'绩效应用验证成功')}><ShieldCheck size={17}/></button>
          <button title="刷新访问令牌" aria-label={`刷新 ${c.display_name}`} disabled={Boolean(busy)||c.status!=='connected'} onClick={()=>void action(c.id,()=>refreshPerformanceToken(c.id),'访问令牌已刷新')}><RefreshCw size={17}/></button>
          <button title="停用连接" aria-label={`停用 ${c.display_name}`} disabled={Boolean(busy)||c.status==='disabled'} onClick={()=>setDisable(c)}><Power size={17}/></button>
          <button title={c.status==='disabled'?'删除连接':'先停用，再删除'} aria-label={`删除 ${c.display_name}`} disabled={Boolean(busy)||c.status!=='disabled'} onClick={()=>setRemove(c)}><Trash2 size={17}/></button>
        </>}</div></td></tr>)}</tbody></table>{!connections.length&&<div className="shop-empty"><Store size={28}/><p>尚未授权绩效应用</p></div>}</div>}
      {view==='settings'&&settings&&<section className="shop-comparison publish-template-settings" aria-label="指标口径">
        <div className="shop-sku-heading"><h3>指标口径</h3></div>
        <div className="shop-form-columns">
          <label>询单归属窗口（小时）<input type="number" min={1} max={720} step={1} value={draft.windowHours} disabled={!canManage||Boolean(busy)} onChange={e=>setDraft({...draft,windowHours:e.target.value})}/></label>
          <label>未回复判定（秒）<input type="number" min={10} max={86400} step={1} value={draft.thresholdSeconds} disabled={!canManage||Boolean(busy)} onChange={e=>setDraft({...draft,thresholdSeconds:e.target.value})}/></label>
        </div>
        <label className="perf-toggle"><input type="checkbox" checked={draft.countOther} disabled={!canManage||Boolean(busy)} onChange={e=>setDraft({...draft,countOther:e.target.checked})}/>客服发出的“其他消息”（平台不提供内容，多为图片、商品卡片或机器人消息）计为人工回复</label>
        <label className="perf-toggle"><input type="checkbox" checked={draft.workHours} disabled={!canManage||Boolean(busy)} onChange={e=>setDraft({...draft,workHours:e.target.checked})}/>按客服工作时段计算响应时间</label>
        {draft.workHours&&<div className="shop-form-columns">
          <label>上班时间（北京时间）<input type="time" value={draft.workStart} disabled={!canManage||Boolean(busy)} onChange={e=>setDraft({...draft,workStart:e.target.value})}/></label>
          <label>下班时间（北京时间）<input type="time" value={draft.workEnd} disabled={!canManage||Boolean(busy)} onChange={e=>setDraft({...draft,workEnd:e.target.value})}/></label>
        </div>}
        <p className="shop-note">{draft.workHours?`${draft.workStart} 前或 ${draft.workEnd} 后进来的咨询，响应时间和未回复从下一次上班时间开始计算；若客服在上班前已回复，按实际等待时间计算。`:'响应时间按买家发消息到客服回复的实际时间计算，夜间咨询会拉高平均值。'}</p>
        <p className="shop-note">买家咨询后 {draft.windowHours||'—'} 小时内下单计入询单转化；买家消息超过 {Number(draft.thresholdSeconds)>0?duration(Number(draft.thresholdSeconds)):'—'} 仍无客服回复，计 1 次未回复。修改后历史报表即时按新口径统计，订单归属会在后台自动重算。</p>
        {canManage&&<button className="shop-button primary" disabled={Boolean(busy)} onClick={()=>void save('metrics')}><Save size={16}/>保存指标口径</button>}
        <div className="shop-sku-heading performance-section"><h3>默认绩效方案</h3></div>
        <div className="shop-form-columns"><label>订单绩效归属<select value={draft.scheme} disabled={!canPayroll||Boolean(busy)} onChange={e=>setDraft({...draft,scheme:e.target.value as AttributionScheme})}>{Object.entries(attributionSchemeNames).map(([value,label])=><option key={value} value={value} disabled={!availableSchemes.includes(value as AttributionScheme)}>{label}</option>)}</select></label>
          <label>方案7：促成下单客服分成（%）<input type="number" min={10} max={90} step={1} value={draft.orderShare} disabled={!canPayroll||Boolean(busy)} onChange={e=>setDraft({...draft,orderShare:e.target.value})}/></label>
          <label>方案9：所属客服分成（%）<input type="number" min={10} max={90} step={1} value={draft.ownerShare} disabled={!canPayroll||Boolean(busy)} onChange={e=>setDraft({...draft,ownerShare:e.target.value})}/></label>
        </div>
        <label className="perf-toggle"><input type="checkbox" checked={draft.autoOwner} disabled={!canPayroll||Boolean(busy)} onChange={e=>setDraft({...draft,autoOwner:e.target.checked})}/>未手动指定所属客服的客户，自动归给首次促成付款的客服（方案8、9 使用）</label>
        <p className="shop-note">方案7：下单与付款不是同一客服时，下单客服得 {draft.orderShare||'—'}%，付款客服得其余部分。方案9：所属客服得 {draft.ownerShare||'—'}%，促成下单的协作客服得其余部分；同一人或只有一方时全部归他。方案5：备注中“@客服名”优先，否则按“客服账号”页设置的旗帜对应客服。</p>
        <p className="shop-note">绩效方案、分成比例和所属客服规则决定订单与提成归属，仅财务权限账号可修改；保存后订单归属在后台重算，可在“订单归属”中对比各方案结果。</p>
        {canPayroll&&<button className="shop-button primary" disabled={Boolean(busy)} onClick={()=>void save('scheme')}><Save size={16}/>保存绩效方案与分成</button>}
        <p className="shop-note">版本 {settings.revision} · 更新于 {time(settings.updated_at)}</p>
      </section>}
      {view==='operations'&&<div className="shop-table-scroll"><table className="shop-table"><thead><tr><th>时间</th><th>店铺</th><th>接口 / 操作</th><th>结果</th><th>错误码</th><th>耗时</th></tr></thead><tbody>{operations.map(item=><tr key={item.id}><td>{time(item.created_at)}</td><td>{item.display_name||'—'}</td><td><code>{item.api_name}</code></td><td><Status value={item.outcome}/></td><td>{item.error_code||'—'}</td><td>{item.duration_ms} ms</td></tr>)}</tbody></table>{!operations.length&&<div className="shop-empty"><Store size={28}/><p>暂无调用记录</p></div>}</div>}
    </>}
    {view==='operations'&&<div className="shop-pagination"><button className="shop-icon" title="上一页" disabled={loading||page===1} onClick={()=>setPage(p=>p-1)}><ChevronLeft size={17}/></button><span>第 {page} 页</span><button className="shop-icon" title="下一页" disabled={loading||operations.length<50} onClick={()=>setPage(p=>p+1)}><ChevronRight size={17}/></button></div>}
    {authUrl&&<Modal title="授权 1688 绩效应用" close={()=>setAuthUrl('')}><div className="shop-modal-body"><p className="shop-note">请使用店铺主账号登录授权，子账号授权无法读取全部客服数据。</p><a className="shop-button primary" href={authUrl} target="_blank" rel="noreferrer">前往 1688 授权 <ExternalLink size={16}/></a><label>完整回跳地址<input value={callbackUrl} onChange={e=>setCallbackUrl(e.target.value)} autoComplete="off" placeholder="https://…?code=…&state=…"/></label><p className="shop-note">授权码有效期 2 分钟</p></div><footer><button className="shop-button" onClick={()=>setAuthUrl('')}>取消</button><button className="shop-button primary" disabled={!callbackUrl||Boolean(busy)} onClick={()=>void action('complete',async()=>{await completePerformanceAuthorization(callbackUrl);setAuthUrl('');setCallbackUrl('')},'绩效应用授权完成，请点击验证确认主账号')}><CheckCircle2 size={16}/>完成授权</button></footer></Modal>}
    {remove&&<ConnectionDelete name={remove.display_name} account={remove.login_id||remove.member_id} close={()=>setRemove(null)} done={()=>{setRemove(null);setNotice('绩效应用连接已删除');void load()}} remove={()=>deletePerformanceConnection(remove.id)}
      impact={async()=>{const u=(await getPerformanceConnectionUsage(remove.id)).data,kept=[u.followups&&`${u.followups} 条跟进记录`,u.attachments&&`${u.attachments} 个客户附件`,u.locked_payrolls&&`${u.locked_payrolls} 期已锁定工资单`].filter(Boolean)
        return{blocked:kept.length?`这个店铺有 ${kept.join('、')}，需要保留，不能删除；保持停用即可。`:null,
          removes:[u.orders&&`${u.orders} 笔订单`,u.sessions&&`${u.sessions} 个聊天会话`,u.buyers&&`${u.buyers} 位买家及其客户资料`,u.agents&&`${u.agents} 个客服账号及提成规则`,u.payrolls&&`${u.payrolls} 期未锁定的工资单草稿`].filter((x):x is string=>Boolean(x))}}}/>}
    {disable&&<Modal title="停用绩效连接" close={()=>setDisable(null)}><div className="shop-modal-body"><p>{disable.display_name} 的绩效数据将停止同步，商品应用连接不受影响，历史记录保留。</p></div><footer><button className="shop-button" onClick={()=>setDisable(null)}>取消</button><button className="shop-button danger" disabled={Boolean(busy)} onClick={()=>void action('disable',async()=>{await disablePerformanceConnection(disable.id);setDisable(null)},'绩效连接已停用')}>停用连接</button></footer></Modal>}
  </div>
}
