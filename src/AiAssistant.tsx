import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Bot, CalendarClock, Check, ChevronLeft, Command, Database, History, LoaderCircle, Mic, Plus, Send, Sparkles, Tag, Trash2, UserRoundCog, X } from 'lucide-react'
import { ApiError, confirmAiAction, deleteAiConversation, getAiConversation, getAiConversations, getAiModels, rejectAiAction, sendAiMessage, type AiAction, type AiConversation, type AiMessage, type AiModel } from './api'
import { DATA_CHANGED, useAiFocus } from './aiFocus'

const toolNames: Record<string, string> = {
  get_business_overview: '经营概览', list_customers: '客户列表', get_customer: '客户资料', get_agent_performance: '客服绩效', get_top_products: '商品销量', get_reply_quality: '回复质量', get_keyword_hits: '关键词命中', get_customer_options: '标签与客服', propose_followup: '拟写跟进', propose_tags: '拟改标签', propose_owner: '拟改所属客服',
}
const suggestions: Record<string, string[]> = {
  dashboard: ['总结近 7 天经营情况，和上一周期比有什么变化？', '今天最该先处理哪几件事？'],
  customerOps: ['今天该优先跟进哪些客户？给出理由和话术', '下单未付款的客户怎么催付？'],
  performance: ['近 7 天哪个客服表现最好？谁需要改进？', '近 7 天有没有站外交易风险？客服话术有什么问题？', '买家最近都在问什么？哪些需要马上处理？'],
}
const fallback = ['总结近 7 天经营情况', '今天该优先跟进哪些客户？', '近 7 天卖得最好的商品是哪些？']

/** Minimal Markdown (headings, lists, tables, bold, inline code) rendered as React nodes — never as HTML. */
function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean).map((part, i) =>
    part.startsWith('**') && part.endsWith('**') ? <strong key={i}>{part.slice(2, -2)}</strong> : part.startsWith('`') && part.endsWith('`') ? <code key={i}>{part.slice(1, -1)}</code> : part)
}
export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r/g, '').split('\n'), out: ReactNode[] = []
  for (let i = 0; i < lines.length;) {
    const line = lines[i]
    if (!line.trim()) { i++; continue }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const rows: string[][] = []
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { if (!/^\s*\|[\s:|-]+\|\s*$/.test(lines[i])) rows.push(lines[i].trim().slice(1, -1).split('|').map(c => c.trim())); i++ }
      out.push(<div className="md-table" key={out.length}><table><thead><tr>{rows[0]?.map((c, j) => <th key={j}>{inline(c)}</th>)}</tr></thead><tbody>{rows.slice(1).map((r, k) => <tr key={k}>{r.map((c, j) => <td key={j}>{inline(c)}</td>)}</tr>)}</tbody></table></div>)
      continue
    }
    const heading = line.match(/^#{1,4}\s+(.*)$/)
    if (heading) { out.push(<h4 key={out.length}>{inline(heading[1])}</h4>); i++; continue }
    if (/^\s*([-*•]|\d+[.)、])\s+/.test(line)) {
      const ordered = /^\s*\d/.test(line), items: string[] = []
      while (i < lines.length && /^\s*([-*•]|\d+[.)、])\s+/.test(lines[i]) && /^\s*\d/.test(lines[i]) === ordered) { items.push(lines[i].replace(/^\s*([-*•]|\d+[.)、])\s+/, '')); i++ }
      const List = ordered ? 'ol' : 'ul'
      out.push(<List key={out.length}>{items.map((item, k) => <li key={k}>{inline(item)}</li>)}</List>)
      continue
    }
    const para: string[] = []
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|\s*\||\s*([-*•]|\d+[.)、])\s+)/.test(lines[i])) para.push(lines[i++])
    out.push(<p key={out.length}>{para.flatMap((l, k) => k ? [<br key={`b${k}`} />, ...inline(l)] : inline(l))}</p>)
  }
  return <div className="md">{out}</div>
}

function ActionCard({ action, onChange }: { action: AiAction; onChange: (next: AiAction) => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  async function act(kind: 'confirm' | 'reject') {
    setBusy(true); setError('')
    try {
      const next = (await (kind === 'confirm' ? confirmAiAction : rejectAiAction)(action.id)).data
      onChange(next)
      if (next.status === 'executed') window.dispatchEvent(new Event(DATA_CHANGED))
    } catch (cause) { setError(cause instanceof ApiError ? cause.message : '操作失败，请重试。') } finally { setBusy(false) }
  }
  const state = { executed: '已保存', rejected: '已忽略', failed: `未能保存：${action.error ?? ''}`, expired: '已过期（超过 24 小时未确认）', confirmed: '处理中…', pending: '' }[action.status]
  const who = (list: { name: string }[]) => list.length <= 5 ? list.map(c => c.name).join('、') : `${list.slice(0, 5).map(c => c.name).join('、')} 等 ${list.length} 位`
  return <div className={`ai-action ai-action-${action.status}`}>
    {action.type === 'customer.followup' ? <>
      <b><CalendarClock size={13} />写跟进 · {action.payload.customerName}</b>
      <p>{action.payload.content}</p>
      <small>{action.payload.nextFollowUpDate ? `下次跟进：${action.payload.nextFollowUpDate} 09:00` : '无需再次跟进'}</small>
    </> : action.type === 'customer.tags' ? <>
      <b><Tag size={13} />改标签 · {action.payload.customers.length} 位客户</b>
      <p>{action.payload.add.length > 0 && <>添加：{action.payload.add.join('、')}{action.payload.newTags.length > 0 && `（新建：${action.payload.newTags.join('、')}）`}</>}{action.payload.add.length > 0 && action.payload.remove.length > 0 && <br />}{action.payload.remove.length > 0 && <>移除：{action.payload.remove.join('、')}</>}</p>
      <small>{who(action.payload.customers)}</small>
    </> : <>
      <b><UserRoundCog size={13} />改所属客服 · {action.payload.customers.length} 位客户</b>
      <p>{action.payload.agentId === 'auto' ? '交还自动分配（按最早付款订单的接待客服）' : <>改为：{action.payload.agentName}（手动指定，不被自动分配覆盖）</>}</p>
      <small>{who(action.payload.customers)} · 会重新计算按所属客服的业绩归因</small>
    </>}
    {action.status === 'pending' ? <div className="ai-action-buttons">
      <button className="confirm" disabled={busy} onClick={() => void act('confirm')}>{busy ? <LoaderCircle className="spin" size={13} /> : <Check size={13} />}确认执行</button>
      <button disabled={busy} onClick={() => void act('reject')}>忽略</button>
    </div> : <span className="ai-action-state">{state}</span>}
    {error && <span className="ai-action-error">{error}</span>}
  </div>
}

export default function AiAssistant({ open, close, initialPrompt, userName, page, pageTitle }: { open: boolean; close: () => void; initialPrompt: string; userName: string; page: string; pageTitle: string }) {
  const [value, setValue] = useState(''), [messages, setMessages] = useState<AiMessage[]>([]), [conversationId, setConversationId] = useState<string | null>(null)
  const [model, setModel] = useState<AiModel>('qwen3.8-flash'), [models, setModels] = useState<AiModel[]>(['qwen3.8-flash', 'qwen3.7-flash', 'qwen3.7-plus', 'qwen3.6-plus'])
  const [configured, setConfigured] = useState(true), [sending, setSending] = useState(false), [error, setError] = useState('')
  const [view, setView] = useState<'chat' | 'history'>('chat'), [history, setHistory] = useState<AiConversation[]>([]), [hasMore, setHasMore] = useState(false), [loadingHistory, setLoadingHistory] = useState(false)
  const focus = useAiFocus(), chatRef = useRef<HTMLDivElement>(null)
  useEffect(() => { if (initialPrompt) setValue(initialPrompt) }, [initialPrompt])
  useEffect(() => { getAiModels().then(result => { setModel(result.data.defaultModel); setModels(result.data.models); setConfigured(result.data.configured) }).catch(() => {}) }, [])
  useEffect(() => { chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight, behavior: 'smooth' }) }, [messages, sending])
  async function send(text = value) {
    const message = text.trim(); if (!message || sending) return
    setValue(''); setError(''); setView('chat')
    setMessages(current => [...current, { id: `pending-${Date.now()}`, role: 'user', content: message, input_tokens: null, output_tokens: null, latency_ms: null, created_at: new Date().toISOString() }])
    setSending(true)
    try {
      const result = await sendAiMessage({ message, conversationId, model, context: { page, pageTitle, ...focus } })
      setConversationId(result.data.conversationId); setMessages(current => [...current, result.data.message])
    } catch (cause) { setError(cause instanceof ApiError ? cause.message : 'AI 暂时无法响应。') } finally { setSending(false) }
  }
  const updateAction = (next: AiAction) => setMessages(current => current.map(m => m.actions?.some(a => a.id === next.id) ? { ...m, actions: m.actions.map(a => a.id === next.id ? next : a) } : m))
  const reset = () => { setMessages([]); setConversationId(null); setError(''); setView('chat') }
  async function loadHistory(more = false) {
    setLoadingHistory(true); setError('')
    try {
      const result = await getAiConversations(more ? history.at(-1)?.updated_at : undefined)
      setHistory(current => more ? [...current, ...result.data] : result.data); setHasMore(result.hasMore)
    } catch (cause) { setError(cause instanceof ApiError ? cause.message : '无法读取历史对话。') } finally { setLoadingHistory(false) }
  }
  async function openConversation(id: string) {
    setLoadingHistory(true); setError('')
    try {
      const result = (await getAiConversation(id)).data
      setMessages(result.messages); setConversationId(id); setView('chat')
      if (result.conversation.model_name && models.includes(result.conversation.model_name as AiModel)) setModel(result.conversation.model_name as AiModel)
    } catch (cause) { setError(cause instanceof ApiError ? cause.message : '无法打开对话。') } finally { setLoadingHistory(false) }
  }
  async function removeConversation(item: AiConversation) {
    if (!window.confirm(`删除对话“${item.title ?? '未命名'}”？删除后无法恢复。`)) return
    try {
      await deleteAiConversation(item.id); setHistory(current => current.filter(c => c.id !== item.id))
      if (conversationId === item.id) { setMessages([]); setConversationId(null) }
    } catch (cause) { setError(cause instanceof ApiError ? cause.message : '删除失败。') }
  }
  return <aside className={`ai-panel ${open ? 'ai-panel-open' : ''}`} aria-hidden={!open}>
    <div className="ai-head"><div className="ai-identity"><div><Bot size={19} /></div><span><b>销途 AI</b><small><i className={configured ? '' : 'offline'} /> {configured ? '千问已连接 · 可查询系统数据' : '等待配置千问'}</small></span></div>
      <div className="ai-head-actions">
        <button onClick={() => { if (view === 'history') setView('chat'); else { setView('history'); void loadHistory() } }} aria-label={view === 'history' ? '返回对话' : '历史对话'} title={view === 'history' ? '返回对话' : '历史对话'} aria-pressed={view === 'history'}>{view === 'history' ? <ChevronLeft size={19} /> : <History size={18} />}</button>
        {(messages.length > 0 || view === 'history') && <button onClick={reset} aria-label="新对话" title="新对话"><Plus size={19} /></button>}
        <button onClick={close} aria-label="关闭 AI 助手"><X size={20} /></button></div></div>
    <div className="ai-context"><Command size={15} /><span>当前上下文</span><b>{pageTitle}{focus.customerName ? ` · 客户 ${focus.customerName}` : ''} · {userName}</b></div>
    {view === 'history' ? <div className="chat ai-history">
      <h3>历史对话</h3>
      {history.map(item => <div className={`ai-history-item ${item.id === conversationId ? 'active' : ''}`} key={item.id}>
        <button className="ai-history-open" onClick={() => void openConversation(item.id)}>
          <b>{item.title ?? '未命名对话'}</b>
          <small>{new Date(item.updated_at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · {item.messages} 条消息{item.pending_actions > 0 && <em>{item.pending_actions} 张待确认</em>}</small>
        </button>
        <button className="ai-history-delete" onClick={() => void removeConversation(item)} aria-label={`删除对话 ${item.title ?? ''}`} title="删除"><Trash2 size={14} /></button>
      </div>)}
      {loadingHistory && <p className="ai-history-empty"><LoaderCircle className="spin" size={14} /> 加载中…</p>}
      {!loadingHistory && !history.length && <p className="ai-history-empty">还没有历史对话。</p>}
      {hasMore && !loadingHistory && <button className="ai-history-more" onClick={() => void loadHistory(true)}>加载更多</button>}
      {error && <div className="ai-error">{error}</div>}
    </div> : <div className="chat" ref={chatRef}>
      {!messages.length && <><div className="ai-message"><div className="bot-dot"><Sparkles size={14} /></div><div><p>你好，{userName}。我可以直接查询系统里的经营数据、客户、客服绩效和商品销量，帮你分析并给出建议。</p><span>我只读取你有权限查看的数据；写跟进等操作会先生成确认卡片，由你确认后才保存。</span></div></div>
        <div className="suggestions">{(focus.customerId ? ['分析这个客户，给出下一步跟进建议', '帮这个客户拟一条跟进记录'] : suggestions[page] ?? fallback).map(s => <button key={s} onClick={() => void send(s)}>{s}</button>)}</div></>}
      {messages.map(message => <div className={`chat-message ${message.role}`} key={message.id}>{message.role === 'assistant' && <div className="bot-dot"><Sparkles size={14} /></div>}<div>
        {message.role === 'assistant' ? <Markdown text={message.content} /> : <p>{message.content}</p>}
        {message.actions?.map(action => <ActionCard key={action.id} action={action} onChange={updateAction} />)}
        {message.role === 'assistant' && <small>{message.tools?.length ? <span className="ai-tools"><Database size={10} />已查询：{[...new Set(message.tools.map(t => toolNames[t.name] ?? t.name))].join('、')}</span> : null}{message.latency_ms != null && `${(message.latency_ms / 1000).toFixed(1)} 秒 · ${model}`}</small>}
      </div></div>)}
      {sending && <div className="chat-message assistant"><div className="bot-dot"><LoaderCircle className="spin" size={14} /></div><div><p>正在查询数据并思考…</p></div></div>}
      {error && <div className="ai-error">{error}</div>}
    </div>}
    <div className="composer"><div className="model-row"><span>模型</span><select value={model} onChange={e => setModel(e.target.value as AiModel)}>{models.map(item => <option key={item}>{item}</option>)}</select></div>
      <div className="composer-box"><textarea value={value} onChange={e => setValue(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send() } }} placeholder="直接说出你想做的事…" />
        <div><button aria-label="语音输入" disabled title="暂不支持语音输入"><Mic size={18} /></button><span>写操作需你确认后才会保存</span><button className="send" aria-label="发送" disabled={sending || !value.trim()} onClick={() => void send()}><Send size={17} /></button></div></div>
      <small>AI 生成内容可能有误，请核对关键业务数据。</small></div>
  </aside>
}
