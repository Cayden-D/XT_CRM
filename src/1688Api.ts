import { request } from './api'
import type { ReviewedVariant } from '../shared/1688-skus'

const base = '/api/integrations/1688'
export type AgentSetting={id:string;display_name:string;status:string;enabled:boolean;revision:number}
export type AgentJob={id:string;status:string;message:string|null;report:{model?:string;title?:string;images?:Array<{url:string;reason:string;readable:boolean;watermark:boolean;rightsRisk:boolean;uncertain:boolean}>};created_at:string;updated_at:string}
export const getAgentSettings=()=>request<{data:AgentSetting[];model:string;configured:boolean;imageRepairAvailable:boolean}>(`${base}/agent/settings`)
export const testAgentModel=()=>request<{data:{model:string;connected:boolean}}>(`${base}/agent/test`,{method:'POST'})
export const setAgentSetting=(id:string,enabled:boolean,revision:number)=>request(`${base}/connections/${id}/agent-settings`,{method:'PUT',body:JSON.stringify({enabled,revision,confirmed:true})})
export type AgentQueueSetting={id:string;display_name:string;connection_status:string;agent_enabled:boolean;enabled:boolean;revision:number}
export type AgentQueueJob={id:string;collected_product_id:string;connection_id:string;title:string;display_name:string;status:'queued'|'processing'|'blocked'|'failed'|'published'|'unknown'|'cancelled';phase:string;attempts:number;message:string|null;product_id:string|null;draft_id:string|null;created_at:string;updated_at:string;ai_fill?:AgentAiFill|null}
export type AgentAiFill={filled:Array<{name:string;label:string;value:string;evidence:string;reason:string}>;refused:Array<{name:string;label:string;reason:string}>;repairs:Array<{code:string;detail:string|null;diagnosis:string;changed:string[]}>}
export const getAgentQueue=(params:{page?:number;pageSize?:number;status?:string;connectionId?:string;search?:string}={})=>request<{data:{settings:AgentQueueSetting[];jobs:AgentQueueJob[];total:number;page:number;pageSize:number}}>(`${base}/agent/queue?${new URLSearchParams(Object.entries(params).filter(([,v])=>v!==undefined&&v!=='').map(([k,v])=>[k,String(v)]))}`)
export const setAgentQueueSetting=(id:string,enabled:boolean,revision:number)=>request(`${base}/connections/${id}/agent-queue-settings`,{method:'PUT',body:JSON.stringify({enabled,revision,confirmed:true})})
export const enqueueCollectedProduct=(id:string)=>request<{data:{id:string;status:string}}>(`${base}/agent/queue/${id}`,{method:'POST',body:'{}'})
export const retryAgentQueueJob=(id:string)=>request<{data:{id:string;status:string}}>(`${base}/agent/queue-jobs/${id}/retry`,{method:'POST',body:'{}'})
export const getAgentJob=(id:string)=>request<{data:AgentJob|null}>(`${base}/drafts/${id}/agent-job`)
export const runPublishingAgent=(id:string,revision:number)=>request<{data:AgentJob}>(`${base}/drafts/${id}/agent`,{method:'POST',body:JSON.stringify({revision})})
export const cancelAgentJob=(id:string)=>request(`${base}/agent-jobs/${id}/cancel`,{method:'POST'})
export type AgentImagePreview={id:string;mode:'generate'|'edit';model:string;prompt:string;url:string;storage?:'oss'|'temporary';findings:Array<{url:string;readable:boolean;watermark:boolean;rightsRisk:boolean;uncertain:boolean;reason:string}>;status:'preview'|'applying'|'applied';photo_url:string|null;created_at:string;expires_at:string;risky?:boolean}
export const getAgentImages=(draftId:string)=>request<{data:AgentImagePreview[]}>(`${base}/drafts/${draftId}/agent-images`)
export const generateAgentImage=(draftId:string,input:{revision:number;mode:'generate'|'edit';model:string;prompt:string;sourceIndex?:number;confirmed:true})=>post<{data:AgentImagePreview}>(`/drafts/${draftId}/agent-images`,input)
export const applyAgentImage=(draftId:string,imageId:string,input:{revision:number;albumId:string;placement:'replace'|'append';sourceIndex?:number;confirmed:true})=>post<{data:{draft:PublishDraft;photoUrl:string}}>(`/drafts/${draftId}/agent-images/${imageId}/apply`,input)
const post = <T>(path: string, body?: object) => request<T>(`${base}${path}`, { method: 'POST', ...(body ? { body: JSON.stringify(body) } : {}) })
export type ShopConnection = { id:string; app_key:string; ali_id:string; member_id:string|null; login_id:string|null; display_name:string; access_expires_at:string; refresh_expires_at:string|null; status:'connected'|'reauthorize'|'disabled'; member_capability:'unknown'|'available'|'unavailable'; last_tested_at:string|null; last_refreshed_at:string|null; listings_synced_through?:string|null; listings_full_synced_at?:string|null }
export type PlatformProduct = { productID:string|number; subject:string; description?:string; image?:{images:string[]}; skuInfos?:Array<{specId:string;amountOnSale:number;price:number;attributes?:Array<{attributeDisplayName:string;attributeValue:string}>}>;saleInfo?:{amountOnSale:number;priceRanges?:Array<{price:number}>} }
export type PlatformListing = { deletion_state?:'active'|'deleting'|'deleted'|'unknown'; id:string;connection_id:string;offer_id:string;product_id:string|null;title:string;status:string;image_url:string|null;synced_at:string;display_name?:string;sku?:string|null;snapshot?:PlatformProduct }
export type PublishDraft = { id:string;connection_id:string;product_id:string;cat_id:string;category_path?:string[]|null;scene:string;revision:number;status:'draft'|'submitting'|'published'|'failed'|'unknown';offer_id:string|null;last_error_code:string|null;updated_at:string;name?:string;sku?:string;display_name?:string;platform_schema:Record<string,any>;data_body:{global:Record<string,unknown>;formValues:Record<string,any>} }
export type IntegrationOperation = { id:string;api_name:string;outcome:string;error_code:string|null;duration_ms:number;created_at:string;display_name:string|null }
export type CategoryOption = { categoryID:string|number;name:string;categoryType?:number }
export const getShopConnections = () => request<{data:ShopConnection[];configured:boolean}>(`${base}/connections`)
export const startShopAuthorization = () => post<{data:{authorizationUrl:string}}>('/authorizations')
export const completeShopAuthorization = (callbackUrl:string) => post<{data:ShopConnection}>('/authorizations/complete',{callbackUrl})
export const testShopConnection = (id:string) => post(`/connections/${id}/test`)
export const refreshShopToken = (id:string) => post(`/connections/${id}/refresh`)
export type ShopConnectionUsage = { status:string; display_name:string; listings:number; bound:number; published:number; drafts:number; queue_jobs:number; agent_jobs:number }
export const getShopConnectionUsage = (id:string) => request<{data:ShopConnectionUsage}>(`${base}/connections/${id}/usage`)
export const deleteShopConnection = (id:string) => request<{data:{deleted:boolean}}>(`${base}/connections/${id}`,{method:'DELETE'})
export const disableShopConnection = (id:string) => post(`/connections/${id}/disable`)
export type SyncWindow = { from:string|null; to:string }
/** One page of 平台商品 sync; page 1 picks the window (incremental needs an earlier completed sync, else it reads everything). */
export const syncShopPage = (id:string,body:{pageNo:number;mode:'full'|'incremental';window?:SyncWindow;total?:number}) => post<{data:{count:number;total:number;pageNo:number;hasMore:boolean;mode:'full'|'incremental';window:SyncWindow;completed:boolean}}>(`/connections/${id}/sync`,body)
const syncTime=(value:string)=>new Date(value).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})
export const syncNotice=(r:{count:number;mode:'full'|'incremental';completed:boolean;since:string|null;stopped:boolean})=>r.stopped?`同步已停止，本轮已读取 ${r.count} 件`
  :`${r.mode==='incremental'?`增量同步完成：${r.since?`${syncTime(r.since)} 之后`:''}有变动的商品 ${r.count} 件`:`全量同步完成，共读取 ${r.count} 件`}${r.completed?'':'；同步期间店铺商品数有变化，下次同步会重新检查这段时间'}`
/** Runs a whole sync pass page by page; `incremental` reads only products modified since the last completed pass. */
export async function syncShop(id:string,requested:'full'|'incremental',progress:(read:number,total:number,mode:'full'|'incremental')=>void,stopped:()=>boolean){
  let hasMore=true,window:SyncWindow|undefined,total:number|undefined,completed=false,mode=requested,count=0
  for(let pageNo=1;hasMore&&!stopped();pageNo++){
    if(pageNo>1000)throw new Error('本轮同步达到分页上限，请联系管理员继续。')
    const result=(await syncShopPage(id,{pageNo,mode:requested,window,total})).data
    window=result.window;total=result.total;mode=result.mode;completed=result.completed;count+=result.count;hasMore=result.hasMore
    progress(count,result.total,mode)
  }
  return {count,mode,completed,since:window?.from??null,stopped:hasMore}
}
export const getShopListings = (connectionId:string,page:number,search:string) => request<{data:PlatformListing[]}>(`${base}/listings?${new URLSearchParams({connectionId,page:String(page),search})}`)
export const getShopListing = (id:string) => request<{data:PlatformListing}>(`${base}/listings/${id}`)
export type CatalogGroup='on_sale'|'expired'|'other'
export type CatalogSort='recent'|'sales'|'price_asc'|'price_desc'|'stock'
/** One offer in 产品目录, as last synced from the shop, with 30-day sales from synced orders. */
export type CatalogItem={package_weight_g?:number|null;id:string;connection_id:string;shop:string|null;offer_id:string;title:string;status:string;image_url:string|null;synced_at:string;product_id:string|null;product_sku:string|null;product_name:string|null;category:string|null;cargo_number:string|null;unit:string|null;updated_on_platform:string|null;expires_on_platform:string|null;price_min:number|null;price_max:number|null;stock:number|null;sku_count:number;sales_quantity:number|null;sales_amount:number;sales_orders:number}
export type CatalogShop={id:string;display_name:string|null;status:string;synced_at:string|null;listings_synced_through:string|null}
export const getCatalog=(params:{connectionId?:string;group:CatalogGroup;search?:string;sort:CatalogSort;page:number;pageSize:number})=>{const query=new URLSearchParams();Object.entries(params).forEach(([k,v])=>{if(v!==undefined&&v!=='')query.set(k,String(v))});return request<{data:CatalogItem[];total:number;page:number;pageSize:number;facets:Record<CatalogGroup,number>;shops:CatalogShop[]}>(`${base}/catalog?${query}`)}
export type ComparisonValue={crm:string|null;platform:string|null;status:'equal'|'changed'|'unknown';basis?:string}
export type ListingComparison={listing:{id:string;offerId:string;title:string;productId:string|null;bindingRevision:number;syncedAt:string};product:{id:string;sku:string;name:string;status:string;currency:string;updatedAt:string}|null;variants:Array<{id:string;label:string;attributes:Record<string,string>;unitPrice:string;stock:string|null}>;platformSkus:Array<{specId:string|null;label:string;price:number|string|null;stock:number|string|null}>;bindings:Array<{specId:string;variantId:string}>;rows:Array<{specId:string;variantId:string;crmLabel:string;platformLabel:string;missing:boolean;price:ComparisonValue;stock:ComparisonValue}>;summary:{mapped:number;unmatchedCrm:number;unmatchedPlatform:number;changedPrice:number;changedStock:number;unknown:number};fields:{title:ComparisonValue;image:ComparisonValue;basePrice:ComparisonValue}}
export const getListingComparison=(id:string,productId?:string)=>request<{data:ListingComparison}>(`${base}/listings/${id}/comparison${productId?`?${new URLSearchParams({productId})}`:''}`)
export const saveListingBinding=(id:string,input:{productId:string|null;revision:number;syncedAt:string;confirmed:true;bindings:Array<{specId:string;variantId:string}>})=>post(`/listings/${id}/binding`,input)
export const refreshShopListing = (id:string) => post(`/listings/${id}/refresh`)
export const updateShopStock = (id:string,stocks:Array<{specId:string|null;before:number;after:number}>) => post(`/listings/${id}/stock`,{confirmed:true,stocks})
export const getShopOperations = (page:number) => request<{data:IntegrationOperation[]}>(`${base}/operations?page=${page}`)
export const findShopCategories = (id:string,keyword:string) => request<{data:CategoryOption[]}>(`${base}/connections/${id}/categories?${new URLSearchParams({keyword})}`)
export const getPublishDrafts = () => request<{data:PublishDraft[]}>(`${base}/drafts`)
export const createPublishDraft = (body:{connectionId:string;productId:string;catId:string;scene:string}) => post<{data:PublishDraft;missing:string[]}>('/drafts',body)
export const getPublishDraft = (id:string) => request<{data:PublishDraft;missing:string[]}>(`${base}/drafts/${id}`)
export const getDraftVariants = (id:string) => request<{data:ReviewedVariant[]}>(`${base}/drafts/${id}/variants`)
export const mapDraftVariants = (id:string,revision:number,mapping:Record<string,string>) => post<{data:PublishDraft;missing:string[]}>(`/drafts/${id}/map-variants`,{revision,mapping,confirmed:true})
export const refreshSkuRules = (id:string,revision:number) => post<{data:PublishDraft;missing:string[]}>(`/drafts/${id}/sku-rules`,{revision})
export const savePublishDraft = (id:string,revision:number,formValues:Record<string,unknown>) => request<{data:PublishDraft;missing:string[]}>(`${base}/drafts/${id}`,{method:'PATCH',body:JSON.stringify({revision,formValues})})
export const submitPublishDraft = (id:string,revision:number) => post<{data:{offerId:string;status:string}}>(`/drafts/${id}/publish`,{revision,confirmed:true})
export const reconcilePublishDraft = (id:string,offerId:string) => post(`/drafts/${id}/reconcile`,{offerId})
export const uploadShopPhoto = (id:string,body:{albumId:string;name:string;content:string;mime:string}) => post<{data:{url:string;id:string}}>(`/connections/${id}/photos`,body)

export type PublishTemplate = {values:import('../shared/1688-publish-template').PublishTemplateValues;revision:number}
export const getPublishTemplate=()=>request<{data:PublishTemplate}>(`${base}/publish-template`)
export const savePublishTemplate=(input:PublishTemplate)=>request<{data:PublishTemplate}>(`${base}/publish-template`,{method:'PUT',body:JSON.stringify(input)})
export const applyDraftTemplate=(id:string,revision:number)=>post<{data:PublishDraft;missing:string[]}>(`/drafts/${id}/apply-template`,{revision})
export const applyDraftProductData=(id:string,revision:number,fields:string[])=>post<{data:PublishDraft;missing:string[]}>(`/drafts/${id}/product-attributes/apply`,{revision,fields})

export const deleteShopListing=(id:string,input:{confirmed:true;offerId:string;syncedAt:string})=>post<{data:{deleted:boolean}}>(`/listings/${id}/delete`,input)
