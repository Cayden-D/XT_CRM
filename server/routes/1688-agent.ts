import { fillPublishTemplate } from '../integrations/1688-publish-template.js'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { db } from '../db.js'
import { config } from '../config.js'
import { currentTextModel, generateQwenText, LlmRequestError, withTextModel } from '../llm/qwen.js'
import { teamOf } from '../integrations/teams.js'
import { requirePermission } from '../auth.js'
import { IntegrationError } from '../integrations/1688.js'
import { inspectPublishingImages, prepareAgentFields, publishingImages } from '../integrations/1688-agent.js'
import { collectedCategoryDefaults } from '../integrations/1688-collected-attributes.js'
import { fillFromProductData, loadProductData } from '../integrations/product-attributes.js'
import { collectedSkuAttributes } from '../integrations/1688-collected-skus.js'
import { defaultBrand, ownBrandNames } from '../integrations/brands.js'
import { attributeFacts, attributePictures, BRAND_FIELD, fillRequiredAttributes, isAttributeRejection, repairRejectedAttributes, type AttributeFillReport } from '../integrations/1688-attribute-fill.js'
import { validatePublishBody } from './1688.js'

type Publisher=(request:Pick<FastifyRequest,'params'|'body'|'authUser'|'id'>,agent?:{jobId:string;settingsRevision:number;queue?:{id:string;workerId:string}})=>Promise<unknown>
const idSchema=z.object({id:z.string().uuid()})
const MAX_PLATFORM_REPAIRS=2
export async function agent1688Routes(app:FastifyInstance,publish:Publisher){
  app.post('/agent/test',{preHandler:[requirePermission('integration:manage'),requirePermission('integration:publish')]},async()=>{
    if(!config.DASHSCOPE_API_KEY)throw new IntegrationError('LLM_NOT_CONFIGURED','请先配置百炼 API Key。',503)
    try{
      const result=await generateQwenText({model:'qwen3.8-flash',messages:[{role:'user',content:'只回复 OK，不调用任何工具。'}],maxTokens:100})
      return {data:{model:result.model,connected:true}}
    }catch(error){throw new IntegrationError('LLM_CONNECTION_FAILED',`模型连通测试失败${error instanceof LlmRequestError?`（HTTP ${error.status}）`:''}，请检查业务空间地址、API Key 归属及模型权限。`,502)}
  })
  app.get('/agent/settings',{preHandler:requirePermission('integration:read')},async request=>({data:(await db.query(`SELECT c.id,c.display_name,c.status,coalesce(s.enabled,false) AS enabled,coalesce(s.revision,0) AS revision FROM integration_1688_connections c LEFT JOIN integration_1688_agent_settings s ON s.connection_id=c.id WHERE c.tenant_id=$1 ORDER BY c.created_at`,[request.authUser.tenantId])).rows,model:'qwen3.8-flash',configured:Boolean(config.DASHSCOPE_API_KEY),imageRepairAvailable:true}))
  app.put('/connections/:id/agent-settings',{preHandler:[requirePermission('integration:manage'),requirePermission('integration:publish')]},async request=>{
    const {id}=idSchema.parse(request.params),input=z.object({enabled:z.boolean(),revision:z.number().int().nonnegative(),confirmed:z.literal(true)}).parse(request.body)
    if(input.enabled&&!config.DASHSCOPE_API_KEY)throw new IntegrationError('LLM_NOT_CONFIGURED','请先配置百炼 API Key。',503)
    const client=await db.connect()
    try{
      await client.query('BEGIN')
      const connection=(await client.query('SELECT id,status FROM integration_1688_connections WHERE id=$1 AND tenant_id=$2 FOR UPDATE',[id,request.authUser.tenantId])).rows[0]
      if(!connection)throw new IntegrationError('NOT_FOUND','店铺不存在。',404)
      if(input.enabled&&connection.status!=='connected')throw new IntegrationError('CONNECTION_UNAVAILABLE','请先连接店铺。',409)
      const previous=(await client.query('SELECT * FROM integration_1688_agent_settings WHERE connection_id=$1',[id])).rows[0]
      if((previous?.revision||0)!==input.revision)throw new IntegrationError('SETTINGS_CONFLICT','配置已变化，请刷新。',409)
      const saved=(await client.query(`INSERT INTO integration_1688_agent_settings(connection_id,tenant_id,enabled,updated_by)VALUES($1,$2,$3,$4) ON CONFLICT(connection_id) DO UPDATE SET enabled=excluded.enabled,revision=integration_1688_agent_settings.revision+1,updated_by=excluded.updated_by,updated_at=now() RETURNING *`,[id,request.authUser.tenantId,input.enabled,request.authUser.sub])).rows[0]
      if(!input.enabled){
        await client.query('UPDATE integration_1688_collection_queue_settings SET enabled=false,revision=revision+1,updated_at=now() WHERE connection_id=$1 AND enabled',[id])
        await client.query("UPDATE integration_1688_collection_queue_jobs SET status='cancelled',message='Agent 模式已关闭，未开始的任务已取消。',updated_at=now() WHERE connection_id=$1 AND tenant_id=$2 AND status='queued'",[id,request.authUser.tenantId])
      }
      await client.query("INSERT INTO audit_logs(tenant_id,actor_id,action,entity_type,entity_id,after_data,request_id)VALUES($1,$2,'1688.agent.settings','1688_connection',$3,$4,$5)",[request.authUser.tenantId,request.authUser.sub,id,JSON.stringify({enabled:input.enabled,revision:saved.revision}),request.id])
      await client.query('COMMIT');return {data:saved}
    }catch(error){await client.query('ROLLBACK');throw error}finally{client.release()}
  })
  app.get('/drafts/:id/agent-job',{preHandler:requirePermission('integration:read')},async request=>{
    const {id}=idSchema.parse(request.params)
    return {data:(await db.query('SELECT id,status,report,message,created_at,updated_at FROM integration_1688_agent_jobs WHERE draft_id=$1 AND tenant_id=$2 ORDER BY created_at DESC LIMIT 1',[id,request.authUser.tenantId])).rows[0]||null}
  })
  app.post('/agent-jobs/:id/cancel',{preHandler:requirePermission('integration:publish')},async request=>{
    const {id}=idSchema.parse(request.params),client=await db.connect()
    try{
      await client.query('BEGIN')
      const identity=(await client.query('SELECT connection_id FROM integration_1688_agent_jobs WHERE id=$1 AND tenant_id=$2',[id,request.authUser.tenantId])).rows[0]
      if(!identity)throw new IntegrationError('NOT_FOUND','任务不存在。',404)
      await client.query('SELECT id FROM integration_1688_connections WHERE id=$1 FOR UPDATE',[identity.connection_id])
      const job=(await client.query('SELECT * FROM integration_1688_agent_jobs WHERE id=$1 AND tenant_id=$2 FOR UPDATE',[id,request.authUser.tenantId])).rows[0]
      const draft=(await client.query('SELECT status FROM integration_1688_publish_drafts WHERE id=$1 AND tenant_id=$2 FOR UPDATE',[job.draft_id,request.authUser.tenantId])).rows[0]
      if(!['analyzing','publishing'].includes(job.status)||!['draft','failed'].includes(draft?.status))throw new IntegrationError('AGENT_CANNOT_CANCEL','请求已提交或结果未知，请使用发布结果核对，不能取消重发。',409)
      await client.query("UPDATE integration_1688_agent_jobs SET status='cancelled',message='已取消未提交的任务。',updated_at=now() WHERE id=$1",[id])
      await client.query("INSERT INTO audit_logs(tenant_id,actor_id,action,entity_type,entity_id,request_id)VALUES($1,$2,'1688.agent.cancel','1688_agent_job',$3,$4)",[request.authUser.tenantId,request.authUser.sub,id,request.id])
      await client.query('COMMIT');return {data:{cancelled:true}}
    }catch(error){await client.query('ROLLBACK');throw error}finally{client.release()}
  })
  app.post('/drafts/:id/agent',{preHandler:[requirePermission('integration:publish'),requirePermission('product:read')]},request=>runAgentDraft(request,publish))
}

/** Runs with the text model of the requesting account's team. */
export async function runAgentDraft(request:Pick<FastifyRequest,'params'|'body'|'authUser'|'id'>,publish:Publisher,queue?:{id:string;workerId:string;skipImageCheck?:boolean}){
  const team=await teamOf(request.authUser.tenantId,request.authUser.sub)
  return withTextModel(team.textModel,()=>agentDraft(request,publish,queue))
}
async function agentDraft(request:Pick<FastifyRequest,'params'|'body'|'authUser'|'id'>,publish:Publisher,queue?:{id:string;workerId:string;skipImageCheck?:boolean}){
    const {id}=idSchema.parse(request.params),{revision}=z.object({revision:z.number().int().positive()}).parse(request.body)
    const tenant=request.authUser.tenantId
    const draft=(await db.query('SELECT * FROM integration_1688_publish_drafts WHERE id=$1 AND tenant_id=$2',[id,tenant])).rows[0]
    if(!draft)throw new IntegrationError('NOT_FOUND','发布草稿不存在。',404)
    if(draft.revision!==revision||!['draft','failed'].includes(draft.status))throw new IntegrationError('DRAFT_CONFLICT','草稿已变化或不能发布。',409)
    const settings=(await db.query('SELECT * FROM integration_1688_agent_settings WHERE connection_id=$1 AND tenant_id=$2',[draft.connection_id,tenant])).rows[0]
    if(!settings?.enabled)throw new IntegrationError('AGENT_DISABLED','请先在“设置 → 自动上架”开启该店铺 Agent 上品。',409)
    const product=(await db.query("SELECT * FROM products WHERE id=$1 AND tenant_id=$2 AND status='active' AND deleted_at IS NULL",[draft.product_id,tenant])).rows[0]
    if(!product)throw new IntegrationError('PRODUCT_INACTIVE','请选择已启用的正式产品。',409)
    const variants=(await db.query('SELECT * FROM product_variants WHERE product_id=$1 AND tenant_id=$2 ORDER BY position',[draft.product_id,tenant])).rows
    let job
    try{job=(await db.query("INSERT INTO integration_1688_agent_jobs(tenant_id,connection_id,draft_id,actor_id,settings_revision,draft_revision,status)VALUES($1,$2,$3,$4,$5,$6,'analyzing')RETURNING *",[tenant,draft.connection_id,id,request.authUser.sub,settings.revision,revision])).rows[0]}catch(error){if((error as {code?:string}).code==='23505')throw new IntegrationError('AGENT_BUSY','已有 Agent 任务，请查看任务或发布核对结果，不要重复提交。',409);throw error}
    let report:Record<string,unknown>={model:currentTextModel(),imageRepairAvailable:true}
    try{
      const source=(await db.query('SELECT * FROM collected_products WHERE tenant_id=$1 AND product_id=$2 ORDER BY updated_at DESC LIMIT 1',[tenant,product.id])).rows[0]||null
      const sourceVariants=source?(await db.query('SELECT id,label,attributes FROM collected_product_variants WHERE tenant_id=$1 AND collected_product_id=$2',[tenant,source.id])).rows:[]
      const sourceById=new Map(sourceVariants.map(variant=>[variant.id,variant]))
      const reviewed=variants.map(variant=>{
        const original=sourceById.get(variant.source_variant_id)
        return original?{...variant,attributes:{...variant.attributes,...collectedSkuAttributes(source,original)}}:variant
      })
      const defaults=collectedCategoryDefaults(draft.platform_schema,source),ownBrand=await defaultBrand(tenant)
      // The collected brand is the source seller's; with a brand of its own the shop does not list under it.
      if(ownBrand)for(const field of draft.platform_schema.data?.catProp?.fields?.dataSource||[])if(BRAND_FIELD.test(String(field.label||'')))delete defaults[field.name]
      const current=await fillPublishTemplate(tenant,draft.platform_schema,fillFromProductData(draft.platform_schema,draft.data_body.formValues,await loadProductData(tenant,product.id)))
      const catProp={...(current.catProp||{})}
      for(const [name,value] of Object.entries(defaults))if(catProp[name]==null||catProp[name]===''||typeof catProp[name]==='object'&&catProp[name].value==null)catProp[name]=value
      let formValues=await prepareAgentFields(draft.platform_schema,{...current,catProp},product,reviewed)
      report={...report,title:formValues.title}
      const images=publishingImages(formValues)
      // Pictures generated for this listing are published unchecked when the owner chose so (AI images on).
      const findings=queue?.skipImageCheck?[]:await inspectPublishingImages(images,await ownBrandNames(tenant));report={...report,images:findings,...(queue?.skipImageCheck?{imagesUnchecked:true}:{})}
      const risky=findings.filter(i=>!i.readable||i.watermark||i.rightsRisk||i.uncertain)
      if(risky.length)throw new IntegrationError('AGENT_IMAGE_RISK',`图片检查未通过：${risky.map(i=>i.reason||'图片无法读取或存在明确标识').join('；')}。请核对原图或替换图片；不能通过编辑原图消除明确的公司水印或品牌 Logo。`,400)
      const facts=attributeFacts(product,reviewed,source,ownBrand?.name),pictures=attributePictures(formValues)
      const fill=await fillRequiredAttributes(draft.platform_schema,formValues,facts,pictures)
      formValues=fill.values
      const ai:AttributeFillReport={filled:fill.filled,refused:fill.refused,repairs:[]}
      report={...report,ai}
      const requireComplete=()=>{
        const missing=validatePublishBody(draft.platform_schema,{...draft.data_body,formValues})
        if(!missing.length)return
        const why=ai.refused.filter(item=>missing.includes(item.label)).map(item=>`${item.label}（${item.reason}）`)
        throw new IntegrationError('AGENT_MISSING_FIELDS',`发布规则未通过：${missing.join('、')}${why.length?`。AI 未填写：${why.join('；')}`:''}`,400)
      }
      requireComplete()
      let currentRevision=revision
      for(let repairs=0;;repairs++){
        // CAS keeps an image inspection tied to the exact body that will be published.
        const updated=(await db.query("UPDATE integration_1688_publish_drafts SET data_body=jsonb_set(data_body,'{formValues}',$4::jsonb),revision=revision+1,updated_at=now() WHERE id=$1 AND tenant_id=$2 AND revision=$3 AND status IN ('draft','failed') RETURNING revision",[id,tenant,currentRevision,JSON.stringify(formValues)])).rows[0]
        if(!updated)throw new IntegrationError('DRAFT_CONFLICT','AI 检测期间草稿已变化，请重新检测。',409)
        currentRevision=updated.revision
        const claimed=await db.query("UPDATE integration_1688_agent_jobs SET status='publishing',report=$2,updated_at=now() WHERE id=$1 AND status='analyzing' RETURNING id",[job.id,JSON.stringify(report)])
        if(!claimed.rows.length)throw new IntegrationError('AGENT_STOPPED','任务已取消，本次未发布。',409)
        try{
          const sent=await publish({...request,params:{id},body:{revision:currentRevision,confirmed:true}},{jobId:job.id,settingsRevision:settings.revision,queue}) as {data?:{warning?:string;skuCheck?:string}}|undefined
          if(sent?.data?.warning)report={...report,skuWarning:sent.data.warning}
          if(sent?.data?.skuCheck)report={...report,skuCheck:sent.data.skuCheck}
          break
        }catch(error){
          // Only a definite rejection leaves the draft 'failed'; anything that may have reached the shop is never sent again.
          const state=(await db.query('SELECT status FROM integration_1688_publish_drafts WHERE id=$1 AND tenant_id=$2',[id,tenant])).rows[0]?.status
          if(state!=='failed'||!isAttributeRejection(error))throw error
          if(repairs>=MAX_PLATFORM_REPAIRS)throw new IntegrationError(error.code,`${error.message}（AI 已自动修改并重试 ${repairs} 次仍未通过，请人工核对）`,400,error.detail)
          const reopened=await db.query("UPDATE integration_1688_agent_jobs SET status='analyzing',updated_at=now() WHERE id=$1 AND status='publishing' RETURNING id",[job.id])
          if(!reopened.rows.length)throw new IntegrationError('AGENT_STOPPED','任务已取消，本次未发布。',409)
          const repair=await repairRejectedAttributes(draft.platform_schema,formValues,facts,pictures,error,ai.filled.map(item=>item.name))
          ai.repairs.push({code:error.code,detail:error.detail??null,diagnosis:repair.diagnosis,changed:repair.changed})
          if(!repair.changed.length)throw new IntegrationError(error.code,`${error.message}（AI 未找到可修改的内容，请人工核对）`,400,error.detail)
          formValues=repair.values
          ai.filled=[...ai.filled.filter(item=>!repair.filled.some(next=>next.name===item.name)),...repair.filled]
          ai.refused=repair.refused
          report={...report,title:formValues.title,ai}
          requireComplete()
        }
      }
      const summary=[ai.filled.length?`AI 代填 ${ai.filled.length} 项属性`:'',ai.repairs.length?`平台拒绝后自动修复 ${ai.repairs.length} 次`:''].filter(Boolean).join('，')
      await db.query("UPDATE integration_1688_agent_jobs SET status='published',report=$2,message=$3,updated_at=now() WHERE id=$1",[job.id,JSON.stringify(report),`已提交平台；审核状态以平台为准。${summary?`${summary}，可在任务详情核对。`:''}${report.skuWarning?`注意：${report.skuWarning}`:report.skuCheck&&report.skuCheck!=='unread'?`${report.skuCheck}。`:''}`])
    }catch(error){
      const state=(await db.query('SELECT status FROM integration_1688_publish_drafts WHERE id=$1 AND tenant_id=$2',[id,tenant])).rows[0]?.status
      const status=state==='unknown'||state==='submitting'?'unknown':error instanceof IntegrationError?'blocked':'failed'
      const message=error instanceof IntegrationError?error.message:'AI 检测或生成失败，本次未自动重试。请检查模型配置与返回结果。'
      await db.query("UPDATE integration_1688_agent_jobs SET status=$2,report=$3,message=$4,updated_at=now() WHERE id=$1 AND status<>'cancelled'",[job.id,status,JSON.stringify(report),message])
    }
    await db.query("INSERT INTO audit_logs(tenant_id,actor_id,action,entity_type,entity_id,request_id)VALUES($1,$2,'1688.agent.run','1688_agent_job',$3,$4)",[tenant,request.authUser.sub,job.id,request.id])
    return {data:(await db.query('SELECT id,status,report,message,created_at,updated_at FROM integration_1688_agent_jobs WHERE id=$1 AND tenant_id=$2',[job.id,tenant])).rows[0]}
}
