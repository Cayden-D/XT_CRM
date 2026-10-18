import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { buildApp } from '../server/app.js'
import { db } from '../server/db.js'
import { appCredentials, connectionToken, decryptGrant, IntegrationError, saveConnection, signApi, stateHash } from '../server/integrations/1688.js'
import { accountRole } from '../server/integrations/1688-performance.js'

// All platform requests are intercepted; this suite never reaches 1688.
const originalFetch=globalThis.fetch
const marker=randomUUID(),tenantIds:string[]=[]
const app=await buildApp()
const product=appCredentials('product'),perf=appCredentials('performance')
assert.notEqual(product.appKey,perf.appKey,'performance app must use its own AppKey')
let refreshClients:string[]=[],subAccountMode:'main'|'sub'='main',aliId='',rejectRefresh=false
const calls:{api:string;token:string}[]=[]
const response=(data:unknown)=>new Response(JSON.stringify(data),{status:200})
globalThis.fetch=async(input,init)=>{
  const url=String(input)
  assert.ok(url.startsWith('https://gw.open.1688.com/openapi/'),'unexpected network destination')
  const params=init?.body instanceof URLSearchParams?init.body:null
  assert.ok(params)
  if(url.includes('system.oauth2/getToken')){
    const client=params.get('client_id')!
    assert.ok(url.endsWith(`/${client}`))
    assert.equal(params.get('client_secret'),client===perf.appKey?perf.secret:product.secret)
    if(params.get('grant_type')==='refresh_token'){
      refreshClients.push(client)
      // As observed live (2026-10-16) when the account was authorized again elsewhere: HTTP 400 echoing the token.
      if(rejectRefresh)return new Response(JSON.stringify({error:'invalid_request',error_description:`wrong refreshToken ${params.get('refresh_token')}`}),{status:400})
      assert.equal(params.get('refresh_token'),client===perf.appKey?'perf-refresh':'product-refresh','refresh must use the grant of the same app')
    }
    const prefix=client===perf.appKey?'perf':'product'
    return response({access_token:`${prefix}-access-new`,refresh_token:`${prefix}-refresh`,aliId,resource_owner:'shop-main',expires_in:36000,refresh_token_timeout:'20990101000000000+0800'})
  }
  const flat=Object.fromEntries(params.entries())
  const path=url.split('/openapi/')[1]
  assert.ok(path.endsWith(`/${perf.appKey}`),'performance APIs must be called with the performance AppKey')
  assert.equal(flat._aop_signature,signApi(path,flat,perf.secret),'performance APIs must be signed with the performance secret')
  assert.ok(flat.access_token.startsWith('perf-'),'performance APIs must never receive a product token')
  calls.push({api:path.split('/')[3],token:flat.access_token})
  if(path.includes('alibaba.account.basic'))return response({result:{companyName:'绩效测试店铺',userId:aliId}})
  if(path.includes('alibaba.subAccount.list'))return response(subAccountMode==='main'
    ?{mainUserId:aliId,mainLoginId:'shop-main',subAccountList:[{loginId:'shop-main:a',userId:1},{loginId:'shop-main:b',userId:2}]}
    :{mainUserId:'999',mainLoginId:'shop-main'})
  throw new Error('Unmocked API')
}

try{
  for(let i=0;i<2;i++)tenantIds.push((await db.query('INSERT INTO tenants(name,slug)VALUES($1,$2)RETURNING id',['1688 performance test',`test-1688-perf-${marker}-${i}`])).rows[0].id)
  const tenantId=tenantIds[0]
  const actor=(await db.query("INSERT INTO users(tenant_id,email,password_hash,display_name,status)VALUES($1,$2,'unused','测试账号','active')RETURNING id",[tenantId,`perf-${marker}@integration.local`])).rows[0].id
  const token=(tenant:string,permissions:string[])=>app.jwt.sign({sub:actor,tenantId:tenant,email:'test',displayName:'测试账号',roles:[],permissions})
  const auth=(permissions:string[],tenant=tenantId)=>({authorization:`Bearer ${token(tenant,permissions)}`})
  const all=auth(['*'])
  const request=(method:'GET'|'POST'|'PUT',url:string,payload?:object,headers=all)=>app.inject({method,url,headers,...(payload?{payload}:{})})
  const base='/api/integrations/1688/performance'
  aliId=`perf-${marker}`

  // Same shop, two independent grants stored in separate tables.
  const productConnection=await saveConnection(tenantId,actor,{access_token:'product-access',refresh_token:'product-refresh',expires_in:36000,aliId,resource_owner:'shop-main',refresh_token_timeout:'20990101000000000+0800'})
  const perfConnection=await saveConnection(tenantId,actor,{access_token:'perf-access',refresh_token:'perf-refresh',expires_in:36000,aliId,resource_owner:'shop-main',refresh_token_timeout:'20990101000000000+0800'},Date.now(),'performance')
  assert.notEqual(productConnection.id,perfConnection.id)
  assert.equal(perfConnection.app_key,perf.appKey);assert.equal(productConnection.app_key,product.appKey)

  // Cross-use is structurally impossible: each app only finds its own connections.
  await assert.rejects(connectionToken(productConnection.id,tenantId,actor,false,'performance'),(e:unknown)=>e instanceof IntegrationError&&e.code==='NOT_FOUND')
  await assert.rejects(connectionToken(perfConnection.id,tenantId,actor,false,'product'),(e:unknown)=>e instanceof IntegrationError&&e.code==='NOT_FOUND')
  assert.equal((await request('POST',`${base}/connections/${productConnection.id}/test`)).statusCode,404)
  assert.equal((await request('POST',`${base}/connections/${productConnection.id}/refresh`)).statusCode,404)
  assert.equal((await request('POST',`/api/integrations/1688/connections/${perfConnection.id}/refresh`)).statusCode,404)
  assert.equal((await request('POST',`/api/integrations/1688/connections/${perfConnection.id}/sync`,{pageNo:1})).statusCode,404)
  // A grant stored under the wrong AppKey is rejected even inside the performance table.
  await db.query('UPDATE integration_1688_perf_connections SET app_key=$2 WHERE id=$1',[perfConnection.id,product.appKey])
  await assert.rejects(connectionToken(perfConnection.id,tenantId,actor,false,'performance'),(e:unknown)=>e instanceof IntegrationError&&e.code==='APP_MISMATCH')
  await db.query('UPDATE integration_1688_perf_connections SET app_key=$2 WHERE id=$1',[perfConnection.id,perf.appKey])

  // Listings and tokens stay separate; neither list exposes ciphertext or tokens.
  const perfList=await request('GET',`${base}/connections`);assert.equal(perfList.statusCode,200)
  assert.deepEqual(perfList.json().data.map((c:{id:string})=>c.id),[perfConnection.id]);assert.equal(perfList.json().configured,true)
  assert.ok(!/token_ciphertext|perf-access|perf-refresh/.test(perfList.body))
  const productList=await request('GET','/api/integrations/1688/connections')
  assert.deepEqual(productList.json().data.map((c:{id:string})=>c.id),[productConnection.id])

  // Permission boundaries.
  assert.equal((await request('GET',`${base}/connections`,undefined,auth(['integration:manage']))).statusCode,403,'product permissions do not grant performance access')
  assert.equal((await request('POST',`${base}/authorizations`,undefined,auth(['performance:read']))).statusCode,403)
  assert.equal((await request('POST',`${base}/connections/${perfConnection.id}/test`,undefined,auth(['*'],tenantIds[1]))).statusCode,404,'tenant isolation')

  // Main-account grant verifies and records the sub-account count.
  const tested=await request('POST',`${base}/connections/${perfConnection.id}/test`);assert.equal(tested.statusCode,200,tested.body)
  assert.deepEqual(tested.json().data,{verified:true,accountRole:'main',subAccountCount:2})
  const stored=(await db.query('SELECT display_name,account_role,sub_account_count,member_capability FROM integration_1688_perf_connections WHERE id=$1',[perfConnection.id])).rows[0]
  assert.deepEqual(stored,{display_name:'绩效测试店铺',account_role:'main',sub_account_count:2,member_capability:'available'})
  // A sub-account grant is flagged and must be re-authorized with the main account.
  subAccountMode='sub'
  await db.query("UPDATE integration_1688_perf_connections SET login_id='shop-main:cs' WHERE id=$1",[perfConnection.id])
  const subTest=await request('POST',`${base}/connections/${perfConnection.id}/test`);assert.equal(subTest.statusCode,409);assert.match(subTest.body,/主账号/)
  assert.equal((await db.query('SELECT account_role FROM integration_1688_perf_connections WHERE id=$1',[perfConnection.id])).rows[0].account_role,'sub')
  subAccountMode='main'
  await db.query("UPDATE integration_1688_perf_connections SET login_id='shop-main' WHERE id=$1",[perfConnection.id])
  assert.equal(accountRole({ali_id:'1',login_id:'shop:cs'},'',''),'sub')
  assert.equal(accountRole({ali_id:'1',login_id:'shop'},'',''),'unknown')

  // Refreshing the performance grant uses the performance app and leaves the product grant untouched.
  await db.query("UPDATE integration_1688_perf_connections SET access_expires_at=now()-interval '1 minute' WHERE id=$1",[perfConnection.id])
  const refreshed=await request('POST',`${base}/connections/${perfConnection.id}/refresh`);assert.equal(refreshed.statusCode,200,refreshed.body)
  assert.deepEqual(refreshClients,[perf.appKey])
  assert.equal((await decryptGrant((await db.query('SELECT token_ciphertext FROM integration_1688_perf_connections WHERE id=$1',[perfConnection.id])).rows[0].token_ciphertext)).access_token,'perf-access-new')
  assert.equal((await decryptGrant((await db.query('SELECT token_ciphertext FROM integration_1688_connections WHERE id=$1',[productConnection.id])).rows[0].token_ciphertext)).access_token,'product-access')
  assert.ok(calls.every(call=>call.token.startsWith('perf-')))

  // A refresh token the platform rejects marks the shop for re-authorization with a clear message that never echoes the token.
  rejectRefresh=true
  await db.query("UPDATE integration_1688_perf_connections SET access_expires_at=now()-interval '1 minute' WHERE id=$1",[perfConnection.id])
  const rejected=await request('POST',`${base}/connections/${perfConnection.id}/refresh`)
  assert.equal(rejected.statusCode,409,rejected.body);assert.match(rejected.json().message,/授权已失效.*请重新授权/);assert.doesNotMatch(rejected.body,/perf-refresh|wrong refreshToken/)
  assert.equal((await db.query('SELECT status FROM integration_1688_perf_connections WHERE id=$1',[perfConnection.id])).rows[0].status,'reauthorize')
  assert.equal((await db.query("SELECT error_code FROM integration_1688_operations WHERE perf_connection_id=$1 AND api_name LIKE '%oauth2%' ORDER BY created_at DESC LIMIT 1",[perfConnection.id])).rows[0].error_code,'REAUTHORIZE')
  rejectRefresh=false
  await db.query("UPDATE integration_1688_perf_connections SET status='connected',access_expires_at=now()+interval '1 hour' WHERE id=$1",[perfConnection.id])

  // OAuth: URL carries the performance AppKey; a product-app state cannot complete a performance authorization.
  const started=await request('POST',`${base}/authorizations`);assert.equal(started.statusCode,200)
  const authUrl=new URL(started.json().data.authorizationUrl)
  assert.equal(authUrl.searchParams.get('client_id'),perf.appKey);assert.equal(authUrl.searchParams.get('redirect_uri'),perf.redirect)
  const productState=randomUUID()
  await db.query("INSERT INTO integration_1688_oauth_states(state_hash,tenant_id,created_by,app_key,redirect_uri,expires_at)VALUES($1,$2,$3,$4,$5,now()+interval '10 minutes')",[stateHash(productState),tenantId,actor,product.appKey,product.redirect])
  const callback=(state:string)=>{const url=new URL(perf.redirect);url.searchParams.set('code','mock-code');url.searchParams.set('state',state);return url.href}
  assert.equal((await request('POST',`${base}/authorizations/complete`,{callbackUrl:callback(productState)})).statusCode,409)
  const completed=await request('POST',`${base}/authorizations/complete`,{callbackUrl:callback(authUrl.searchParams.get('state')!)});assert.equal(completed.statusCode,201,completed.body)
  assert.equal(completed.json().data.id,perfConnection.id,'re-authorizing the same shop updates its performance connection')
  assert.equal((await request('POST',`${base}/authorizations/complete`,{callbackUrl:callback(authUrl.searchParams.get('state')!)})).statusCode,409,'state is single-use')

  // Operation logs are separated by app.
  const perfOps=(await request('GET',`${base}/operations`)).json().data as {api_name:string}[]
  assert.ok(perfOps.some(op=>op.api_name==='alibaba.subAccount.list'))
  const productOps=(await request('GET','/api/integrations/1688/operations')).json().data as {api_name:string}[]
  assert.ok(!productOps.some(op=>op.api_name==='alibaba.subAccount.list'))

  // Settings: defaults, editable thresholds, finance-only attribution scheme, optimistic revision.
  const defaults=await request('GET',`${base}/settings`);assert.equal(defaults.statusCode,200)
  assert.deepEqual((({attribution_window_hours,unanswered_threshold_seconds,default_scheme,revision})=>({attribution_window_hours,unanswered_threshold_seconds,default_scheme,revision}))(defaults.json().data),{attribution_window_hours:72,unanswered_threshold_seconds:180,default_scheme:'order_first',revision:1})
  const manager=auth(['performance:read','performance:manage']),finance=auth(['performance:read','payroll:manage'])
  const window=await request('PUT',`${base}/settings`,{revision:1,attributionWindowHours:48,unansweredThresholdSeconds:300},manager);assert.equal(window.statusCode,200,window.body)
  assert.equal(window.json().data.attribution_window_hours,48);assert.equal(window.json().data.unanswered_threshold_seconds,300)
  assert.equal((await request('PUT',`${base}/settings`,{revision:2,defaultScheme:'payment_first'},manager)).statusCode,403,'managers cannot change the commission scheme')
  assert.equal((await request('PUT',`${base}/settings`,{revision:2,attributionWindowHours:24},finance)).statusCode,403,'finance cannot change metric thresholds')
  assert.equal((await request('PUT',`${base}/settings`,{revision:1,defaultScheme:'payment_first'},finance)).statusCode,409,'stale revision')
  const scheme=await request('PUT',`${base}/settings`,{revision:2,defaultScheme:'payment_first'},finance);assert.equal(scheme.statusCode,200,scheme.body);assert.equal(scheme.json().data.default_scheme,'payment_first')
  assert.ok((await request('PUT',`${base}/settings`,{revision:3,attributionWindowHours:0},manager)).statusCode>=400)
  assert.ok((await request('PUT',`${base}/settings`,{revision:3,defaultScheme:'unknown'},finance)).statusCode>=400)
  assert.equal((await db.query("SELECT count(*)::int AS n FROM audit_logs WHERE tenant_id=$1 AND action='performance.settings.update'",[tenantId])).rows[0].n,2)

  // Disabling the performance connection leaves the product connection active.
  assert.equal((await request('POST',`${base}/connections/${perfConnection.id}/disable`)).statusCode,200)
  assert.equal((await db.query('SELECT status FROM integration_1688_connections WHERE id=$1',[productConnection.id])).rows[0].status,'connected')
  assert.equal((await request('POST',`${base}/connections/${perfConnection.id}/test`)).statusCode,409)

  console.log(JSON.stringify({separateTables:'ok',crossUseRejected:'ok',appKeyMismatch:'ok',signedWithPerformanceSecret:'ok',independentRefresh:'ok',mainAccountCheck:'ok',oauthStateIsolation:'ok',operationLogs:'ok',settings:'ok',permissions:'ok',tenantIsolation:'ok'}))
}finally{
  globalThis.fetch=originalFetch
  for(const id of tenantIds){await db.query('DELETE FROM audit_logs WHERE tenant_id=$1',[id]);await db.query('DELETE FROM tenants WHERE id=$1',[id])}
  await app.close();await db.end()
}
