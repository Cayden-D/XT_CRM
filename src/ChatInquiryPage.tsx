import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { AlertCircle, ChevronDown, ChevronRight, LoaderCircle, MessageSquareText, MessagesSquare, Search, ShieldCheck, X } from 'lucide-react'
import type { SessionUser } from './api'
import { useAiFocusPart } from './aiFocus'
import { ChatAnalysisView, Drawer, Timeline, WangwangButton } from './PerformanceAnalysis'
import { agentLabel } from './PerformanceReports'
import { getChatDetail, getInquiry, getKeywordSessions, getPerformanceConnections, lookupBuyer, type BuyerLookup, type ChatDetail, type InquirySummary, type KeywordSession, type PerformanceConnection } from './performanceApi'
import { navigate } from './navigation'
import { DateRange, NeedShop, Note, ShopPicker } from './ui'
import './1688.css'

type Tab = 'chats' | 'inquiry'
type Preset = 'today' | 'yesterday' | '7d' | '30d'
const presets: [Preset, string][] = [['today', '今天'], ['yesterday', '昨天'], ['7d', '近 7 天'], ['30d', '近 30 天']]
const beijingDate = (offset = 0) => new Date(Date.now() + 8 * 3_600_000 + offset * 86_400_000).toISOString().slice(0, 10)
const rangeOf = (p: Preset) => p === 'today' ? { from: beijingDate(), to: beijingDate() } : p === 'yesterday' ? { from: beijingDate(-1), to: beijingDate(-1) } : { from: beijingDate(p === '7d' ? -6 : -29), to: beijingDate() }
const message = (cause: unknown) => cause instanceof Error ? cause.message : '操作未完成，请稍后重试。'
const can = (user: SessionUser, name: string) => (user.permissions || []).some(v => v === '*' || v === name || v === `${name.split(':')[0]}:*`)
const pct = (part: number, whole: number) => whole ? `${(part / whole * 100).toFixed(1)}%` : '—'
const day = (value: string | null) => value ? new Date(Date.parse(value) + 8 * 3_600_000).toISOString().slice(0, 10) : '—'

/** 聊天与询盘: the shop's Wangwang chats and what the pre-sales inquiries turned into. */
export default function ChatInquiryPage({ user, tab }: { user: SessionUser; tab: Tab }) {
  const [shops, setShops] = useState<PerformanceConnection[]>([]), [shop, setShop] = useState(''), [loading, setLoading] = useState(true)
  const [preset, setPreset] = useState<Preset | 'custom'>('7d'), [range, setRange] = useState(() => rangeOf('7d'))
  const [error, setError] = useState('')
  useAiFocusPart({ connectionId: shop || undefined, view: tab === 'chats' ? 'chats' : 'inquiry' })
  const canRead = can(user, 'performance:read') || can(user, 'performance:read_own')
  useEffect(() => {
    if (!canRead) { setLoading(false); return }
    getPerformanceConnections().then(r => { setShops(r.data); setShop((r.data.find(c => c.status === 'connected') || r.data[0])?.id || '') }).catch(cause => setError(message(cause))).finally(() => setLoading(false))
  }, [canRead])
  if (!canRead) return <section className="state-card"><ShieldCheck size={28} /><h2>暂无聊天记录访问权限</h2></section>
  return <div className="shop-workspace performance-page chat-inquiry">
    {error && <div className="shop-feedback error" role="alert"><AlertCircle size={16} /><span>{error}</span><button title="关闭错误" onClick={() => setError('')}><X size={15} /></button></div>}
    {loading ? <div className="shop-empty"><LoaderCircle size={26} className="spin" /></div> : !shop ? <NeedShop text="还没有授权绩效应用" /> : <>
      <div className="shop-controlbar perf-filters">
        <ShopPicker shops={shops} value={shop} onChange={setShop} />
        <DateRange presets={presets} preset={preset} range={range} onPreset={id => { setPreset(id); setRange(rangeOf(id)) }} onCustom={next => { setPreset('custom'); setRange(next) }} />
      </div>
      {tab === 'chats' && <BuyerFinder connectionId={shop} setError={setError} />}
      {tab === 'chats' ? <ChatAnalysisView connectionId={shop} from={range.from} to={range.to} setError={setError} /> : <InquiryView connectionId={shop} from={range.from} to={range.to} setError={setError} />}
    </>}
  </div>
}

/** Finds a buyer by the Wangwang login name the merchant types (1688 encrypts it to the id our records use). */
function BuyerFinder({ connectionId, setError }: { connectionId: string; setError: (text: string) => void }) {
  const [loginId, setLoginId] = useState(''), [busy, setBusy] = useState(false), [result, setResult] = useState<BuyerLookup | null | undefined>(undefined)
  const [detail, setDetail] = useState<{ title: string; data: ChatDetail } | null>(null)
  useEffect(() => { setResult(undefined) }, [connectionId])
  async function find(event: FormEvent) {
    event.preventDefault()
    if (loginId.trim().length < 2) return
    setBusy(true); setError('')
    try { setResult((await lookupBuyer(connectionId, loginId.trim())).data) } catch (cause) { setError(message(cause)) } finally { setBusy(false) }
  }
  async function open(id: string, title: string) { try { setDetail({ title, data: (await getChatDetail(id)).data }) } catch (cause) { setError(message(cause)) } }
  return <section className="chat-finder" aria-label="按旺旺名查找买家">
    <form onSubmit={e => void find(e)}><Search size={16} /><input value={loginId} maxLength={64} onChange={e => { setLoginId(e.target.value); if (!e.target.value) setResult(undefined) }} placeholder="按买家旺旺名查找" title="旺旺名只用于这一次查询，不会保存" aria-label="买家旺旺名" />
      <button className="shop-button primary" disabled={busy || loginId.trim().length < 2}>{busy ? <LoaderCircle size={15} className="spin" /> : <Search size={15} />}查找</button></form>
    {result === null && <p className="shop-note">近 90 天没有这位买家的会话。</p>}
    {result && <div className="chat-finder-result">
      <div className="chat-finder-head"><div><strong>买家 …{result.buyer_tail}</strong><small>首次咨询 {day(result.first_chat_at)} · 最近 {day(result.last_chat_at)} · {result.sessions.length} 次会话</small></div>
        <div className="chat-finder-stats"><span>订单 <b>{result.orders.orders}</b></span><span>已付款 <b>{result.orders.paid}</b></span><span>付款金额 <b>¥{result.orders.paid_amount.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}</b></span></div>
        <WangwangButton buyerId={result.id} setError={setError} label="旺旺联系" />
        <button className="shop-icon" title="关闭" aria-label="关闭查找结果" onClick={() => { setResult(undefined); setLoginId('') }}><X size={16} /></button></div>
      {result.sessions.length > 0 && <ul className="chat-finder-sessions">{result.sessions.map(s => <li key={s.id}><button onClick={() => void open(s.id, `${agentLabel(s)} · ${s.chat_date} · 买家 …${result.buyer_tail}`)}>
        <span>{s.chat_date}</span><span>{agentLabel(s)}</span><span>买家 {s.buyer_messages} · 客服 {s.agent_messages}</span><ChevronRight size={15} /></button></li>)}</ul>}
    </div>}
    {detail && <Drawer title={detail.title} close={() => setDetail(null)}><Timeline data={detail.data} /></Drawer>}
  </section>
}

/** 询盘分析: pre-sales inquiries (one per buyer per day, after-sales chats excluded) and what became of them. */
function InquiryView({ connectionId, from, to, setError }: { connectionId: string; from: string; to: string; setError: (text: string) => void }) {
  const [data, setData] = useState<InquirySummary | null>(null), [loading, setLoading] = useState(true), [open, setOpen] = useState('')
  useEffect(() => setOpen(''), [connectionId, from, to])
  const load = useCallback(() => {
    let live = true; setLoading(true)
    getInquiry(connectionId, from, to).then(r => { if (live) setData(r.data) }).catch(cause => live && setError(message(cause))).finally(() => live && setLoading(false))
    return () => { live = false }
  }, [connectionId, from, to, setError])
  useEffect(load, [load])
  if (loading || !data) return <div className="shop-empty"><LoaderCircle size={26} className="spin" /><p>正在统计询盘…</p></div>
  const t = data.totals
  if (!t.sessions) return <div className="shop-empty"><MessagesSquare size={28} /><p>所选日期内没有聊天记录</p></div>
  const maxDay = Math.max(1, ...data.daily.map(d => d.inquiries)), maxHour = Math.max(1, ...data.hourly.map(h => h.inquiries))
  const hours = Array.from({ length: 24 }, (_, h) => data.hourly.find(x => x.hour === h)?.inquiries ?? 0)
  return <section className="perf-report" aria-label="询盘分析">
    <div className="perf-kpis">
      <article><span>询盘</span><strong>{t.inquiries}</strong><small>{t.sessions} 个会话</small></article>
      <article><span>询盘后下单</span><strong>{t.ordered}</strong><small>{pct(t.ordered, t.inquiries)}</small></article>
      <article><span>询盘后付款</span><strong>{t.paid}</strong><small>{pct(t.paid, t.inquiries)}</small></article>
      <article><span>售后会话</span><strong>{t.after_sales}</strong></article>
    </div>
    <div className="inquiry-funnel" aria-label="询盘转化">{[['询盘', t.inquiries], ['下单', t.ordered], ['付款', t.paid]].map(([label, n], i) =>
      <div key={label as string}><span>{label}</span><div className="perf-bar-track"><i style={{ width: `${Math.max(2, Number(n) / Math.max(1, t.inquiries) * 100)}%` }} /></div><b>{n}</b>{i > 0 && <small>{pct(Number(n), t.inquiries)}</small>}</div>)}</div>
    <h3 className="perf-chart-title">每日询盘</h3>
    <ul className="perf-bars">{data.daily.map(d => <li key={d.date} title={`${d.date}：询盘 ${d.inquiries}，付款 ${d.paid}`}><span className="perf-bar-label">{d.date}</span>
      <div className="perf-bar-track"><i style={{ width: `${d.inquiries / maxDay * 100}%` }} /></div><span className="perf-bar-value">{d.inquiries}<small> · 付款 {d.paid}</small></span></li>)}</ul>
    <h3 className="perf-chart-title">询盘时段（北京时间）</h3>
    <div className="inquiry-hours" role="img" aria-label="按小时的询盘数">{hours.map((n, h) => <div key={h} title={`${String(h).padStart(2, '0')}:00–${String(h + 1).padStart(2, '0')}:00：${n} 个询盘`}>
      <i style={{ height: `${n / maxHour * 100}%` }} /><span>{h % 3 === 0 ? h : ''}</span></div>)}</div>
    <h3 className="perf-chart-title">各客服询盘转化</h3>
    <div className="shop-table-scroll"><table className="shop-table perf-table"><thead><tr><th>客服</th><th>询盘</th><th>下单</th><th>付款</th><th>付款转化率</th></tr></thead>
      <tbody>{data.agents.map(a => <tr key={a.agent_id}><td><strong>{agentLabel(a)}</strong></td><td>{a.inquiries}</td><td>{a.ordered}</td><td>{a.paid}</td><td>{pct(a.paid, a.inquiries)}</td></tr>)}</tbody></table></div>
    <h3 className="perf-chart-title">买家在问什么</h3>
    {data.keywords.length ? <ul className="perf-bars inquiry-keywords">{data.keywords.map(k => <li key={k.word} className={open === k.word ? 'open' : ''}>
      <button className="inquiry-keyword-row" aria-expanded={open === k.word} onClick={() => setOpen(open === k.word ? '' : k.word)}>
        <span className="perf-bar-label">{open === k.word ? <ChevronDown size={14} /> : <ChevronRight size={14} />}{k.word}</span><div className="perf-bar-track"><i style={{ width: `${k.hits / data.keywords[0].hits * 100}%` }} /></div><span className="perf-bar-value">{k.hits}<small> · {k.sessions} 个会话</small></span></button>
      {open === k.word && <KeywordSessions connectionId={connectionId} from={from} to={to} word={k.word} setError={setError} />}</li>)}</ul>
      : <p className="shop-note">还没有命中。可在 <button className="ui-link" onClick={() => navigate('performance/keywords')}>绩效 → 关键词</button> 添加常见问题词。</p>}
    <Note label="口径说明">询盘按“买家 × 日期”去重，以当天第一次咨询为准；下单 / 付款指咨询后在归属窗口（设置 → 绩效规则）内产生的订单。售后会话指 90 天内付过款的买家，不计入询盘。买家消息正文被平台隐藏，所以按关键词统计。</Note>
  </section>
}

/** The conversations behind one 买家在问什么 keyword: open the messages (at the first hit) or contact the buyer. */
function KeywordSessions({ connectionId, from, to, word, setError }: { connectionId: string; from: string; to: string; word: string; setError: (text: string) => void }) {
  const [rows, setRows] = useState<KeywordSession[] | null>(null), [more, setMore] = useState(false), [detail, setDetail] = useState<{ title: string; focus: string; data: ChatDetail } | null>(null)
  useEffect(() => { let live = true; setRows(null)
    getKeywordSessions(connectionId, from, to, word).then(r => { if (live) { setRows(r.data); setMore(r.hasMore) } }).catch(cause => live && setError(message(cause)))
    return () => { live = false } }, [connectionId, from, to, word, setError])
  const buyer = (r: KeywordSession) => r.buyer_name ?? `买家 …${r.buyer_tail}`
  async function show(r: KeywordSession) { try { setDetail({ title: `${agentLabel(r)} · ${r.chat_date} · ${buyer(r)}`, focus: r.first_hit_uuid, data: (await getChatDetail(r.id)).data }) } catch (cause) { setError(message(cause)) } }
  if (!rows) return <p className="shop-note inquiry-keyword-sessions"><LoaderCircle size={14} className="spin" /> 正在读取提到「{word}」的会话…</p>
  return <div className="inquiry-keyword-sessions">
    {rows.length ? <table className="shop-table"><thead><tr><th>首次提到</th><th>买家</th><th>接待客服</th><th>命中</th><th>买家 / 客服消息</th><th /></tr></thead>
      <tbody>{rows.map(r => <tr key={r.id}><td>{new Date(r.first_hit_at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</td><td>{buyer(r)}</td><td>{agentLabel(r)}{r.user_name && <small>{r.user_name}</small>}</td>
        <td>{r.hits} 次</td><td>{r.buyer_messages} / {r.agent_messages}</td>
        <td className="perf-row-actions"><WangwangButton buyerId={r.buyer_id} setError={setError} /><button className="shop-icon" title="查看对话" aria-label={`查看 ${r.chat_date} 的对话`} onClick={() => void show(r)}><MessageSquareText size={16} /></button></td></tr>)}</tbody></table>
      : <p className="shop-note">没有找到会话（可能不在你的查看范围内）。</p>}
    {more && <p className="shop-note">只显示最近 50 个会话，可缩小日期范围查看更早的。</p>}
    {detail && <Drawer title={detail.title} close={() => setDetail(null)}><div className="perf-drawer-actions"><WangwangButton buyerId={rows.find(r => r.first_hit_uuid === detail.focus)?.buyer_id ?? ''} setError={setError} label="旺旺联系买家" /></div><Timeline data={detail.data} focus={detail.focus} /></Drawer>}
  </div>
}
