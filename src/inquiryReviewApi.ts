import { request } from './api'
import type { ChatMessage } from './performanceApi'

const base = '/api/integrations/1688/performance'
const send = <T>(method: string, path: string, body?: object) => request<T>(`${base}${path}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) })
const period = (connectionId: string, from: string, to: string, extra: Record<string, string> = {}) => new URLSearchParams({ connectionId, from, to, ...extra })

export type LossNames = Record<string, string>
export type Finding = { type: string; summary: string; message_uuid?: string | null; excerpt?: string | null; fact_ref?: string }
export type LinkedProduct = { offer_id: string; name?: string | null; product_name?: string | null; confidence: string; source?: string; evidence_message_uuid?: string | null }
export type WorklistRow = { id: string; agent_id: string; chat_date: string; started_at: string; category: string; new_customer: boolean; buyer_messages: number; agent_messages: number; other_agent_messages: number; real_chars: number; text_messages: number; template_messages: number; offsite: number; keywords: string[]; first_response_seconds: number | null; matured: boolean; evidence_level: 'rules_only' | 'thin' | 'sufficient'; rule_loss_code: string | null; review_id: string | null; review_status: string; review_revision: number; ai_loss_code: string | null; ai_loss_confidence: string | null; finding_count: number; final_loss_code: string | null; published_at: string | null; priority: number; login_id: string; is_main: boolean; user_name: string | null; buyer_tail: string; products: LinkedProduct[] }
export type WorklistTotals = { inquiries: number; lost: number; watching: number; pending: number; thin_evidence: number }
export type Review = { id: string; status: string; revision: number; ai_loss_code?: string | null; ai_loss_confidence?: string | null; ai_findings?: Finding[]; ai_coaching?: string | null; final_loss_code: string | null; final_findings: Finding[] | null; reviewer_note: string | null; published_at: string | null; agent_response: string | null; model?: string | null; prompt_version?: string | null; input_tokens?: number | null; output_tokens?: number | null }
export type ReviewDetail = {
  session: { id: string; chat_date: string; agent_id: string; login_id: string; is_main: boolean; user_name: string | null; buyer_id: string; buyer_tail: string }
  facts: { category: string; buyer_messages: number; agent_messages: number; other_agent_messages: number; real_chars: number; text_messages: number; template_messages: number; offsite: number; keywords: string[]; first_response_seconds: number | null; matured: boolean; evidence_level: string; rule_loss_code: string | null } | undefined
  messages: (ChatMessage & { linked_offer_ids?: string[] })[]; turns: never[]; products: LinkedProduct[]; review: Review | null; productFacts: { offer_id: string; title: string | null; facts: Record<string, string> }[]; own: boolean; canReview: boolean
}
export type LossAnalysis = { reasons: { code: string; sessions: number; confirmed: number; by_rule: number }[]; agents: { agent_id: string; login_id: string; is_main: boolean; user_name: string | null; code: string; sessions: number }[]; coverage: { lost: number; confirmed: number; sufficient: number; with_product: number }; refunds: { reason: string; refunds: number }[]; includeAi: boolean }
export type ProductInquiry = { products: { offer_id: string; name: string | null; sessions: number; before_order: number; ordered: number; paid: number; lost: number; cancelled: number; refunds: number; refund_reasons: string[] }[]; coverage: { no_order: number; no_order_linked: number; inquiries: number; linked: number } }
export type DayStats = { inquiries: number; paid: number; unpaid: number; no_order: number; no_reply: number; slow_reply: number; avg_first_response: number | null; text_messages: number; template_messages: number; offsite: number }
export type CoachingItem = { id: string; title: string; detail: string | null; status: 'open' | 'acknowledged' | 'done' | 'dropped'; due_date: string | null; review_id: string | null; created_at: string; created_by_name: string | null }
export type AgentBrief = { agent: { id: string; login_id: string; is_main: boolean; user_name: string | null }; stats: { today: DayStats; previousDays: number; previousDailyAverage: { inquiries: number; paid: number; no_order: number; no_reply: number } }; summary: string | null; supervisorNote: string | null
  reviews: { id: string; session_id: string; chat_date: string; status: string; ai_loss_code: string | null; final_loss_code: string | null; ai_findings: Finding[]; final_findings: Finding[] | null; ai_coaching: string | null; reviewer_note: string | null; published_at: string | null; agent_response: string | null }[]
  trend: { date: string; today: DayStats }[]; items: CoachingItem[]; canReview: boolean; own: boolean }
export type ReviewSettings = { enabled: boolean; daily_session_limit: number; min_real_chars: number; model: string; models: string[]; runs: { id: string; review_date: string; status: string; stats: { candidates?: number; analyzed?: number; failed?: number; inputTokens?: number; outputTokens?: number; briefs?: number }; error_message: string | null; finished_at: string | null }[] }

export const getWorklist = (connectionId: string, from: string, to: string, status: string, agentId?: string) => request<{ data: WorklistRow[]; totals: WorklistTotals; lossNames: LossNames }>(`${base}/inquiry-review/worklist?${period(connectionId, from, to, { status, ...(agentId ? { agentId } : {}) })}`)
export const getReviewDetail = (id: string) => request<{ data: ReviewDetail; lossNames: LossNames }>(`${base}/inquiry-review/sessions/${id}`)
export const analyzeReviewSession = (id: string) => send<{ data: Review }>('POST', `/inquiry-review/sessions/${id}/analyze`)
export const decideReview = (id: string, body: { revision: number; action: 'confirm' | 'correct' | 'dismiss'; lossCode?: string | null; findings?: Finding[]; note?: string | null; publish: boolean }) => send<{ data: Review }>('PUT', `/inquiry-review/sessions/${id}/review`, body)
export const respondToReview = (id: string, text: string) => send('POST', `/inquiry-review/reviews/${id}/response`, { text })
export const setSessionProduct = (id: string, offerId: string) => send('PUT', `/inquiry-review/sessions/${id}/products`, { offerId })
export const removeSessionProduct = (id: string, offerId: string) => send('DELETE', `/inquiry-review/sessions/${id}/products/${offerId}`)
export const getLossAnalysis = (connectionId: string, from: string, to: string, includeAi: boolean) => request<{ data: LossAnalysis; lossNames: LossNames }>(`${base}/inquiry/loss-analysis?${period(connectionId, from, to, { includeAi: String(includeAi) })}`)
export const getProductInquiry = (connectionId: string, from: string, to: string) => request<{ data: ProductInquiry }>(`${base}/inquiry/products?${period(connectionId, from, to)}`)
export const getAgentBrief = (agentId: string, date: string) => request<{ data: AgentBrief; lossNames: LossNames }>(`${base}/agents/${agentId}/brief?${new URLSearchParams({ date })}`)
export const saveBriefNote = (agentId: string, date: string, note: string) => send('PUT', `/agents/${agentId}/brief`, { date, note: note || null })
export const createCoachingItem = (body: { agentId: string; reviewId?: string | null; title: string; dueDate?: string | null }) => send('POST', '/coaching-items', body)
export const updateCoachingItem = (id: string, status: CoachingItem['status']) => send('PATCH', `/coaching-items/${id}`, { status })
export const getReviewSettings = (connectionId: string) => request<{ data: ReviewSettings }>(`${base}/inquiry-review/settings?${new URLSearchParams({ connectionId })}`)
export const saveReviewSettings = (body: { enabled: boolean; dailySessionLimit: number; minRealChars: number; model: string }) => send('PUT', '/inquiry-review/settings', body)
export const queueReviewRun = (connectionId: string, date: string) => send('POST', '/inquiry-review/runs', { connectionId, date })
