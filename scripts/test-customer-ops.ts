import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import OSS from 'ali-oss'
import { buildApp } from '../server/app.js'
import { config } from '../server/config.js'
import { db } from '../server/db.js'
import { saveConnection } from '../server/integrations/1688.js'
import { ensureOrderBuyers, refreshCustomerStats, resolveBuyer } from '../server/integrations/customer-ops.js'

// No platform calls: buyers, chats and orders are seeded straight into the mirror tables.
const originalFetch=globalThis.fetch
// OSS is mocked at the client: no bucket is touched. Fixture credentials replace any configured ones.
Object.assign(config,{OSS_REGION:'oss-cn-beijing',OSS_BUCKET:'custops-fixture',OSS_ACCESS_KEY_ID:'fixture-id',OSS_ACCESS_KEY_SECRET:'fixture-secret',OSS_CUSTOM_DOMAIN:undefined})
const objects=new Map<string,Buffer>(),ossProto=OSS.prototype as any,ossOriginal={put:ossProto.put,delete:ossProto.delete,get:ossProto.get}
ossProto.put=async(key:string,bytes:Buffer,options:{headers:Record<string,string>})=>{assert.equal(options.headers['x-oss-object-acl'],'private');assert.equal(options.headers['x-oss-forbid-overwrite'],'true');objects.set(key,bytes);return {}}
ossProto.delete=async(key:string)=>{objects.delete(key);return {}}
ossProto.get=async()=>{throw new Error('not used')}
globalThis.fetch=async()=>{throw new Error('no network in this suite')}
const marker=randomUUID(),tenantIds:string[]=[]
const app=await buildApp()
const daysAgo=(n:number)=>new Date(Date.now()-n*86_400_000)

try{
  for(let i=0;i<2;i++)tenantIds.push((await db.query('INSERT INTO tenants(name,slug)VALUES($1,$2)RETURNING id',['customer ops test',`test-custops-${marker}-${i}`])).rows[0].id)
  const tenantId=tenantIds[0]
  const admin=(await db.query("INSERT INTO users(tenant_id,email,password_hash,display_name,status)VALUES($1,$2,'unused','admin','active')RETURNING id",[tenantId,`custops-${marker}@integration.local`])).rows[0].id
  const headers=(permissions:string[],tenant=tenantId)=>({authorization:`Bearer ${app.jwt.sign({sub:admin,tenantId:tenant,email:'t',displayName:'t',roles:[],permissions})}`})
  const all=headers(['*']),rep=headers(['customer_ops:read','customer_ops:update']),viewer=headers(['customer_ops:read'])
  const request=(method:'GET'|'POST'|'PUT'|'DELETE',url:string,payload?:object,h=all)=>app.inject({method,url,headers:h,...(payload?{payload}:{})})
  const c=await saveConnection(tenantId,admin,{access_token:'co',refresh_token:'co',expires_in:36000,aliId:`co-${marker}`,resource_owner:'shop',refresh_token_timeout:'20990101000000000+0800'},Date.now(),'performance')
  await db.query("UPDATE integration_1688_perf_connections SET status='disabled' WHERE id=$1",[c.id])
  const agent=(await db.query("INSERT INTO perf_agents(tenant_id,connection_id,login_id,is_main) VALUES($1,$2,'shop:a',false) RETURNING id",[tenantId,c.id])).rows[0].id
  let seq=0
  const order=async(buyer:string,placedDaysAgo:number,amount:number,paid=true)=>db.query(`INSERT INTO perf_orders(tenant_id,connection_id,order_id,buyer_open_uid,status,total_amount,placed_at,paid_at,items) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'[]')`,
    [tenantId,c.id,String(5000+seq++),buyer,paid?'success':'waitbuyerpay',amount,daysAgo(placedDaysAgo),paid?daysAgo(placedDaysAgo):null])
  const chat=async(buyerId:string,daysBack:number)=>db.query(`INSERT INTO perf_chat_sessions(tenant_id,connection_id,agent_id,buyer_id,cid,chat_date,last_peer_at,needs_sync,buyer_messages) VALUES($1,$2,$3,$4,$5,$6::date,now(),false,2)`,
    [tenantId,c.id,agent,buyerId,`cid${seq++}`,daysAgo(daysBack).toISOString().slice(0,10)])
  const base='/api/customer-ops'

  // ---- Buyer identity: order-only buyers get a row; a later chat folds the sub-buyer into the main buyer ----
  await order('S1',25,200)
  assert.equal(await ensureOrderBuyers(c.id),1)
  const s1=(await db.query("SELECT id FROM perf_buyers WHERE connection_id=$1 AND buyer_key='S1'",[c.id])).rows[0].id
  // Data written against the order-only buyer must survive the merge.
  const tag=(await request('POST',`${base}/tags`,{name:'批发'},rep)).json().data
  assert.equal((await request('PUT',`${base}/customers/${s1}/profile`,{revision:0,name:'张三五金',wangwangId:null,phone:'138-0000-0000',wechat:null,email:null,qq:null,address:null,memberIdentity:'网点',purchaseType:'distribution',salesChannels:['抖音'],cycleMode:'system',cycleDays:null,note:null,accountId:null,ownerAgentId:null},rep)).statusCode,200)
  await request('PUT',`${base}/customers/${s1}/tags`,{tagIds:[tag.id]},rep)
  await request('POST',`${base}/customers/${s1}/followups`,{content:'问过批发价',method:'wangwang',needFollowUp:false},rep)
  const viaChat=await resolveBuyer(tenantId,c.id,{key:'A',openUid:'S2',adminOpenUid:'A',taobaoNick:null,at:new Date()})
  assert.equal(viaChat.merged,0)
  const merged=await resolveBuyer(tenantId,c.id,{key:'A',openUid:'S1',adminOpenUid:'A',taobaoNick:null,at:new Date()})
  assert.equal(merged.merged,1);assert.equal(merged.buyerId,viaChat.buyerId,'the main-account buyer survives')
  const A=viaChat.buyerId
  assert.equal((await db.query('SELECT count(*)::int AS n FROM perf_buyers WHERE id=$1',[s1])).rows[0].n,0)
  assert.deepEqual((await db.query('SELECT open_uid FROM perf_buyer_identities WHERE buyer_id=$1 ORDER BY open_uid',[A])).rows.map(r=>r.open_uid),['A','S1','S2'])
  assert.equal((await db.query('SELECT name FROM cust_profiles WHERE buyer_id=$1',[A])).rows[0].name,'张三五金')
  assert.equal((await db.query('SELECT count(*)::int AS n FROM cust_buyer_tags WHERE buyer_id=$1',[A])).rows[0].n,1)
  assert.equal((await db.query('SELECT count(*)::int AS n FROM cust_followups WHERE buyer_id=$1',[A])).rows[0].n,1)

  // ---- Customers with known segments ----
  await order('S2',15,300); await order('A',5,400); await chat(A,1)                                            // A: 3 paid, every 10 days -> 老客户, 900 -> 普通
  await order('B',100,80)                                                                                         // B: 1 paid long ago -> 新客户, overdue, low price
  const C=(await resolveBuyer(tenantId,c.id,{key:'C',openUid:'C',adminOpenUid:null,taobaoNick:null,at:new Date()})).buyerId; await chat(C,2)  // C: chat only -> 未下单
  await order('D',1,999,false); await ensureOrderBuyers(c.id)                                                     // D: unpaid order -> 下单未付款
  for(let i=0;i<6;i++)await order('E',i*3,3000)                                                                  // E: 6 x 3000 -> 忠诚, VIP, high price
  await ensureOrderBuyers(c.id)
  assert.equal(await refreshCustomerStats(c.id),5)
  const id=async(key:string)=>(await db.query('SELECT buyer_id FROM perf_buyer_identities WHERE connection_id=$1 AND open_uid=$2',[c.id,key])).rows[0].buyer_id as string
  const [B,D,E]=[await id('B'),await id('D'),await id('E')]

  const list=async(query='',h=all)=>{const r=await request('GET',`${base}/customers?connectionId=${c.id}${query}`,undefined,h);assert.equal(r.statusCode,200,r.body);return r.json()}
  const ids=async(query:string)=>(await list(query)).data.map((r:{id:string})=>r.id).sort()
  const all5=await list();assert.equal(all5.total,5);assert.equal(all5.online,5)
  assert.ok(!JSON.stringify(all5).includes('"buyer_key"'),'encrypted buyer ids are not exposed')
  const row=(id:string)=>all5.data.find((r:{id:string})=>r.id===id)
  assert.deepEqual([row(A).customer_type,row(A).level,row(A).paid_orders,row(A).paid_amount,row(A).avg_interval_days,row(A).price_tier],['returning','normal',3,900,10,'mid'])
  assert.deepEqual([row(B).customer_type,row(B).overdue,row(B).price_tier],['new',true,'low'])
  assert.deepEqual([row(C).customer_type,row(C).pool],['prospect','no_order'])
  assert.deepEqual([row(D).pool,row(D).unpaid_amount],['unpaid',999])
  assert.deepEqual([row(E).customer_type,row(E).level,row(E).price_tier],['loyal','vip','high'])
  assert.deepEqual(await ids('&customerType=new,loyal'),[B,E].sort())
  assert.deepEqual(await ids('&level=vip'),[E]);assert.deepEqual(await ids('&priceTier=low'),[B])
  assert.deepEqual(await ids('&overdue=yes'),[B]);assert.deepEqual(await ids('&idleDays=60'),[B])
  assert.deepEqual(await ids('&pool=any'),[C,D].sort());assert.deepEqual(await ids('&pool=unpaid'),[D])
  assert.deepEqual(await ids(`&tagId=${tag.id}`),[A]);assert.deepEqual(await ids('&memberIdentity=网点'),[A]);assert.deepEqual(await ids('&channel=抖音,快手'),[A]);assert.deepEqual(await ids('&purchaseType=distribution'),[A])
  assert.deepEqual(await ids('&cycle=8-30'),[A]);assert.deepEqual(await ids('&cycle=3-7'),[E])
  assert.deepEqual(await ids(`&search=${encodeURIComponent('张三')}`),[A]);const bOrder=(await db.query("SELECT order_id FROM perf_orders WHERE connection_id=$1 AND buyer_open_uid='B'",[c.id])).rows[0].order_id
  assert.deepEqual(await ids(`&search=${bOrder}`),[B],'search by order id')
  assert.deepEqual(await ids('&minFollowups=1'),[A])
  assert.ok((await request('GET',`${base}/customers?connectionId=${c.id}&level=gold`)).statusCode>=400)
  assert.equal((await list('&sort=paid_amount')).data[0].id,E)

  // ---- Profile: optimistic revision, validation, CRM link and owning agent ----
  const detail=async(id:string)=>(await request('GET',`${base}/customers/${id}`)).json().data
  let d=await detail(A);assert.equal(d.customer.revision,1,'profile moved with the merge');assert.equal(d.orders.length,3);assert.equal(d.chats.length,1)
  const profile={name:'张三五金',wangwangId:'zhangsan',phone:'13800000000',wechat:null,email:'a@b.cn',qq:'12345',address:'义乌',memberIdentity:'网点' as const,purchaseType:'distribution' as const,salesChannels:['抖音','抖音'],cycleMode:'custom' as const,cycleDays:3,note:'老客',accountId:null as string|null,ownerAgentId:agent}
  assert.equal((await request('PUT',`${base}/customers/${A}/profile`,{...profile,revision:0},rep)).statusCode,409)
  assert.ok((await request('PUT',`${base}/customers/${A}/profile`,{...profile,revision:1,email:'bad'},rep)).statusCode>=400)
  assert.ok((await request('PUT',`${base}/customers/${A}/profile`,{...profile,revision:1,cycleDays:null},rep)).statusCode>=400,'custom cycle needs days')
  assert.equal((await request('PUT',`${base}/customers/${A}/profile`,{...profile,revision:1,ownerAgentId:randomUUID()},rep)).statusCode,400)
  assert.equal((await request('PUT',`${base}/customers/${A}/profile`,{...profile,revision:1},viewer)).statusCode,403)
  const account=(await db.query("INSERT INTO accounts(tenant_id,name) VALUES($1,'张三五金有限公司') RETURNING id",[tenantId])).rows[0].id
  assert.equal((await request('PUT',`${base}/customers/${A}/profile`,{...profile,revision:1,accountId:account},rep)).statusCode,200)
  d=await detail(A);assert.deepEqual([d.customer.sales_channels,d.customer.cycle_mode,d.customer.cycle_days,d.account.name],[['抖音'],'custom',3,'张三五金有限公司'])
  assert.deepEqual(await ids('&overdue=yes'),[A,B].sort(),'custom 3-day cycle makes A overdue (last purchase 5 days ago)')

  // ---- Follow-ups: newest plan supersedes, due filter, mirrored to the linked CRM customer ----
  const due=new Date(Date.now()-3600_000).toISOString(),later=new Date(Date.now()+5*86_400_000).toISOString()
  assert.ok((await request('POST',`${base}/customers/${A}/followups`,{content:'x',method:'other',needFollowUp:false,nextFollowUpAt:due},rep)).statusCode>=400)
  assert.equal((await request('POST',`${base}/customers/${A}/followups`,{content:'用户有购买意愿，在纠结价格',method:'wangwang',needFollowUp:true,nextFollowUpAt:due},rep)).statusCode,201)
  assert.equal((await request('POST',`${base}/customers/${B}/followups`,{content:'下周回访',method:'other',needFollowUp:true,nextFollowUpAt:later},rep)).statusCode,201)
  assert.deepEqual(await ids('&due=yes'),[A])
  assert.equal((await request('POST',`${base}/customers/${A}/followups`,{content:'已报价',method:'wangwang',needFollowUp:true,nextFollowUpAt:later},rep)).statusCode,201)
  assert.deepEqual(await ids('&due=yes'),[],'a newer plan replaces the overdue one')
  assert.equal((await list('&sort=next_follow_up')).data[0].next_follow_up_at!==null,true)
  assert.equal((await db.query("SELECT count(*)::int AS n FROM activities WHERE account_id=$1 AND subject='1688 客户跟进'",[account])).rows[0].n,2)
  d=await detail(A);assert.equal(d.followups.length,3);assert.equal(d.customer.followups,3)

  // ---- Tags ----
  assert.equal((await request('POST',`${base}/tags`,{name:'批发'},rep)).statusCode,409)
  const vipTag=(await request('POST',`${base}/tags`,{name:'重点'},rep)).json().data
  assert.equal((await request('POST',`${base}/customers/bulk-tags`,{buyerIds:[B,E,randomUUID()],tagId:vipTag.id,action:'add'},rep)).json().data.changed,2)
  assert.deepEqual(await ids(`&tagId=${vipTag.id}`),[B,E].sort())
  assert.equal((await request('POST',`${base}/customers/bulk-tags`,{buyerIds:[B],tagId:vipTag.id,action:'remove'},rep)).json().data.changed,1)
  assert.equal((await request('DELETE',`${base}/tags/${vipTag.id}`,undefined,rep)).statusCode,403,'deleting a tag needs manage')
  assert.equal((await request('DELETE',`${base}/tags/${vipTag.id}`)).statusCode,200)
  assert.deepEqual(await ids(`&tagId=${vipTag.id}`),[])

  // ---- Thresholds re-segment immediately ----
  const settings=(await request('GET',`${base}/settings`)).json().data
  assert.equal((await request('PUT',`${base}/settings`,{revision:settings.revision,levelPlatinum:500,levelVip:800,priceMid:100,priceHigh:500,loyalOrders:3,defaultCycleDays:30},rep)).statusCode,403)
  assert.ok((await request('PUT',`${base}/settings`,{revision:settings.revision,levelPlatinum:900,levelVip:800,priceMid:100,priceHigh:500,loyalOrders:3,defaultCycleDays:30})).statusCode>=400)
  assert.equal((await request('PUT',`${base}/settings`,{revision:settings.revision,levelPlatinum:500,levelVip:800,priceMid:100,priceHigh:500,loyalOrders:3,defaultCycleDays:30})).statusCode,200)
  assert.deepEqual([(await list()).data.find((r:{id:string})=>r.id===A).level,(await list()).data.find((r:{id:string})=>r.id===A).customer_type],['vip','loyal'])

  // ---- Overdue customers join 待跟进 until someone follows up after they became overdue ----
  await order('F',50,120);await ensureOrderBuyers(c.id);await refreshCustomerStats(c.id)
  const F=await id('F')
  const dueRows=async()=>Object.fromEntries((await list('&due=yes&sort=next_follow_up')).data.map((r:{id:string;due_reason:string})=>[r.id,r.due_reason]))
  assert.deepEqual(await dueRows(),{[F]:'overdue'},'B has a plan for next week; A followed up after becoming overdue')
  assert.equal((await request('POST',`${base}/customers/${F}/followups`,{content:'问复购意向',method:'wangwang',needFollowUp:false},rep)).statusCode,201)
  assert.deepEqual(await dueRows(),{},'a follow-up written after the overdue date clears it')
  await db.query('UPDATE cust_followups SET created_at=$2 WHERE buyer_id=$1',[F,daysAgo(40)])
  assert.deepEqual(await dueRows(),{[F]:'overdue'},'an older follow-up does not count')
  let cs=(await request('GET',`${base}/settings`)).json().data;assert.equal(cs.overdue_followup,true)
  cs=(await request('PUT',`${base}/settings`,{revision:cs.revision,levelPlatinum:cs.level_platinum,levelVip:cs.level_vip,priceMid:cs.price_mid,priceHigh:cs.price_high,loyalOrders:cs.loyal_orders,defaultCycleDays:cs.default_cycle_days,overdueFollowup:false})).json().data
  assert.deepEqual(await dueRows(),{},'switched off')
  await request('PUT',`${base}/settings`,{revision:cs.revision,levelPlatinum:cs.level_platinum,levelVip:cs.level_vip,priceMid:cs.price_mid,priceHigh:cs.price_high,loyalOrders:cs.loyal_orders,defaultCycleDays:cs.default_cycle_days,overdueFollowup:true})

  // ---- Export: manager only, audited, Excel-safe ----
  const cRev=(await db.query('SELECT revision FROM cust_profiles WHERE buyer_id=$1',[C])).rows[0]?.revision??0
  assert.equal((await request('PUT',`${base}/customers/${C}/profile`,{revision:cRev,name:'=HYPERLINK("x")',wangwangId:null,phone:null,wechat:null,email:null,qq:null,address:null,memberIdentity:null,purchaseType:null,salesChannels:[],cycleMode:'system',cycleDays:null,note:null,accountId:null,ownerAgentId:null},rep)).statusCode,200)
  assert.equal((await request('GET',`${base}/customers/export?connectionId=${c.id}`,undefined,rep)).statusCode,403,'contact details: manager only')
  const exported=await request('GET',`${base}/customers/export?connectionId=${c.id}&customerType=returning,loyal,prospect`);assert.equal(exported.statusCode,200)
  assert.match(String(exported.headers['content-type']),/text\/csv/);assert.match(String(exported.headers['content-disposition']),/filename\*=UTF-8''/)
  const csvLines=exported.body.replace(/^\ufeff/,'').split('\r\n')
  assert.ok(exported.body.startsWith('\ufeff'));assert.ok(csvLines[0].startsWith('买家尾号,淘宝昵称,客户名称,旺旺号,电话'))
  assert.equal(csvLines.length,1+4,'filters apply: A, E (loyal), C, D (no paid order)');assert.ok(csvLines.some(l=>l.includes('张三五金')&&l.includes('13800000000')))
  assert.ok(exported.body.includes(`"'=HYPERLINK(""x"")"`),'formula neutralised')
  assert.equal((await db.query("SELECT count(*)::int AS n FROM audit_logs WHERE tenant_id=$1 AND action='customer.export'",[tenantId])).rows[0].n,1)

  // ---- Attachments: private OSS, type/size/count limits, signed links, merge ----
  const png=(n=64)=>Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.alloc(n)]).toString('base64')
  const pdf=(n=64)=>Buffer.concat([Buffer.from('%PDF-1.4\n'),Buffer.alloc(n,32)]).toString('base64')
  const attach=(buyer:string,body:object,h=rep)=>request('POST',`${base}/customers/${buyer}/attachments`,body,h)
  const first=await attach(A,{name:'门头照.png',mime:'image/png',content:png()});assert.equal(first.statusCode,201,first.body)
  assert.ok([...objects.keys()].every(k=>k.startsWith(`customer-attachments/${tenantId}/${A}/`)&&k.endsWith('.png')))
  assert.equal((await attach(A,{name:'报价单.pdf',mime:'application/pdf',content:pdf()})).statusCode,201)
  assert.equal((await attach(A,{name:'假图.png',mime:'image/png',content:pdf()})).statusCode,400,'content must match the type')
  assert.equal((await attach(A,{name:'../x.pdf',mime:'application/pdf',content:pdf()})).statusCode,400,'no paths in names')
  assert.equal((await attach(A,{name:'大文件.pdf',mime:'application/pdf',content:pdf(1024*1024)})).statusCode,400,'files ≤ 1MB')
  assert.equal((await attach(A,{name:'x.exe',mime:'application/x-msdownload',content:pdf()})).statusCode,400)
  assert.equal((await attach(A,{name:'看看.png',mime:'image/png',content:png()},viewer)).statusCode,403)
  for(let i=0;i<9;i++)assert.equal((await attach(A,{name:`图${i}.png`,mime:'image/png',content:png()})).statusCode,201)
  assert.equal((await attach(A,{name:'第11张.png',mime:'image/png',content:png()})).statusCode,400,'10 images per customer')
  const listed=(await request('GET',`${base}/customers/${A}/attachments`,undefined,viewer)).json()
  assert.equal(listed.data.length,11);assert.deepEqual(listed.limits,{image:{count:10,bytes:2097152},file:{count:10,bytes:1048576}})
  const fileLink=new URL(listed.data.find((a:{kind:string})=>a.kind==='file').url)
  assert.equal(fileLink.protocol,'https:');assert.equal(fileLink.hostname,'custops-fixture.oss-cn-beijing.aliyuncs.com');assert.ok(fileLink.searchParams.get('x-oss-signature'))
  assert.match(fileLink.searchParams.get('response-content-disposition')!,/^attachment; filename\*=UTF-8''/)
  assert.ok(!JSON.stringify(listed).includes('storage_key'),'storage keys are not exposed')
  assert.equal((await request('GET',`${base}/customers/${A}/attachments`,undefined,headers(['*'],tenantIds[1]))).statusCode,404)
  assert.equal((await list()).data.find((r:{id:string})=>r.id===A).attachments,11)
  const victim=listed.data[0].id
  assert.equal((await request('DELETE',`${base}/customers/${A}/attachments/${victim}`,undefined,viewer)).statusCode,403)
  assert.equal((await request('DELETE',`${base}/customers/${A}/attachments/${victim}`,undefined,rep)).statusCode,204)
  assert.equal(objects.size,10);assert.equal((await request('DELETE',`${base}/customers/${A}/attachments/${victim}`,undefined,rep)).statusCode,404)
  await order('M1',2,50);await ensureOrderBuyers(c.id);const M1=await id('M1')
  assert.equal((await attach(M1,{name:'合同.pdf',mime:'application/pdf',content:pdf()})).statusCode,201)
  await resolveBuyer(tenantId,c.id,{key:'A',openUid:'M1',adminOpenUid:'A',taobaoNick:null,at:new Date()})
  assert.equal((await db.query('SELECT count(*)::int AS n FROM cust_attachments WHERE buyer_id=$1',[A])).rows[0].n,11,'attachments follow a merge')

  // ---- Options, permissions and isolation ----
  const options=(await request('GET',`${base}/options`,undefined,viewer)).json().data
  assert.equal(options.shops.length,1);assert.equal(options.offlineCustomers,1);assert.ok(options.memberIdentities.includes('网点'))
  assert.equal((await request('GET',`${base}/customers?connectionId=${c.id}`,undefined,headers([]))).statusCode,403)
  const other=headers(['*'],tenantIds[1])
  assert.equal((await request('GET',`${base}/customers?connectionId=${c.id}`,undefined,other)).statusCode,404)
  assert.equal((await request('GET',`${base}/customers/${A}`,undefined,other)).statusCode,404)
  assert.equal((await request('POST',`${base}/customers/bulk-tags`,{buyerIds:[A],tagId:tag.id,action:'remove'},other)).statusCode,400)

  console.log(JSON.stringify({overdueFollowup:'ok',export:'ok',attachments:'ok',orderOnlyBuyers:'ok',buyerMerge:'ok',mergeKeepsProfileTagsFollowups:'ok',segments:'ok',filters:'ok',search:'ok',profile:'ok',crmLink:'ok',customCycle:'ok',followups:'ok',dueSupersede:'ok',activityMirror:'ok',tags:'ok',thresholds:'ok',permissions:'ok',isolation:'ok'}))
}finally{
  globalThis.fetch=originalFetch
  Object.assign(ossProto,ossOriginal)
  for(const id of tenantIds){await db.query('DELETE FROM audit_logs WHERE tenant_id=$1',[id]);await db.query('DELETE FROM tenants WHERE id=$1',[id])}
  await app.close();await db.end()
}
