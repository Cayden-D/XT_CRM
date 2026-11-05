import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { buildApp } from '../server/app.js'
import { db } from '../server/db.js'
import { saveConnection } from '../server/integrations/1688.js'
import { computeTurns, enqueuePerformanceSync, parseBeijingTime, rebuildSession, runPerformanceSyncOnce } from '../server/integrations/1688-performance-sync.js'

// The mock reproduces the response shapes observed on the live platform (2026-10-14 read-only probe):
// top-level {success,data}, Beijing time strings, masked sender/receiver, owner decided by selfLoginId.
const originalFetch=globalThis.fetch
const marker=randomUUID(),tenantIds:string[]=[]
const app=await buildApp()
const DAY=86_400_000
const beijingDay=(offset:number)=>new Date(Date.now()+8*3_600_000+offset*DAY).toISOString().slice(0,10)
const D=beijingDay(-1),compactD=D.replaceAll('-',''),nextD=beijingDay(0)
const at=(date:string,time:string)=>`${date} ${time}`
const ms=(text:string)=>parseBeijingTime(text).getTime()
type Msg={uuid:string;self:string;direction:0|1;time:string;types:string[];text?:string}
const messages:Record<string,Msg[]>={
  c1:[
    {uuid:'m1',self:'shop:a',direction:1,time:at(D,'10:00:00'),types:['正常消息']},
    {uuid:'m2',self:'shop:a',direction:1,time:at(D,'10:00:30'),types:['正常消息']},
    {uuid:'m3',self:'shop:a',direction:0,time:at(D,'10:01:00'),types:['自动回复消息']},
    {uuid:'m4',self:'shop:a',direction:0,time:at(D,'10:02:00'),types:['正常消息'],text:'亲，这款现货，48 小时内发货 https://detail.1688.com/offer/712345678901.html'},
    {uuid:'m10',self:'shop',direction:1,time:at(D,'10:04:00'),types:['正常消息']},
    {uuid:'m9',self:'shop',direction:0,time:at(D,'10:05:00'),types:['正常消息'],text:'听不明白'},
    {uuid:'m11',self:'shop',direction:0,time:at(D,'10:06:00'),types:['客服转交消息']},
    {uuid:'m5',self:'shop:a',direction:1,time:at(D,'10:10:00'),types:['其他消息']},
    {uuid:'m6',self:'shop:a',direction:0,time:at(D,'10:20:00'),types:['正常消息'],text:'加我微信 abc_12345 发你实拍，电话 138 1234 5678'},
    {uuid:'m7',self:'shop:a',direction:1,time:at(D,'10:30:00'),types:['系统消息']},
    {uuid:'m8',self:'shop:a',direction:1,time:at(D,'11:00:00'),types:['正常消息']},
    {uuid:'m12',self:'shop:a',direction:1,time:at(nextD,'00:00:10'),types:['正常消息']},
  ],
  c2:[
    {uuid:'n1',self:'shop:a',direction:1,time:at(D,'14:00:00'),types:['正常消息']},
    {uuid:'n2',self:'shop:a',direction:0,time:at(D,'14:00:20'),types:['正常消息'],text:'好的'},
  ],
  c3:[{uuid:'p1',self:'shop:b',direction:1,time:at(D,'03:00:00'),types:['正常消息']},{uuid:'p2',self:'shop:b',direction:0,time:at(D,'03:00:05'),types:['其他消息']}],
}
const lastTime=(cid:string,self:string)=>Math.max(...messages[cid].filter(m=>m.self===self&&m.time.startsWith(D)).map(m=>ms(m.time)))
const peers:Record<string,{cid:string;date:string;time:number;openUid:string;adminOpenUid:string;taobaoNick:string}[]>={
  'shop:a':[{cid:'c1',date:compactD,time:lastTime('c1','shop:a'),openUid:'O1',adminOpenUid:'A1',taobaoNick:'nick1'},{cid:'c2',date:compactD,time:lastTime('c2','shop:a'),openUid:'',adminOpenUid:'',taobaoNick:'tbuser'}],
  shop:[{cid:'c1',date:compactD,time:lastTime('c1','shop'),openUid:'O1-sub',adminOpenUid:'A1',taobaoNick:'nick1'}],
  'shop:b':[{cid:'c3',date:compactD,time:lastTime('c3','shop:b'),openUid:'O3',adminOpenUid:'A3',taobaoNick:'nick3'}],
}
const counts={relation:0,messages:0,overflowPages:0,tooOld:0,throttled:0}
let failRelationAt=0
const response=(data:unknown)=>new Response(JSON.stringify(data),{status:200})
globalThis.fetch=async(input,init)=>{
  const url=String(input)
  assert.ok(url.startsWith('https://gw.open.1688.com/openapi/'),'unexpected network destination')
  const flat=Object.fromEntries((init!.body as URLSearchParams).entries())
  assert.equal(flat.access_token,'sync-access','only the test grant may reach the mock')
  if(url.includes('alibaba.subAccount.list'))return response({mainLoginId:'shop',mainUserId:'100',mainMemberId:'b2b-1',subAccountList:[{loginId:'shop:a',userId:101,memberId:'b2b-1',status:'正常'},{loginId:'shop:b',userId:102,memberId:'b2b-1',status:'正常'}]})
  if(url.includes('wangwang.chat.relation.query')){
    counts.relation++
    if(counts.relation===failRelationAt)return response({error_code:'isp.service-unavailable',error_message:'busy'})
    const beg=Number(flat.beg),end=Number(flat.end),page=Number(flat.page),size=Number(flat.size)
    assert.ok(size<=80&&page>=1&&page<=25)
    // The platform only keeps 90 days of relations.
    if(beg<Date.now()-90*86_400_000){counts.tooOld++;return response({success:'false',errorCode:'200',errorMessage:'out of range'})}
    const list=peers[flat.loginId]||[]
    // Like the platform: every Beijing date from beg to end (inclusive) is returned, whatever the clock time.
    const date=(t:number)=>new Date(t+8*3_600_000).toISOString().slice(0,10).replaceAll('-','')
    const inWindow=list.filter(p=>p.date>=date(beg)&&p.date<=date(end)).map(p=>({...p,loginId:'**',fromDomain:'cnalichn',targetDomain:'cnalichn'}))
    // shop:b behaves like a busy account: its day exceeds the 2000-record cap.
    if(flat.loginId==='shop:b'&&inWindow.length){counts.overflowPages++;return response({success:'true',data:{hasMore:true,peers:Array.from({length:80},()=>inWindow[0])}})}
    const slice=inWindow.slice((page-1)*size,page*size)
    return response({success:'true',data:{peers:slice,hasMore:page*size<inWindow.length}})
  }
  if(url.includes('chat.msg.query')){
    // The first call is throttled by the gateway, as seen live; the sync backs off and retries.
    if(!counts.throttled++)return response({error_code:'gw.QosAppFrequencyLimit',error_message:'App call limited'})
    counts.messages++
    assert.equal(flat.forward,'true')
    // Two per page to exercise cursor paging; every account's messages in the cid are returned, as on the platform.
    const all=(messages[flat.cid]||[]).filter(m=>ms(m.time)>=Number(flat.beg)).sort((a,b)=>ms(a.time)-ms(b.time))
    const page=all.slice(0,2)
    return response({success:true,data:{nextCursor:page.length?ms(page.at(-1)!.time)+1:Number(flat.beg),hasMore:all.length>2,historyChatLogList:page.map(m=>({content:m.direction?'---***---':(m.text??'x'),direction:m.direction,length:'3',time:m.time,uuid:m.uuid,receiverLoginId:'**',senderLoginId:'**',messageTypes:m.types,urls:[],words:[],selfLoginId:m.self,buyerOpenUid:'O1',buyerAdminOpenUid:'A1'}))}})
  }
  // Orders and refunds are covered by test-1688-performance-orders; this shop has none.
  if(url.includes('alibaba.trade.ec.getOrderList.sellerView'))return response({success:true,totalRecord:0,result:[]})
  if(url.includes('alibaba.trade.refund.queryOrderRefundList'))return response({result:{totalCount:0,currentPageNum:0,opOrderRefundModels:[]}})
  throw new Error(`Unmocked API ${url}`)
}

try{
  // Pure turn logic.
  const t=(s:string)=>new Date(`2026-01-01T${s}+08:00`)
  const pure=computeTurns([{direction:1,sent_at:t('10:00:00'),message_types:['正常消息']},{direction:0,sent_at:t('10:00:05'),message_types:['客服转交消息']},{direction:0,sent_at:t('10:00:09'),message_types:['正常消息']},{direction:0,sent_at:t('10:00:10'),message_types:['正常消息']}],false)
  assert.equal(pure.turns.length,1);assert.equal(pure.turns[0].reply_at?.getTime(),t('10:00:09').getTime());assert.equal(pure.transferred,true);assert.equal(pure.agent,2)
  const card=[{direction:1,sent_at:t('10:00:00'),message_types:['正常消息']},{direction:0,sent_at:t('10:00:03'),message_types:['其他消息']},{direction:1,sent_at:t('10:00:30'),message_types:['正常消息']},{direction:0,sent_at:t('10:01:00'),message_types:['正常消息']}]
  assert.deepEqual(computeTurns(card,false).turns.map(x=>x.reply_at?.getTime()),[t('10:01:00').getTime()],'strict: a card does not answer the buyer')
  assert.deepEqual(computeTurns(card,true).turns.map(x=>x.reply_at?.getTime()),[t('10:00:03').getTime(),t('10:01:00').getTime()],'loose: a card answers the buyer')
  assert.equal(computeTurns(card,false).other,1)
  assert.throws(()=>parseBeijingTime('2026/01/01'))

  for(let i=0;i<2;i++)tenantIds.push((await db.query('INSERT INTO tenants(name,slug)VALUES($1,$2)RETURNING id',['1688 performance sync test',`test-1688-perfsync-${marker}-${i}`])).rows[0].id)
  const tenantId=tenantIds[0]
  const mkUser=async(tenant:string,name:string)=>(await db.query("INSERT INTO users(tenant_id,email,password_hash,display_name,status)VALUES($1,$2,'unused',$3,'active')RETURNING id",[tenant,`${name}-${marker}@integration.local`,name])).rows[0].id as string
  const admin=await mkUser(tenantId,'admin'),agentUser=await mkUser(tenantId,'agentA'),otherUser=await mkUser(tenantId,'agentB'),foreignUser=await mkUser(tenantIds[1],'foreign')
  const token=(sub:string,permissions:string[],tenant=tenantId)=>({authorization:`Bearer ${app.jwt.sign({sub,tenantId:tenant,email:'t',displayName:'t',roles:[],permissions})}`})
  const all=token(admin,['*'])
  const request=(method:'GET'|'POST'|'PUT',url:string,payload?:object,headers=all)=>app.inject({method,url,headers,...(payload?{payload}:{})})
  const base='/api/integrations/1688/performance'
  const connection=await saveConnection(tenantId,admin,{access_token:'sync-access',refresh_token:'sync-refresh',expires_in:36000,aliId:`sync-${marker}`,resource_owner:'shop',refresh_token_timeout:'20990101000000000+0800'},Date.now(),'performance')
  await db.query("UPDATE integration_1688_perf_connections SET account_role='main' WHERE id=$1",[connection.id])
  const sync=async()=>{const result=await runPerformanceSyncOnce(undefined,connection.id);assert.ok(result);return result}

  // History range: 7/30/60/90 days (default 30), manager only.
  const historyDays=(days:number,headers=all)=>request('PUT',`${base}/connections/${connection.id}/history-days`,{days},headers)
  assert.equal((await db.query('SELECT history_days FROM integration_1688_perf_connections WHERE id=$1',[connection.id])).rows[0].history_days,30)
  assert.equal((await historyDays(45)).statusCode,400);assert.equal((await historyDays(7,token(admin,['performance:read']))).statusCode,403)
  assert.equal((await historyDays(7)).statusCode,200)
  assert.equal((await request('POST',`${base}/connections/${connection.id}/sync`,{scopeDays:3})).statusCode,400,'scope is today / 7 / 30 days only')

  // Manual trigger: one active run per shop.
  const queued=await request('POST',`${base}/connections/${connection.id}/sync`,{});assert.equal(queued.statusCode,202,queued.body)
  assert.equal((await request('POST',`${base}/connections/${connection.id}/sync`,{})).statusCode,409)
  assert.equal((await request('POST',`${base}/connections/${connection.id}/sync`,{},token(admin,['performance:read']))).statusCode,403)
  const first=await sync();assert.equal(first.status,'succeeded',JSON.stringify(first))
  assert.equal(first.stats.agents,3);assert.equal(first.stats.truncatedDays,1,'a day past the cap is reported, not split');assert.equal(first.stats.throttled,1);assert.equal(first.stats.failedSessions,undefined)

  // Agent text: analysed and masked before saving; buyer text (masked by the platform) is never kept.
  const texts=Object.fromEntries((await db.query('SELECT uuid,text_masked,char_count,flags FROM perf_chat_messages WHERE connection_id=$1',[connection.id])).rows.map(r=>[r.uuid,r]))
  assert.deepEqual([texts.m6.text_masked,texts.m6.flags.sort()],['加我微信 ****** 发你实拍，电话 1**********',['phone','wechat']],'contact details masked before saving')
  assert.deepEqual([texts.m9.flags,texts.n2.flags,texts.n2.char_count,texts.m4.flags],[['curt'],['short'],2,[]])
  assert.deepEqual([texts.m1.text_masked,texts.m1.char_count,texts.m3.text_masked],[null,null,'x'],'buyer text is not stored; auto replies keep their (masked) text')
  assert.equal((await db.query("SELECT count(*)::int AS n FROM perf_chat_messages WHERE connection_id=$1 AND text_masked ~ '1[3-9][0-9]{9}|abc_12345'",[connection.id])).rows[0].n,0)
  const offerRow=(await db.query("SELECT text_masked,linked_offer_ids FROM perf_chat_messages WHERE connection_id=$1 AND uuid='m4'",[connection.id])).rows[0]
  assert.deepEqual(offerRow,{text_masked:'亲，这款现货，48 小时内发货 https://detail.1688.com/offer/######.html',linked_offer_ids:['712345678901']},'offer id kept separately, stored text stays masked')
  const quality=(await request('GET',`${base}/quality?connectionId=${connection.id}&from=${D}&to=${D}`)).json().data
  const qa=Object.fromEntries(quality.agents.map((a:{login_id:string})=>[a.login_id,a]))
  assert.deepEqual([qa['shop:a'].messages,qa['shop:a'].offsite,qa['shop:a'].short_replies,qa['shop:a'].curt,qa.shop.curt],[3,1,1,0,1],'auto replies are not counted as manual messages')
  assert.deepEqual(quality.risks.map((r:{uuid:string;flags:string[]})=>r.uuid),['m6']);assert.equal(quality.totals.offsite,1);assert.equal(quality.coverage,1)
  assert.match(quality.risks[0].text_masked,/\*{6}/);assert.equal(quality.curt[0].uuid,'m9')
  const riskSession=quality.risks[0].session_id
  const timeline=(await request('GET',`${base}/chats/${riskSession}/messages`)).json().data.messages
  assert.ok(timeline.some((m:{uuid:string;text_masked:string|null})=>m.uuid==='m6'&&m.text_masked?.includes('******')))
  assert.equal((await request('GET',`${base}/quality?connectionId=${connection.id}&from=${D}&to=${D}`,undefined,token(admin,['*'],tenantIds[1]))).statusCode,404)

  // Agents: main + sub-accounts. Sessions: per agent x cid x day. Messages: only the agent's own view, only that day.
  const agents=(await request('GET',`${base}/agents?connectionId=${connection.id}`)).json().data as {id:string;login_id:string;is_main:boolean;binding_revision:number}[]
  assert.deepEqual(agents.map(a=>[a.login_id,a.is_main]),[['shop',true],['shop:a',false],['shop:b',false]])
  const byLogin=Object.fromEntries(agents.map(a=>[a.login_id,a]))
  const stored=(await db.query(`SELECT a.login_id,s.cid,s.chat_date::text AS chat_date,s.buyer_messages,s.agent_messages,s.auto_replies,s.transferred,array_agg(m.uuid ORDER BY m.sent_at) AS uuids
    FROM perf_chat_sessions s JOIN perf_agents a ON a.id=s.agent_id JOIN perf_chat_messages m ON m.session_id=s.id WHERE s.connection_id=$1 GROUP BY 1,2,3,4,5,6,7 ORDER BY 1,2`,[connection.id])).rows
  assert.deepEqual(stored,[
    {login_id:'shop',cid:'c1',chat_date:D,buyer_messages:1,agent_messages:1,auto_replies:0,transferred:true,uuids:['m10','m9','m11']},
    {login_id:'shop:a',cid:'c1',chat_date:D,buyer_messages:4,agent_messages:2,auto_replies:1,transferred:false,uuids:['m1','m2','m3','m4','m5','m6','m7','m8']},
    {login_id:'shop:a',cid:'c2',chat_date:D,buyer_messages:1,agent_messages:1,auto_replies:0,transferred:false,uuids:['n1','n2']},
    {login_id:'shop:b',cid:'c3',chat_date:D,buyer_messages:1,agent_messages:0,auto_replies:0,transferred:false,uuids:['p1','p2']},
  ])
  assert.equal((await db.query("SELECT count(*)::int AS n FROM perf_chat_sessions WHERE connection_id=$1 AND cid='noise'",[connection.id])).rows[0].n,0,'capped pages are discarded, not saved')
  const buyers=(await db.query('SELECT buyer_key,open_uid,taobao_nick FROM perf_buyers WHERE connection_id=$1 ORDER BY buyer_key',[connection.id])).rows
  assert.deepEqual(buyers,[{buyer_key:'A1',open_uid:'O1',taobao_nick:null},{buyer_key:'A3',open_uid:'O3',taobao_nick:null},{buyer_key:'tb:tbuser',open_uid:null,taobao_nick:'tbuser'}],'sub-buyers of one main buyer merge')

  // Metrics with the default 180 s threshold.
  const metrics=async(headers=all,from=D,to=D)=>{const r=await request('GET',`${base}/metrics?connectionId=${connection.id}&from=${from}&to=${to}`,undefined,headers);assert.equal(r.statusCode,200,r.body);return Object.fromEntries((r.json().data as {login_id:string}[]).map(row=>[row.login_id,row])) as Record<string,Record<string,unknown>>}
  const pick=(row:Record<string,unknown>)=>({reception:row.reception,effective:row.effective_reception,first:row.first_response_seconds,avg:row.avg_response_seconds,unanswered:row.unanswered,transfers:row.transfers,auto:row.auto_replies})
  let m=await metrics()
  assert.deepEqual(pick(m['shop:a']),{reception:2,effective:2,first:70,avg:247,unanswered:2,transfers:0,auto:1})
  assert.deepEqual(pick(m.shop),{reception:1,effective:1,first:60,avg:60,unanswered:0,transfers:1,auto:0})
  assert.deepEqual(pick(m['shop:b']),{reception:1,effective:0,first:null,avg:null,unanswered:1,transfers:0,auto:0})
  // Changing the threshold re-scores history without re-syncing.
  const settings=(await request('GET',`${base}/settings`)).json().data
  assert.equal((await request('PUT',`${base}/settings`,{revision:settings.revision,unansweredThresholdSeconds:900})).statusCode,200)
  m=await metrics();assert.equal(m['shop:a'].unanswered,1)
  // Counting agent "其他消息" as replies switches to the precomputed loose turns.
  assert.equal(m['shop:b'].other_agent_messages,1)
  const loose=await request('PUT',`${base}/settings`,{revision:settings.revision+1,countOtherAsReply:true});assert.equal(loose.statusCode,200,loose.body)
  m=await metrics();assert.deepEqual(pick(m['shop:b']),{reception:1,effective:1,first:5,avg:5,unanswered:0,transfers:0,auto:0});assert.equal(m['shop:a'].first_response_seconds,70)
  assert.equal((await request('PUT',`${base}/settings`,{revision:settings.revision+2,countOtherAsReply:false},token(admin,['payroll:manage']))).statusCode,403)
  assert.equal((await request('PUT',`${base}/settings`,{revision:settings.revision+2,countOtherAsReply:false})).statusCode,200)
  const empty=await metrics(all,beijingDay(-10),beijingDay(-9));assert.equal(empty['shop:a'].reception,0)
  assert.ok((await request('GET',`${base}/metrics?connectionId=${connection.id}&from=${D}&to=2099-01-01`)).statusCode>=400,'range limit')

  const hourly=(await request('GET',`${base}/metrics/hourly?connectionId=${connection.id}&from=${D}&to=${D}`)).json().data
  assert.equal(hourly.buckets.length,16);assert.equal(hourly.buckets[0].label,'00:00-09:00')
  const cells=Object.fromEntries((hourly.cells as {agent_id:string;bucket:number;reception:number}[]).map(c=>[`${agents.find(a=>a.id===c.agent_id)!.login_id}@${c.bucket}`,c.reception]))
  assert.deepEqual(cells,{'shop:a@10':1,'shop:a@11':1,'shop:a@14':1,'shop@10':1,'shop:b@0':1})

  // Idempotent: nothing new on the platform means no message calls and no duplicates.
  const before=counts.messages
  assert.ok(await (async()=>{await request('POST',`${base}/connections/${connection.id}/sync`,{});return true})())
  const second=await sync();assert.equal(second.status,'succeeded')
  assert.equal(counts.messages,before,'unchanged sessions are not re-read')
  assert.equal((await db.query('SELECT count(*)::int AS n FROM perf_chat_messages WHERE connection_id=$1',[connection.id])).rows[0].n,15)
  // New activity moves the session time; only that session is re-read from its cursor.
  messages.c2.push({uuid:'n3',self:'shop:a',direction:1,time:at(D,'15:00:00'),types:['正常消息']},{uuid:'n4',self:'shop:a',direction:0,time:at(D,'15:01:00'),types:['正常消息']})
  peers['shop:a'][1].time=ms(at(D,'15:01:00'))
  // As if the previous sync ran at noon that day: the next run re-reads that date from its cursor.
  await db.query('UPDATE perf_agents SET relations_synced_until=$2 WHERE connection_id=$1',[connection.id,new Date(ms(at(D,'12:00:00')))])
  await request('POST',`${base}/connections/${connection.id}/sync`,{})
  assert.equal((await sync()).status,'succeeded')
  const turns=(await db.query("SELECT t.turn_index,extract(epoch FROM t.reply_at-t.turn_at)::int AS seconds FROM perf_chat_turns t JOIN perf_chat_sessions s ON s.id=t.session_id WHERE s.connection_id=$1 AND s.cid='c2' AND t.mode='strict' ORDER BY 1",[connection.id])).rows
  assert.deepEqual(turns,[{turn_index:0,seconds:20},{turn_index:1,seconds:60}])

  // Sessions built by an older algorithm are rebuilt from stored messages without platform calls.
  await db.query("UPDATE perf_chat_sessions SET turns_version=1 WHERE connection_id=$1",[connection.id])
  await db.query("DELETE FROM perf_chat_turns WHERE mode='strict' AND session_id IN (SELECT id FROM perf_chat_sessions WHERE connection_id=$1)",[connection.id])
  const callsBeforeRebuild=counts.messages
  await request('POST',`${base}/connections/${connection.id}/sync`,{})
  const rebuilt=await sync();assert.equal(rebuilt.stats.rebuiltSessions,4);assert.equal(counts.messages,callsBeforeRebuild)
  assert.equal((await db.query("SELECT count(*)::int AS n FROM perf_chat_turns t JOIN perf_chat_sessions s ON s.id=t.session_id WHERE s.connection_id=$1 AND t.mode='strict'",[connection.id])).rows[0].n,7)

  // A 90-day backfill interrupted by a platform error resumes in the next ordinary run without re-reading finished days,
  // and stays inside the platform's retention window.
  failRelationAt=counts.relation+40
  assert.equal((await historyDays(90)).statusCode,200)
  await request('POST',`${base}/connections/${connection.id}/sync`,{})
  const broken=await sync();assert.equal(broken.status,'failed')
  const callsBeforeResume=counts.relation
  await request('POST',`${base}/connections/${connection.id}/sync`,{})
  const full=await sync();assert.equal(full.status,'succeeded',JSON.stringify(full));assert.equal(counts.tooOld,0)
  assert.ok(counts.relation-callsBeforeResume<3*89,'finished days are not read again')
  const reached=(await db.query("SELECT bool_and(relations_synced_from<=now()-interval '89 days')::text AS ok FROM perf_agents WHERE connection_id=$1",[connection.id])).rows[0].ok
  assert.equal(reached,'true','every account reaches the backfill target')
  const feeds=(await db.query("SELECT orders_synced_from<=now()-interval '89 days' AS orders,refunds_synced_from<=now()-interval '89 days' AS refunds FROM integration_1688_perf_connections WHERE id=$1",[connection.id])).rows[0]
  assert.deepEqual(feeds,{orders:true,refunds:true})

  // Scoped run ("today"): reads only today's relation day per account and today's sessions; when the cursor lags behind the
  // window, cursors are left alone so the next full run still fills the gap.
  await db.query("UPDATE perf_agents SET relations_synced_until=now()-interval '3 days' WHERE connection_id=$1",[connection.id])
  await db.query("UPDATE integration_1688_perf_connections SET orders_synced_until=now()-interval '3 days' WHERE id=$1",[connection.id])
  const old=(await db.query(`INSERT INTO perf_chat_sessions(tenant_id,connection_id,agent_id,buyer_id,cid,chat_date,last_peer_at,needs_sync)
    SELECT tenant_id,connection_id,agent_id,buyer_id,'c-old',(now() AT TIME ZONE 'Asia/Shanghai')::date-40,now()-interval '40 days',true FROM perf_chat_sessions WHERE connection_id=$1 LIMIT 1 RETURNING id`,[connection.id])).rows[0].id
  let relationCalls=counts.relation,messageCalls=counts.messages
  assert.equal((await request('POST',`${base}/connections/${connection.id}/sync`,{scopeDays:1})).statusCode,202)
  const today=await sync();assert.equal(today.status,'succeeded',JSON.stringify(today))
  assert.equal(counts.relation-relationCalls,3,'one relation day per account')
  assert.equal(counts.messages,messageCalls,'the 40-day-old session is outside the scope')
  const cursors=(await db.query("SELECT bool_and(relations_synced_until<now()-interval '2 days') AS relations,(SELECT orders_synced_until<now()-interval '2 days' FROM integration_1688_perf_connections WHERE id=$1) AS orders FROM perf_agents WHERE connection_id=$1",[connection.id])).rows[0]
  assert.deepEqual(cursors,{relations:true,orders:true},'scoped run leaves lagging cursors for the full run')
  assert.equal((await request('GET',`${base}/sync-runs?connectionId=${connection.id}`)).json().data[0].scope_days,1)

  // Shrinking the history range keeps synced data but stops filling outside it; a full run catches the cursors up.
  assert.equal((await historyDays(30)).statusCode,200)
  relationCalls=counts.relation;messageCalls=counts.messages
  await request('POST',`${base}/connections/${connection.id}/sync`,{})
  const caughtUp=await sync();assert.equal(caughtUp.status,'succeeded',JSON.stringify(caughtUp))
  assert.equal(counts.messages,messageCalls,'outside the 30-day range: not fetched');assert.ok(counts.relation-relationCalls<=3*5+24,`only the lagging days are read, no history (${counts.relation-relationCalls})`)
  assert.equal((await db.query("SELECT bool_and(relations_synced_until>now()-interval '1 hour')::text AS ok FROM perf_agents WHERE connection_id=$1",[connection.id])).rows[0].ok,'true')
  const status=(await request('GET',`${base}/connections/${connection.id}/sync-status`)).json().data
  assert.equal(status.history_days,30);assert.equal(status.skipped_sessions,1);assert.equal(status.pending_sessions,0);assert.ok(status.calls_today>0)
  assert.equal((await request('GET',`${base}/connections/${connection.id}/sync-status`,undefined,token(admin,['*'],tenantIds[1]))).statusCode,404)
  await db.query("UPDATE perf_chat_sessions SET needs_sync=false WHERE id=$1",[old])

  // Binding: one CRM user per agent account per shop, optimistic revision, same tenant only.
  const bindA=await request('PUT',`${base}/agents/${byLogin['shop:a'].id}/binding`,{userId:agentUser,revision:byLogin['shop:a'].binding_revision});assert.equal(bindA.statusCode,200,bindA.body);assert.equal(bindA.json().data.user_name,'agentA')
  assert.equal((await request('PUT',`${base}/agents/${byLogin['shop:b'].id}/binding`,{userId:agentUser,revision:byLogin['shop:b'].binding_revision})).statusCode,409,'a user binds to one account')
  assert.equal((await request('PUT',`${base}/agents/${byLogin['shop:a'].id}/binding`,{userId:otherUser,revision:byLogin['shop:a'].binding_revision})).statusCode,409,'stale revision')
  assert.equal((await request('PUT',`${base}/agents/${byLogin['shop:b'].id}/binding`,{userId:foreignUser,revision:byLogin['shop:b'].binding_revision})).statusCode,400,'user of another tenant')
  assert.equal((await request('PUT',`${base}/agents/${byLogin['shop:b'].id}/binding`,{userId:otherUser,revision:byLogin['shop:b'].binding_revision},token(admin,['performance:read']))).statusCode,403)
  const bindB=await request('PUT',`${base}/agents/${byLogin['shop:b'].id}/binding`,{userId:otherUser,revision:byLogin['shop:b'].binding_revision});assert.equal(bindB.statusCode,200)
  const unbind=await request('PUT',`${base}/agents/${byLogin['shop:b'].id}/binding`,{userId:null,revision:bindB.json().data.binding_revision});assert.equal(unbind.statusCode,200);assert.equal(unbind.json().data.user_id,null)
  assert.equal((await db.query("SELECT count(*)::int AS n FROM audit_logs WHERE tenant_id=$1 AND action LIKE 'performance.agent.%'",[tenantId])).rows[0].n,3)

  // Own-data scope: an agent sees only the accounts bound to them.
  const own=token(agentUser,['performance:read_own'])
  assert.deepEqual(Object.keys(await metrics(own)),['shop:a'])
  assert.deepEqual(((await request('GET',`${base}/agents?connectionId=${connection.id}`,undefined,own)).json().data as {login_id:string}[]).map(a=>a.login_id),['shop:a'])
  assert.equal((await request('GET',`${base}/sync-runs?connectionId=${connection.id}`,undefined,own)).statusCode,403)
  assert.equal((await request('GET',`${base}/metrics?connectionId=${connection.id}&from=${D}&to=${D}`,undefined,token(agentUser,[]))).statusCode,403)

  // Working hours: an inquiry before opening starts its clock at opening; a turn still open at night takes the agent's first reply
  // the next day and is clocked from the next opening. Without working hours the raw wait counts.
  const nightAgent=(await db.query("INSERT INTO perf_agents(tenant_id,connection_id,login_id,is_main) VALUES($1,$2,'shop:night',false) RETURNING id",[tenantIds[0],connection.id])).rows[0].id
  const anyBuyer=(await db.query('SELECT id FROM perf_buyers WHERE connection_id=$1 LIMIT 1',[connection.id])).rows[0].id
  const nightSessions:Record<string,string>={}
  for(const day of [D,nextD])nightSessions[day]=(await db.query('INSERT INTO perf_chat_sessions(tenant_id,connection_id,agent_id,buyer_id,cid,chat_date,last_peer_at) VALUES($1,$2,$3,$4,$5,$6,now()) RETURNING id',[tenantIds[0],connection.id,nightAgent,anyBuyer,'night',day])).rows[0].id
  for(const [day,uuid,direction,time] of [[D,'w1',1,'07:00:00'],[D,'w2',0,'09:01:00'],[D,'w3',1,'23:00:00'],[nextD,'w4',0,'09:02:00']] as const)
    await db.query("INSERT INTO perf_chat_messages(tenant_id,connection_id,session_id,uuid,direction,sent_at,length,message_types,keywords) VALUES($1,$2,$3,$4,$5,$6,1,ARRAY['正常消息'],'[]')",[tenantIds[0],connection.id,nightSessions[day],uuid,direction,new Date(ms(at(day,time)))])
  for(const id of Object.values(nightSessions))await rebuildSession(id,tenantIds[0])
  let current=(await request('GET',`${base}/settings`)).json().data
  assert.deepEqual([current.work_hours_enabled,current.work_start,current.work_end],[true,'09:00','22:00'],'default working hours')
  current=(await request('PUT',`${base}/settings`,{revision:current.revision,unansweredThresholdSeconds:180})).json().data
  let night=(await metrics())['shop:night']
  assert.deepEqual([night.first_response_seconds,night.avg_response_seconds,night.unanswered],[60,90,0])
  assert.equal((await request('PUT',`${base}/settings`,{revision:current.revision,workStart:'23:00',workEnd:'22:00'})).statusCode,400,'start must precede end')
  assert.equal((await request('PUT',`${base}/settings`,{revision:current.revision,workHoursEnabled:false},token(admin,['performance:read']))).statusCode,403)
  current=(await request('PUT',`${base}/settings`,{revision:current.revision,workHoursEnabled:false})).json().data
  night=(await metrics())['shop:night']
  assert.deepEqual([night.first_response_seconds,night.avg_response_seconds,night.unanswered],[7260,21690,2])
  const chats=(await request('GET',`${base}/chats?connectionId=${connection.id}&from=${D}&to=${D}&agentId=${nightAgent}`)).json().data as {first_response_seconds:number;unanswered:number}[]
  assert.deepEqual(chats.map(c=>[c.first_response_seconds,c.unanswered]),[[7260,2]])
  current=(await request('PUT',`${base}/settings`,{revision:current.revision,workHoursEnabled:true,workStart:'08:00',workEnd:'24:00'})).json().data
  assert.deepEqual([current.work_start,current.work_end],['08:00','24:00'])
  night=(await metrics())['shop:night']
  assert.deepEqual([night.first_response_seconds,night.avg_response_seconds],[3660,(3660+36120)/2])

  // Tenant isolation and inactive connections.
  assert.equal((await request('GET',`${base}/metrics?connectionId=${connection.id}&from=${D}&to=${D}`,undefined,token(foreignUser,['*'],tenantIds[1]))).statusCode,404)
  assert.equal((await request('POST',`${base}/connections/${connection.id}/sync`,{},token(foreignUser,['*'],tenantIds[1]))).statusCode,404)
  const runs=(await request('GET',`${base}/sync-runs?connectionId=${connection.id}`)).json().data as {status:string}[]
  assert.equal(runs.length,8,'six earlier runs plus the scoped and catch-up runs');assert.equal(runs.filter(r=>r.status==='failed').length,1);

  // Call savers. (1) An unchanged session of today is not re-read: only sessions whose relation time moved are fetched.
  const todaySession=(await db.query(`INSERT INTO perf_chat_sessions(tenant_id,connection_id,agent_id,buyer_id,cid,chat_date,last_peer_at,needs_sync,messages_synced_at)
    SELECT tenant_id,connection_id,agent_id,buyer_id,'c-today',(now() AT TIME ZONE 'Asia/Shanghai')::date,now()-interval '3 hours',false,now()-interval '3 hours' FROM perf_chat_sessions WHERE connection_id=$1 LIMIT 1 RETURNING id`,[connection.id])).rows[0].id
  await db.query('UPDATE perf_chat_sessions SET needs_sync=false WHERE connection_id=$1',[connection.id])
  let mark=counts.messages
  await request('POST',`${base}/connections/${connection.id}/sync`,{});assert.equal((await sync()).status,'succeeded')
  assert.equal(counts.messages,mark,'no hourly re-fetch of unchanged sessions')
  await db.query('DELETE FROM perf_chat_sessions WHERE id=$1',[todaySession])
  // (2) An account without a session in 7 days is polled by the scheduler at most every two hours; manual runs poll it.
  await db.query("UPDATE perf_chat_sessions SET chat_date=chat_date-10 WHERE agent_id=$1",[byLogin['shop:b'].id])
  const relationCallsFor=async(trigger:'schedule'|'manual')=>{
    await db.query("UPDATE perf_agents SET relations_synced_until=now()-interval '1 hour' WHERE connection_id=$1",[connection.id])
    mark=counts.relation;await enqueuePerformanceSync(tenantId,connection.id,null,trigger)
    const r=await sync();assert.equal(r.status,'succeeded',JSON.stringify(r));return {calls:counts.relation-mark,skipped:r.stats.idleSkipped??0}
  }
  assert.deepEqual(await relationCallsFor('schedule'),{calls:2,skipped:1},'idle shop:b skipped, shop and shop:a read today')
  assert.deepEqual(await relationCallsFor('manual'),{calls:3,skipped:0},'a manual run polls every account')
  await db.query("UPDATE perf_agents SET relations_synced_until=now()-interval '3 hours' WHERE id=$1",[byLogin['shop:b'].id])
  mark=counts.relation;await enqueuePerformanceSync(tenantId,connection.id,null,'schedule')
  assert.equal((await sync()).stats.idleSkipped,undefined,'after two hours the idle account is polled again');assert.ok(counts.relation-mark>=3)
  await db.query("UPDATE perf_chat_sessions SET chat_date=chat_date+10 WHERE agent_id=$1",[byLogin['shop:b'].id])

  // Messages synced before text capture get their text when the session is read again; text older than 90 days is dropped.
  const m6Session=(await db.query("SELECT session_id FROM perf_chat_messages WHERE connection_id=$1 AND uuid='m6'",[connection.id])).rows[0].session_id
  await db.query("UPDATE perf_chat_messages SET text_masked=NULL,char_count=NULL,flags='{}' WHERE connection_id=$1 AND uuid='m6'",[connection.id])
  // A message whose text was captured (and later purged) before offer ids existed: the id returns, the purged text does not.
  await db.query("UPDATE perf_chat_messages SET text_masked=NULL,linked_offer_ids='{}' WHERE connection_id=$1 AND uuid='m4'",[connection.id])
  await db.query("UPDATE perf_chat_sessions SET needs_sync=true,message_cursor=NULL WHERE id=$1",[m6Session])
  const oldText=(await db.query(`INSERT INTO perf_chat_messages(tenant_id,connection_id,session_id,uuid,direction,sent_at,text_masked,char_count,flags) VALUES($1,$2,$3,'old-1',0,now()-interval '91 days','很久以前的回复',6,'{phone}') RETURNING id`,[tenantId,connection.id,m6Session])).rows[0].id
  await request('POST',`${base}/connections/${connection.id}/sync`,{});const refill=await sync();assert.equal(refill.status,'succeeded',JSON.stringify(refill))
  assert.deepEqual((await db.query("SELECT flags FROM perf_chat_messages WHERE connection_id=$1 AND uuid='m6'",[connection.id])).rows[0].flags.sort(),['phone','wechat'],'text filled in on re-read')
  assert.equal(refill.stats.messages??0,0,'refilling text does not count as new messages')
  assert.deepEqual((await db.query("SELECT text_masked,linked_offer_ids FROM perf_chat_messages WHERE connection_id=$1 AND uuid='m4'",[connection.id])).rows[0],{text_masked:null,linked_offer_ids:['712345678901']},'offer id filled in on re-read, purged text stays purged')
  assert.deepEqual((await db.query('SELECT text_masked,flags FROM perf_chat_messages WHERE id=$1',[oldText])).rows[0],{text_masked:null,flags:['phone']},'text purged after 90 days, flags kept')
  await db.query('DELETE FROM perf_chat_messages WHERE id=$1',[oldText])

  await db.query("UPDATE integration_1688_perf_connections SET status='disabled' WHERE id=$1",[connection.id])
  assert.equal((await request('POST',`${base}/connections/${connection.id}/sync`,{})).statusCode,409)

  console.log(JSON.stringify({agentsIncludeMain:'ok',dayWindows:'ok',selfLoginIdOwnership:'ok',dayBoundary:'ok',buyerMerge:'ok',turns:'ok',metrics:'ok',thresholdRescore:'ok',hourly:'ok',idempotent:'ok',incremental:'ok',binding:'ok',ownScope:'ok',tenantIsolation:'ok',retention90:'ok',resumableBackfill:'ok',historyRange:'ok',scopedRun:'ok',noRefetch:'ok',idlePolling:'ok',agentText:'ok',replyQuality:'ok',textRetention:'ok',workHours:'ok',qosBackoff:'ok',relationCalls:counts.relation,messageCalls:counts.messages,livePlatformCalls:0}))
}finally{
  globalThis.fetch=originalFetch
  for(const id of tenantIds){await db.query('DELETE FROM audit_logs WHERE tenant_id=$1',[id]);await db.query('DELETE FROM tenants WHERE id=$1',[id])}
  await app.close();await db.end()
}
