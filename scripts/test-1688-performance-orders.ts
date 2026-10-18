import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { buildApp } from '../server/app.js'
import { db } from '../server/db.js'
import { saveConnection } from '../server/integrations/1688.js'
import { runPerformanceSyncOnce, parseBeijingTime } from '../server/integrations/1688-performance-sync.js'
import { attribute, formatPlatformTime, parsePlatformTime } from '../server/integrations/1688-performance-orders.js'

// Mocked gateway using the live response shapes (2026-10-14 probe): orders carry baseInfo.buyerOpenUid matching
// either a chat openUid or adminOpenUid; refunds report amounts in fen and need dipsuteType=0.
const originalFetch=globalThis.fetch
const marker=randomUUID(),tenantIds:string[]=[]
const app=await buildApp()
const DAY=86_400_000
const beijingDay=(offset:number)=>new Date(Date.now()+8*3_600_000+offset*DAY).toISOString().slice(0,10)
const D=beijingDay(-1)
const at=(date:string,time:string)=>`${date} ${time}`
const ms=(text:string)=>parseBeijingTime(text).getTime()
const platform=(text:string)=>formatPlatformTime(ms(text))
type Msg={uuid:string;self:string;direction:0|1;time:string;types:string[]}
const n=['正常消息'],other=['其他消息']
const messages:Record<string,Msg[]>={
  // Buyer A (openUid O1, main buyer A1) talks to three accounts on day D.
  a1:[{uuid:'a1',self:'shop:a',direction:1,time:at(D,'10:00:00'),types:n},{uuid:'a2',self:'shop:a',direction:0,time:at(D,'10:02:00'),types:n},
      {uuid:'a3',self:'shop:a',direction:1,time:at(D,'12:40:00'),types:n},{uuid:'a4',self:'shop:a',direction:0,time:at(D,'12:45:00'),types:n}],
  m1:[{uuid:'m1',self:'shop',direction:1,time:at(D,'11:59:00'),types:n},{uuid:'m2',self:'shop',direction:0,time:at(D,'12:00:00'),types:n}],
  b1:[{uuid:'b1',self:'shop:b',direction:1,time:at(D,'12:49:00'),types:n},{uuid:'b2',self:'shop:b',direction:0,time:at(D,'12:50:00'),types:other},
      // Buyer B (O2) asks shop:b after an earlier purchase.
      ],
  b2:[{uuid:'c1',self:'shop:b',direction:1,time:at(D,'16:00:00'),types:n},{uuid:'c2',self:'shop:b',direction:0,time:at(D,'16:01:00'),types:n}],
  // Buyer C (O3) asks and never orders.
  a2:[{uuid:'d1',self:'shop:a',direction:1,time:at(D,'17:00:00'),types:n},{uuid:'d2',self:'shop:a',direction:0,time:at(D,'17:00:30'),types:n}],
}
const last=(cid:string)=>Math.max(...messages[cid].map(m=>ms(m.time)))
const peer=(cid:string,openUid:string,adminOpenUid:string)=>({cid,date:D.replaceAll('-',''),time:last(cid),openUid,adminOpenUid,taobaoNick:'x',loginId:'**'})
const peers:Record<string,ReturnType<typeof peer>[]>={'shop:a':[peer('a1','O1','A1'),peer('a2','O3','A3')],shop:[peer('m1','O1','A1')],'shop:b':[peer('b1','O1','A1'),peer('b2','O2','A2')]}
const order=(id:string,buyer:string,placed:string,paid:string|null,amount:number,status:string,memo:{sellerMemo?:string;sellerRemarkIcon?:string}={})=>({baseInfo:{...memo,idOfStr:id,id,buyerOpenUid:buyer,status,businessType:'cn',totalAmount:amount,sumProductPayment:amount-5,shippingFee:5,refund:0,
  createTime:platform(placed),payTime:paid?platform(paid):undefined,modifyTime:platform(at(beijingDay(0),'00:00:01')),buyerLoginId:'t*'},orderRateInfo:{buyerRateStatus:5},
  productItems:[{productID:'9007199254740993123',name:'测试商品',quantity:2,price:(amount-5)/2,itemAmount:amount-5,skuInfos:[{name:'颜色',value:'红'}]}]})
const orders=[
  order('1001','O1',at(D,'12:30:00'),at(D,'13:00:00'),100,'waitsellersend',{sellerRemarkIcon:'3'}),
  order('1002','A1',at(D,'15:00:00'),null,50,'waitbuyerpay'),
  order('1003','Z9',at(D,'18:00:00'),at(D,'18:05:00'),30,'waitsellersend',{sellerMemo:'@b 已跟进，加急',sellerRemarkIcon:'1'}),
  order('1004','O2',at(beijingDay(-11),'09:00:00'),at(beijingDay(-11),'09:10:00'),80,'success'),
]
const refunds=[{id:'r1',refundId:'TQ1',orderId:'1001',buyerOpenUid:'O1',status:'refundsuccess',disputeType:1,onlyRefund:true,applyPayment:500,refundPayment:500,applyCarriage:300,refundCarriage:300,applyReason:'不想要了',
  gmtApply:platform(at(D,'14:00:00')),gmtCompleted:platform(at(D,'15:00:00')),gmtModified:platform(at(beijingDay(0),'00:00:02'))}]
const calls={orders:0,refunds:0}
const response=(data:unknown)=>new Response(JSON.stringify(data),{status:200})
globalThis.fetch=async(input,init)=>{
  const url=String(input)
  assert.ok(url.startsWith('https://gw.open.1688.com/openapi/'),'unexpected network destination')
  const flat=Object.fromEntries((init!.body as URLSearchParams).entries())
  assert.equal(flat.access_token,'orders-access','only the test grant may reach the mock')
  if(url.includes('alibaba.subAccount.list'))return response({mainLoginId:'shop',mainUserId:'100',subAccountList:[{loginId:'shop:a',userId:101,status:'正常'},{loginId:'shop:b',userId:102,status:'正常'}]})
  if(url.includes('wangwang.chat.relation.query')){
    const beg=Number(flat.beg),end=Number(flat.end)
    return response({success:'true',data:{peers:(peers[flat.loginId]||[]).filter(p=>p.time>=beg&&p.time<end),hasMore:false}})
  }
  if(url.includes('chat.msg.query')){
    const list=(messages[flat.cid]||[]).filter(m=>ms(m.time)>=Number(flat.beg))
    return response({success:true,data:{hasMore:false,nextCursor:Date.now(),historyChatLogList:list.map(m=>({direction:m.direction,length:'1',time:m.time,uuid:m.uuid,messageTypes:m.types,selfLoginId:m.self,senderLoginId:'**',receiverLoginId:'**',words:[]}))}})
  }
  if(url.includes('alibaba.trade.ec.getOrderList.sellerView')){
    calls.orders++
    const beg=parsePlatformTime(flat.modifyStartTime)!.getTime(),end=parsePlatformTime(flat.modifyEndTime)!.getTime(),page=Number(flat.page),size=Number(flat.pageSize)
    assert.ok(size<=20)
    assert.equal(flat.needMemoInfo,'true','memo and flag are requested for scheme 5')
    const match=orders.filter(o=>{const t=parsePlatformTime(o.baseInfo.modifyTime)!.getTime();return t>=beg&&t<end})
    return response({success:true,totalRecord:match.length,result:match.slice((page-1)*size,page*size)})
  }
  if(url.includes('alibaba.trade.refund.queryOrderRefundList')){
    calls.refunds++
    assert.equal(flat.dipsuteType,'0','both in-sale and after-sale refunds')
    const beg=parsePlatformTime(flat.modifyStartTime)!.getTime(),end=parsePlatformTime(flat.modifyEndTime)!.getTime()
    const match=refunds.filter(r=>{const t=parsePlatformTime(r.gmtModified)!.getTime();return t>=beg&&t<end})
    return response({result:{totalCount:match.length,currentPageNum:Number(flat.currentPageNum),opOrderRefundModels:match}})
  }
  throw new Error(`Unmocked API ${url}`)
}

try{
  // Pure scheme logic.
  const t=(s:string)=>new Date(`2026-01-01T${s}+08:00`)
  const replies=[{agent_id:'A',session_id:'s1',sent_at:t('10:00:00')},{agent_id:'B',session_id:'s2',sent_at:t('11:00:00')},{agent_id:'C',session_id:'s3',sent_at:t('11:30:00')}]
  const credits=attribute({placed_at:t('11:10:00'),paid_at:t('11:40:00')},replies,72*3_600_000)
  const agents=(scheme:keyof typeof credits)=>credits[scheme].map(c=>`${c.agent_id}:${c.share}`)
  assert.deepEqual(agents('order_first'),['B:1']);assert.deepEqual(agents('payment_first'),['C:1']);assert.deepEqual(agents('order_payment_split'),['B:0.5','C:0.5'])
  assert.deepEqual(agents('payment_day_chat').sort(),['A:0.3333333333333333','B:0.3333333333333333','C:0.3333333333333333'])
  assert.deepEqual(attribute({placed_at:t('11:10:00'),paid_at:null},replies,3_600_000).payment_first.map(c=>c.agent_id),['B'],'unpaid falls back to the order agent')
  assert.deepEqual(attribute({placed_at:t('11:10:00'),paid_at:null},replies,60_000).order_first,[],'outside the window nobody is credited')
  assert.equal(parsePlatformTime('20261014102903000+0800')?.toISOString(),'2026-10-14T02:29:03.000Z')
  assert.equal(formatPlatformTime(Date.parse('2026-10-14T02:29:03.000Z')),'20261014102903000+0800')

  for(let i=0;i<2;i++)tenantIds.push((await db.query('INSERT INTO tenants(name,slug)VALUES($1,$2)RETURNING id',['1688 performance orders test',`test-1688-perforders-${marker}-${i}`])).rows[0].id)
  const tenantId=tenantIds[0]
  const admin=(await db.query("INSERT INTO users(tenant_id,email,password_hash,display_name,status)VALUES($1,$2,'unused','admin','active')RETURNING id",[tenantId,`orders-${marker}@integration.local`])).rows[0].id
  const headers=(permissions:string[],tenant=tenantId)=>({authorization:`Bearer ${app.jwt.sign({sub:admin,tenantId:tenant,email:'t',displayName:'t',roles:[],permissions})}`})
  const all=headers(['*'])
  const request=(method:'GET'|'POST'|'PUT',url:string,payload?:object,h=all)=>app.inject({method,url,headers:h,...(payload?{payload}:{})})
  const base='/api/integrations/1688/performance'
  const connection=await saveConnection(tenantId,admin,{access_token:'orders-access',refresh_token:'r',expires_in:36000,aliId:`orders-${marker}`,resource_owner:'shop',refresh_token_timeout:'20990101000000000+0800'},Date.now(),'performance')
  await db.query("UPDATE integration_1688_perf_connections SET account_role='main' WHERE id=$1",[connection.id])
  const sync=async(scopeDays?:1|7|30)=>{assert.equal((await request('POST',`${base}/connections/${connection.id}/sync`,scopeDays?{scopeDays}:{})).statusCode,202);const r=await runPerformanceSyncOnce(undefined,connection.id);assert.equal(r?.status,'succeeded',JSON.stringify(r));return r!}

  // The default 30-day history range covers the fixture's two weeks.
  const first=await sync()
  assert.equal(first.stats.orders,4);assert.equal(first.stats.refunds,1);assert.equal(first.stats.attributedOrders,6,'buyer A gets an owner, so its two orders are attributed again');assert.equal(first.stats.ownersChanged,1)
  const stored=(await db.query('SELECT order_id,status,total_amount::float AS total,paid_at IS NOT NULL AS paid,items->0->>\'productId\' AS product FROM perf_orders WHERE connection_id=$1 ORDER BY order_id',[connection.id])).rows
  assert.deepEqual(stored.map(o=>[o.order_id,o.total,o.paid]),[['1001',100,true],['1002',50,false],['1003',30,true],['1004',80,true]])
  assert.equal(stored[0].product,'9007199254740993123','large product ids stay lossless')
  assert.deepEqual((await db.query('SELECT refund_amount::float AS goods,refund_carriage::float AS shipping,refund_total::float AS total,apply_carriage::float AS applied FROM perf_refunds WHERE connection_id=$1',[connection.id])).rows[0],{goods:5,shipping:3,total:8,applied:3},'goods and shipping converted from fen; shipping is not part of refundPayment')
  assert.ok(!(await db.query("SELECT column_name FROM information_schema.columns WHERE table_name='perf_orders'")).rows.some(c=>/address|phone|contact/.test(c.column_name)),'no contact data stored')

  // Attribution: order 1001 by openUid, 1002 by the main-buyer id, 1003 unknown buyer.
  const credit=async(scheme:string)=>Object.fromEntries((await db.query(`SELECT o.order_id,string_agg(ag.login_id||':'||a.share::float,',' ORDER BY ag.login_id) AS c FROM perf_orders o
    LEFT JOIN perf_order_attributions a ON a.order_id=o.id AND a.scheme=$2 LEFT JOIN perf_agents ag ON ag.id=a.agent_id WHERE o.connection_id=$1 GROUP BY o.order_id`,[connection.id,scheme])).rows.map(r=>[r.order_id,r.c]))
  assert.deepEqual(await credit('order_first'),{'1001':'shop:1','1002':'shop:a:1','1003':null,'1004':null})
  assert.deepEqual(await credit('payment_first'),{'1001':'shop:a:1','1002':'shop:a:1','1003':null,'1004':null})
  assert.deepEqual(await credit('order_payment_split'),{'1001':'shop:0.5,shop:a:0.5','1002':'shop:a:1','1003':null,'1004':null})
  assert.deepEqual(await credit('payment_day_chat'),{'1001':'shop:0.5,shop:a:0.5','1002':null,'1003':null,'1004':null},'"其他消息" is not a reply in strict mode')

  // Agent comparison with conversion and credited sales (default scheme 1).
  const metrics=async()=>{const r=await request('GET',`${base}/metrics?connectionId=${connection.id}&from=${D}&to=${D}`);assert.equal(r.statusCode,200,r.body);return {scheme:r.json().scheme,rows:Object.fromEntries((r.json().data as Record<string,unknown>[]).map(x=>[x.login_id,x]))}}
  const conv=(row:Record<string,unknown>)=>({inquiry:row.inquiry,newCustomer:row.new_customer_inquiry,afterSales:row.after_sales,ordered:row.ordered_buyers,paid:row.paid_buyers,orders:row.orders,amount:row.order_amount,paidAmount:row.paid_amount,refund:row.refund_amount})
  let m=await metrics();assert.equal(m.scheme,'order_first')
  assert.deepEqual(conv(m.rows['shop:a']),{inquiry:2,newCustomer:2,afterSales:0,ordered:1,paid:1,orders:1,amount:50,paidAmount:0,refund:0})
  assert.deepEqual(conv(m.rows.shop),{inquiry:1,newCustomer:1,afterSales:0,ordered:1,paid:1,orders:1,amount:100,paidAmount:100,refund:8})
  assert.deepEqual(conv(m.rows['shop:b']),{inquiry:1,newCustomer:1,afterSales:1,ordered:1,paid:0,orders:0,amount:0,paidAmount:0,refund:0})

  // Chat analysis categories and drill-down.
  const chats=await request('GET',`${base}/chats?connectionId=${connection.id}&from=${D}&to=${D}`);assert.equal(chats.statusCode,200,chats.body)
  assert.deepEqual(chats.json().counts,{paid:2,ordered_unpaid:1,after_sales:1,no_order:1})
  const afterSales=(await request('GET',`${base}/chats?connectionId=${connection.id}&from=${D}&to=${D}&category=after_sales`)).json().data
  assert.equal(afterSales.length,1);assert.equal(afterSales[0].login_id,'shop:b');assert.equal(afterSales[0].buyer_tail.length<=6,true)
  const paidChat=(await request('GET',`${base}/chats?connectionId=${connection.id}&from=${D}&to=${D}&category=paid`)).json().data.find((c:{login_id:string})=>c.login_id==='shop:a')
  assert.deepEqual(paidChat.orders_after,['1001','1002']);assert.equal(paidChat.first_response_seconds,120)
  const detail=await request('GET',`${base}/chats/${paidChat.id}/messages`);assert.equal(detail.statusCode,200)
  assert.deepEqual(detail.json().data.messages.map((x:{uuid:string})=>x.uuid),['a1','a2','a3','a4'])
  assert.equal((await request('GET',`${base}/chats/${paidChat.id}/messages`,undefined,headers(['*'],tenantIds[1]))).statusCode,404)

  // Order list with credits and filters.
  const list=await request('GET',`${base}/orders?connectionId=${connection.id}&from=${D}&to=${D}`);assert.equal(list.statusCode,200,list.body)
  assert.deepEqual(list.json().data.map((o:{order_id:string})=>o.order_id),['1003','1002','1001']);assert.equal(list.json().pendingAttribution,0)
  const o1=list.json().data.find((o:{order_id:string})=>o.order_id==='1001');assert.equal(o1.credits[0].login_id,'shop');assert.equal(o1.credits[0].basis,'order_reply');assert.equal(o1.refunded,8)
  assert.deepEqual((await request('GET',`${base}/orders?connectionId=${connection.id}&from=${D}&to=${D}&attributed=no`)).json().data.map((o:{order_id:string})=>o.order_id),['1003'])
  assert.deepEqual((await request('GET',`${base}/orders?connectionId=${connection.id}&from=${D}&to=${D}&scheme=payment_first&orderId=1001`)).json().data[0].credits.map((c:{login_id:string})=>c.login_id),['shop:a'])

  // Finance switches the default scheme; only available schemes are accepted.
  const settings=(await request('GET',`${base}/settings`)).json().data
  assert.equal((await request('PUT',`${base}/settings`,{revision:settings.revision,defaultScheme:'bogus'})).statusCode,400)
  assert.equal((await request('PUT',`${base}/settings`,{revision:settings.revision,defaultScheme:'payment_first'})).statusCode,200)
  m=await metrics();assert.equal(m.scheme,'payment_first');assert.deepEqual([m.rows['shop:a'].orders,m.rows['shop:a'].paid_amount,m.rows['shop:a'].refund_amount,m.rows.shop.orders],[2,100,8,0])

  // Counting "其他消息" changes the payment agent; the settings change queues a recompute.
  assert.equal((await request('PUT',`${base}/settings`,{revision:settings.revision+1,countOtherAsReply:true})).statusCode,200)
  assert.ok((await request('GET',`${base}/orders?connectionId=${connection.id}&from=${D}&to=${D}`)).json().pendingAttribution>0)
  const recompute=await runPerformanceSyncOnce(undefined,connection.id);assert.equal(recompute?.status,'succeeded');assert.equal(recompute!.stats.attributedOrders,6,'4 orders, then buyer A again for its new owner')
  assert.deepEqual(await credit('payment_only'),{'1001':'shop:b:1','1002':null,'1003':null,'1004':null})

  // Incremental: nothing re-read beyond the overlap; unchanged orders keep their credit.
  const before={...calls}
  const again=await sync();assert.equal(again.stats.attributedOrders,undefined,'no order needed recompute')
  assert.ok(calls.orders-before.orders<=2&&calls.refunds-before.refunds<=2)
  assert.equal((await db.query('SELECT count(*)::int AS n FROM perf_orders WHERE connection_id=$1',[connection.id])).rows[0].n,4)

  // P9 — schemes 8/9: buyer A's earliest paid order (1001) credits shop:b under scheme 2 once "其他消息" counts, so A is auto-owned by shop:b.
  const agentId=async(login:string)=>(await db.query('SELECT id FROM perf_agents WHERE connection_id=$1 AND login_id=$2',[connection.id,login])).rows[0].id as string
  const owners=async()=>(await db.query(`SELECT ag.login_id,p.owner_source FROM cust_profiles p JOIN perf_buyers b ON b.id=p.buyer_id JOIN perf_agents ag ON ag.id=p.owner_agent_id WHERE b.connection_id=$1`,[connection.id])).rows.map(r=>`${r.login_id}:${r.owner_source}`)
  assert.deepEqual(await owners(),['shop:b:auto'])
  assert.deepEqual(await credit('owner_only'),{'1001':'shop:b:1','1002':'shop:b:1','1003':null,'1004':null})
  assert.deepEqual(await credit('owner_collaborator_split'),{'1001':'shop:0.5,shop:b:0.5','1002':'shop:b:1','1003':null,'1004':null},'closer shares with the owner; owner alone when they closed it')
  // Scheme 5: "@b" in the memo credits shop:b; flags only count once a rule maps them.
  assert.deepEqual(await credit('memo_flag'),{'1001':null,'1002':null,'1003':'shop:b:1','1004':null})
  const flagUrl=`${base}/connections/${connection.id}/flag-rules`
  assert.equal((await request('PUT',flagUrl,{rules:[{flag:3,agentId:await agentId('shop')}]},headers(['performance:manage']))).statusCode,403,'flag rules decide commission: finance only')
  assert.equal((await request('PUT',flagUrl,{rules:[{flag:3,agentId:await agentId('shop')},{flag:3,agentId:await agentId('shop:a')}]})).statusCode,400)
  assert.equal((await request('PUT',flagUrl,{rules:[{flag:1,agentId:randomUUID()}]})).statusCode,400)
  assert.equal((await request('PUT',flagUrl,{rules:[{flag:3,agentId:await agentId('shop')},{flag:1,agentId:await agentId('shop:a')}]})).statusCode,200)
  await runPerformanceSyncOnce(undefined,connection.id)
  assert.deepEqual(await credit('memo_flag'),{'1001':'shop:1','1002':null,'1003':'shop:b:1','1004':null},'flag 3 → shop; an @mention beats the flag on 1003')
  const flags=(await request('GET',flagUrl,undefined,headers(['performance:read_own']))).json().data
  assert.deepEqual([flags.usage,flags.memoMentions,flags.creditedOrders],[[{flag:1,orders:1},{flag:3,orders:1}],1,2])
  // A hand-set owner wins immediately and survives later syncs; "auto" hands the customer back.
  const buyerA=(await db.query("SELECT buyer_id FROM perf_buyer_identities WHERE connection_id=$1 AND open_uid='O1'",[connection.id])).rows[0].buyer_id
  const profile=async(ownerAgentId:string|null)=>{const revision=(await db.query('SELECT revision FROM cust_profiles WHERE buyer_id=$1',[buyerA])).rows[0].revision
    const r=await request('PUT',`/api/customer-ops/customers/${buyerA}/profile`,{revision,name:null,wangwangId:null,phone:null,wechat:null,email:null,qq:null,address:null,memberIdentity:null,purchaseType:null,salesChannels:[],cycleMode:'system',cycleDays:null,note:null,accountId:null,ownerAgentId})
    assert.equal(r.statusCode,200,r.body)}
  await profile(await agentId('shop:a'))
  assert.deepEqual(await owners(),['shop:a:manual']);assert.deepEqual(await credit('owner_only'),{'1001':'shop:a:1','1002':'shop:a:1','1003':null,'1004':null},'re-attributed without waiting for a sync')
  await runPerformanceSyncOnce(undefined,connection.id);await sync()
  assert.deepEqual(await owners(),['shop:a:manual'],'automatic assignment never overwrites a manual owner')
  await profile('auto')
  assert.deepEqual(await owners(),['shop:b:auto']);assert.deepEqual(await credit('owner_only'),{'1001':'shop:b:1','1002':'shop:b:1','1003':null,'1004':null})
  // Scheme 7/9 ratios and automatic ownership belong to finance; changes queue a recompute.
  let current=(await request('GET',`${base}/settings`)).json().data
  assert.deepEqual([current.split_order_share,current.owner_share,current.auto_assign_owner],[0.5,0.5,true])
  assert.equal((await request('PUT',`${base}/settings`,{revision:current.revision,splitOrderShare:0.7},headers(['performance:manage']))).statusCode,403)
  assert.equal((await request('PUT',`${base}/settings`,{revision:current.revision,splitOrderShare:0.95})).statusCode,400)
  current=(await request('PUT',`${base}/settings`,{revision:current.revision,splitOrderShare:0.7,ownerShare:0.6})).json().data
  assert.ok((await request('GET',`${base}/orders?connectionId=${connection.id}&from=${D}&to=${D}`)).json().pendingAttribution>0)
  await runPerformanceSyncOnce(undefined,connection.id)
  assert.equal((await credit('order_payment_split'))['1001'],'shop:0.7,shop:b:0.3')
  assert.equal((await credit('owner_collaborator_split'))['1001'],'shop:0.4,shop:b:0.6')
  current=(await request('PUT',`${base}/settings`,{revision:current.revision,autoAssignOwner:false})).json().data
  assert.deepEqual(await owners(),[],'switching off removes automatic owners')
  await runPerformanceSyncOnce(undefined,connection.id)
  assert.deepEqual(await credit('owner_only'),{'1001':null,'1002':null,'1003':null,'1004':null})

  // Scope and isolation.
  assert.equal((await request('GET',`${base}/orders?connectionId=${connection.id}&from=${D}&to=${D}`,undefined,headers(['*'],tenantIds[1]))).statusCode,404)
  assert.equal((await request('GET',`${base}/chats?connectionId=${connection.id}&from=${D}&to=${D}`,undefined,headers([]))).statusCode,403)
  assert.deepEqual((await request('GET',`${base}/orders?connectionId=${connection.id}&from=${D}&to=${D}`,undefined,headers(['performance:read_own']))).json().data,[],'unbound user sees no orders')

  console.log(JSON.stringify({schemes:'ok',identityLinking:'ok',refundFen:'ok',refundShipping:'ok',noContactData:'ok',conversion:'ok',creditedSales:'ok',chatCategories:'ok',orderList:'ok',schemeSwitch:'ok',replyRuleRecompute:'ok',incremental:'ok',ownerSchemes:'ok',memoScheme:'ok',manualOwner:'ok',financeShares:'ok',isolation:'ok',livePlatformCalls:0}))
}finally{
  globalThis.fetch=originalFetch
  for(const id of tenantIds){await db.query('DELETE FROM audit_logs WHERE tenant_id=$1',[id]);await db.query('DELETE FROM tenants WHERE id=$1',[id])}
  await app.close();await db.end()
}
