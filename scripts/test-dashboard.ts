import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { buildApp } from '../server/app.js'
import { db } from '../server/db.js'
import { saveConnection } from '../server/integrations/1688.js'
import { ensureOrderBuyers, refreshCustomerStats, resolveBuyer } from '../server/integrations/customer-ops.js'

// Home dashboard over seeded mirror tables: every figure below is worked out by hand from the fixture.
const originalFetch=globalThis.fetch
globalThis.fetch=async()=>{throw new Error('no network in this suite')}
const marker=randomUUID(),tenantIds:string[]=[]
const app=await buildApp()
const HOUR=3_600_000,DAY=24*HOUR
const beijingDate=(offset:number)=>new Date(Date.now()+8*HOUR+offset*DAY).toISOString().slice(0,10)
// Noon Beijing time `offset` days from today: stays on that calendar date whatever the current hour.
const noon=(offset:number)=>new Date(`${beijingDate(offset)}T12:00:00+08:00`)

try{
  for(let i=0;i<2;i++)tenantIds.push((await db.query('INSERT INTO tenants(name,slug)VALUES($1,$2)RETURNING id',['dashboard test',`test-dashboard-${marker}-${i}`])).rows[0].id)
  const tenantId=tenantIds[0]
  const admin=(await db.query("INSERT INTO users(tenant_id,email,password_hash,display_name,status)VALUES($1,$2,'unused','admin','active')RETURNING id",[tenantId,`dash-${marker}@integration.local`])).rows[0].id
  const headers=(permissions:string[],tenant=tenantId)=>({authorization:`Bearer ${app.jwt.sign({sub:admin,tenantId:tenant,email:'t',displayName:'t',roles:[],permissions})}`})
  const get=async(query:string,h=headers(['*']))=>{const r=await app.inject({method:'GET',url:`/api/dashboard${query}`,headers:h});return r}
  const c=await saveConnection(tenantId,admin,{access_token:'d',refresh_token:'d',expires_in:36000,aliId:`dash-${marker}`,resource_owner:'shop',refresh_token_timeout:'20990101000000000+0800'},Date.now(),'performance')
  await db.query("UPDATE integration_1688_perf_connections SET status='disabled' WHERE id=$1",[c.id])
  const agent=(await db.query("INSERT INTO perf_agents(tenant_id,connection_id,login_id,is_main) VALUES($1,$2,'shop',true) RETURNING id",[tenantId,c.id])).rows[0].id
  let seq=0
  const order=(buyer:string,placed:Date,paid:Date|null,amount:number)=>db.query(`INSERT INTO perf_orders(tenant_id,connection_id,order_id,buyer_open_uid,status,total_amount,placed_at,paid_at,items) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'[]') RETURNING order_id`,
    [tenantId,c.id,String(7000+seq++),buyer,paid?'success':'waitbuyerpay',amount,placed,paid])
  const chat=(buyerId:string,offset:number)=>db.query(`INSERT INTO perf_chat_sessions(tenant_id,connection_id,agent_id,buyer_id,cid,chat_date,last_peer_at,needs_sync,buyer_messages,agent_messages) VALUES($1,$2,$3,$4,$5,$6::date,now(),false,2,1)`,
    [tenantId,c.id,agent,buyerId,`cid${seq++}`,beijingDate(offset)])
  const buyer=async(key:string)=>(await resolveBuyer(tenantId,c.id,{key,openUid:key,adminOpenUid:null,taobaoNick:null,at:new Date()})).buyerId

  // Period = last 7 Beijing days. A chats 2 days ago and pays an order placed yesterday (converted); B chats and never orders;
  // C pays without chatting; D paid 10 days ago (previous period). A refund of 10 + 2 shipping completes today on A's order.
  const A=await buyer('A'),B=await buyer('B')
  await chat(A,-2);await chat(B,-1)
  const aOrder=(await order('A',noon(-1),noon(-1),100)).rows[0].order_id
  await order('C',noon(0),noon(0),50);await order('D',noon(-10),noon(-10),80)
  await db.query(`INSERT INTO perf_refunds(tenant_id,connection_id,refund_id,order_id,status,refund_amount,refund_carriage,completed_at) VALUES($1,$2,'R1',$3,'refundsuccess',10,2,$4)`,[tenantId,c.id,aOrder,noon(0)])
  await ensureOrderBuyers(c.id);await refreshCustomerStats(c.id)

  const r=await get('?range=7d');assert.equal(r.statusCode,200,r.body)
  const d=r.json().data
  assert.equal(d.connectionId,c.id);assert.deepEqual(d.period,{from:beijingDate(-6),to:beijingDate(0)});assert.deepEqual(d.previous,{from:beijingDate(-13),to:beijingDate(-7)})
  assert.deepEqual(d.kpis.current,{paidAmount:150,paidOrders:2,paidBuyers:2,refundAmount:12,refunds:1,netAmount:138,reception:2,inquired:2,converted:1,conversionRate:0.5})
  assert.deepEqual([d.kpis.previous.paidAmount,d.kpis.previous.paidOrders,d.kpis.previous.reception],[80,1,0])
  assert.equal(d.trend.length,7);assert.deepEqual(d.trend.at(-1),{date:beijingDate(0),paid_amount:50,paid_orders:1,reception:0})
  assert.equal(d.trend.find((t:{date:string})=>t.date===beijingDate(-2)).reception,1)
  assert.deepEqual(d.buyerMix,{first_time:2,returning:0})
  assert.deepEqual([d.service.agents.length,d.service.agents[0].reception],[1,2])
  assert.deepEqual([d.customers.total,d.customers.buyers,d.customers.unpaid],[4,3,0],'A, B, C, D; three have paid')
  assert.deepEqual(d.listings,{queue:{},blockedReasons:[],drafts:0,listings:{},collected:0})
  assert.equal(d.sync.pending_sessions,0)

  // "Today" compares with yesterday and still returns 30 days of trend for context.
  const today=(await get('?range=today')).json().data
  assert.deepEqual([today.kpis.current.paidAmount,today.kpis.previous.paidAmount,today.trend.length],[50,100,30])

  // Sections follow permissions: a customer-only user gets no sales or listing data.
  const custOnly=(await get('',headers(['customer_ops:read']))).json().data
  assert.deepEqual(custOnly.sections,{performance:false,customers:true,listings:false})
  assert.equal(custOnly.kpis,undefined);assert.equal(custOnly.listings,undefined);assert.equal(custOnly.customers.total,4)
  const nothing=(await get('',headers([]))).json().data
  assert.deepEqual([nothing.shops,nothing.kpis,nothing.customers],[[],undefined,undefined])
  // Isolation: another tenant cannot read this shop.
  assert.equal((await get(`?connectionId=${c.id}`,headers(['*'],tenantIds[1]))).statusCode,404)
  assert.equal((await app.inject({method:'GET',url:'/api/dashboard'})).statusCode,401)

  console.log(JSON.stringify({kpis:'ok',previousPeriod:'ok',refundWithShipping:'ok',conversion:'ok',trend:'ok',buyerMix:'ok',customers:'ok',permissions:'ok',isolation:'ok'}))
}finally{
  globalThis.fetch=originalFetch
  for(const id of tenantIds){await db.query('DELETE FROM audit_logs WHERE tenant_id=$1',[id]);await db.query('DELETE FROM tenants WHERE id=$1',[id])}
  await app.close();await db.end()
}
