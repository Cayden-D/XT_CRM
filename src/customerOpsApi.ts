import { download, request } from './api'

const base = '/api/customer-ops'
const json = (method: string, body: unknown) => ({ method, body: JSON.stringify(body) })

export type CustomerType = 'prospect'|'new'|'returning'|'loyal'
export type Level = 'normal'|'platinum'|'vip'
export type PriceTier = 'low'|'mid'|'high'
export type Followup = { id?:string; content:string; method:'wangwang'|'other'; need_follow_up:boolean; next_follow_up_at:string|null; created_at:string; superseded?:boolean; created_by_name?:string|null }
export type Customer = {
  id:string; connection_id:string; buyer_tail:string; name:string|null; wangwang_id:string|null; phone:string|null; wechat:string|null; email:string|null; qq:string|null; address:string|null
  member_identity:string|null; purchase_type:'distribution'|'procurement'|null; sales_channels:string[]; cycle_mode:'system'|'custom'; cycle_days:number|null; note:string|null
  account_id:string|null; owner_agent_id:string|null; owner_source:'manual'|'auto'|null; revision:number
  paid_orders:number; paid_amount:number; avg_order_amount:number|null; first_paid_at:string|null; last_paid_at:string|null; avg_interval_days:number|null; inquiry_days:number; last_chat_at:string|null
  unpaid_order_id:string|null; unpaid_amount:number|null; unpaid_placed_at:string|null; cycle:number; cycle_known:boolean
  followups:number; last_followup:Followup|null; next_follow_up_at:string|null; tag_ids:string[]
  customer_type:CustomerType; level:Level|null; price_tier:PriceTier|null; overdue:boolean; overdue_at:string|null; pool:'unpaid'|'no_order'|null
  due_reason:'planned'|'overdue'|null; last_followup_at:string|null; attachments:number
}
export type CustomerDetail = { customer:Customer; followups:Followup[]; orders:{order_id:string;status:string;total_amount:number;placed_at:string;paid_at:string|null;refunded:number;items:{name:string|null;quantity:number}[]}[]
  chats:{id:string;chat_date:string;buyer_messages:number;agent_messages:number;login_id:string;is_main:boolean}[]; account:{id:string;name:string}|null }
export type Tag = { id:string; name:string; customers:number }
export type Options = { shops:{id:string;display_name:string;status:string}[]; tags:Tag[]; memberIdentities:string[]; salesChannels:string[]; offlineCustomers:number }
export type CustomerSettings = { level_platinum:number; level_vip:number; price_mid:number; price_high:number; loyal_orders:number; default_cycle_days:number; overdue_followup:boolean; revision:number; updated_at:string }
export type Filters = { search?:string; purchaseType?:string[]; customerType?:string[]; memberIdentity?:string[]; channel?:string[]; level?:string[]; priceTier?:string[]; tagId?:string[]
  minFollowups?:number; overdue?:'no'|'yes'; idleDays?:number; cycle?:string[]; pool?:'unpaid'|'no_order'|'any'; due?:'yes'; sort?:string; page?:number }
export type ProfileInput = { revision:number; name:string|null; wangwangId:string|null; phone:string|null; wechat:string|null; email:string|null; qq:string|null; address:string|null
  memberIdentity:string|null; purchaseType:'distribution'|'procurement'|null; salesChannels:string[]; cycleMode:'system'|'custom'; cycleDays:number|null; note:string|null; accountId:string|null; ownerAgentId:string|null|'auto' }

export const getOptions = () => request<{data:Options}>(`${base}/options`)
function query(connectionId:string, filters:Filters) {
  const params = new URLSearchParams({ connectionId })
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === '' || (Array.isArray(value) && !value.length)) continue
    params.set(key, Array.isArray(value) ? value.join(',') : String(value))
  }
  return params
}
export const getCustomers = (connectionId:string, filters:Filters) => request<{data:Customer[];total:number;online:number}>(`${base}/customers?${query(connectionId, filters)}`)
export const exportCustomers = (connectionId:string, filters:Filters) => download(`${base}/customers/export?${query(connectionId, { ...filters, page: undefined })}`, '线上客户.csv')
export const getCustomer = (id:string) => request<{data:CustomerDetail}>(`${base}/customers/${id}`)
export const saveProfile = (id:string, input:ProfileInput) => request<{data:{revision:number}}>(`${base}/customers/${id}/profile`, json('PUT', input))
export const addFollowup = (id:string, input:{content:string;method:'wangwang'|'other';needFollowUp:boolean;nextFollowUpAt:string|null}) => request(`${base}/customers/${id}/followups`, json('POST', input))
export const setCustomerTags = (id:string, tagIds:string[]) => request(`${base}/customers/${id}/tags`, json('PUT', { tagIds }))
export const bulkTag = (buyerIds:string[], tagId:string, action:'add'|'remove') => request<{data:{changed:number}}>(`${base}/customers/bulk-tags`, json('POST', { buyerIds, tagId, action }))
export const createTag = (name:string) => request<{data:Tag}>(`${base}/tags`, json('POST', { name }))
export const deleteTag = (id:string) => request(`${base}/tags/${id}`, { method:'DELETE' })
export const getCustomerSettings = () => request<{data:CustomerSettings}>(`${base}/settings`)
export const saveCustomerSettings = (input:{revision:number;levelPlatinum:number;levelVip:number;priceMid:number;priceHigh:number;loyalOrders:number;defaultCycleDays:number;overdueFollowup?:boolean}) =>
  request<{data:CustomerSettings}>(`${base}/settings`, json('PUT', input))
export const getShopAgents = (connectionId:string) => request<{data:{id:string;login_id:string;is_main:boolean;present:boolean}[]}>(`${base}/agents?${new URLSearchParams({connectionId})}`)

export type Attachment = { id:string; kind:'image'|'file'; name:string; mime:string; size:number; created_at:string; created_by_name:string|null; url:string }
export type AttachmentLimits = Record<'image'|'file',{count:number;bytes:number}>
/** Accepted uploads by extension (some systems report no MIME type for CSV/Office files). */
export const attachmentMimes: Record<string,string> = { jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png', gif:'image/gif', webp:'image/webp', pdf:'application/pdf',
  docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', txt:'text/plain', csv:'text/csv' }
export const getAttachments = (id:string) => request<{data:Attachment[];limits:AttachmentLimits}>(`${base}/customers/${id}/attachments`)
export const uploadAttachment = (id:string, input:{name:string;mime:string;content:string}) => request<{data:Attachment}>(`${base}/customers/${id}/attachments`, json('POST', input))
export const deleteAttachment = (id:string, attachmentId:string) => request(`${base}/customers/${id}/attachments/${attachmentId}`, { method:'DELETE' })
