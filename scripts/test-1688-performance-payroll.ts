import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { buildApp } from '../server/app.js'
import { db } from '../server/db.js'
import { saveConnection } from '../server/integrations/1688.js'
import { rebuildSession } from '../server/integrations/1688-performance-sync.js'
import { computeAttributions } from '../server/integrations/1688-performance-orders.js'
import { commissionFor, scoreKpi } from '../server/integrations/1688-performance-payroll.js'

// No platform calls: data is seeded straight into the mirror tables with hand-checkable numbers for 2026-09.
const originalFetch=globalThis.fetch
globalThis.fetch=async()=>{throw new Error('no network in this suite')}
const marker=randomUUID(),tenantIds:string[]=[]
const app=await buildApp()
const bj=(text:string)=>new Date(`${text}+08:00`)

try{
  // Pure KPI scoring: value/max for higher-is-better, min/value for lower-is-better, ties share a rank.
  const row=(id:string,reception:number,paid:number,avg:number|null)=>({agent_id:id,reception,paid_amount:paid,avg_response_seconds:avg,orders:paid?1:0} as never)
  const pure=scoreKpi([row('a',2,1500,30),row('b',1,200,300),row('c',1,0,null),row('idle',0,0,null)],[{metric:'paid_amount',weight:50},{metric:'avg_response_seconds',weight:50}])
  assert.deepEqual(pure.map(r=>[r.agent_id,r.score,r.rank]),[['a',100,1],['b',11.65,2],['c',0,3]],'inactive agents are not ranked')
  assert.deepEqual(scoreKpi([row('x',1,100,10),row('y',1,100,10)],[{metric:'paid_amount',weight:1}]).map(r=>r.rank),[1,1])

  for(let i=0;i<2;i++)tenantIds.push((await db.query('INSERT INTO tenants(name,slug)VALUES($1,$2)RETURNING id',['1688 payroll test',`test-1688-perfpay-${marker}-${i}`])).rows[0].id)
  const tenantId=tenantIds[0]
  const user=async(name:string)=>(await db.query("INSERT INTO users(tenant_id,email,password_hash,display_name,status)VALUES($1,$2,'unused',$3,'active')RETURNING id",[tenantId,`${name}-${marker}@integration.local`,name])).rows[0].id as string
  const admin=await user('admin'),financeUser=await user('finance'),manager=await user('manager')
  const headers=(sub:string,permissions:string[],tenant=tenantId)=>({authorization:`Bearer ${app.jwt.sign({sub,tenantId:tenant,email:'t',displayName:'t',roles:[],permissions})}`})
  const all=headers(admin,['*']),finance=headers(financeUser,['performance:read','payroll:read','payroll:manage']),mgr=headers(manager,['performance:read','performance:manage']),viewer=headers(manager,['performance:read','payroll:read'])
  const request=(method:'GET'|'POST'|'PUT'|'DELETE',url:string,payload?:object,h=all)=>app.inject({method,url,headers:h,...(payload?{payload}:{})})
  const base='/api/integrations/1688/performance'
  const c=await saveConnection(tenantId,admin,{access_token:'pay',refresh_token:'pay',expires_in:36000,aliId:`pay-${marker}`,resource_owner:'shop',refresh_token_timeout:'20990101000000000+0800'},Date.now(),'performance')
  // Disabled so no background sync can touch it.
  await db.query("UPDATE integration_1688_perf_connections SET status='disabled',account_role='main' WHERE id=$1",[c.id])
  const agent=async(login:string,main=false)=>(await db.query("INSERT INTO perf_agents(tenant_id,connection_id,login_id,is_main) VALUES($1,$2,$3,$4) RETURNING id",[tenantId,c.id,login,main])).rows[0].id as string
  const main=await agent('shop',true),a=await agent('shop:a'),b=await agent('shop:=1+1')
  let seq=0
  const chat=async(agentId:string,buyer:string,date:string,messages:[0|1,string][])=>{
    const buyerId=(await db.query("INSERT INTO perf_buyers(tenant_id,connection_id,buyer_key,open_uid) VALUES($1,$2,$3,$3) ON CONFLICT(connection_id,buyer_key) DO UPDATE SET open_uid=excluded.open_uid RETURNING id",[tenantId,c.id,buyer])).rows[0].id
    await db.query('INSERT INTO perf_buyer_identities(connection_id,open_uid,buyer_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[c.id,buyer,buyerId])
    const s=(await db.query("INSERT INTO perf_chat_sessions(tenant_id,connection_id,agent_id,buyer_id,cid,chat_date,last_peer_at,needs_sync) VALUES($1,$2,$3,$4,$5,$6,now(),false) RETURNING id",[tenantId,c.id,agentId,buyerId,`cid${seq++}`,date])).rows[0].id
    for(const [direction,time] of messages)await db.query("INSERT INTO perf_chat_messages(tenant_id,connection_id,session_id,uuid,direction,sent_at,message_types) VALUES($1,$2,$3,$4,$5,$6,'{正常消息}')",[tenantId,c.id,s,`u${seq++}`,direction,bj(`${date}T${time}`)])
    await rebuildSession(s,tenantId)
  }
  const order=async(id:string,buyer:string,placed:string,paid:string,amount:number)=>db.query("INSERT INTO perf_orders(tenant_id,connection_id,order_id,buyer_open_uid,status,total_amount,placed_at,paid_at) VALUES($1,$2,$3,$4,'success',$5,$6,$7)",[tenantId,c.id,id,buyer,amount,bj(placed),bj(paid)])
  const refund=async(id:string,orderId:string,amount:number,completed:string)=>db.query("INSERT INTO perf_refunds(tenant_id,connection_id,refund_id,order_id,status,refund_amount,completed_at) VALUES($1,$2,$3,$4,'refundsuccess',$5,$6)",[tenantId,c.id,id,orderId,amount,bj(completed)])
  await chat(a,'B1','2026-08-30',[[1,'09:00:00'],[0,'09:00:30']]); await order('O0','B1','2026-08-30T10:00:00','2026-08-30T10:05:00',300)
  await chat(a,'B1','2026-09-10',[[1,'10:00:00'],[0,'10:00:30']]); await order('O1','B1','2026-09-10T11:00:00','2026-09-10T11:10:00',1000)
  await chat(a,'B2','2026-09-10',[[1,'11:30:00'],[0,'11:30:30']]); await order('O2','B2','2026-09-10T12:00:00','2026-09-10T12:05:00',500)
  await chat(b,'B3','2026-09-11',[[1,'10:00:00'],[0,'10:05:00']]); await order('O3','B3','2026-09-11T11:00:00','2026-09-11T11:05:00',200)
  await chat(main,'B4','2026-09-12',[[1,'10:00:00']])
  await refund('R1','O1',100,'2026-09-20T10:00:00'); await refund('R0','O0',50,'2026-09-02T10:00:00'); await refund('R9','O1',999,'2026-10-02T10:00:00')
  await computeAttributions({tenantId,connectionId:c.id,backfillFrom:null,stats:{},call:async()=>({}),heartbeat:async()=>{}})

  // ---- P4: KPI scheme and ranking ----
  const kpi=await request('GET',`${base}/kpi`);assert.equal(kpi.statusCode,200);assert.equal(kpi.json().data.revision,0);assert.ok(kpi.json().data.metrics.length>=8)
  assert.equal((await request('PUT',`${base}/kpi`,{revision:0,items:[{metric:'paid_amount',weight:50}]},finance)).statusCode,403,'finance does not edit KPI weights')
  assert.ok((await request('PUT',`${base}/kpi`,{revision:0,items:[{metric:'paid_amount',weight:50},{metric:'paid_amount',weight:10}]},mgr)).statusCode>=400)
  const savedKpi=await request('PUT',`${base}/kpi`,{revision:0,items:[{metric:'paid_amount',weight:50},{metric:'avg_response_seconds',weight:50}]},mgr);assert.equal(savedKpi.statusCode,200,savedKpi.body)
  assert.equal((await request('PUT',`${base}/kpi`,{revision:0,items:[{metric:'reception',weight:1}]},mgr)).statusCode,409)
  const ranking=await request('GET',`${base}/kpi/ranking?connectionId=${c.id}&from=2026-09-01&to=2026-09-30`);assert.equal(ranking.statusCode,200,ranking.body)
  assert.deepEqual(ranking.json().data.map((r:{login_id:string;score:number;rank:number})=>[r.login_id,r.score,r.rank]),[['shop:a',100,1],['shop:=1+1',11.65,2],['shop',0,3]])
  assert.equal(ranking.json().data[0].values.paid_amount,1500)

  // ---- P4: favorites and CSV export ----
  assert.deepEqual((await request('GET',`${base}/favorites`)).json().data.metrics,[])
  assert.ok((await request('PUT',`${base}/favorites`,{metrics:['reception','bogus']})).statusCode>=400)
  assert.equal((await request('PUT',`${base}/favorites`,{metrics:['paid_amount','reception']})).statusCode,200)
  assert.deepEqual((await request('GET',`${base}/favorites`)).json().data.metrics,['paid_amount','reception'])
  assert.deepEqual((await request('GET',`${base}/favorites`,undefined,mgr)).json().data.metrics,[],'favorites are per user')
  const csv=await request('GET',`${base}/metrics/export?connectionId=${c.id}&from=2026-09-01&to=2026-09-30&columns=paid_amount,reception`)
  assert.equal(csv.statusCode,200);assert.match(String(csv.headers['content-type']),/text\/csv/);assert.ok(csv.body.startsWith('﻿'))
  const csvLines=csv.body.slice(1).split('\r\n')
  assert.equal(csvLines[0],'客服,平台账号,绩效销售额（元）,总接待人数')
  assert.ok(csvLines.includes(`"'=1+1","'shop:=1+1",200.00,1`)||csvLines.includes(`"'=1+1",shop:=1+1,200.00,1`),`formula cells are neutralised: ${csvLines.join(' | ')}`)

  // ---- P5: pay rules (finance only) ----
  assert.equal((await request('GET',`${base}/pay-settings?connectionId=${c.id}`,undefined,mgr)).statusCode,403,'salary data is finance-only')
  const rules={connectionId:c.id,revision:0,rankBonuses:[150,50],defaultRule:{baseSalary:3000,commissionRate:0.01},rules:[{agentId:a,baseSalary:3500,commissionRate:0.02}]}
  assert.equal((await request('PUT',`${base}/pay-settings`,rules,viewer)).statusCode,403)
  assert.equal((await request('PUT',`${base}/pay-settings`,{...rules,rules:[{agentId:randomUUID(),baseSalary:1,commissionRate:0}]},finance)).statusCode,400)
  assert.equal((await request('PUT',`${base}/pay-settings`,rules,finance)).statusCode,200)
  assert.equal((await request('PUT',`${base}/pay-settings`,rules,finance)).statusCode,409,'stale revision')
  const paySettings=(await request('GET',`${base}/pay-settings?connectionId=${c.id}`,undefined,viewer)).json().data
  assert.deepEqual([paySettings.rankBonuses,paySettings.defaultRule.base_salary,paySettings.rules[0].commission_rate],[[150,50],3000,0.02])

  // ---- P5: payroll ----
  assert.equal((await request('POST',`${base}/payroll`,{connectionId:c.id,month:'2099-01'},finance)).statusCode,400,'no future months')
  assert.equal((await request('POST',`${base}/payroll`,{connectionId:c.id,month:'2026-09'},viewer)).statusCode,403)
  const created=await request('POST',`${base}/payroll`,{connectionId:c.id,month:'2026-09'},finance);assert.equal(created.statusCode,201,created.body)
  const period=created.json().data
  const line=(data:{lines:{login_id:string}[]},login:string)=>data.lines.find(l=>l.login_id===login) as unknown as Record<string,number>
  const pick=(l:Record<string,number>)=>[l.base_salary,l.paid_amount,l.refund_amount,l.commission,l.kpi_rank,l.kpi_bonus,l.adjustments,l.total]
  // shop:a: (1500 paid - 150 refunds completed in Sept, including the August order) x 2% = 27; rank 1 bonus 150. October refund excluded.
  assert.deepEqual(pick(line(period,'shop:a')),[3500,1500,150,27,1,150,0,3677])
  assert.deepEqual(pick(line(period,'shop:=1+1')),[3000,200,0,2,2,50,0,3052])
  assert.deepEqual(pick(line(period,'shop')),[3000,0,0,0,3,0,0,3000])
  assert.equal(period.scheme,'order_first');assert.deepEqual(period.basis.rankBonuses,[150,50])

  const reward=await request('POST',`${base}/payroll/${period.id}/adjustments`,{revision:period.revision,agentId:b,amount:200,reason:'好评奖励'},finance);assert.equal(reward.statusCode,201,reward.body)
  assert.equal(line(reward.json().data,'shop:=1+1').total,3252)
  assert.equal((await request('POST',`${base}/payroll/${period.id}/adjustments`,{revision:period.revision,agentId:main,amount:-100,reason:'迟到'},finance)).statusCode,409,'stale revision')
  const penalty=await request('POST',`${base}/payroll/${period.id}/adjustments`,{revision:reward.json().data.revision,agentId:main,amount:-100,reason:'迟到'},finance);assert.equal(penalty.statusCode,201)
  assert.equal(line(penalty.json().data,'shop').total,2900)
  const detail=(await request('GET',`${base}/payroll/${period.id}`,undefined,viewer)).json().data
  assert.equal(detail.adjustments.length,2)
  const removed=await request('DELETE',`${base}/payroll/${period.id}/adjustments/${detail.adjustments[1].id}?revision=${detail.revision}`,undefined,finance);assert.equal(removed.statusCode,200,removed.body)
  assert.equal(line(removed.json().data,'shop').total,3000)

  // Rule changes apply on recalculation of a draft.
  const latestRules=(await request('GET',`${base}/pay-settings?connectionId=${c.id}`,undefined,finance)).json().data
  await request('PUT',`${base}/pay-settings`,{...rules,revision:latestRules.revision,rankBonuses:[300]},finance)
  const recalculated=await request('POST',`${base}/payroll/${period.id}/recalculate`,{revision:removed.json().data.revision},finance);assert.equal(recalculated.statusCode,200)
  assert.deepEqual([line(recalculated.json().data,'shop:a').kpi_bonus,line(recalculated.json().data,'shop:=1+1').kpi_bonus],[300,0])

  // Line detail: the orders and refunds behind shop:a.
  const items=(await request('GET',`${base}/payroll/${period.id}/lines/${a}`,undefined,viewer)).json().data
  assert.deepEqual(items.orders.map((o:{order_id:string})=>o.order_id),['O1','O2']);assert.deepEqual(items.refunds.map((r:{refund_id:string})=>r.refund_id),['R0','R1'])

  // ---- P11: tiered commission and zero floor ----
  const flat={mode:'flat' as const,style:'progressive' as const,tiers:[],floorZero:false}
  const bands=[{from:0,rate:0.01},{from:1000,rate:0.03},{from:5000,rate:0.05}]
  assert.equal(commissionFor(1350,0.02,flat).commission,27)
  assert.deepEqual(commissionFor(6000,0,{...flat,mode:'tiered',tiers:bands}).detail.bands.map(b=>[b.from,b.amount,b.rate]),[[0,1000,0.01],[1000,4000,0.03],[5000,1000,0.05]])
  assert.equal(commissionFor(6000,0,{...flat,mode:'tiered',tiers:bands}).commission,10+120+50,'超额累进')
  assert.equal(commissionFor(6000,0,{...flat,mode:'tiered',style:'whole',tiers:bands}).commission,300,'全额累进')
  assert.equal(commissionFor(1000,0,{...flat,mode:'tiered',style:'whole',tiers:bands}).commission,30,'reaching a threshold exactly counts')
  assert.equal(commissionFor(-500,0.02,flat).commission,-10,'refunds above sales reduce commission by default')
  assert.deepEqual([commissionFor(-500,0.02,{...flat,floorZero:true}).commission,commissionFor(-500,0.02,{...flat,floorZero:true}).detail.floored],[0,true])
  assert.equal(commissionFor(-500,0,{...flat,mode:'tiered',tiers:bands}).commission,-5,'negative net uses the first band')
  let payRev=(await request('GET',`${base}/pay-settings?connectionId=${c.id}`,undefined,finance)).json().data.revision
  const tiered={...rules,rankBonuses:[300],commissionMode:'tiered',tierStyle:'progressive',tiers:[{from:0,rate:0.01},{from:1000,rate:0.03}],floorZero:true}
  assert.equal((await request('PUT',`${base}/pay-settings`,{...tiered,revision:payRev,tiers:[{from:100,rate:0.01}]},finance)).statusCode,400,'bands start at 0')
  assert.equal((await request('PUT',`${base}/pay-settings`,{...tiered,revision:payRev,tiers:[{from:0,rate:0.01},{from:0,rate:0.02}]},finance)).statusCode,400,'bands ascend')
  assert.equal((await request('PUT',`${base}/pay-settings`,{...tiered,revision:payRev,tiers:[]},finance)).statusCode,400,'tiered needs a band')
  assert.equal((await request('PUT',`${base}/pay-settings`,{...tiered,revision:payRev},finance)).statusCode,200)
  const tierSettings=(await request('GET',`${base}/pay-settings?connectionId=${c.id}`,undefined,viewer)).json().data
  assert.deepEqual([tierSettings.commissionMode,tierSettings.tierStyle,tierSettings.tiers,tierSettings.floorZero],['tiered','progressive',[{from:0,rate:0.01},{from:1000,rate:0.03}],true])
  const recalc=async()=>{const r=(await request('GET',`${base}/payroll/${period.id}`,undefined,finance)).json().data;const x=await request('POST',`${base}/payroll/${period.id}/recalculate`,{revision:r.revision},finance);assert.equal(x.statusCode,200,x.body);return x.json().data}
  let tieredRun=await recalc()
  // shop:a net 1350: 1000 x 1% + 350 x 3% = 20.50 (personal 2% rate ignored); shop:=1+1 net 200 x 1% = 2.
  assert.deepEqual([line(tieredRun,'shop:a').commission,line(tieredRun,'shop:a').commission_rate,line(tieredRun,'shop:=1+1').commission],[20.5,0.0152,2])
  assert.equal(line(tieredRun,'shop:a').base_salary,3500,'personal base salary still applies')
  assert.deepEqual((line(tieredRun,'shop:a') as unknown as {commission_detail:{bands:{amount:number}[]}}).commission_detail.bands.map(b=>b.amount),[1000,350])
  assert.deepEqual(tieredRun.basis.commission,{mode:'tiered',style:'progressive',tiers:[{from:0,rate:0.01},{from:1000,rate:0.03}],floorZero:true})
  payRev=(await request('GET',`${base}/pay-settings?connectionId=${c.id}`,undefined,finance)).json().data.revision
  await request('PUT',`${base}/pay-settings`,{...tiered,revision:payRev,tierStyle:'whole'},finance)
  tieredRun=await recalc();assert.equal(line(tieredRun,'shop:a').commission,40.5,'全额: 1350 x 3%')
  // Back to flat rates for the rest of the suite.
  payRev=(await request('GET',`${base}/pay-settings?connectionId=${c.id}`,undefined,finance)).json().data.revision
  await request('PUT',`${base}/pay-settings`,{...rules,revision:payRev,rankBonuses:[300]},finance)
  assert.equal(line(await recalc(),'shop:a').commission,27)

  // Lock: final; no recalculation or adjustments afterwards.
  const current=(await request('GET',`${base}/payroll/${period.id}`,undefined,finance)).json().data
  assert.ok((await request('POST',`${base}/payroll/${period.id}/lock`,{revision:current.revision},finance)).statusCode>=400,'confirmation required')
  const locked=await request('POST',`${base}/payroll/${period.id}/lock`,{revision:current.revision,confirmed:true},finance);assert.equal(locked.statusCode,200,locked.body);assert.equal(locked.json().data.status,'locked')
  const lockedRevision=locked.json().data.revision
  assert.equal((await request('POST',`${base}/payroll/${period.id}/recalculate`,{revision:lockedRevision},finance)).statusCode,409)
  assert.equal((await request('POST',`${base}/payroll/${period.id}/adjustments`,{revision:lockedRevision,agentId:a,amount:1,reason:'x'},finance)).statusCode,409)
  assert.equal((await request('POST',`${base}/payroll`,{connectionId:c.id,month:'2026-09'},finance)).statusCode,409)
  await db.query("UPDATE perf_pay_rules SET base_salary=9999 WHERE connection_id=$1",[c.id])
  assert.equal(line((await request('GET',`${base}/payroll/${period.id}`,undefined,finance)).json().data,'shop:a').base_salary,3500,'locked lines do not follow rule changes')
  const payCsv=await request('GET',`${base}/payroll/${period.id}/export`,undefined,viewer);assert.equal(payCsv.statusCode,200)
  assert.ok(!payCsv.body.includes('3,500.00'),'plain numbers, no thousands separators')
  assert.ok(payCsv.body.split('\r\n').some(l=>l.includes('shop:a')&&l.endsWith(',3827.00')),payCsv.body)
  const list=(await request('GET',`${base}/payroll?connectionId=${c.id}`,undefined,viewer)).json().data;assert.equal(list[0].status,'locked');assert.equal(list[0].month,'2026-09-01')

  // Isolation.
  const other=headers(admin,['*'],tenantIds[1])
  assert.equal((await request('GET',`${base}/payroll/${period.id}`,undefined,other)).statusCode,404)
  assert.equal((await request('GET',`${base}/pay-settings?connectionId=${c.id}`,undefined,other)).statusCode,404)
  assert.equal((await db.query("SELECT count(*)::int AS n FROM audit_logs WHERE tenant_id=$1 AND action LIKE 'payroll.%'",[tenantId])).rows[0].n,8+6,'P11 section: 3 rule saves and 3 recalculations')

  console.log(JSON.stringify({tieredCommission:'ok',floorZero:'ok',kpiScoring:'ok',kpiPermissions:'ok',ranking:'ok',favorites:'ok',csvExport:'ok',formulaInjection:'ok',payRules:'ok',commissionCashBasis:'ok',rankBonus:'ok',adjustments:'ok',recalculate:'ok',lineDetail:'ok',lock:'ok',isolation:'ok',audit:'ok'}))
}finally{
  globalThis.fetch=originalFetch
  for(const id of tenantIds){await db.query('DELETE FROM audit_logs WHERE tenant_id=$1',[id]);await db.query('DELETE FROM tenants WHERE id=$1',[id])}
  await app.close();await db.end()
}
