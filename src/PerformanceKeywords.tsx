import { buyerLabel } from './buyerLabel'
import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Note } from './ui'
import { Check, LoaderCircle, MessageSquareText, Plus, RefreshCw, Tags, X } from 'lucide-react'
import { Drawer, Timeline, WangwangButton } from './PerformanceAnalysis'
import {
  addKeywords, deleteKeyword, getChatDetail, getKeywordHits, getKeywords, reconcileKeywords, setKeywordCategory,
  type ChatDetail, type KeywordHit, type KeywordPreset, type KeywordRecent, type PerfKeyword,
} from './performanceApi'

const message = (cause:unknown) => cause instanceof Error ? cause.message : '操作未完成，请稍后重试。'
const dateTime = (value:string) => new Date(value).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'})
const day = (value:string) => new Date(value).toLocaleDateString('zh-CN',{month:'2-digit',day:'2-digit'})

/**
 * 关键词库: the shop's Wangwang keyword list on 1688 and the hits it produces. Buyer text is masked by the platform,
 * so keyword hits are the only way to see what buyers ask about; 1688 marks only messages sent after a word is added.
 */
export function KeywordsView({connectionId,from,to,canManage,setError,setNotice}:{connectionId:string;from:string;to:string;canManage:boolean;setError:(text:string)=>void;setNotice:(text:string)=>void}) {
  const [keywords,setKeywords]=useState<PerfKeyword[]>([]),[presets,setPresets]=useState<KeywordPreset[]>([]),[hits,setHits]=useState<{words:KeywordHit[];recent:KeywordRecent[]}|null>(null)
  const [loading,setLoading]=useState(true),[busy,setBusy]=useState(''),[word,setWord]=useState(''),[offerId,setOfferId]=useState(''),[category,setCategory]=useState('售后退款')
  const [detail,setDetail]=useState<{buyerId:string;title:string;focus:string;data:ChatDetail}|null>(null)
  const load=useCallback(async()=>{
    try{const [k,h]=await Promise.all([getKeywords(connectionId),getKeywordHits(connectionId,from,to)]);setKeywords(k.data);setPresets(k.presets);setHits(h.data)}
    catch(cause){setError(message(cause))}finally{setLoading(false)}
  },[connectionId,from,to,setError])
  useEffect(()=>{setLoading(true);void load()},[load])
  const categories=[...new Set([...presets.map(p=>p.category),...keywords.map(k=>k.category),'其他'])]
  const have=new Set(keywords.filter(k=>k.on_platform).map(k=>k.word.toLowerCase()))
  async function add(words:{word:string;category:string;offerId?:string}[]){
    setBusy('add');setError('')
    try{const r=(await addKeywords(connectionId,words)).data;setKeywords(r.keywords)
      const parts=[r.added.length&&`已添加 ${r.added.length} 个`,r.skipped.length&&`${r.skipped.length} 个已存在`].filter(Boolean)
      if(r.failed.length)setError(`${r.failed.map(f=>`“${f.word}”`).join('、')} 添加失败：${r.failed[0].message}`)
      if(parts.length)setNotice(`${parts.join('，')}；新词从现在起对新消息生效`)
      setWord('');setOfferId('')
    }catch(cause){setError(message(cause))}finally{setBusy('')}
  }
  async function submit(event:FormEvent){event.preventDefault();if(word.trim())await add([{word:word.trim(),category,...(offerId.trim()?{offerId:offerId.trim()}:{})}])}
  async function remove(k:PerfKeyword){if(!window.confirm(`从 1688 词库删除“${k.word}”？已统计的历史命中保留。`))return;setBusy(k.id);setError('');try{setKeywords((await deleteKeyword(k.id)).data);setNotice(`已删除“${k.word}”`)}catch(cause){setError(message(cause))}finally{setBusy('')}}
  async function recategorize(k:PerfKeyword,next:string){setBusy(k.id);try{setKeywords((await setKeywordCategory(k.id,next)).data)}catch(cause){setError(message(cause))}finally{setBusy('')}}
  async function reconcile(){setBusy('sync');setError('');try{const r=(await reconcileKeywords(connectionId)).data;setKeywords(r.keywords);setNotice(`平台词库共 ${r.platform} 个词${r.imported?`，导入 ${r.imported} 个`:''}${r.missing.length?`，${r.missing.length} 个已不在平台`:''}`)}catch(cause){setError(message(cause))}finally{setBusy('')}}
  async function open(row:KeywordRecent){try{setDetail({buyerId:row.buyer_id,title:`${row.login_id.split(':').pop()} · ${row.chat_date} · ${buyerLabel(row)}`,focus:row.uuid,data:(await getChatDetail(row.session_id)).data})}catch(cause){setError(message(cause))}}
  if(loading)return <div className="shop-empty"><LoaderCircle size={26} className="spin"/><p>正在读取…</p></div>
  const grouped=categories.map(c=>({category:c,items:keywords.filter(k=>k.category===c)})).filter(g=>g.items.length)
  const firstAdded=keywords.length?keywords.map(k=>k.created_at).sort()[0]:null
  return <section className="perf-report perf-keywords" aria-label="关键词">
    <Note>买家消息正文被 1688 隐藏，关键词是了解买家在问什么的唯一途径：平台在消息发送时按词库标记命中，<b>新加的词只对之后的新消息生效</b>，历史消息不会补标。词库保存在 1688，对该店铺所有客服账号生效。</Note>
    <div className="perf-kw-grid">
      <div className="perf-kw-card">
        <header><h3><Tags size={17}/>当前词库 <span>{keywords.filter(k=>k.on_platform).length}</span></h3>{canManage&&<button className="shop-button" disabled={Boolean(busy)} onClick={()=>void reconcile()}>{busy==='sync'?<LoaderCircle size={15} className="spin"/>:<RefreshCw size={15}/>}与平台核对</button>}</header>
        {canManage&&<form className="perf-kw-add" onSubmit={e=>void submit(e)}><input aria-label="关键词" value={word} maxLength={20} placeholder="输入关键词，如：退款" onChange={e=>setWord(e.target.value)}/>
          <input aria-label="关联商品 ID（选填）" inputMode="numeric" value={offerId} maxLength={30} placeholder="货号或型号词可填商品 ID，用于关联询盘商品" onChange={e=>setOfferId(e.target.value)}/>
          <select aria-label="分类" value={category} onChange={e=>setCategory(e.target.value)}>{categories.map(c=><option key={c}>{c}</option>)}</select>
          <button className="shop-button primary" disabled={!word.trim()||Boolean(busy)}>{busy==='add'?<LoaderCircle size={15} className="spin"/>:<Plus size={15}/>}添加</button></form>}
        {grouped.length?grouped.map(g=><div className="perf-kw-group" key={g.category}><small>{g.category}</small><div>{g.items.map(k=><span key={k.id} className={`perf-kw-chip ${k.on_platform?'':'missing'}`} title={`${k.created_by_name?`${k.created_by_name} 添加于 `:'添加于 '}${day(k.created_at)}${k.on_platform?'':' · 已不在平台词库'}`}>
          {k.word}{canManage&&<select aria-label={`${k.word} 的分类`} value={k.category} disabled={Boolean(busy)} onChange={e=>void recategorize(k,e.target.value)}>{categories.map(c=><option key={c}>{c}</option>)}</select>}
          {canManage&&<button aria-label={`删除 ${k.word}`} title="删除" disabled={Boolean(busy)} onClick={()=>void remove(k)}>{busy===k.id?<LoaderCircle size={12} className="spin"/>:<X size={12}/>}</button>}</span>)}</div></div>)
          :<div className="shop-empty"><Tags size={26}/><p>词库还是空的{canManage?'，可从右侧常用词一键添加':''}</p></div>}
      </div>
      {canManage&&<div className="perf-kw-card">
        <header><h3>常用词推荐</h3></header>
        {presets.map(p=>{const missing=p.words.filter(w=>!have.has(w.toLowerCase()));return <div className="perf-kw-preset" key={p.category}>
          <div><b>{p.category}</b><small>{p.hint}</small><p>{p.words.map(w=><span key={w} className={have.has(w.toLowerCase())?'on':''}>{have.has(w.toLowerCase())&&<Check size={11}/>}{w}</span>)}</p></div>
          <button className="shop-button" disabled={!missing.length||Boolean(busy)} onClick={()=>void add(missing.map(w=>({word:w,category:p.category})))}>{missing.length?`添加 ${missing.length} 个`:'已全部添加'}</button></div>})}
      </div>}
    </div>
    <h3 className="perf-chart-title">本期命中统计</h3>
    {hits&&hits.words.length?<div className="shop-table-scroll"><table className="shop-table"><thead><tr><th>关键词</th><th>分类</th><th>买家提到</th><th>客服提到</th><th>会话数</th><th>涉及买家</th><th>最近命中</th></tr></thead>
      <tbody>{hits.words.map(h=><tr key={h.word}><td><strong>{h.word}</strong></td><td>{h.category}</td><td>{h.buyer_hits}</td><td>{h.agent_hits}</td><td>{h.sessions}</td><td>{h.buyers}</td><td>{dateTime(h.last_hit)}</td></tr>)}</tbody></table></div>
      :<p className="shop-note">{keywords.length?`本期还没有命中。${firstAdded?`词库最早在 ${day(firstAdded)} 添加，`:''}之后买家或客服的新消息里出现这些词就会出现在这里（每次同步后更新）。`:'添加关键词后，这里会统计买家和客服提到每个词的次数。'}</p>}
    {hits&&hits.recent.length>0&&<><h3 className="perf-chart-title">最近命中</h3><div className="shop-table-scroll"><table className="shop-table"><thead><tr><th>时间</th><th>关键词</th><th>谁提到</th><th>客服</th><th>买家</th><th/></tr></thead>
      <tbody>{hits.recent.map(r=><tr key={`${r.uuid}-${r.word}`}><td>{dateTime(r.sent_at)}</td><td><strong>{r.word}</strong><small>{r.category}</small></td><td>{r.direction===1?<span className="shop-status warning">买家</span>:<span className="shop-status">客服</span>}</td>
        <td>{r.login_id.split(':').pop()}</td><td>{buyerLabel(r)}</td>
        <td className="perf-row-actions"><WangwangButton buyerId={r.buyer_id} setError={setError}/><button className="shop-icon" title="查看会话" aria-label={`查看 ${r.chat_date} 会话`} onClick={()=>void open(r)}><MessageSquareText size={16}/></button></td></tr>)}</tbody></table></div></>}
    {detail&&<Drawer title={detail.title} close={()=>setDetail(null)}><div className="perf-drawer-actions"><WangwangButton buyerId={detail.buyerId} setError={setError} label="旺旺联系买家"/></div><Timeline data={detail.data} focus={detail.focus}/></Drawer>}
  </section>
}
