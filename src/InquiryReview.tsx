import { useCallback, useEffect, useState } from 'react'
import { LoaderCircle, Settings2, Sparkles } from 'lucide-react'
import type { SessionUser } from './api'
import { Drawer, Timeline, WangwangButton } from './PerformanceAnalysis'
import { agentLabel } from './PerformanceReports'
import { analyzeReviewSession, createCoachingItem, decideReview, getLossAnalysis, getProductInquiry, getReviewDetail, getReviewSettings, getWorklist, queueReviewRun, removeSessionProduct, respondToReview, saveReviewSettings, setSessionProduct, type Finding, type LossAnalysis, type LossNames, type ProductInquiry, type ReviewDetail, type ReviewSettings, type WorklistRow, type WorklistTotals } from './inquiryReviewApi'
import './inquiryReview.css'

const message = (cause: unknown) => cause instanceof Error ? cause.message : '操作未完成，请稍后重试。'
const can = (user: SessionUser, name: string) => (user.permissions || []).some(v => v === '*' || v === name || v === `${name.split(':')[0]}:*`)
export const canSeeReviews = (user: SessionUser) => can(user, 'performance:review') || can(user, 'performance:review_read')
const seconds = (value: number | null | undefined) => value == null ? '—' : value >= 60 ? `${Math.round(value / 60)} 分钟` : `${value} 秒`
const pct = (part: number, whole: number) => whole ? `${Math.round(part / whole * 100)}%` : '—'
const evidenceNames: Record<string, string> = { rules_only: '无文字证据', thin: '证据少', sufficient: '可分析' }
const statusNames: Record<string, string> = { pending: '待复盘', confirmed: '已确认', corrected: '已纠正', dismissed: '不算问题' }
const findingNames: Record<string, string> = { wrong_fact: '与资料不符', cannot_answer: '答不上来', missed_spec: '缺关键参数', no_followup: '未主动推进', other_issue: '其他问题' }
const confidenceNames: Record<string, string> = { certain: '已确认', high: '高', medium: '中', low: '低' }
const categoryNames: Record<string, string> = { no_order: '未下单', ordered_unpaid: '下单未付款', paid: '已付款', after_sales: '售后' }

/** Said wherever a conclusion is shown: the platform hides buyers' words. */
export function InferenceNote() {
  return <p className="review-limit">平台不提供买家消息内容，以下结论只根据客服文字、响应时间、关键词和订单推断，需要主管判断。不计入工资和 KPI。</p>
}

/** 询盘复盘: the supervisor's daily list. */
export function InquiryReviewView({ user, connectionId, from, to, setError }: { user: SessionUser; connectionId: string; from: string; to: string; setError: (text: string) => void }) {
  const [rows, setRows] = useState<WorklistRow[]>([]), [totals, setTotals] = useState<WorklistTotals | null>(null), [names, setNames] = useState<LossNames>({}), [status, setStatus] = useState('pending'), [loading, setLoading] = useState(true), [open, setOpen] = useState(''), [settings, setSettings] = useState(false)
  const load = useCallback(() => {
    setLoading(true)
    return getWorklist(connectionId, from, to, status).then(r => { setRows(r.data); setTotals(r.totals); setNames(r.lossNames) }).catch(cause => setError(message(cause))).finally(() => setLoading(false))
  }, [connectionId, from, to, status, setError])
  useEffect(() => { void load() }, [load])
  const reasonOf = (r: WorklistRow) => r.final_loss_code ?? r.rule_loss_code ?? r.ai_loss_code
  return <div className="review-page">
    <InferenceNote />
    {totals && <div className="perf-kpis"><article><span>询盘</span><strong>{totals.inquiries}</strong></article><article><span>已流失（过窗口未下单）</span><strong>{totals.lost}</strong></article><article><span>观察中（未过窗口）</span><strong>{totals.watching}</strong></article><article><span>待复盘</span><strong>{totals.pending}</strong><small>其中证据不足 {totals.thin_evidence}</small></article></div>}
    <div className="review-bar">
      <nav className="perf-metric-tabs" aria-label="复盘状态">{[['pending', '待复盘'], ['reviewed', '已处理'], ['all', '全部']].map(([id, label]) => <button key={id} aria-pressed={status === id} className={status === id ? 'active' : ''} onClick={() => setStatus(id)}>{label}</button>)}</nav>
      <button className="shop-button" onClick={() => setSettings(v => !v)}><Settings2 size={15} />AI 复盘设置</button>
    </div>
    {settings && <ReviewSettingsPanel user={user} connectionId={connectionId} setError={setError} />}
    {loading ? <div className="shop-empty"><LoaderCircle size={24} className="spin" /></div> : !rows.length ? <div className="shop-empty"><p>{status === 'pending' ? '这段时间没有待复盘的询盘。' : '没有记录。'}</p></div> :
      <div className="shop-table-scroll"><table className="shop-table review-table"><thead><tr><th>日期</th><th>客服</th><th>买家</th><th>结果</th><th>初步判断</th><th>证据</th><th>首响</th><th>商品</th><th>状态</th></tr></thead>
        <tbody>{rows.map(r => <tr key={r.id} className="clickable" onClick={() => setOpen(r.id)}>
          <td>{r.chat_date}</td><td>{agentLabel(r)}</td><td>尾号 {r.buyer_tail}{r.new_customer && <small>新客</small>}</td>
          <td>{categoryNames[r.category] ?? r.category}{!r.matured && <small>观察中</small>}</td>
          <td>{reasonOf(r) ? names[reasonOf(r)!] ?? reasonOf(r) : '—'}<small>{r.final_loss_code ? '主管判断' : r.rule_loss_code ? '规则' : r.ai_loss_code ? `AI 推断·${confidenceNames[r.ai_loss_confidence ?? 'low']}` : ''}{r.finding_count > 0 ? ` · ${r.finding_count} 个问题` : ''}{r.offsite > 0 ? ' · 站外风险' : ''}</small></td>
          <td>{evidenceNames[r.evidence_level]}<small>{r.real_chars} 字{r.template_messages > 0 ? ` · 话术 ${r.template_messages} 条` : ''}</small></td>
          <td>{seconds(r.first_response_seconds)}</td>
          <td>{r.products.length ? <>{r.products[0].name ?? r.products[0].offer_id}<small>可信度{confidenceNames[r.products[0].confidence]}{r.products.length > 1 ? ` · 另 ${r.products.length - 1} 个` : ''}</small></> : '未知'}</td>
          <td><span className={`shop-status ${r.review_status === 'pending' ? 'warning' : 'positive'}`}>{statusNames[r.review_status]}</span></td></tr>)}</tbody></table></div>}
    {open && <ReviewDrawer sessionId={open} close={() => setOpen('')} changed={() => void load()} setError={setError} />}
  </div>
}

export function ReviewDrawer({ sessionId, close, changed, setError }: { sessionId: string; close: () => void; changed: () => void; setError: (text: string) => void }) {
  const [detail, setDetail] = useState<ReviewDetail | null>(null), [names, setNames] = useState<LossNames>({}), [busy, setBusy] = useState(false), [local, setLocal] = useState('')
  const [loss, setLoss] = useState(''), [note, setNote] = useState(''), [publish, setPublish] = useState(false), [offer, setOffer] = useState(''), [dropped, setDropped] = useState<number[]>([]), [response, setResponse] = useState(''), [coach, setCoach] = useState('')
  const load = useCallback(() => getReviewDetail(sessionId).then(r => {
    setDetail(r.data); setNames(r.lossNames)
    setLoss(r.data.review?.final_loss_code ?? ''); setNote(r.data.review?.reviewer_note ?? ''); setPublish(Boolean(r.data.review?.published_at)); setDropped([])
  }).catch(cause => { setError(message(cause)); close() }), [sessionId, setError, close])
  useEffect(() => { void load() }, [load])
  const act = async (work: () => Promise<unknown>, after = true) => { setBusy(true); setLocal(''); try { await work(); await load(); if (after) changed() } catch (cause) { setLocal(message(cause)) } finally { setBusy(false) } }
  if (!detail) return <Drawer title="询盘复盘" close={close}><div className="shop-empty"><LoaderCircle size={24} className="spin" /></div></Drawer>
  const { session, facts, review, products, productFacts, canReview } = detail
  const findings: Finding[] = review?.final_findings ?? review?.ai_findings ?? []
  const kept = findings.filter((_, i) => !dropped.includes(i))
  const editedFindings = dropped.length > 0, changedLoss = loss !== (review?.final_loss_code ?? '')
  const aiName = review?.ai_loss_code ? names[review.ai_loss_code] ?? review.ai_loss_code : null
  // Re-saving a correction (to publish it, say) stays a correction, and keeps the findings it already has.
  const correcting = changedLoss || editedFindings || review?.status === 'corrected'
  const decide = (action: 'confirm' | 'correct' | 'dismiss') => act(() => decideReview(session.id, { revision: review?.revision ?? 0, action, lossCode: loss || null, ...(editedFindings || review?.final_findings ? { findings: kept } : {}), note: note || null, publish }))
  return <Drawer title={`${session.chat_date} · ${agentLabel(session)} · 买家尾号 ${session.buyer_tail}`} close={close}>
    <div className="review-drawer">
      <div>
        <InferenceNote />
        {local && <div className="shop-feedback error" role="alert"><span>{local}</span></div>}
        {facts && <dl className="review-facts"><div><dt>结果</dt><dd>{categoryNames[facts.category] ?? facts.category}{facts.matured ? '' : '（观察中）'}</dd></div><div><dt>首次响应</dt><dd>{seconds(facts.first_response_seconds)}</dd></div><div><dt>买家消息</dt><dd>{facts.buyer_messages} 条</dd></div><div><dt>客服文字</dt><dd>{facts.real_chars} 字（话术 {facts.template_messages} 条）</dd></div><div><dt>内容不可见</dt><dd>{facts.other_agent_messages} 条</dd></div><div><dt>买家关键词</dt><dd>{facts.keywords.length ? facts.keywords.join('、') : '无命中'}</dd></div></dl>}
        {facts?.rule_loss_code && <p className="review-rule">规则判定：<b>{names[facts.rule_loss_code]}</b>（由时间记录得出）</p>}
        <h3 className="perf-chart-title">关联商品</h3>
        {!products.length && <p className="shop-note">没有证据能确定商品。</p>}
        <ul className="review-products">{products.map(p => <li key={`${p.offer_id}-${p.source}`}><b>{p.product_name ?? p.offer_id}</b><small>{({ manual: '主管指定', agent_link: '客服发的链接', order_after: '之后下单的商品', keyword: '商品关键词', recent_order: '买家近 90 天买过（仅供参考）', ai_text: 'AI 识别' } as Record<string, string>)[p.source ?? ''] ?? p.source} · 可信度{confidenceNames[p.confidence]}</small>
          {canReview && p.source === 'manual' && <button disabled={busy} onClick={() => void act(() => removeSessionProduct(session.id, p.offer_id))}>移除</button>}</li>)}</ul>
        {canReview && <form className="review-inline" onSubmit={e => { e.preventDefault(); const id = offer.trim(); if (id) void act(() => setSessionProduct(session.id, id).then(() => setOffer(''))) }}><input aria-label="指定商品 ID" placeholder="手动指定商品 ID" value={offer} onChange={e => setOffer(e.target.value)} /><button className="shop-button" disabled={busy || !offer.trim()}>指定</button></form>}
        {productFacts.some(p => Object.keys(p.facts).length) && <details className="review-facts-list"><summary>商品资料（用于核对客服说法）</summary>{productFacts.map(p => <div key={p.offer_id}><b>{p.title ?? p.offer_id}</b><ul>{Object.entries(p.facts).slice(0, 40).map(([k, v]) => <li key={k}>{k}：{v}</li>)}</ul></div>)}</details>}
        <h3 className="perf-chart-title">聊天记录</h3>
        <WangwangButton buyerId={session.buyer_id} setError={setLocal} label="在旺旺查看或联系买家" />
        <Timeline data={{ session: { id: session.id, chat_date: session.chat_date, login_id: session.login_id, is_main: session.is_main }, messages: detail.messages, turns: [] }} />
      </div>
      <aside className="review-side">
        <h3 className="perf-chart-title">复盘结论</h3>
        {review ? <p className="review-state"><span className={`shop-status ${review.status === 'pending' ? 'warning' : 'positive'}`}>{statusNames[review.status]}</span>{review.published_at ? ' · 业务员可见' : ' · 业务员不可见'}</p> : <p className="shop-note">还没有分析结果。证据少的会话通常靠规则和主管判断。</p>}
        {aiName && <div className="review-ai"><b><Sparkles size={13} />AI 推断：{aiName}</b><small>可信度{confidenceNames[review?.ai_loss_confidence ?? 'low']} · {review?.model} · {review?.prompt_version}</small>{review?.ai_coaching && <p>建议：{review.ai_coaching}</p>}</div>}
        {!review?.ai_loss_code && review?.final_loss_code && <p>主管判断：<b>{names[review.final_loss_code]}</b></p>}
        {findings.length > 0 && <ul className="review-findings">{findings.map((f, i) => <li key={i} className={dropped.includes(i) ? 'dropped' : ''}><b>{findingNames[f.type] ?? f.type}</b>{f.fact_ref && <small>资料项：{f.fact_ref}</small>}<p>{f.summary}</p>{f.excerpt && <q>{f.excerpt}</q>}
          {canReview && <button disabled={busy} onClick={() => setDropped(current => current.includes(i) ? current.filter(x => x !== i) : [...current, i])}>{dropped.includes(i) ? '恢复' : '去掉这条'}</button>}</li>)}</ul>}
        {review?.reviewer_note && !canReview && <p>主管说明：{review.reviewer_note}</p>}
        {review?.agent_response && <p className="review-response">业务员说明：{review.agent_response}</p>}
        {canReview && <div className="review-decide">
          <label>流失原因<select aria-label="流失原因" value={loss} onChange={e => setLoss(e.target.value)}><option value="">{aiName ? `采用 AI 推断（${aiName}）` : facts?.rule_loss_code ? `采用规则（${names[facts.rule_loss_code]}）` : '不指定'}</option>{Object.entries(names).map(([code, name]) => <option key={code} value={code}>{name}</option>)}</select></label>
          <label>主管说明<textarea aria-label="主管说明" rows={3} maxLength={1000} value={note} onChange={e => setNote(e.target.value)} /></label>
          <label className="review-check"><input type="checkbox" checked={publish} onChange={e => setPublish(e.target.checked)} />发布给业务员本人</label>
          <div className="review-actions">
            <button className="shop-button primary" disabled={busy} onClick={() => void decide(correcting ? 'correct' : 'confirm')}>{correcting ? '保存纠正' : '确认'}</button>
            <button className="shop-button" disabled={busy} onClick={() => void decide('dismiss')}>不算问题</button>
            {(!review || review.status === 'pending') && <button className="shop-button" disabled={busy} onClick={() => void act(() => analyzeReviewSession(session.id))}><Sparkles size={14} />{review?.ai_loss_code ? '重新分析' : 'AI 分析'}</button>}
          </div>
          <form className="review-inline" onSubmit={e => { e.preventDefault(); const title = coach.trim(); if (title) void act(() => createCoachingItem({ agentId: session.agent_id, reviewId: review?.id, title }).then(() => setCoach('')), false) }}><input aria-label="改进事项" placeholder="给业务员加一条改进事项" maxLength={200} value={coach} onChange={e => setCoach(e.target.value)} /><button className="shop-button" disabled={busy || !coach.trim()}>添加</button></form>
        </div>}
        {detail.own && review?.published_at && <form className="review-decide" onSubmit={e => { e.preventDefault(); const text = response.trim(); if (text) void act(() => respondToReview(review.id, text).then(() => setResponse('')), false) }}><label>我的说明<textarea aria-label="我的说明" rows={3} maxLength={1000} value={response} onChange={e => setResponse(e.target.value)} /></label><button className="shop-button" disabled={busy || !response.trim()}>提交</button></form>}
      </aside>
    </div>
  </Drawer>
}

function ReviewSettingsPanel({ user, connectionId, setError }: { user: SessionUser; connectionId: string; setError: (text: string) => void }) {
  const [settings, setSettings] = useState<ReviewSettings | null>(null), [busy, setBusy] = useState(false), [saved, setSaved] = useState('')
  const canManage = can(user, 'performance:manage')
  const load = useCallback(() => getReviewSettings(connectionId).then(r => setSettings(r.data)).catch(cause => setError(message(cause))), [connectionId, setError])
  useEffect(() => { void load() }, [load])
  if (!settings) return null
  const yesterday = new Date(Date.now() + 8 * 3_600_000 - 86_400_000).toISOString().slice(0, 10)
  const update = (patch: Partial<ReviewSettings>) => { setSettings({ ...settings, ...patch }); setSaved('') }
  async function save() { setBusy(true); try { await saveReviewSettings({ enabled: settings!.enabled, dailySessionLimit: settings!.daily_session_limit, minRealChars: settings!.min_real_chars, model: settings!.model }); setSaved('已保存'); await load() } catch (cause) { setError(message(cause)) } finally { setBusy(false) } }
  async function run() { setBusy(true); try { await queueReviewRun(connectionId, yesterday); setSaved(`已排队复盘 ${yesterday}`); await load() } catch (cause) { setError(message(cause)) } finally { setBusy(false) } }
  return <section className="review-settings" aria-label="AI 复盘设置">
    <label className="review-check"><input type="checkbox" disabled={!canManage} checked={settings.enabled} onChange={e => update({ enabled: e.target.checked })} />每天早上 6 点自动分析昨天的会话（把客服遮盖后的文字发给阿里云百炼）</label>
    <div><label>每天最多<input type="number" min={0} max={2000} disabled={!canManage} value={settings.daily_session_limit} onChange={e => update({ daily_session_limit: Number(e.target.value) })} />个会话</label>
      <label>至少<input type="number" min={1} max={1000} disabled={!canManage} value={settings.min_real_chars} onChange={e => update({ min_real_chars: Number(e.target.value) })} />字真实文字才分析</label>
      <label>模型<select disabled={!canManage} value={settings.model} onChange={e => update({ model: e.target.value })}>{settings.models.map(m => <option key={m}>{m}</option>)}</select></label></div>
    {canManage && <div className="review-actions"><button className="shop-button primary" disabled={busy} onClick={() => void save()}>保存</button><button className="shop-button" disabled={busy} onClick={() => void run()}>立即复盘昨天</button>{saved && <span className="shop-note">{saved}</span>}</div>}
    {settings.runs.length > 0 && <div className="shop-table-scroll"><table className="shop-table"><thead><tr><th>日期</th><th>状态</th><th>分析/候选</th><th>失败</th><th>Token（入/出）</th></tr></thead><tbody>{settings.runs.map(r => <tr key={r.id}><td>{r.review_date}</td><td>{({ queued: '排队中', running: '进行中', succeeded: '完成', failed: '失败' } as Record<string, string>)[r.status]}{r.error_message && <small>{r.error_message}</small>}</td><td>{r.stats.analyzed ?? 0}/{r.stats.candidates ?? 0}</td><td>{r.stats.failed ?? 0}</td><td>{r.stats.inputTokens ?? 0}/{r.stats.outputTokens ?? 0}</td></tr>)}</tbody></table></div>}
  </section>
}

/** 询盘分析 additions: why inquiries were lost (reviewers only) and which products they were about, always with sample size and coverage. */
export function InquiryLossPanels({ user, connectionId, from, to, setError }: { user: SessionUser; connectionId: string; from: string; to: string; setError: (text: string) => void }) {
  const [loss, setLoss] = useState<LossAnalysis | null>(null), [names, setNames] = useState<LossNames>({}), [products, setProducts] = useState<ProductInquiry | null>(null), [includeAi, setIncludeAi] = useState(false)
  const reviewer = canSeeReviews(user)
  useEffect(() => { if (reviewer) getLossAnalysis(connectionId, from, to, includeAi).then(r => { setLoss(r.data); setNames(r.lossNames) }).catch(cause => setError(message(cause))) }, [connectionId, from, to, includeAi, reviewer, setError])
  useEffect(() => { getProductInquiry(connectionId, from, to).then(r => setProducts(r.data)).catch(cause => setError(message(cause))) }, [connectionId, from, to, setError])
  const most = Math.max(1, ...(loss?.reasons ?? []).map(r => r.sessions))
  return <div className="review-panels">
    {reviewer && loss && <section><h3 className="perf-chart-title">流失原因</h3><InferenceNote />
      <p className="shop-note">共 {loss.coverage.lost} 个已流失询盘：主管已确认 {loss.coverage.confirmed} 个，有足够文字可分析 {loss.coverage.sufficient} 个，能关联到商品 {loss.coverage.with_product} 个。</p>
      <label className="review-check"><input type="checkbox" checked={includeAi} onChange={e => setIncludeAi(e.target.checked)} />同时计入未确认的 AI 推断</label>
      {!loss.coverage.lost ? <p className="shop-note">这段时间没有已过归属窗口的流失询盘。</p> : <ul className="review-bars">{loss.reasons.map(r => <li key={r.code}><span>{names[r.code] ?? r.code}</span><i style={{ width: `${r.sessions / most * 100}%` }} /><b>{r.sessions}</b><small>{r.confirmed ? `确认 ${r.confirmed}` : ''}{r.by_rule ? ` 规则 ${r.by_rule}` : ''}</small></li>)}</ul>}
      {loss.refunds.length > 0 && <><h3 className="perf-chart-title">退款原因（买家自选，平台数据）</h3><ul className="review-bars">{loss.refunds.map(r => <li key={r.reason}><span>{r.reason}</span><i style={{ width: `${r.refunds / loss.refunds[0].refunds * 100}%` }} /><b>{r.refunds}</b></li>)}</ul></>}
    </section>}
    {products && <section><h3 className="perf-chart-title">商品询盘</h3>
      <p className="shop-note">已关联商品的询盘 {products.coverage.linked} / {products.coverage.inquiries}（{pct(products.coverage.linked, products.coverage.inquiries)}）；未下单询盘只有 {products.coverage.no_order_linked} / {products.coverage.no_order} 能确定商品，所以下表不代表全部询盘。成交的询盘按实际购买的商品统计。</p>
      {!products.products.length ? <p className="shop-note">这段时间没有能关联到商品的询盘。</p> : <div className="shop-table-scroll"><table className="shop-table"><thead><tr><th>商品</th><th>询盘</th><th>下单</th><th>付款</th><th>流失</th><th>取消单</th><th>退款</th><th>退款原因</th></tr></thead><tbody>{products.products.map(p => <tr key={p.offer_id}><td>{p.name ?? p.offer_id}<small>{p.offer_id}</small></td><td>{p.sessions}</td><td>{p.ordered}</td><td>{p.paid}</td><td>{p.lost}</td><td>{p.cancelled}</td><td>{p.refunds}</td><td>{p.refund_reasons.join('、') || '—'}</td></tr>)}</tbody></table></div>}
    </section>}
  </div>
}
