import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { buildApp } from '../dist-server/server/app.js'
import { db } from '../dist-server/server/db.js'

const modulePath=process.env.PLAYWRIGHT_MODULE
if(!modulePath)throw new Error('Set PLAYWRIGHT_MODULE to the installed Playwright index.mjs path')
const {chromium}=await import(modulePath)
const app=await buildApp(),browser=await chromium.launch({headless:true,channel:'chrome'})
const output='/tmp/crm-1688-ui'
await mkdir(output,{recursive:true})
try{
  const user=(await db.query("SELECT id,tenant_id,email,display_name FROM users WHERE tenant_id=(SELECT id FROM tenants WHERE slug='default') AND status='active' AND deleted_at IS NULL LIMIT 1")).rows[0]
  assert.ok(user)
  const token=app.jwt.sign({sub:user.id,tenantId:user.tenant_id,email:user.email,displayName:user.display_name,roles:['ui-test'],permissions:['*']},{expiresIn:'5m'})
  const page=await browser.newPage({viewport:{width:1440,height:1000}})
  await page.emulateMedia({reducedMotion:'reduce'})
  const errors=[],writes=[];page.on('pageerror',error=>errors.push(error.message))
  // Runs against the real local API with no fixtures: this walk only reads, so refuse and count any write.
  await page.route('**/api/**',route=>{if(route.request().method()==='GET')return route.fallback();writes.push(route.request().url());return route.abort()})
  await page.addInitScript(value=>localStorage.setItem('ai_crm_access_token',value),token)
  const section=name=>page.locator('.sidebar').getByRole('button',{name,exact:true}).click()
  const tab=(group,name)=>page.getByRole('navigation',{name:group}).getByRole('button',{name,exact:true})
  await page.goto('http://127.0.0.1:5173/')
  await section('商品')
  await tab('商品','在售商品').waitFor()
  await page.locator('.goods-card').first().waitFor()
  await page.locator('.commerce-page img').first().evaluate(image=>image.complete?undefined:new Promise(resolve=>{image.addEventListener('load',resolve,{once:true});image.addEventListener('error',resolve,{once:true})}))
  await page.screenshot({path:`${output}/desktop.png`,fullPage:true})
  const overflow=()=>page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth+1)
  assert.equal(await overflow(),false,'desktop document overflow')
  for(const [group,names] of [['商品',['采集箱','上架队列','发布草稿','产品资料','在售商品']],['设置',['客服账号','绩效规则','自动上架','账号权限','调用记录','店铺授权']]]){
    await section(group)
    for(const name of names){
      await tab(group,name).click()
      await tab(group,name).and(page.locator('[aria-current="page"]')).waitFor()
    }
  }
  await page.locator('.settings-stack section').filter({has:page.getByRole('heading',{name:'商品应用',exact:true})}).getByRole('columnheader',{name:'授权到期'}).waitFor()
  await page.screenshot({path:`${output}/connections.png`,fullPage:true})
  await section('商品')
  await tab('商品','发布草稿').click()
  await page.getByRole('button',{name:'新建草稿',exact:true}).click()
  await page.getByRole('dialog',{name:'新建发布草稿'}).waitFor()
  await page.screenshot({path:`${output}/create-draft.png`})
  await page.getByRole('button',{name:'取消',exact:true}).click()
  await tab('商品','在售商品').click()
  await page.locator('.goods-card').first().waitFor()
  await page.setViewportSize({width:390,height:844})
  await page.screenshot({path:`${output}/mobile.png`,fullPage:true})
  assert.equal(await overflow(),false,'mobile document overflow')
  await page.locator('.goods-card .goods-media').first().click()
  await page.getByRole('dialog',{name:'平台商品详情'}).waitFor()
  await page.screenshot({path:`${output}/mobile-detail.png`})
  assert.equal(await overflow(),false,'mobile modal document overflow')
  assert.deepEqual(errors,[]);assert.deepEqual(writes,[])
  const images=await page.locator('.commerce-page img').evaluateAll(nodes=>({total:nodes.length,loaded:nodes.filter(node=>node.complete&&node.naturalWidth>0).length}))
  assert.ok(images.loaded>0,'platform product images must render')
  console.log(JSON.stringify({desktop:'ok',mobile:'ok',connections:'ok',createDraft:'ok',productDetail:'ok',documentOverflow:false,consoleErrors:errors.length,navigation:'ok',images,screenshots:output,platformWrites:writes.length}))
}finally{await browser.close();await app.close();await db.end()}
