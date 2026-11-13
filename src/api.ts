const API_BASE = import.meta.env.VITE_API_URL ?? 'http://127.0.0.1:3001'
export const COLLECTOR_SCRIPT_URL = `${API_BASE}/api/product-collections/collector-script.user.js`
export const COLLECTOR_EXTENSION_URL = `${API_BASE}/api/product-collections/collector-extension.zip`
const TOKEN_KEY = 'ai_crm_access_token'

export type SessionUser = {
  sub?: string
  id?: string
  tenantId?: string
  email: string
  displayName: string
  roles: string[]
  permissions?: string[]
}



export type AssignableUser = { id: string; display_name: string; email: string; roles: string[] }
export type LeadActivity = { id: string; activity_type: string; subject: string | null; content: string; occurred_at: string; next_action: string | null; next_action_at: string | null; ai_generated: boolean; actor_name: string | null }

export type Account = {
  id: string; owner_id: string | null; owner_name: string | null; name: string; website: string | null; domain: string | null;
  province: string | null; city: string | null; district: string | null; address: string | null; industry: string | null; tax_id: string | null;
  credit_level: 'A' | 'B' | 'C' | 'D' | null; lifecycle_status: string; source: string | null; last_contact_at: string | null;
  created_at: string; updated_at: string; contact_count?: number; open_opportunity_count?: number; pipeline_amount?: string; order_total?: string;
}
export type AccountInput = {
  name: string; website?: string | null; domain?: string | null; province?: string | null; city?: string | null;
  district?: string | null; address?: string | null; industry?: string | null; taxId?: string | null; creditLevel?: Account['credit_level'];
  lifecycleStatus?: 'active' | 'silent' | 'public_pool' | 'lost'; source?: string | null; ownerId?: string | null;
}
export type Contact = { id: string; full_name: string; job_title: string | null; department: string | null; email: string | null; phone: string | null; wechat: string | null; preferred_channel: string | null; employment_status: string; is_primary: boolean; created_at: string; updated_at: string }
export type ContactInput = { fullName: string; jobTitle?: string | null; department?: string | null; email?: string | null; phone?: string | null; wechat?: string | null; preferredChannel?: 'email' | 'phone' | 'wechat' | 'meeting' | null; employmentStatus?: 'active' | 'left' | 'unknown'; isPrimary?: boolean }
export type AccountOpportunity = { id: string; name: string; amount: string; currency: string; expected_close_date: string | null; probability: string | null; ai_predicted_probability: string | null; status: string; stage_name: string; stage_code: string; created_at: string }
export type AccountTask = { id: string; title: string; description: string | null; priority: string; status: string; due_at: string | null; completed_at: string | null; assignee_name: string | null }
export type AccountOrder = { id: string; order_number: string; status: string; currency: string; total_amount: string; delivery_date: string | null; created_at: string }
export type AccountDetail = { account: Account; contacts: Contact[]; opportunities: AccountOpportunity[]; activities: LeadActivity[]; tasks: AccountTask[]; orders: AccountOrder[]; summary: { contactCount: number; openOpportunityCount: number; openPipeline: number; orderTotal: number; planned_amount: string; received_amount: string; overdue_count: number } }
export type ProductPrice = { id?:string;min_quantity:number|string;unit_price:number|string;customer_level:'A'|'B'|'C'|'D'|null;valid_from:string|null;valid_until:string|null }
export type Product = { package_weight_g?:number|null;id:string;sku:string;name:string;category:string|null;description:string|null;specifications:Record<string,string>;base_price:string;base_currency:string;status:'draft'|'active'|'inactive';created_at:string;updated_at:string;prices:ProductPrice[];images?:string[] }
export type Paged<T,F> = { data:T[];total:number;page:number;pageSize:number;facets:F }
export type ProductFacets = { all:number;active:number;draft:number;inactive:number }
export type CollectionStage = 'pending'|'queue'|'attention'|'promoted'|'published'
export type CollectionFacets = Record<'all'|CollectionStage,number>
/** A collected product as listed on the cards (the full record comes from the detail endpoint). */
export type CollectedProductCard = { id:string;source:'1688'|'alibaba';source_product_id:string;source_url:string;title:string;main_image_url:string|null;seller_name:string|null;processing_status:CollectedProduct['processing_status'];product_id:string|null;collected_at:string;updated_at:string;collector_name:string|null;queue_status:CollectedProduct['queue_status'];queue_message:string|null;stage:CollectionStage;variant_count:number;min_price:string|null;max_price:string|null }
export type ProductInput = { sku:string;name:string;category?:string|null;description?:string|null;specifications?:Record<string,string>;basePrice:number;status:'draft'|'active'|'inactive';prices:Array<{minQuantity:number;unitPrice:number;customerLevel?:'A'|'B'|'C'|'D'|null;validFrom?:string|null;validUntil?:string|null}> }
export type CollectedProduct = { id:string;source:'1688'|'alibaba';source_product_id:string;source_url:string;title:string;main_image_url:string|null;gallery_images:string[];detail_images:string[];video_url:string|null;description_url:string|null;currency:string;price_min:string|null;price_max:string|null;attributes:Record<string,string>;sku_props:unknown[];seller_name:string|null;seller_id:string|null;category_path:string|null;source_category_id:string|null;source_category_attributes:unknown[];tags:string[];collector_note:string|null;source_collected_at:string|null;raw_data:Record<string,unknown>;collector_mode:string|null;collector_version:string|null;processing_status:'collected'|'ai_processing'|'ai_completed'|'ready'|'published'|'failed';queue_status:'queued'|'processing'|'blocked'|'failed'|'published'|'unknown'|'cancelled'|null;queue_message:string|null;product_id:string|null;collector_name:string|null;variant_count:number;min_price:string|null;max_price:string|null;collected_at:string;created_at:string;updated_at:string }
export type CollectedVariant = { id:string;position:number;external_sku_id:string|null;label:string;attributes:Record<string,string>;image_url:string|null;price_text:string|null;price:string|null;stock_text:string|null;stock:string|null;raw_data:Record<string,unknown> }
export type CollectedProductDetail = { product:CollectedProduct;variants:CollectedVariant[] }
export type AiModel = 'qwen3.8-flash'|'qwen3.7-flash'|'qwen3.7-plus'|'qwen3.6-plus'
type AiActionBase = { id:string;status:'pending'|'confirmed'|'rejected'|'executed'|'failed'|'expired';error:string|null }
type AiCustomerRef = { id:string;name:string }
export type AiAction = AiActionBase&({ type:'customer.followup';payload:{customerId:string;customerName:string;content:string;nextFollowUpDate:string|null} }
  |{ type:'customer.tags';payload:{customers:AiCustomerRef[];add:string[];remove:string[];newTags:string[]} }
  |{ type:'customer.owner';payload:{customers:AiCustomerRef[];agentId:string;agentName:string} })
export type AiConversation = { id:string;title:string|null;model_name:string|null;created_at:string;updated_at:string;messages:number;pending_actions:number }
export type AiMessage = { id:string;role:'user'|'assistant';content:string;input_tokens:number|null;output_tokens:number|null;latency_ms:number|null;created_at:string;tools?:{name:string;ok:boolean}[];actions?:AiAction[] }
export type AiContext = { page?:string;pageTitle?:string;view?:string;connectionId?:string;customerId?:string;customerName?:string }

export class ApiError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message)
  }
}

export const getToken = () => localStorage.getItem(TOKEN_KEY)
export const clearToken = () => localStorage.removeItem(TOKEN_KEY)

export async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken()
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: { ...(options.body != null ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options.headers },
  })
  if (response.status === 401 && path !== '/api/auth/login') {
    clearToken()
    window.dispatchEvent(new Event('crm:unauthorized'))
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { message?: string; details?: unknown }
    throw new ApiError(response.status, body.message ?? '请求未能完成，请稍后重试。', body.details)
  }
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

/** Downloads an authenticated file (e.g. CSV export) without exposing the token in a URL. */
export async function download(path: string, fallbackName: string) {
  const token = getToken()
  const response = await fetch(`${API_BASE}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { message?: string }
    throw new ApiError(response.status, body.message ?? '导出失败，请稍后重试。')
  }
  const disposition = response.headers.get('content-disposition') || ''
  const match = /filename\*=UTF-8''([^;]+)/.exec(disposition)
  const url = URL.createObjectURL(await response.blob())
  const link = Object.assign(document.createElement('a'), { href: url, download: match ? decodeURIComponent(match[1]) : fallbackName })
  document.body.append(link); link.click(); link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export async function login(email: string, password: string) {
  const result = await request<{ token: string; user: SessionUser }>('/api/auth/login', {
    method: 'POST', body: JSON.stringify({ email, password, tenant: 'default' }),
  })
  localStorage.setItem(TOKEN_KEY, result.token)
  return result.user
}

export async function getCurrentUser() {
  return (await request<{ user: SessionUser }>('/api/auth/me')).user
}


export const getAssignableUsers = () => request<{ data: AssignableUser[] }>('/api/users/assignable')

const cleanInput = <T extends object>(data: T) => Object.fromEntries(Object.entries(data).map(([key, value]) => [key, typeof value === 'string' && value.trim() === '' ? null : value]))
export async function getAccounts(params: { search?: string; lifecycleStatus?: string; creditLevel?: string } = {}) {
  const query = new URLSearchParams({ page: '1', pageSize: '50' })
  if (params.search) query.set('search', params.search)
  if (params.lifecycleStatus) query.set('lifecycleStatus', params.lifecycleStatus)
  if (params.creditLevel) query.set('creditLevel', params.creditLevel)
  return request<{ data: Account[]; pagination: { page: number; pageSize: number; total: number } }>(`/api/accounts?${query}`)
}
export const getAccount = (id: string) => request<{ data: AccountDetail }>(`/api/accounts/${id}`)
export const createAccount = (data: AccountInput) => request<{ data: Account }>('/api/accounts', { method: 'POST', body: JSON.stringify(cleanInput(data)) })
export const updateAccount = (id: string, data: Partial<AccountInput>) => request<{ data: Account }>(`/api/accounts/${id}`, { method: 'PATCH', body: JSON.stringify(cleanInput(data)) })
export const deleteAccount = (id: string) => request<void>(`/api/accounts/${id}`, { method: 'DELETE' })
export const createContact = (accountId: string, data: ContactInput) => request<{ data: Contact }>(`/api/accounts/${accountId}/contacts`, { method: 'POST', body: JSON.stringify(cleanInput(data)) })
export const updateContact = (accountId: string, contactId: string, data: Partial<ContactInput>) => request<{ data: Contact }>(`/api/accounts/${accountId}/contacts/${contactId}`, { method: 'PATCH', body: JSON.stringify(cleanInput(data)) })
export const deleteContact = (accountId: string, contactId: string) => request<void>(`/api/accounts/${accountId}/contacts/${contactId}`, { method: 'DELETE' })

export async function getProducts(params:{search?:string;category?:string;status?:string}={}){const query=new URLSearchParams();Object.entries(params).forEach(([key,value])=>{if(value)query.set(key,value)});return request<{data:Product[]}>(`/api/products?${query}`)}
/** One catalogue page with status counts and the category list. */
export async function getProductPage(params:{search?:string;category?:string;status?:string;missingPackage?:string;unlisted?:string;page:number;pageSize:number}){const query=new URLSearchParams();Object.entries(params).forEach(([key,value])=>{if(value!==undefined&&value!=='')query.set(key,String(value))});return request<Paged<Product,ProductFacets>&{categories:string[];allCategories?:string[]}>(`/api/products?${query}`)}
export const getProduct=(id:string)=>request<{data:Product}>(`/api/products/${id}`)
export const createProduct=(data:ProductInput)=>request<{data:Product}>('/api/products',{method:'POST',body:JSON.stringify(cleanInput(data))})
export const updateProduct=(id:string,data:Partial<ProductInput>)=>request<{data:Product}>(`/api/products/${id}`,{method:'PATCH',body:JSON.stringify(cleanInput(data))})
export const deleteProduct=(id:string)=>request<void>(`/api/products/${id}`,{method:'DELETE'})
export async function getCollectedProducts(params:{search?:string;source?:string;stage?:CollectionStage;page?:number;pageSize?:number}={}){const query=new URLSearchParams();Object.entries(params).forEach(([key,value])=>{if(value!==undefined&&value!=='')query.set(key,String(value))});return request<Paged<CollectedProductCard,CollectionFacets>>(`/api/product-collections?${query}`)}
export const getCollectedProduct=(id:string)=>request<{data:CollectedProductDetail}>(`/api/product-collections/${id}`)
export const promoteCollectedProduct=(id:string,input:{sku:string;name:string;category:string|null;basePrice:number;description:string;specifications:Record<string,string>;variants:Array<{id:string;price:number;stock:number|null}>;reviewed:true})=>request<{data:{id:string;sku:string;name:string}}>(`/api/product-collections/${id}/promote`,{method:'POST',body:JSON.stringify(input)})
export const deleteCollectedProduct=(id:string)=>request<void>(`/api/product-collections/${id}`,{method:'DELETE'})
export const createCollectorKey=()=>request<{data:{id:string;name:string;key_prefix:string;key:string;created_at:string}}>('/api/product-collections/access-key',{method:'POST'})
export const getAiModels=()=>request<{data:{provider:'qwen';configured:boolean;defaultModel:AiModel;models:AiModel[]}}>('/api/ai/models')
export const sendAiMessage=(data:{message:string;conversationId?:string|null;model?:AiModel;context?:AiContext})=>request<{data:{conversationId:string;message:AiMessage;model:string}}>('/api/ai/chat',{method:'POST',body:JSON.stringify(data)})
/** /api/ai/chat as a stream: answer text arrives through `onText`; resolves with the saved message. */
export async function streamAiMessage(data:{message:string;conversationId?:string|null;model?:AiModel;context?:AiContext},on:{onStart?:(conversationId:string)=>void;onText:(text:string)=>void;onTools:(names:string[])=>void}){
  const token=getToken()
  const response=await fetch(`${API_BASE}/api/ai/chat/stream`,{method:'POST',body:JSON.stringify(data),headers:{'Content-Type':'application/json',Accept:'text/event-stream',...(token?{Authorization:`Bearer ${token}`}:{})}})
  if(response.status===401){clearToken();window.dispatchEvent(new Event('crm:unauthorized'))}
  if(!response.ok||!response.body){const body=await response.json().catch(()=>({})) as {message?:string};throw new ApiError(response.status,body.message??'AI 暂时无法响应。')}
  const reader=response.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer='',done:{conversationId:string;message:AiMessage;model:string}|null=null
  const handle=(block:string)=>{
    let event='message',payload=''
    for(const line of block.split('\n')){if(line.startsWith('event:'))event=line.slice(6).trim();else if(line.startsWith('data:'))payload+=line.slice(5).trim()}
    if(!payload)return
    const value=JSON.parse(payload)
    if(event==='start')on.onStart?.(value.conversationId)
    else if(event==='delta')on.onText(value.text)
    else if(event==='tools')on.onTools(value.names)
    else if(event==='done')done=value
    else if(event==='error')throw new ApiError(502,value.message??'AI 暂时无法响应。')
  }
  for(;;){
    const {value,done:ended}=await reader.read();if(ended)break
    buffer+=value
    let end;while((end=buffer.indexOf('\n\n'))>=0){handle(buffer.slice(0,end));buffer=buffer.slice(end+2)}
  }
  if(buffer.trim())handle(buffer)
  if(!done)throw new ApiError(502,'AI 回答中断，请重试。')
  return done as {conversationId:string;message:AiMessage;model:string}
}
export const confirmAiAction=(id:string)=>request<{data:AiAction}>(`/api/ai/actions/${id}/confirm`,{method:'POST',body:'{}'})
export const rejectAiAction=(id:string)=>request<{data:AiAction}>(`/api/ai/actions/${id}/reject`,{method:'POST',body:'{}'})
export const getAiConversations=(before?:string)=>request<{data:AiConversation[];hasMore:boolean}>(`/api/ai/conversations${before?`?before=${encodeURIComponent(before)}`:''}`)
export const getAiConversation=(id:string)=>request<{data:{conversation:{id:string;title:string|null;model_name:string|null};messages:AiMessage[]}}>(`/api/ai/conversations/${id}/messages`)
export const deleteAiConversation=(id:string)=>request(`/api/ai/conversations/${id}`,{method:'DELETE'})
