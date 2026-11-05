import { useCallback, useEffect, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import type { SessionUser } from './api'
import { agentLabel } from './PerformanceReports'
import { getPerformanceAgents, type PerformanceAgent } from './performanceApi'
import { createCoachingItem, getAgentBrief, saveBriefNote, updateCoachingItem, type AgentBrief, type CoachingItem, type LossNames } from './inquiryReviewApi'
import { canSeeReviews, InferenceNote, ReviewDrawer } from './InquiryReview'
import './inquiryReview.css'

const message = (cause: unknown) => cause instanceof Error ? cause.message : '操作未完成，请稍后重试。'
const beijingDate = (offset = 0) => new Date(Date.now() + 8 * 3_600_000 + offset * 86_400_000).toISOString().slice(0, 10)
const itemNames: Record<CoachingItem['status'], string> = { open: '待处理', acknowledged: '已知悉', done: '已完成', dropped: '已取消' }
const findingNames: Record<string, string> = { wrong_fact: '与资料不符', cannot_answer: '答不上来', missed_spec: '缺关键参数', no_followup: '未主动推进', other_issue: '其他问题' }

/** 业务员复盘: one person's day against their last week, what the supervisor confirmed, and what they agreed to improve. */
export function AgentCoachingView({ user, connectionId, setError }: { user: SessionUser; connectionId: string; setError: (text: string) => void }) {
  const [agents, setAgents] = useState<PerformanceAgent[]>([]), [agentId, setAgentId] = useState(''), [date, setDate] = useState(beijingDate(-1))
  const [brief, setBrief] = useState<AgentBrief | null>(null), [names, setNames] = useState<LossNames>({}), [loading, setLoading] = useState(false), [note, setNote] = useState(''), [title, setTitle] = useState(''), [due, setDue] = useState(''), [open, setOpen] = useState(''), [busy, setBusy] = useState(false)
  const reviewer = canSeeReviews(user), mine = user.sub ?? user.id
  useEffect(() => {
    getPerformanceAgents(connectionId).then(r => {
      // The server already limits an agent to their own accounts; this just picks a sensible first choice.
      setAgents(r.data)
      setAgentId(current => r.data.some(a => a.id === current) ? current : (r.data.find(a => a.user_id === mine) ?? r.data.find(a => a.is_main) ?? r.data[0])?.id ?? '')
    }).catch(cause => setError(message(cause)))
  }, [connectionId, mine, setError])
  const load = useCallback(() => {
    if (!agentId) return Promise.resolve()
    setLoading(true)
    return getAgentBrief(agentId, date).then(r => { setBrief(r.data); setNames(r.lossNames); setNote(r.data.supervisorNote ?? '') }).catch(cause => { setBrief(null); setError(message(cause)) }).finally(() => setLoading(false))
  }, [agentId, date, setError])
  useEffect(() => { void load() }, [load])
  const act = async (work: () => Promise<unknown>) => { setBusy(true); try { await work(); await load() } catch (cause) { setError(message(cause)) } finally { setBusy(false) } }
  const unbound = reviewer && agents.length > 0 && agents.every(a => !a.user_id)
  const selected = agents.find(a => a.id === agentId)
  const t = brief?.stats.today, avg = brief?.stats.previousDailyAverage
  return <div className="review-page">
    <InferenceNote />
    {unbound && <p className="review-limit">客服账号还没有绑定系统用户，业务员自己看不到这一页。请到“客服账号”完成绑定。</p>}
    {selected?.is_main && <p className="review-limit">这是主账号。如果多人共用，这里的数据无法区分具体是谁。</p>}
    <div className="review-bar">
      <div className="shop-select"><select aria-label="客服" value={agentId} onChange={e => setAgentId(e.target.value)}>{agents.map(a => <option key={a.id} value={a.id}>{agentLabel(a)}</option>)}</select></div>
      <input type="date" aria-label="日期" value={date} max={beijingDate()} onChange={e => { if (e.target.value) setDate(e.target.value) }} />
    </div>
    {loading && !brief && <div className="shop-empty"><LoaderCircle size={24} className="spin" /></div>}
    {brief && t && avg && <>
      <div className="perf-kpis">
        <article><span>询盘</span><strong>{t.inquiries}</strong><small>前 {brief.stats.previousDays} 天日均 {avg.inquiries}</small></article>
        <article><span>未下单</span><strong>{t.no_order}</strong><small>日均 {avg.no_order}</small></article>
        <article><span>付款</span><strong>{t.paid}</strong><small>日均 {avg.paid}</small></article>
        <article><span>未回复</span><strong>{t.no_reply}</strong><small>日均 {avg.no_reply} · 响应慢 {t.slow_reply}</small></article>
        <article><span>平均首响</span><strong>{t.avg_first_response == null ? '—' : `${t.avg_first_response} 秒`}</strong></article>
        <article><span>话术占比</span><strong>{t.text_messages ? `${Math.round(t.template_messages / t.text_messages * 100)}%` : '—'}</strong><small>{t.text_messages} 条文字</small></article>
        <article><span>站外风险</span><strong>{t.offsite}</strong></article>
      </div>
      {brief.summary && <section className="review-note"><h3 className="perf-chart-title">AI 简报</h3><p>{brief.summary}</p></section>}
      <section className="review-note"><h3 className="perf-chart-title">主管寄语</h3>
        {brief.canReview ? <form onSubmit={e => { e.preventDefault(); void act(() => saveBriefNote(agentId, date, note.trim())) }}><textarea aria-label="主管寄语" rows={2} maxLength={2000} value={note} onChange={e => setNote(e.target.value)} /><button className="shop-button" disabled={busy}>保存</button></form> : <p>{brief.supervisorNote ?? '暂无'}</p>}
      </section>
      <section><h3 className="perf-chart-title">改进事项</h3>
        {brief.canReview && <form className="review-inline" onSubmit={e => { e.preventDefault(); const text = title.trim(); if (text) void act(() => createCoachingItem({ agentId, title: text, dueDate: due || null }).then(() => { setTitle(''); setDue('') })) }}><input aria-label="新的改进事项" placeholder="需要改进什么" maxLength={200} value={title} onChange={e => setTitle(e.target.value)} /><input type="date" aria-label="完成期限" value={due} onChange={e => setDue(e.target.value)} /><button className="shop-button" disabled={busy || !title.trim()}>添加</button></form>}
        {!brief.items.length ? <p className="shop-note">还没有改进事项。</p> : <ul className="review-items">{brief.items.map(item => <li key={item.id} className={item.status}><div><b>{item.title}</b><small>{itemNames[item.status]}{item.due_date ? ` · 期限 ${item.due_date}` : ''}{item.created_by_name ? ` · ${item.created_by_name}` : ''}</small></div>
          <div className="review-actions">{item.status === 'open' && <button className="shop-button" disabled={busy} onClick={() => void act(() => updateCoachingItem(item.id, 'acknowledged'))}>知悉</button>}
            {['open', 'acknowledged'].includes(item.status) && <button className="shop-button" disabled={busy} onClick={() => void act(() => updateCoachingItem(item.id, 'done'))}>完成</button>}
            {brief.canReview && ['open', 'acknowledged'].includes(item.status) && <button className="shop-button" disabled={busy} onClick={() => void act(() => updateCoachingItem(item.id, 'dropped'))}>取消</button>}
            {brief.canReview && ['done', 'dropped'].includes(item.status) && <button className="shop-button" disabled={busy} onClick={() => void act(() => updateCoachingItem(item.id, 'open'))}>重新打开</button>}</div></li>)}</ul>}
      </section>
      <section><h3 className="perf-chart-title">近 7 天已确认的复盘</h3>
        {!brief.reviews.length ? <p className="shop-note">{brief.canReview ? '这 7 天没有确认过的复盘。' : '这 7 天没有发布给你的复盘。'}</p> : <ul className="review-items">{brief.reviews.map(r => { const findings = r.final_findings ?? r.ai_findings ?? [], code = r.final_loss_code ?? r.ai_loss_code; return <li key={r.id}><div><b>{r.chat_date} · {code ? names[code] ?? code : '未指定原因'}</b><small>{r.published_at ? '已发布' : '未发布'}{findings.length ? ` · ${findings.map(f => findingNames[f.type] ?? f.type).join('、')}` : ''}</small>{r.reviewer_note && <p>{r.reviewer_note}</p>}{r.agent_response && <p>业务员说明：{r.agent_response}</p>}</div><button className="shop-button" onClick={() => setOpen(r.session_id)}>查看</button></li> })}</ul>}
      </section>
      {brief.trend.length > 1 && <section><h3 className="perf-chart-title">趋势</h3><div className="shop-table-scroll"><table className="shop-table"><thead><tr><th>日期</th><th>询盘</th><th>未下单</th><th>付款</th><th>未回复</th><th>响应慢</th><th>平均首响</th></tr></thead><tbody>{brief.trend.slice().reverse().map(d => <tr key={d.date}><td>{d.date}</td><td>{d.today.inquiries}</td><td>{d.today.no_order}</td><td>{d.today.paid}</td><td>{d.today.no_reply}</td><td>{d.today.slow_reply}</td><td>{d.today.avg_first_response == null ? '—' : `${d.today.avg_first_response} 秒`}</td></tr>)}</tbody></table></div></section>}
    </>}
    {open && <ReviewDrawer sessionId={open} close={() => setOpen('')} changed={() => void load()} setError={setError} />}
  </div>
}
