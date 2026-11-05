import { request } from './api'

const base = '/api/integrations/1688/performance'
const post = <T>(path: string, body?: object) => request<T>(`${base}${path}`, { method: 'POST', ...(body ? { body: JSON.stringify(body) } : {}) })

export type PerformanceConnection = { id:string; app_key:string; ali_id:string; member_id:string|null; login_id:string|null; display_name:string; access_expires_at:string; refresh_expires_at:string|null; status:'connected'|'reauthorize'|'disabled'; member_capability:'unknown'|'available'|'unavailable'; account_role:'unknown'|'main'|'sub'; main_login_id:string|null; sub_account_count:number|null; last_tested_at:string|null }
export type PerformanceOperation = { id:string; api_name:string; outcome:string; error_code:string|null; duration_ms:number; created_at:string; display_name:string|null }
export type AttributionScheme = 'order_first'|'payment_first'|'order_only'|'payment_only'|'memo_flag'|'payment_day_chat'|'order_payment_split'|'owner_only'|'owner_collaborator_split'
export type PerformanceSettings = { attribution_window_hours:number; unanswered_threshold_seconds:number; count_other_as_reply:boolean; work_hours_enabled:boolean; work_start:string; work_end:string; default_scheme:AttributionScheme; split_order_share:number; owner_share:number; auto_assign_owner:boolean; revision:number; updated_at:string }

export const attributionSchemeNames: Record<AttributionScheme,string> = {
  order_first: '方案1：绩效优先给促成下单的客服',
  payment_first: '方案2：绩效优先给促成付款的客服',
  order_only: '方案3：绩效只给促成下单的客服',
  payment_only: '方案4：绩效只给促成付款的客服',
  memo_flag: '方案5：绩效只给订单插旗备注的客服',
  payment_day_chat: '方案6：绩效给付款当日有聊天的客服',
  order_payment_split: '方案7：促成下单和促成付款的客服按比例分成',
  owner_only: '方案8：绩效只给会员所属的客服',
  owner_collaborator_split: '方案9：会员所属客服和协作客服按比例分成',
}

export const getPerformanceConnections = () => request<{data:PerformanceConnection[];configured:boolean}>(`${base}/connections`)
export const startPerformanceAuthorization = () => post<{data:{authorizationUrl:string}}>('/authorizations')
export const completePerformanceAuthorization = (callbackUrl:string) => post<{data:PerformanceConnection}>('/authorizations/complete',{callbackUrl})
export const testPerformanceConnection = (id:string) => post<{data:{verified:boolean;accountRole:string;subAccountCount:number|null}}>(`/connections/${id}/test`)
export const refreshPerformanceToken = (id:string) => post(`/connections/${id}/refresh`)
export const disablePerformanceConnection = (id:string) => post(`/connections/${id}/disable`)
export const getPerformanceOperations = (page:number) => request<{data:PerformanceOperation[]}>(`${base}/operations?page=${page}`)
export const getPerformanceSettings = () => request<{data:PerformanceSettings}>(`${base}/settings`)
export const savePerformanceSettings = (input:{revision:number;attributionWindowHours?:number;unansweredThresholdSeconds?:number;countOtherAsReply?:boolean;workHoursEnabled?:boolean;workStart?:string;workEnd?:string;defaultScheme?:AttributionScheme;splitOrderShare?:number;ownerShare?:number;autoAssignOwner?:boolean}) =>
  request<{data:PerformanceSettings}>(`${base}/settings`,{method:'PUT',body:JSON.stringify(input)})

export type PerformanceAgent = { id:string; login_id:string; is_main:boolean; platform_status:string|null; present:boolean; user_id:string|null; user_name:string|null; binding_revision:number; relations_synced_until:string|null }
export type AgentMetrics = { agent_id:string; login_id:string; is_main:boolean; present:boolean; user_id:string|null; user_name:string|null; reception:number; effective_reception:number; unanswered:number; transfers:number; buyer_messages:number; agent_messages:number; other_agent_messages:number; auto_replies:number; first_response_seconds:number|null; avg_response_seconds:number|null; inquiry:number; new_customer_inquiry:number; after_sales:number; ordered_buyers:number; paid_buyers:number; orders:number; order_amount:number; paid_amount:number; refund_amount:number }
export type SyncRun = { id:string; trigger:'schedule'|'manual'; backfill_days:number|null; scope_days:1|7|30|null; status:'queued'|'running'|'succeeded'|'failed'; phase:string|null; attempts:number; stats:Record<string,number>; error_code:string|null; error_message:string|null; created_at:string; started_at:string|null; finished_at:string|null }
export type HourlyReception = { buckets:{key:number;label:string}[]; cells:{agent_id:string;bucket:number;reception:number}[] }
const range = (connectionId:string,from:string,to:string) => new URLSearchParams({connectionId,from,to}).toString()
export const getPerformanceAgents = (connectionId:string) => request<{data:PerformanceAgent[]}>(`${base}/agents?${new URLSearchParams({connectionId})}`)
export const bindPerformanceAgent = (id:string,userId:string|null,revision:number) => request<{data:PerformanceAgent}>(`${base}/agents/${id}/binding`,{method:'PUT',body:JSON.stringify({userId,revision})})
export type SyncScope = 1|7|30
export type HistoryDays = 7|30|60|90
export type SyncStatus = { history_days:HistoryDays; history_from:string; orders_synced_from:string|null; refunds_synced_from:string|null; chats_synced_from:string|null; pending_sessions:number; skipped_sessions:number; calls_today:number; daily_call_limit:number }
/** Without a scope: full run (new activity plus history back to the shop's range). */
export const startPerformanceSync = (connectionId:string,scopeDays?:SyncScope) => post<{data:{id:string}}>(`/connections/${connectionId}/sync`,scopeDays?{scopeDays}:{})
export const getSyncStatus = (connectionId:string) => request<{data:SyncStatus}>(`${base}/connections/${connectionId}/sync-status`)
export const saveHistoryDays = (connectionId:string,days:HistoryDays) => request<{data:{historyDays:HistoryDays}}>(`${base}/connections/${connectionId}/history-days`,{method:'PUT',body:JSON.stringify({days})})
export const getPerformanceSyncRuns = (connectionId:string) => request<{data:SyncRun[]}>(`${base}/sync-runs?${new URLSearchParams({connectionId})}`)
export const getAgentMetrics = (connectionId:string,from:string,to:string) => request<{data:AgentMetrics[];syncedAt:string|null;scheme:AttributionScheme}>(`${base}/metrics?${range(connectionId,from,to)}`)
export const getHourlyReception = (connectionId:string,from:string,to:string) => request<{data:HourlyReception}>(`${base}/metrics/hourly?${range(connectionId,from,to)}`)

export const availableSchemes: AttributionScheme[] = ['order_first','payment_first','order_only','payment_only','memo_flag','payment_day_chat','order_payment_split','owner_only','owner_collaborator_split']
export type CreditBasis = 'order_reply'|'payment_reply'|'payment_day_chat'|'owner'|'memo_mention'|'memo_flag'
export const creditBasisNames: Record<CreditBasis,string> = { order_reply:'下单前最后回复', payment_reply:'付款前最后回复', payment_day_chat:'付款当日聊天', owner:'会员所属客服', memo_mention:'备注 @客服', memo_flag:'订单旗帜' }
export type FlagRules = { rules:{flag:number;agent_id:string}[]; usage:{flag:number;orders:number}[]; memoMentions:number; creditedOrders:number }
export const getFlagRules = (connectionId:string) => request<{data:FlagRules}>(`${base}/connections/${connectionId}/flag-rules`)
export const saveFlagRules = (connectionId:string,rules:{flag:number;agentId:string}[]) => request<{data:FlagRules['rules']}>(`${base}/connections/${connectionId}/flag-rules`,{method:'PUT',body:JSON.stringify({rules})})
export type ChatCategory = 'no_order'|'ordered_unpaid'|'paid'|'after_sales'
export const chatCategoryNames: Record<ChatCategory,string> = { no_order:'未下单', ordered_unpaid:'下单未付款', paid:'促成付款', after_sales:'售后聊天' }
export type ChatSession = { id:string; agent_id:string; buyer_id:string; login_id:string; is_main:boolean; user_name:string|null; buyer_tail:string; chat_date:string; started_at:string; last_peer_at:string; buyer_messages:number; agent_messages:number; other_agent_messages:number; auto_replies:number; transferred:boolean; category:ChatCategory; orders_after:string[]|null; paid_after:string[]|null; new_customer:boolean; first_response_seconds:number|null; unanswered:number }
export type ChatMessage = { uuid:string; direction:0|1; sent_at:string; length:number; message_types:string[]; keywords:{word:string;count:number}[]; text_masked?:string|null; flags?:string[] }
export const OFFSITE_FLAGS = ['phone','wechat','qq','offsite','external_link'] as const
export const flagNames:Record<string,string> = { phone:'手机号', wechat:'微信', qq:'QQ', offsite:'站外付款/交易', external_link:'外部链接', curt:'生硬用语', short:'极短回复', image:'图片/卡片', address:'地址/退货信息' }
export type QualityAgent = { agent_id:string; login_id:string; is_main:boolean; user_name:string|null; messages:number; captured:number; avg_chars:number|null; short_replies:number; text_replies:number; images:number; curt:number; offsite:number }
export type QualityRisk = { uuid:string; sent_at:string; flags:string[]; text_masked:string|null; session_id:string; chat_date:string; login_id:string; buyer_tail:string; buyer_name:string|null }
export type ReplyQuality = { agents:QualityAgent[]; risks:QualityRisk[]; curt:{uuid:string;sent_at:string;text_masked:string;session_id:string;login_id:string}[]; coverage:number|null; totals:{messages:number;captured:number;offsite:number} }
export type ChatDetail = { session:{id:string;chat_date:string;login_id:string;is_main:boolean}; messages:ChatMessage[]; turns:{mode:'strict'|'loose';turn_index:number;turn_at:string;reply_at:string|null;buyer_messages:number}[] }
export type OrderCredit = { agent_id:string; login_id:string; is_main:boolean; user_name:string|null; share:number; basis:CreditBasis; basis_at:string|null }
export type CreditedOrder = { id:string; order_id:string; status:string; total_amount:number; placed_at:string; paid_at:string|null; refunded:number; items:{name:string|null;quantity:number;sku:string|null}[]; credits:OrderCredit[] }
export const getChatSessions = (params:{connectionId:string;from:string;to:string;category?:ChatCategory;agentId?:string;page:number}) =>
  request<{data:ChatSession[];counts:Partial<Record<ChatCategory,number>>}>(`${base}/chats?${new URLSearchParams(Object.entries(params).filter(([,v])=>v!==undefined&&v!=='').map(([k,v])=>[k,String(v)]))}`)
export const getChatDetail = (id:string) => request<{data:ChatDetail}>(`${base}/chats/${id}/messages`)
export const getCreditedOrders = (params:{connectionId:string;from:string;to:string;scheme?:AttributionScheme;agentId?:string;orderId?:string;attributed?:'yes'|'no';page:number}) =>
  request<{data:CreditedOrder[];scheme:AttributionScheme;pendingAttribution:number}>(`${base}/orders?${new URLSearchParams(Object.entries(params).filter(([,v])=>v!==undefined&&v!=='').map(([k,v])=>[k,String(v)]))}`)

export type KpiMetric = 'reception'|'effective_rate'|'inquiry'|'conversion'|'paid_amount'|'first_response_seconds'|'avg_response_seconds'|'unanswered_rate'
export type KpiItem = { metric:KpiMetric; weight:number }
export type KpiScheme = { items:KpiItem[]; revision:number; updatedAt:string|null; metrics:{key:KpiMetric;label:string;higherIsBetter:boolean}[] }
export type KpiRow = { agent_id:string; login_id:string; is_main:boolean; user_name:string|null; score:number; rank:number; parts:Partial<Record<KpiMetric,number>>; values:Partial<Record<KpiMetric,number|null>> }
export const getKpiScheme = () => request<{data:KpiScheme}>(`${base}/kpi`)
export const saveKpiScheme = (revision:number,items:KpiItem[]) => request<{data:{items:KpiItem[];revision:number}}>(`${base}/kpi`,{method:'PUT',body:JSON.stringify({revision,items})})
export const getKpiRanking = (connectionId:string,from:string,to:string) => request<{data:KpiRow[];items:KpiItem[]}>(`${base}/kpi/ranking?${range(connectionId,from,to)}`)
export const getFavorites = () => request<{data:{metrics:string[];columns:{key:string;label:string}[]}}>(`${base}/favorites`)
export const saveFavorites = (metrics:string[]) => request<{data:{metrics:string[]}}>(`${base}/favorites`,{method:'PUT',body:JSON.stringify({metrics})})
export const metricsExportPath = (connectionId:string,from:string,to:string,columns:string[]) => `${base}/metrics/export?${range(connectionId,from,to)}&${new URLSearchParams({columns:columns.join(',')})}`

export type PayRule = { agent_id:string|null; base_salary:number; commission_rate:number }
export type CommissionTier = { from:number; rate:number }
export type PaySettings = { rankBonuses:number[]; revision:number; updatedAt:string|null; defaultRule:PayRule; rules:PayRule[]; commissionMode:'flat'|'tiered'; tierStyle:'progressive'|'whole'; tiers:CommissionTier[]; floorZero:boolean }
export type CommissionDetail = { mode:'flat'|'tiered'; style:'progressive'|'whole'|null; net:number; bands:{from:number;to:number|null;amount:number;rate:number}[]; floored:boolean }
export type PayrollPeriod = { id:string; month:string; status:'draft'|'locked'; scheme:AttributionScheme; revision:number; calculated_at:string|null; locked_at:string|null; total?:number; agents?:number; locked_by_name?:string|null }
export type PayrollLine = { agent_id:string; login_id:string; is_main:boolean; user_name:string|null; base_salary:number; credited_orders:number; paid_amount:number; refund_amount:number; commission_rate:number; commission:number; commission_detail:CommissionDetail|null; kpi_score:number|null; kpi_rank:number|null; kpi_bonus:number; adjustments:number; total:number }
export type PayrollAdjustment = { id:string; agent_id:string; login_id:string; is_main:boolean; amount:number; reason:string; created_at:string; created_by_name:string|null }
export type PayrollDetail = PayrollPeriod & { lines:PayrollLine[]; adjustments?:PayrollAdjustment[] }
export type PayrollLineItems = { orders:{order_id:string;paid_at:string;total_amount:number;share:number;credited:number;basis:string}[]; refunds:{refund_id:string;order_id:string;completed_at:string;refund_amount:number;share:number;credited:number;apply_reason:string|null}[] }
export const getPaySettings = (connectionId:string) => request<{data:PaySettings}>(`${base}/pay-settings?${new URLSearchParams({connectionId})}`)
export const savePaySettings = (input:{connectionId:string;revision:number;rankBonuses:number[];defaultRule:{baseSalary:number;commissionRate:number};rules:{agentId:string;baseSalary:number;commissionRate:number}[];commissionMode:'flat'|'tiered';tierStyle:'progressive'|'whole';tiers:CommissionTier[];floorZero:boolean}) =>
  request<{data:{revision:number}}>(`${base}/pay-settings`,{method:'PUT',body:JSON.stringify(input)})
export const getPayrollPeriods = (connectionId:string) => request<{data:PayrollPeriod[]}>(`${base}/payroll?${new URLSearchParams({connectionId})}`)
export const calculatePayrollMonth = (connectionId:string,month:string) => post<{data:PayrollDetail}>('/payroll',{connectionId,month})
export const getPayroll = (id:string) => request<{data:PayrollDetail}>(`${base}/payroll/${id}`)
export const recalculatePayroll = (id:string,revision:number) => post<{data:PayrollDetail}>(`/payroll/${id}/recalculate`,{revision})
export const addPayrollAdjustment = (id:string,input:{revision:number;agentId:string;amount:number;reason:string}) => post<{data:PayrollDetail}>(`/payroll/${id}/adjustments`,input)
export const removePayrollAdjustment = (id:string,adjustmentId:string,revision:number) => request<{data:PayrollDetail}>(`${base}/payroll/${id}/adjustments/${adjustmentId}?revision=${revision}`,{method:'DELETE'})
export const lockPayroll = (id:string,revision:number) => post<{data:PayrollPeriod}>(`/payroll/${id}/lock`,{revision,confirmed:true})
export const getPayrollLineItems = (id:string,agentId:string) => request<{data:PayrollLineItems}>(`${base}/payroll/${id}/lines/${agentId}`)
export const payrollExportPath = (id:string) => `${base}/payroll/${id}/export`
export const getReplyQuality = (connectionId:string,from:string,to:string) => request<{data:ReplyQuality}>(`${base}/quality?${range(connectionId,from,to)}`)
export type PerfKeyword = { id:string; word:string; category:string; on_platform:boolean; created_at:string; checked_at:string; created_by_name:string|null }
export type KeywordPreset = { category:string; hint:string; words:string[] }
export type KeywordHit = { word:string; category:string; buyer_hits:number; agent_hits:number; sessions:number; buyers:number; last_hit:string }
export type KeywordRecent = { uuid:string; sent_at:string; direction:0|1; word:string; category:string; session_id:string; buyer_id:string; chat_date:string; login_id:string; buyer_tail:string; buyer_name:string|null }
export const getKeywords = (connectionId:string) => request<{data:PerfKeyword[];presets:KeywordPreset[]}>(`${base}/keywords?${new URLSearchParams({connectionId})}`)
export const addKeywords = (connectionId:string,words:{word:string;category:string;offerId?:string}[]) => post<{data:{added:string[];skipped:string[];failed:{word:string;message:string}[];keywords:PerfKeyword[]}}>('/keywords',{connectionId,words})
export const deleteKeyword = (id:string) => request<{data:PerfKeyword[]}>(`${base}/keywords/${id}`,{method:'DELETE'})
export const setKeywordCategory = (id:string,category:string) => request<{data:PerfKeyword[]}>(`${base}/keywords/${id}`,{method:'PATCH',body:JSON.stringify({category})})
export const reconcileKeywords = (connectionId:string) => post<{data:{platform:number;imported:number;missing:string[];keywords:PerfKeyword[]}}>('/keywords/reconcile',{connectionId})
export const getKeywordHits = (connectionId:string,from:string,to:string) => request<{data:{words:KeywordHit[];recent:KeywordRecent[]}}>(`${base}/keywords/hits?${range(connectionId,from,to)}`)

// 聊天与询盘
export type InquiryAgent = { agent_id:string; login_id:string; is_main:boolean; user_name:string|null; inquiries:number; new_buyers:number; ordered:number; paid:number }
export type InquirySummary = {
  totals:{ sessions:number; buyers:number; after_sales:number; inquiries:number; new_buyers:number; ordered:number; paid:number }
  daily:{ date:string; inquiries:number; new_buyers:number; paid:number }[]; hourly:{ hour:number; inquiries:number }[]; agents:InquiryAgent[]
  keywords:{ word:string; hits:number; sessions:number }[]
}
export type BuyerLookup = { id:string; buyer_tail:string; first_chat_at:string|null; last_chat_at:string|null
  sessions:{ id:string; chat_date:string; buyer_messages:number; agent_messages:number; login_id:string; is_main:boolean; user_name:string|null }[]
  orders:{ orders:number; paid:number; paid_amount:number; last_order_at:string|null } }
export type KeywordSession = { id:string; chat_date:string; buyer_id:string; buyer_tail:string; buyer_name:string|null; login_id:string; is_main:boolean; user_name:string|null; buyer_messages:number; agent_messages:number; hits:number; first_hit_at:string; first_hit_uuid:string }
/** Sessions in the period where a buyer message carried `word` (newest first, up to 50). */
export const getKeywordSessions = (connectionId:string, from:string, to:string, word:string) => request<{data:KeywordSession[];hasMore:boolean}>(`${base}/inquiry/keyword-sessions?${new URLSearchParams({ connectionId, from, to, word })}`)
export type PerfConnectionUsage = { status:string; display_name:string; orders:number; sessions:number; buyers:number; agents:number; followups:number; attachments:number; payrolls:number; locked_payrolls:number }
export const getPerformanceConnectionUsage = (id:string) => request<{data:PerfConnectionUsage}>(`${base}/connections/${id}/usage`)
export const deletePerformanceConnection = (id:string) => request<{data:{deleted:boolean}}>(`${base}/connections/${id}`,{method:'DELETE'})
export const getInquiry = (connectionId:string, from:string, to:string) => request<{data:InquirySummary}>(`${base}/inquiry?${new URLSearchParams({ connectionId, from, to })}`)
export const lookupBuyer = (connectionId:string, loginId:string) => post<{data:BuyerLookup|null}>('/buyers/lookup', { connectionId, loginId })
export const wangwangLinks = (buyerId:string) => post<{data:{ web:string; client:string }}>(`/buyers/${buyerId}/wangwang`, {})

// 订单
export type OrderGroup = 'unpaid'|'toship'|'shipped'|'done'|'closed'|'refund'
export type OrderRow = { order_id:string; status:string; status_group:OrderGroup|'other'; total_amount:number; product_amount:number; shipping_fee:number; refund_amount:number
  placed_at:string; paid_at:string|null; items:{ name:string; sku?:string; price:number; amount:number; quantity:number; productId?:string }[]; seller_memo:string|null; seller_flag:number|null
  buyer_rate_status:number|null; buyer_id:string|null; buyer_tail:string|null; agents:{ login_id:string; is_main:boolean; user_name:string|null; share:number }[]|null }
export type OrderDetail = {
  order:{ id:string; status:string; trade_type:string|null; created_at:string|null; paid_at:string|null; delivered_at:string|null; received_at:string|null; completed_at:string|null
    total_amount:number; product_amount:number; shipping_fee:number; discount:number; coupon:number; refund:number; pay_channels:string[]; close_reason:string|null
    buyer_memo:string|null; seller_memo:string|null; remark:string|null; credit:{ status:string|null; amount:number; unpaid:number }|null; seller_flag:number|null }
  buyer:{ login:string|null; company:string|null; level:string|null; buyer_id:string|null }
  receiver:{ name:string|null; mobile:string|null; phone:string|null; region:string|null; address:string|null; zip:string|null }
  items:{ name:string|null; image:string|null; sku:string|null; quantity:number; unit:string|null; price:number; amount:number; refund:number; status:string|null; cargo_number:string|null; product_id:string|null; snapshot_url:string|null }[]
  shipments:{ company:string|null; bill_no:string|null; status:string|null; delivered_at:string|null; no_logistics:string|null }[]
  rate:{ buyer:number|null; seller:number|null }; invoice:{ type:string|null; title:string|null }|null; masked:string[]
}
export const getOrderList = (params:{connectionId:string;from:string;to:string;group?:OrderGroup;search?:string;page:number;pageSize:number}) => {
  const q = new URLSearchParams(); Object.entries(params).forEach(([k,v]) => { if (v !== undefined && v !== '') q.set(k, String(v)) })
  return request<{data:OrderRow[];total:number;counts:Partial<Record<OrderGroup|'all'|'other',number>>;amount:number}>(`${base}/order-list?${q}`)
}
export const getOrderDetail = (connectionId:string, orderId:string) => request<{data:OrderDetail}>(`${base}/order-list/${orderId}?connectionId=${connectionId}`)
