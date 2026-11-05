import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { db } from '../db.js'
import { config } from '../config.js'
import { hasPermission, requireAuth } from '../auth.js'
import { chatQwen,isQwenModel,LlmConfigurationError,LlmRequestError,QWEN_MODELS,streamQwen,type LlmMessage,type QwenModel } from '../llm/qwen.js'
import { beijingDate, runTool, toolsFor, type AssistantContext } from '../integrations/ai-assistant-tools.js'
import { addFollowup, changeTags, setOwners } from './customer-ops.js'

const chatSchema=z.object({message:z.string().trim().min(1).max(8000),conversationId:z.string().uuid().optional().nullable(),model:z.string().optional(),context:z.object({
  page:z.string().max(50).optional(),pageTitle:z.string().max(100).optional(),view:z.string().max(50).optional(),
  connectionId:z.string().uuid().optional(),customerId:z.string().uuid().optional(),customerName:z.string().max(100).optional(),
}).optional()})
const idSchema=z.object({id:z.string().uuid()})
const MAX_TOOL_ROUNDS=5
// Answers that summarise several tool results can take longer than one plain completion.
const ASSISTANT_TIMEOUT_MS=120_000
const weekdays='日一二三四五六'

const systemPrompt=`你是“销途 AI”，内嵌在一套 1688 店铺经营 CRM 里的助手，服务国内 B2B 销售与客服团队。请用简洁、准确的中文回答，可以使用 Markdown（列表、加粗、表格）。
系统模块：首页（销售/退款/接待/转化/待办汇总）、客户（1688 线上买家：分层、购买周期、待跟进、下单未付款、咨询未下单、跟进记录；以及线下客户档案）、聊天（聊天记录与询盘分析）、订单、商品（在售商品、采集箱、上架队列、发布草稿、产品资料）、图片（图片编辑、电商套图）、绩效（接待、响应、归因业绩、工资、回复质量与站外交易风险、旺旺关键词命中）、设置（店铺授权、客服账号、绩效规则、自动上架、账号权限）。
规则：
1. 涉及具体数字、客户、订单、客服或商品时，必须先调用工具查询系统数据，不得凭空编造；工具没有返回的数据要明确说“系统里没有”。
2. 回答数据问题时注明统计周期与口径（金额单位：元）。如果工具提示同步未完成或历史数据不完整，要提醒用户。
3. 你不能直接修改数据。只有当用户明确要求时才调用 propose_followup（写跟进）、propose_tags（加/移除标签）、propose_owner（改所属客服）；系统会生成确认卡片，由用户确认后才保存，不要声称已保存。改标签或所属客服前先用 get_customer_options 查可用标签和客服账号。其他修改请告诉用户去对应页面操作。
4. 没有权限的工具不会提供给你；若用户问到无权查看的数据，说明需要相应权限。
5. 买家消息原文被 1688 隐藏：要了解买家在问什么，用 get_keyword_hits（关键词只对加入后的新消息生效）；分析客服话术或站外交易风险用 get_reply_quality；看某个客户时 get_customer 会带上客服最近发的话（已遮盖联系方式），写跟进建议时不要与之矛盾。
6. 优先给出可执行的建议（先跟进谁、为什么、怎么说），并点名客户/客服。`

type Proposal={id:string;action_type:string;proposed_payload:Record<string,unknown>;status:string;error_message:string|null}
async function proposals(ids:string[]){
  if(!ids.length)return []
  // A proposal not confirmed within a day is shown as expired; confirming it is refused below.
  return (await db.query<Proposal>(`SELECT id,action_type,proposed_payload,CASE WHEN status='pending' AND created_at<=now()-interval '1 day' THEN 'expired' ELSE status END AS status,error_message
    FROM ai_action_requests WHERE id=ANY($1::uuid[]) ORDER BY created_at`,[ids])).rows
    .map(p=>({id:p.id,type:p.action_type,payload:p.proposed_payload,status:p.status,error:p.error_message}))
}

/** The shop the assistant works on: the one the user is looking at if it is theirs, else the first connected shop. */
async function resolveShop(tenantId:string,wanted?:string){
  const shops=(await db.query<{id:string;display_name:string|null}>(`SELECT id,display_name FROM integration_1688_perf_connections WHERE tenant_id=$1 ORDER BY status='connected' DESC,created_at`,[tenantId])).rows
  return shops.find(s=>s.id===wanted)??shops[0]??null
}

type Emit=(event:string,data:unknown)=>void
type Prepared={conversationId:string;requested:QwenModel;input:z.infer<typeof chatSchema>}

/** Validates the turn and records the user's message (in a new conversation if none is given). */
async function prepareChat(request:FastifyRequest):Promise<Prepared|{status:number;body:object}>{
  const input=chatSchema.safeParse(request.body);if(!input.success)return{status:400,body:{error:'VALIDATION_ERROR',message:'消息格式不正确。',details:input.error.flatten()}}
  const requested=input.data.model??config.QWEN_DEFAULT_MODEL;if(!isQwenModel(requested))return{status:400,body:{error:'UNSUPPORTED_MODEL',message:'所选模型不在允许列表中。'}}
  const {tenantId,sub:userId}=request.authUser
  const client=await db.connect();let conversationId=input.data.conversationId??null
  try{
    await client.query('BEGIN')
    if(conversationId){
      const exists=await client.query('SELECT id FROM ai_conversations WHERE id=$1 AND tenant_id=$2 AND user_id=$3 FOR UPDATE',[conversationId,tenantId,userId])
      if(!exists.rows[0]){await client.query('ROLLBACK');return{status:404,body:{error:'NOT_FOUND',message:'对话不存在。'}}}
      await client.query('UPDATE ai_conversations SET model_provider=$2,model_name=$3,updated_at=now() WHERE id=$1',[conversationId,'qwen',requested])
    }else conversationId=(await client.query(`INSERT INTO ai_conversations(tenant_id,user_id,title,context_type,model_provider,model_name)VALUES($1,$2,$3,$4,'qwen',$5)RETURNING id`,[tenantId,userId,input.data.message.slice(0,80),input.data.context?.page??'global',requested])).rows[0].id as string
    await client.query(`INSERT INTO ai_messages(conversation_id,role,content)VALUES($1,'user',$2)`,[conversationId,input.data.message])
    await client.query('COMMIT')
  }catch(error){await client.query('ROLLBACK');throw error}finally{client.release()}
  return{conversationId:conversationId!,requested,input:input.data}
}

function llmFailure(request:FastifyRequest,error:unknown):{status:number;body:{error:string;message:string}}{
  request.log.error(error)
  if(error instanceof LlmConfigurationError)return{status:503,body:{error:'LLM_NOT_CONFIGURED',message:error.message}}
  if(error instanceof LlmRequestError)return{status:error.status===429?429:error.status===504?504:502,body:{error:'LLM_REQUEST_FAILED',message:error.message}}
  return{status:500,body:{error:'INTERNAL_SERVER_ERROR',message:'服务器处理请求时发生错误。'}}
}

/** Runs the tool rounds and saves the answer. With `emit`, the model is streamed and progress is pushed as it happens. */
async function answer(request:FastifyRequest,{conversationId,requested,input}:Prepared,emit?:Emit){
  const {tenantId,sub:userId,permissions,displayName}=request.authUser
  const context=input.context??{}
  const shop=await resolveShop(tenantId,context.connectionId)
  const ctx:AssistantContext={tenantId,userId,permissions,connectionId:shop?.id??null,conversationId,proposals:[]}
  const tools=toolsFor(permissions)
  const today=beijingDate(0)
  // Only pointers go into the prompt; the model pulls the actual figures through tools when a question needs them.
  const situation=[`今天：${today}（星期${weekdays[new Date(`${today}T00:00:00+08:00`).getUTCDay()]}，北京时间）`,`当前用户：${displayName}`,
    `当前页面：${context.pageTitle||context.page||'全局工作台'}${context.view?` / ${context.view}`:''}`,
    shop?`当前店铺：${shop.display_name??'未命名店铺'}`:'当前没有授权的 1688 店铺',
    context.customerId?`用户正在查看的客户：${context.customerName??'未命名'}（customerId=${context.customerId}）。用户说“这个客户/他”时指该客户。`:'',
    tools.length?`可用工具：${tools.map(t=>t.function.name).join('、')}`:'当前账号没有可查询的业务数据权限，只能回答通用问题。'].filter(Boolean).join('\n')
  const history=(await db.query<{role:'user'|'assistant';content:string}>(`SELECT role,content FROM ai_messages WHERE conversation_id=$1 AND role IN ('user','assistant') ORDER BY created_at DESC,id DESC LIMIT 20`,[conversationId])).rows.reverse()
  const messages:LlmMessage[]=[{role:'system',content:`${systemPrompt}\n\n${situation}`},...history]
  const started=Date.now(),used:{name:string;ok:boolean}[]=[];let inputTokens=0,outputTokens=0
  const timeoutMs=Math.max(config.QWEN_TIMEOUT_MS,ASSISTANT_TIMEOUT_MS)
  const complete=(withTools:boolean)=>emit
    ?streamQwen({messages,model:requested,tools:withTools?tools:undefined,timeoutMs,onText:text=>emit('delta',{text})})
    :chatQwen({messages,model:requested,tools:withTools?tools:undefined,timeoutMs})
  let result=await complete(true)
  for(let round=0;result.toolCalls.length;round++){
    inputTokens+=result.inputTokens??0;outputTokens+=result.outputTokens??0
    emit?.('tools',{names:result.toolCalls.map(c=>c.function.name)})
    messages.push({role:'assistant',content:result.content,tool_calls:result.toolCalls})
    for(const call of result.toolCalls){
      const out=await runTool(ctx,call.function.name,call.function.arguments)
      used.push({name:call.function.name,ok:out.ok})
      messages.push({role:'tool',tool_call_id:call.id,content:out.content})
    }
    // After the last allowed round the model must answer with what it has.
    result=await complete(round+1<MAX_TOOL_ROUNDS)
  }
  inputTokens+=result.inputTokens??0;outputTokens+=result.outputTokens??0
  const content=result.content??'（没有生成回答）'
  const saved=(await db.query(`INSERT INTO ai_messages(conversation_id,role,content,input_tokens,output_tokens,latency_ms,extracted_entities)VALUES($1,'assistant',$2,$3,$4,$5,$6)RETURNING id,role,content,input_tokens,output_tokens,latency_ms,created_at`,
    [conversationId,content,inputTokens,outputTokens,Date.now()-started,JSON.stringify({tools:used,actions:ctx.proposals})])).rows[0]
  await db.query('UPDATE ai_conversations SET updated_at=now() WHERE id=$1',[conversationId])
  await db.query(`INSERT INTO audit_logs(tenant_id,actor_id,action,entity_type,entity_id,after_data,request_id)VALUES($1,$2,'ai.chat','ai_conversation',$3,$4,$5)`,
    [tenantId,userId,conversationId,JSON.stringify({provider:'qwen',model:result.model,stream:Boolean(emit),inputTokens,outputTokens,tools:used.map(t=>t.name),proposals:ctx.proposals.length}),request.id])
  return{conversationId,message:{...saved,tools:used,actions:await proposals(ctx.proposals)},model:result.model}
}

export async function aiRoutes(app:FastifyInstance){
  app.get('/models',{preHandler:requireAuth},async()=>({data:{provider:'qwen',configured:Boolean(config.DASHSCOPE_API_KEY),defaultModel:config.QWEN_DEFAULT_MODEL,models:QWEN_MODELS}}))

  app.get('/conversations',{preHandler:requireAuth},async request=>{
    const {limit,before}=z.object({limit:z.coerce.number().int().min(1).max(100).default(30),before:z.string().datetime({offset:true}).optional()}).parse(request.query)
    const rows=(await db.query(`SELECT c.id,c.title,c.model_name,c.created_at,c.updated_at,
        (SELECT count(*)::int FROM ai_messages m WHERE m.conversation_id=c.id AND m.role IN ('user','assistant')) AS messages,
        (SELECT count(*)::int FROM ai_action_requests a WHERE a.conversation_id=c.id AND a.status='pending' AND a.created_at>now()-interval '1 day') AS pending_actions
      FROM ai_conversations c WHERE c.tenant_id=$1 AND c.user_id=$2 AND ($3::timestamptz IS NULL OR c.updated_at<$3) ORDER BY c.updated_at DESC LIMIT $4`,[request.authUser.tenantId,request.authUser.sub,before??null,limit+1])).rows
    return{data:rows.slice(0,limit),hasMore:rows.length>limit}
  })

  // Deletes the user's own conversation; proposals stay in ai_action_requests (conversation_id is cleared) for the audit trail.
  app.delete('/conversations/:id',{preHandler:requireAuth},async(request,reply)=>{
    const {id}=idSchema.parse(request.params)
    const row=(await db.query('DELETE FROM ai_conversations WHERE id=$1 AND tenant_id=$2 AND user_id=$3 RETURNING id',[id,request.authUser.tenantId,request.authUser.sub])).rows[0]
    if(!row)return reply.code(404).send({error:'NOT_FOUND',message:'对话不存在。'})
    await db.query(`INSERT INTO audit_logs(tenant_id,actor_id,action,entity_type,entity_id,request_id)VALUES($1,$2,'ai.conversation.delete','ai_conversation',$3,$4)`,[request.authUser.tenantId,request.authUser.sub,id,request.id])
    return reply.code(204).send()
  })

  app.get('/conversations/:id/messages',{preHandler:requireAuth},async(request,reply)=>{
    const id=idSchema.safeParse(request.params);if(!id.success)return reply.code(400).send({error:'VALIDATION_ERROR'})
    const conversation=await db.query('SELECT id,title,model_name,created_at,updated_at FROM ai_conversations WHERE id=$1 AND tenant_id=$2 AND user_id=$3',[id.data.id,request.authUser.tenantId,request.authUser.sub])
    if(!conversation.rows[0])return reply.code(404).send({error:'NOT_FOUND'})
    const messages=(await db.query(`SELECT id,role,content,input_tokens,output_tokens,latency_ms,created_at,extracted_entities FROM ai_messages WHERE conversation_id=$1 AND role IN ('user','assistant') ORDER BY created_at,id`,[id.data.id])).rows
    return{data:{conversation:conversation.rows[0],messages:await Promise.all(messages.map(async({extracted_entities:meta,...m})=>({...m,tools:meta?.tools??[],actions:await proposals(meta?.actions??[])})))}}
  })

  app.post('/chat',{preHandler:requireAuth},async(request,reply)=>{
    const prepared=await prepareChat(request);if('status' in prepared)return reply.code(prepared.status).send(prepared.body)
    try{return{data:await answer(request,prepared)}}
    catch(error){const failure=llmFailure(request,error);return reply.code(failure.status).send(failure.body)}
  })

  // The same conversation turn as /chat, as server-sent events: `start` (conversation id), `tools` (data being read;
  // text streamed before a tool round is discarded), `delta` (answer text), then `done` (the saved message) or `error`.
  app.post('/chat/stream',{preHandler:requireAuth},async(request,reply)=>{
    const prepared=await prepareChat(request);if('status' in prepared)return reply.code(prepared.status).send(prepared.body)
    reply.hijack()
    // Headers set by plugins (CORS) are carried over; nginx must not buffer the stream.
    reply.raw.writeHead(200,{...reply.getHeaders() as Record<string,string>,'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'})
    const emit:Emit=(event,data)=>{if(!reply.raw.destroyed)reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)}
    // Keeps proxies from closing a connection that waits on a slow tool round.
    const heartbeat=setInterval(()=>{if(!reply.raw.destroyed)reply.raw.write(': ping\n\n')},15_000)
    emit('start',{conversationId:prepared.conversationId})
    try{emit('done',await answer(request,prepared,emit))}
    catch(error){emit('error',llmFailure(request,error).body)}
    finally{clearInterval(heartbeat);reply.raw.end()}
  })

  // A proposal is executed only by the user who asked for it, once, within a day, and with the permission the write itself needs.
  app.post('/actions/:id/confirm',{preHandler:requireAuth},async(request,reply)=>{
    const {id}=idSchema.parse(request.params)
    const {tenantId,sub:userId,permissions}=request.authUser
    const claimed=(await db.query<Proposal>(`UPDATE ai_action_requests SET status='confirmed',confirmed_by=$3,confirmed_at=now()
      WHERE id=$1 AND tenant_id=$2 AND requested_by=$3 AND status='pending' AND created_at>now()-interval '1 day' RETURNING id,action_type,proposed_payload,status,error_message`,[id,tenantId,userId])).rows[0]
    if(!claimed){
      const row=(await db.query('SELECT status FROM ai_action_requests WHERE id=$1 AND tenant_id=$2 AND requested_by=$3',[id,tenantId,userId])).rows[0]
      return reply.code(row?409:404).send({error:row?'ACTION_NOT_PENDING':'NOT_FOUND',message:row?(row.status==='pending'?'该建议已超过 24 小时，请让 AI 重新生成。':'该建议已处理过。'):'建议不存在。'})
    }
    const finish=(status:'executed'|'failed',message:string|null)=>db.query(`UPDATE ai_action_requests SET status=$2::varchar,executed_at=CASE WHEN $2::varchar='executed' THEN now() END,error_message=$3 WHERE id=$1`,[id,status,message])
    try{
      if(!['customer.followup','customer.tags','customer.owner'].includes(claimed.action_type))throw new Error('不支持的操作类型。')
      if(!hasPermission(permissions,'customer_ops:update')){await finish('failed','没有修改客户的权限。');return reply.code(403).send({error:'FORBIDDEN',message:'当前账号没有执行此操作的权限。'})}
      let result:object
      if(claimed.action_type==='customer.followup'){
        const p=claimed.proposed_payload as {customerId:string;content:string;nextFollowUpDate:string|null}
        // The planned date is a Beijing calendar day; it is stored as 09:00 that morning.
        const row=await addFollowup(tenantId,userId,p.customerId,{content:p.content,method:'other',needFollowUp:Boolean(p.nextFollowUpDate),nextFollowUpAt:p.nextFollowUpDate?`${p.nextFollowUpDate}T09:00:00+08:00`:null})
        result={followupId:row.id,customerId:p.customerId}
      }else if(claimed.action_type==='customer.tags'){
        const p=claimed.proposed_payload as {customers:{id:string}[];add:string[];remove:string[]}
        result=await changeTags(tenantId,userId,p.customers.map(c=>c.id),p.add,p.remove,request.id)
      }else{
        const p=claimed.proposed_payload as {customers:{id:string}[];agentId:string}
        result=await setOwners(tenantId,userId,p.customers.map(c=>c.id),p.agentId,request.id)
      }
      await finish('executed',null)
      await db.query(`INSERT INTO audit_logs(tenant_id,actor_id,action,entity_type,entity_id,after_data,request_id)VALUES($1,$2,'ai.action.execute','ai_action_request',$3,$4,$5)`,[tenantId,userId,id,JSON.stringify({type:claimed.action_type,...result}),request.id])
      return{data:(await proposals([id]))[0]}
    }catch(error){
      await finish('failed',error instanceof Error?error.message.slice(0,500):'执行失败')
      throw error
    }
  })

  app.post('/actions/:id/reject',{preHandler:requireAuth},async(request,reply)=>{
    const {id}=idSchema.parse(request.params)
    const row=(await db.query(`UPDATE ai_action_requests SET status='rejected' WHERE id=$1 AND tenant_id=$2 AND requested_by=$3 AND status='pending' RETURNING id`,[id,request.authUser.tenantId,request.authUser.sub])).rows[0]
    if(!row)return reply.code(404).send({error:'NOT_FOUND',message:'建议不存在或已处理。'})
    return{data:(await proposals([id]))[0]}
  })
}
