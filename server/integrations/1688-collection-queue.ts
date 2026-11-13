import { createHash, randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { db } from '../db.js'
import { config } from '../config.js'
import { IntegrationError } from './1688.js'
import { inspectPublishingImages, publishingImages } from './1688-agent.js'
import { createDraftFromProduct } from './1688-drafts.js'
import { ownBrandNames } from './brands.js'
import { DETAIL_TYPES, SUITE_TYPES, productFacts, suiteBrand, suiteBrandOption, suitePrompt, type GeneratedType } from './image-workshop.js'
import { defaultBrand } from './brands.js'
import { ensureAlbum, ensurePhoto } from './image-album.js'
import { apimartConfigured } from '../llm/apimart-image.js'

// With AI image processing on, every listing gets new pictures: six main pictures and three detail pictures are generated
// from the collected ones, put into the shop album and the product, and published without screening (the owner's choice).
// SKU pictures stay as collected. A failure stops the job with its reason; nothing falls back to the originals.
const IMAGE_WAIT_MS=30*60_000,IMAGE_POLL_SECONDS=45
const GENERATED:GeneratedType[]=[...SUITE_TYPES,...DETAIL_TYPES]
type ImageStep={kind:'wait';message:string}|{kind:'block';message:string}|{kind:'applied';count:number}
const autoImages=async(tenantId:string)=>{
  const row=(await db.query('SELECT auto_replace,suite_model,suite_quality FROM image_workshop_settings WHERE tenant_id=$1',[tenantId])).rows[0]
  return row?.auto_replace&&apimartConfigured()?row as {suite_model:string;suite_quality:string}:null
}
import { collectedSkuAttributes } from './1688-collected-skus.js'
import { runAgentDraft } from '../routes/1688-agent.js'
import { publishDraft } from '../routes/1688.js'

type Json=Record<string,any>
type QueueJob={id:string;tenant_id:string;connection_id:string;collected_product_id:string;actor_id:string;source_updated_at:Date;attempts:number;worker_id:string;draft_id:string|null;report:Json|null}
/** Ladder price text written by the collector; up to three increasing tiers (what a 1688 quantity quote takes). */
export function ladderTiers(text:unknown){
  if(typeof text!=='string')return []
  const tiers=[...text.matchAll(/¥\s*(\d+(?:\.\d+)?)\s*\((\d+)\s*pieces?\)/gi)].map(m=>({price:Number(m[1]),quantity:Number(m[2])})).filter(t=>t.price>0&&Number.isInteger(t.quantity)&&t.quantity>0).sort((a,b)=>a.quantity-b.quantity)
  return tiers.filter((t,i)=>i===0||t.quantity>tiers[i-1].quantity).slice(0,3)
}
const escapeHtml=(value:string)=>value.replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!))
const sourceSku=(source:Json)=>`COL-${createHash('sha256').update(`${source.tenant_id}:${source.source}:${source.source_product_id}`).digest('hex').slice(0,24).toUpperCase()}`

export async function enqueueCollectedProduct(client:PoolClient,source:Json,actorId:string){
  if(source.source!=='1688'||source.product_id)return null
  const target=(await client.query(`SELECT q.connection_id FROM integration_1688_collection_queue_settings q JOIN integration_1688_agent_settings a ON a.connection_id=q.connection_id JOIN integration_1688_connections c ON c.id=q.connection_id WHERE q.tenant_id=$1 AND q.enabled AND a.enabled AND c.status='connected' LIMIT 1`,[source.tenant_id])).rows[0]
  if(!target)return null
  const job=(await client.query(`INSERT INTO integration_1688_collection_queue_jobs(tenant_id,connection_id,collected_product_id,actor_id,source_updated_at)VALUES($1,$2,$3,$4,$5) ON CONFLICT(collected_product_id) DO NOTHING RETURNING id`,[source.tenant_id,target.connection_id,source.id,actorId,source.updated_at])).rows[0]
  if(job)await client.query("UPDATE collected_products SET processing_status='ai_processing' WHERE id=$1",[source.id])
  return job?.id||null
}

function checkedSource(source:Json,variants:Json[]){
  if(source.source!=='1688'||!/^[0-9]{1,20}$/.test(String(source.source_category_id||'')))throw new IntegrationError('QUEUE_CATEGORY','来源类目 ID 缺失或不适用于 1688 发布，请人工核对。',400)
  if(source.currency!=='CNY'||!variants.length)throw new IntegrationError('QUEUE_PRICE','自动上品需要人民币报价和明确的 SKU 价格、库存；请人工核对。',400)
  if(variants.some(v=>v.price==null||v.stock==null||!Number.isFinite(Number(v.price))||Number(v.price)<=0||!Number.isInteger(Number(v.stock))||Number(v.stock)<0))throw new IntegrationError('QUEUE_SKU','来源 SKU 价格或库存缺失、非整数或不合法，请人工核对。',400)
  if(!source.main_image_url||!Array.isArray(source.gallery_images)||!Array.isArray(source.detail_images)||!source.detail_images.length)throw new IntegrationError('QUEUE_IMAGES','来源主图或详情图缺失，不能自动上品。',400)
  const all=publishingImages({main:source.main_image_url,gallery:source.gallery_images,details:source.detail_images,variants:variants.map(v=>v.image_url).filter(Boolean)})
  const main=publishingImages({main:source.main_image_url})[0]
  const gallery=(source.gallery_images||[]).map((url:string)=>publishingImages({image:url})[0])
  const details=source.detail_images.map((url:string)=>publishingImages({image:url})[0])
  return {all,main,gallery,details}
}

async function claim(workerId:string){
  const result=await db.query(`WITH next AS (SELECT j.id FROM integration_1688_collection_queue_jobs j JOIN integration_1688_collection_queue_settings q ON q.connection_id=j.connection_id AND q.enabled JOIN integration_1688_agent_settings a ON a.connection_id=j.connection_id AND a.enabled JOIN integration_1688_connections c ON c.id=j.connection_id AND c.status='connected' WHERE j.status='queued' AND j.available_at<=now() ORDER BY j.created_at FOR UPDATE OF j SKIP LOCKED LIMIT 1) UPDATE integration_1688_collection_queue_jobs j SET status='processing',phase='screening',attempts=attempts+1,worker_id=$1,lease_until=now()+interval '2 minutes',updated_at=now() FROM next WHERE j.id=next.id RETURNING j.*`,[workerId])
  return result.rows[0] as QueueJob|undefined
}

async function finish(job:QueueJob,status:string,message:string,report:Json={}){
  const client=await db.connect()
  try{
    await client.query('BEGIN')
    const result=await client.query('UPDATE integration_1688_collection_queue_jobs SET status=$3,message=$4,report=$5::jsonb,worker_id=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 AND worker_id=$2 AND status=\'processing\' RETURNING collected_product_id',[job.id,job.worker_id,status,message,JSON.stringify(report)])
    if(result.rows.length)await client.query('UPDATE collected_products SET processing_status=$2,updated_at=now() WHERE id=$1',[job.collected_product_id,status==='published'?'published':'failed'])
    await client.query('COMMIT')
  }catch(error){await client.query('ROLLBACK');throw error}finally{client.release()}
}

async function activeActor(job:QueueJob){
  const actor=(await db.query("SELECT id,email::text,display_name FROM users WHERE id=$1 AND tenant_id=$2 AND status='active' AND deleted_at IS NULL",[job.actor_id,job.tenant_id])).rows[0]
  if(!actor)throw new IntegrationError('QUEUE_ACTOR','入队账号已停用，不能自动发布。',409)
  return actor
}

async function publishThroughAgent(job:QueueJob,draft:Json,actor:Json,report:Json,skipImageCheck=false){
  await db.query("UPDATE integration_1688_collection_queue_jobs SET phase='publishing',draft_id=$2,updated_at=now() WHERE id=$1 AND worker_id=$3 AND status='processing'",[job.id,draft.id,job.worker_id])
  const result=await runAgentDraft({params:{id:draft.id},body:{revision:draft.revision},authUser:{sub:actor.id,tenantId:job.tenant_id,email:actor.email,displayName:actor.display_name,roles:[],permissions:[]},id:job.id},publishDraft,{id:job.id,workerId:job.worker_id,skipImageCheck})
  const agent=result.data as Json
  await finish(job,agent.status==='published'?'published':agent.status==='unknown'?'unknown':agent.status==='blocked'?'blocked':'failed',agent.message||'Agent 任务未完成。',{...report,agentJobId:agent.id,agentReport:agent.report})
}

/** A job that already has a draft goes straight back to the agent; the source and product were dealt with the first time. */
async function resumeDraft(job:QueueJob){
  const draft=(await db.query("SELECT id,revision FROM integration_1688_publish_drafts WHERE id=$1 AND tenant_id=$2 AND status IN ('draft','failed') AND offer_id IS NULL",[job.draft_id,job.tenant_id])).rows[0]
  if(!draft)throw new IntegrationError('QUEUE_DRAFT_STATE','发布草稿已提交或结果待核对，不能自动重试。',409)
  // A draft made from generated pictures keeps going without screening, as it started.
  const generated=Boolean((await db.query("SELECT 1 FROM image_assets WHERE collected_product_id=$1 AND options->>'unchecked'='true' AND applied_to IS NOT NULL LIMIT 1",[job.collected_product_id])).rows.length)
  await publishThroughAgent(job,draft,await activeActor(job),{resumed:true},generated&&Boolean(await autoImages(job.tenant_id)))
}

/** Puts the job back in line without counting an attempt; the wait is bounded by IMAGE_WAIT_MS. */
async function defer(job:QueueJob,message:string,report:Json,seconds=IMAGE_POLL_SECONDS){
  await db.query("UPDATE integration_1688_collection_queue_jobs SET status='queued',phase='screening',attempts=0,available_at=now()+($3::int*interval '1 second'),message=$4,report=$5::jsonb,worker_id=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 AND worker_id=$2 AND status='processing'",[job.id,job.worker_id,seconds,message,JSON.stringify(report)])
}

/** Generates the listing's pictures (or reuses an unfinished batch), then puts them into the album and the product. */
async function generateListingImages(job:QueueJob,source:Json,actor:Json,settings:{suite_model:string;suite_quality:string},state:Json):Promise<ImageStep>{
  if(!state.imageBatch){
    // A batch from an earlier attempt that never failed is reused, so a retry does not pay twice.
    const reusable=(await db.query(`SELECT batch_id FROM image_assets WHERE collected_product_id=$1 AND tenant_id=$2 AND options->>'unchecked'='true' AND applied_to IS NULL
      GROUP BY batch_id HAVING count(*)=$3 AND bool_and(status<>'failed') ORDER BY max(created_at) DESC LIMIT 1`,[source.id,job.tenant_id,GENERATED.length])).rows[0]
    if(reusable)state.imageBatch=reusable.batch_id
    else{
      const facts=await productFacts(job.tenant_id,source.id),refs=facts.gallery.slice(0,4)
      if(!refs.length)return {kind:'block',message:'没有可用作参考的商品主图，无法生成新图。'}
      const brand=await defaultBrand(job.tenant_id),batch=randomUUID()
      for(const type of GENERATED)await db.query(`INSERT INTO image_assets(tenant_id,collected_product_id,batch_id,operation,provider,model,reference_urls,options,prompt,trigger,created_by)
        VALUES($1,$2,$3,$4,'apimart',$5,$6,$7,$8,'agent',$9)`,[job.tenant_id,source.id,batch,type,settings.suite_model,JSON.stringify(refs),
        JSON.stringify({size:type.startsWith('detail_')?'3:4':'1:1',resolution:'1k',quality:settings.suite_quality,unchecked:true,...suiteBrandOption(type,brand)}),suitePrompt(type,facts,suiteBrand(brand)),actor.id])
      state.imageBatch=batch
      return {kind:'wait',message:`正在用 AI 生成 ${SUITE_TYPES.length} 张主图和 ${DETAIL_TYPES.length} 张详情图，完成后自动上传店铺相册并上架。`}
    }
  }
  const rows=(await db.query('SELECT * FROM image_assets WHERE batch_id=$1 AND tenant_id=$2',[state.imageBatch,job.tenant_id])).rows
  const ordered=GENERATED.map(type=>rows.find(r=>r.operation===type)).filter(Boolean) as Json[]
  const failed=ordered.find(r=>r.status==='failed')
  if(failed||ordered.length<GENERATED.length)return {kind:'block',message:`AI 生图失败：${failed?.error||'部分图片缺失'}。请在采集商品的「商品图片」里重试后重新入队。`}
  const done=ordered.filter(r=>r.status==='completed').length
  if(done<ordered.length)return {kind:'wait',message:`AI 生图中：已生成 ${done}/${ordered.length} 张，完成后自动上传店铺相册并上架。`}
  const ctx={tenantId:job.tenant_id,actorId:actor.id,requestId:job.id}
  let album:string
  try{album=await ensureAlbum(ctx,job.connection_id)}
  catch(error){return {kind:'block',message:`AI 新图已生成，但没能确定店铺相册：${(error instanceof Error?error.message:'相册接口调用失败').replace(/[。.]+$/,'')}。可在「图片」里手动上传一张图到店铺相册后重新入队。`}}
  const urls:string[]=[]
  for(const asset of ordered)urls.push(await ensurePhoto(ctx,asset,job.connection_id,album))
  const mains=urls.slice(0,SUITE_TYPES.length),details=urls.slice(SUITE_TYPES.length)
  const client=await db.connect()
  try{
    await client.query('BEGIN')
    const updated=(await client.query('UPDATE collected_products SET main_image_url=$2,gallery_images=$3,detail_images=$4,updated_at=now() WHERE id=$1 AND tenant_id=$5 AND product_id IS NULL RETURNING updated_at',[source.id,mains[0],JSON.stringify(mains),JSON.stringify(details),job.tenant_id])).rows[0]
    if(!updated)throw new IntegrationError('QUEUE_SOURCE_CHANGED','采集商品已转正式产品，生成的图片未替换。',409)
    await client.query('UPDATE integration_1688_collection_queue_jobs SET source_updated_at=$2 WHERE id=$1',[job.id,updated.updated_at])
    for(const [i,asset] of ordered.entries())await client.query('UPDATE image_assets SET applied_to=$2,applied_at=now(),updated_at=now() WHERE id=$1',[asset.id,JSON.stringify(i<mains.length
      ?{collectedProductId:source.id,index:i,placement:'replace',previousUrl:null,productId:null}:{collectedProductId:source.id,index:i-mains.length,placement:'detail',previousUrl:null,productId:null})])
    await client.query("INSERT INTO audit_logs(tenant_id,actor_id,action,entity_type,entity_id,after_data,request_id)VALUES($1,$2,'image.generated.listing','collected_product',$3,$4,$5)",[job.tenant_id,actor.id,source.id,JSON.stringify({batch:state.imageBatch,main:mains.length,details:details.length,unchecked:true}),job.id])
    await client.query('COMMIT')
  }catch(error){await client.query('ROLLBACK');throw error}finally{client.release()}
  return {kind:'applied',count:urls.length}
}

async function processJob(job:QueueJob){
  if(job.draft_id)return resumeDraft(job)
  const source=(await db.query('SELECT * FROM collected_products WHERE id=$1 AND tenant_id=$2',[job.collected_product_id,job.tenant_id])).rows[0]
  if(!source||source.product_id||new Date(source.updated_at).getTime()!==new Date(job.source_updated_at).getTime())throw new IntegrationError('QUEUE_SOURCE_CHANGED','采集商品已变化或已转正式产品，请人工核对后再处理。',409)
  const actor=await activeActor(job)
  const allowed=(await db.query(`SELECT 1 FROM integration_1688_collection_queue_settings q JOIN integration_1688_agent_settings a ON a.connection_id=q.connection_id JOIN integration_1688_connections c ON c.id=q.connection_id WHERE q.connection_id=$1 AND q.tenant_id=$2 AND q.enabled AND a.enabled AND c.status='connected'`,[job.connection_id,job.tenant_id])).rows[0]
  if(!allowed)throw new IntegrationError('QUEUE_DISABLED','队列或 Agent 模式已关闭，任务未发布。',409)
  const variants=(await db.query('SELECT * FROM collected_product_variants WHERE collected_product_id=$1 AND tenant_id=$2 ORDER BY position',[source.id,job.tenant_id])).rows
  const images=checkedSource(source,variants)
  const previous=job.report||{}
  const auto=await autoImages(job.tenant_id)
  let report:Json
  let variantImage=(url:string|null)=>url
  if(auto&&!previous.generatedImages){
    const state:Json={sourceTitle:source.title,sourceCategoryId:source.source_category_id,imageBatch:previous.imageBatch,imageWaitSince:previous.imageWaitSince||new Date().toISOString()}
    if(Date.now()-Date.parse(state.imageWaitSince)>IMAGE_WAIT_MS){await finish(job,'blocked','AI 生图等待超时（30 分钟），请在采集商品的「商品图片」里查看后重新入队。',state);return}
    const step=await generateListingImages(job,source,actor,auto,state)
    if(step.kind==='block'){await finish(job,'blocked',step.message,state);return}
    if(step.kind==='wait'){await defer(job,step.message,state);return}
    await defer(job,`已生成并上传 ${step.count} 张 AI 新图，继续上架。`,{...state,generatedImages:step.count},1)
    return
  }
  if(auto){
    // Published as generated, without screening; SKU pictures as collected.
    report={images:[],imagesUnchecked:true,generatedImages:previous.generatedImages,imageBatch:previous.imageBatch,sourceTitle:source.title,sourceCategoryId:source.source_category_id}
  }else{
    const findings=await inspectPublishingImages(images.all,await ownBrandNames(job.tenant_id))
    report={images:findings,sourceTitle:source.title,sourceCategoryId:source.source_category_id}
    const bad=new Set(findings.filter(item=>!item.readable||item.watermark||item.rightsRisk||item.uncertain).map(item=>item.url))
    const unreadable=findings.filter(item=>!item.readable)
    if(unreadable.length){await finish(job,'blocked',`图片检查未通过：${unreadable.length} 张图片无法读取，请核对原图。`,report);return}
    const flaggedMain=[images.main,...images.gallery].filter(url=>bad.has(url))
    if(flaggedMain.length){
      const why=[...new Set(findings.filter(item=>flaggedMain.includes(item.url)).map(item=>item.reason))].join('；')
      await finish(job,'blocked',`图片检查未通过：主图带有他人标识（${flaggedMain.length} 张：${why}）。开启「设置 → 自动上架 → AI 图片自动处理」后，会为每件商品生成全新的主图和详情图。`,report);return
    }
    // Detail and SKU pictures with someone else's mark are left out of the listing.
    const keptDetails=images.details.filter(url=>!bad.has(url))
    const droppedDetails=images.details.length-keptDetails.length
    if(droppedDetails&&!keptDetails.length){await finish(job,'blocked','图片检查未通过：全部详情图都带有他人标识，请更换详情图后重新入队。',report);return}
    images.details=keptDetails
    variantImage=(url:string|null)=>{if(!url)return null;try{const clean=publishingImages({image:url})[0];return bad.has(clean)?null:url}catch{return url}}
    const droppedSku=variants.filter(v=>v.image_url&&!variantImage(v.image_url)).length
    if(droppedDetails||droppedSku)report.droppedImages={details:droppedDetails,sku:droppedSku}
  }
  const client=await db.connect()
  let product:Json
  try{
    await client.query('BEGIN')
    const locked=(await client.query('SELECT * FROM collected_products WHERE id=$1 AND tenant_id=$2 FOR UPDATE',[source.id,job.tenant_id])).rows[0]
    if(!locked||locked.product_id||new Date(locked.updated_at).getTime()!==new Date(job.source_updated_at).getTime())throw new IntegrationError('QUEUE_SOURCE_CHANGED','筛查期间采集商品已变化，本次未发布。',409)
    const description=`<p>${escapeHtml(source.title)}</p>${images.details.map(url=>`<p><img src="${escapeHtml(url)}" alt="商品详情"></p>`).join('')}`
    const price=Math.min(...variants.map(v=>Number(v.price)))
    product=(await client.query(`INSERT INTO products(tenant_id,sku,name,category,description,specifications,base_price,base_currency,status,images,detail_images)VALUES($1,$2,$3,$4,$5,$6,$7,'CNY','active',$8,$9) RETURNING *`,[job.tenant_id,sourceSku(source),source.title.slice(0,200),source.category_path?.slice(0,120)||null,description,JSON.stringify(source.attributes||{}),price,JSON.stringify([...new Set([images.main,...images.gallery])]),JSON.stringify(images.details)])).rows[0]
    // The source listing's ladder ("¥39.00 (2 pieces) / ¥35.00 (10 pieces)") becomes the product's quantity price tiers.
    for(const tier of ladderTiers(source.attributes?.['阶梯价格']))await client.query('INSERT INTO product_prices(tenant_id,product_id,min_quantity,unit_price)VALUES($1,$2,$3,$4)',[job.tenant_id,product.id,tier.quantity,tier.price])
    for(const variant of variants)await client.query('INSERT INTO product_variants(tenant_id,product_id,source_variant_id,position,label,attributes,image_url,unit_price,stock)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[job.tenant_id,product.id,variant.id,variant.position,variant.label,JSON.stringify({...variant.attributes,...collectedSkuAttributes(source,variant)}),variantImage(variant.image_url),Number(variant.price),Number(variant.stock)])
    await client.query("UPDATE collected_products SET product_id=$2,processing_status='ready',updated_at=now() WHERE id=$1",[source.id,product.id])
    await client.query("UPDATE integration_1688_collection_queue_jobs SET phase='materializing',product_id=$2,report=$3::jsonb,updated_at=now() WHERE id=$1 AND worker_id=$4 AND status='processing'",[job.id,product.id,JSON.stringify(report),job.worker_id])
    await client.query('COMMIT')
  }catch(error){await client.query('ROLLBACK');if((error as {code?:string}).code==='23505')throw new IntegrationError('QUEUE_SKU_CONFLICT','来源商品货号已存在，请人工核对重复商品。',409);throw error}finally{client.release()}
  const draft=await createDraftFromProduct({tenantId:job.tenant_id,actorId:job.actor_id,requestId:job.id,connectionId:job.connection_id,product,catId:String(source.source_category_id),scene:'cbu',reuse:true})
  await publishThroughAgent(job,draft,actor,report,Boolean(report.imagesUnchecked))
}

export async function runClaimedCollectionQueueJob(id:string,workerId:string){
  const job=(await db.query("SELECT * FROM integration_1688_collection_queue_jobs WHERE id=$1 AND worker_id=$2 AND status='processing'",[id,workerId])).rows[0] as QueueJob|undefined
  if(!job)return false
  const heartbeat=setInterval(()=>void db.query("UPDATE integration_1688_collection_queue_jobs SET lease_until=now()+interval '2 minutes' WHERE id=$1 AND worker_id=$2 AND status='processing'",[job.id,workerId]).catch(()=>{}),30_000)
  try{await processJob(job)}catch(error){
    const state=(await db.query('SELECT phase FROM integration_1688_collection_queue_jobs WHERE id=$1',[job.id])).rows[0]
    const known=error instanceof IntegrationError
    const message=known?error.message:'Agent 队列处理异常；未确认发布结果，请人工核对。'
    if(state?.phase==='screening'&&!known&&job.attempts<3){await db.query("UPDATE integration_1688_collection_queue_jobs SET status='queued',available_at=now()+($3::int * interval '15 seconds'),message=$4,worker_id=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 AND worker_id=$2",[job.id,workerId,2**(job.attempts-1),message])}
    else await finish(job,state?.phase==='publishing'?'unknown':known?'blocked':'failed',message)
  }finally{clearInterval(heartbeat)}
  return true
}

export async function runCollectionQueueOnce(workerId=randomUUID()){
  const job=await claim(workerId)
  if(!job)return false
  return runClaimedCollectionQueueJob(job.id,workerId)
}

export async function recoverCollectionQueue(tenantId?:string){
  await db.query(`UPDATE integration_1688_collection_queue_jobs SET status=CASE WHEN phase='screening' AND attempts<3 THEN 'queued' WHEN phase='screening' THEN 'failed' ELSE 'unknown' END,message=CASE WHEN phase='screening' THEN '执行进程中断，等待重试或人工核对。' ELSE '执行进程中断且可能已创建产品或提交平台，请人工核对，禁止自动重试。' END,available_at=now()+interval '15 seconds',worker_id=NULL,lease_until=NULL,updated_at=now() WHERE status='processing' AND lease_until<now() AND ($1::uuid IS NULL OR tenant_id=$1)`,[tenantId||null])
}

export function startCollectionQueue(onError:(error:unknown)=>void=()=>{}){
  let running=0,stopped=false,ticking=false
  const active=new Set<Promise<unknown>>()
  const tick=async()=>{
    if(stopped||ticking)return
    ticking=true
    try{
      await recoverCollectionQueue()
      while(!stopped&&running<config.AGENT_QUEUE_CONCURRENCY){
        running++
        const task=runCollectionQueueOnce().catch(onError).finally(()=>{running--;active.delete(task)})
        active.add(task)
      }
    }finally{ticking=false}
  }
  const timer=setInterval(()=>void tick().catch(onError),config.AGENT_QUEUE_POLL_MS)
  void tick().catch(onError)
  return async()=>{
    stopped=true;clearInterval(timer)
    let timeout:ReturnType<typeof setTimeout>|undefined
    try{await Promise.race([Promise.allSettled([...active]),new Promise(resolve=>{timeout=setTimeout(resolve,30_000)})])}
    finally{if(timeout)clearTimeout(timeout)}
  }
}
