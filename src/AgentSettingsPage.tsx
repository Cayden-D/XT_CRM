import PublishTemplateSettings from './PublishTemplateSettings'
import { ImageAutomationSettings } from './ImageWorkshop'
import { useEffect, useState } from 'react'
import { AlertCircle, Bot, LoaderCircle, X } from 'lucide-react'
import { getAgentQueue, getAgentSettings, setAgentQueueSetting, setAgentSetting, testAgentModel, type AgentQueueSetting, type AgentSetting } from './1688Api'
import type { SessionUser } from './api'
import './1688.css'

type Pending = { kind: 'agent'; shop: AgentSetting } | { kind: 'queue'; shop: AgentQueueSetting }

/** 设置 → 自动上架: the two per-shop switches side by side, then the rules drafts are filled with. */
export default function AgentSettingsPage({user}:{user:SessionUser}){
  const [shops,setShops]=useState<AgentSetting[]>([]),[queue,setQueue]=useState<AgentQueueSetting[]>([]),[configured,setConfigured]=useState(false),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(''),[pending,setPending]=useState<Pending|null>(null),[confirmed,setConfirmed]=useState(false),[modelConnected,setModelConnected]=useState(false)
  const has=(name:string)=>(user.permissions||[]).some(p=>p==='*'||p===name||p==='integration:*')
  const editable=has('integration:publish')&&has('integration:manage')
  async function testModel(){setBusy(true);setError('');setModelConnected(false);try{await testAgentModel();setModelConnected(true)}catch(error){setError(error instanceof Error?error.message:'模型测试失败。')}finally{setBusy(false)}}
  async function load(){setLoading(true);setError('');try{const [agent,jobs]=await Promise.all([getAgentSettings(),getAgentQueue({page:1,pageSize:1})]);setShops(agent.data);setConfigured(agent.configured);setQueue(jobs.data.settings)}catch(error){setError(error instanceof Error?error.message:'配置读取失败。')}finally{setLoading(false)}}
  useEffect(()=>{void load()},[])
  async function saveAgent(shop:AgentSetting,enabled:boolean){setBusy(true);setError('');try{await setAgentSetting(shop.id,enabled,shop.revision);setPending(null);setConfirmed(false);await load()}catch(error){setError(error instanceof Error?error.message:'设置保存失败。')}finally{setBusy(false)}}
  async function saveQueue(shop:AgentQueueSetting,enabled:boolean){setBusy(true);setError('');try{await setAgentQueueSetting(shop.id,enabled,shop.revision);setPending(null);setConfirmed(false);await load()}catch(error){setError(error instanceof Error?error.message:'设置保存失败。')}finally{setBusy(false)}}
  return <div className="shop-page settings-sections">
    <section>
      <div className="settings-head"><h3>店铺开关</h3><span className="settings-status">{modelConnected?'模型连接成功':configured?'模型已配置':'模型未配置'}</span><button className="ui-link" disabled={!editable||!configured||busy} onClick={()=>void testModel()}>测试连接</button></div>
      {error&&<p className="shop-alert error" role="alert"><AlertCircle size={16}/>{error}</p>}
      {loading?<div className="shop-empty"><LoaderCircle className="spin"/></div>:<div className="shop-table-scroll"><table className="shop-table"><thead><tr><th>店铺</th><th>AI 填写并发布草稿</th><th>采集后自动上架</th></tr></thead><tbody>{shops.map(shop=>{const auto=queue.find(q=>q.id===shop.id);return <tr key={shop.id}>
        <td><strong>{shop.display_name}</strong>{shop.status!=='connected'&&<small>未连接</small>}</td>
        <td><label className="agent-switch"><input type="checkbox" role="switch" aria-label={`${shop.display_name} AI 填写并发布草稿`} checked={shop.enabled} disabled={!editable||busy||(!shop.enabled&&(!configured||shop.status!=='connected'))} onChange={e=>{if(e.target.checked){setPending({kind:'agent',shop});setConfirmed(false)}else void saveAgent(shop,false)}}/><span>{shop.enabled?'开启':'关闭'}</span></label></td>
        <td>{auto&&<label className="agent-switch" title={auto.enabled||shop.enabled?undefined:'需要先开启“AI 填写并发布草稿”'}><input type="checkbox" role="switch" aria-label={`${shop.display_name} 采集后自动上架`} checked={auto.enabled} disabled={!editable||busy||(!auto.enabled&&(!auto.agent_enabled||auto.connection_status!=='connected'))} onChange={e=>{if(e.target.checked){setPending({kind:'queue',shop:auto});setConfirmed(false)}else void saveQueue(auto,false)}}/><span>{auto.enabled?'开启':'关闭'}</span></label>}</td>
      </tr>})}</tbody></table>{!shops.length&&<p className="shop-note">还没有授权商品应用的店铺。</p>}</div>}
    </section>
    <ImageAutomationSettings editable={editable}/>
    <PublishTemplateSettings editable={editable}/>
    {pending&&<div className="dialog-layer shop-dialog"><button className="drawer-scrim" aria-label="取消开启" disabled={busy} onClick={()=>setPending(null)}/><section className="shop-modal" role="dialog" aria-modal="true" aria-label={pending.kind==='agent'?'开启 AI 填写并发布草稿':'开启采集后自动上架'}><header><h2>{pending.kind==='agent'?'开启 AI 填写并发布草稿':'开启采集后自动上架'}</h2><button title="关闭" disabled={busy} onClick={()=>setPending(null)}><X size={18}/></button></header><div className="shop-modal-body"><p>目标店铺：{pending.shop.display_name}</p>
      {pending.kind==='agent'?<><p>开启后，新建发布草稿将自动检测、填写并提交平台。检测到水印、疑似权利风险或资料不足时中止。</p><p>AI 筛查不等于法律侵权认定或图片授权证明；请确认商品及图片使用权。图片与商品资料将发送至阿里云百炼。</p></>:<p>新采集的 1688 商品将排队筛查，资料齐全时自动提交平台。价格、库存、类目或图片存在不确定性时中止；平台审核结果需另行核对。</p>}
      <label className="shop-review-check"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)} disabled={busy}/>{pending.kind==='agent'?'确认使用权与资料传输，并授权该店铺自动发布':'确认商品及全部图片使用权，并授权该店铺自动提交'}</label></div>
      <footer><button className="shop-button" disabled={busy} onClick={()=>setPending(null)}>取消</button><button className="shop-button primary" disabled={busy||!confirmed} onClick={()=>void (pending.kind==='agent'?saveAgent(pending.shop,true):saveQueue(pending.shop,true))}><Bot size={16}/>确认开启</button></footer></section></div>}
  </div>
}
