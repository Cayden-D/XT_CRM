import assert from 'node:assert/strict'
import {titleLength,titleLimit} from '../shared/1688-title.js'
process.env.DASHSCOPE_API_KEY='title-fixture'
process.env.DASHSCOPE_BASE_URL='https://title-fixture.invalid/compatible-mode/v1'
const [{prepareAgentFields,applyAgentFields,sourceNames,tradeName,withoutNames},{validatePublishBody},{db}]=await Promise.all([import('../server/integrations/1688-agent.js'),import('../server/routes/1688.js'),import('../server/db.js')])
const originalFetch=globalThis.fetch
const schema={data:{title:{fields:{maxLength:60}}}}
const proposal=(title:string)=>({title,catProp:{},unknown:[]})
const long='恩吉车载无线充气泵便携式汽车用电动打气筒轿车轮胎高压数显充气宝'
let calls=0,stillLong=false,truncated=false,lastUser=''
try{
 assert.equal(titleLength(long),62)
 assert.equal(titleLength('中A1 '),5)
 assert.equal(titleLength('中'.repeat(30)),60)
 assert.equal(titleLength('A'.repeat(60)),60)
 assert.equal(titleLength('😀'),2)
 assert.equal(titleLimit({}),60)
 assert.equal(applyAgentFields(schema,{},proposal('中'.repeat(30))).title.length,30)
 assert.throws(()=>applyAgentFields(schema,{},proposal(long)),/AI 标题超过/)
 assert.throws(()=>applyAgentFields({data:{title:{fields:{maxLength:10}}}},{},proposal('中'.repeat(6))),/AI 标题超过/)
 const body=(title:string)=>({formValues:{title,primaryPicture:{imageList:[{url:'https://cbu01.alicdn.com/img/a.jpg'}]}}})
 assert.deepEqual(validatePublishBody(schema,body('中'.repeat(30))),[])
 assert.ok(validatePublishBody(schema,body(long)).some(x=>x.includes('标题超过')))
 globalThis.fetch=async(input,init)=>{
  assert.equal(String(input),'https://title-fixture.invalid/compatible-mode/v1/chat/completions')
  const data=JSON.parse(String(init?.body));calls++;if(data.max_tokens!==500)lastUser=data.messages.at(-1).content
  assert.match(data.messages[0].content,/纯中文最多 30 字/)
  const rewrite=data.max_tokens===500
  const result=rewrite?{title:stillLong?long:'恩吉车载无线数显充气泵'}:proposal(long)
  return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(result)},finish_reason:rewrite&&truncated?'length':'stop'}]}),{status:200})
 }
 const prepared=await prepareAgentFields(schema,{priceRange:[{pricerange_price:44}]},{name:long},[])
 assert.equal(prepared.title,'恩吉车载无线数显充气泵');assert.equal(prepared.priceRange[0].pricerange_price,44);assert.equal(calls,2)
 // The source's brand and shop names never stay in the title: the model is told, and whatever it still writes is removed.
 calls=0
 const clean=await prepareAgentFields(schema,{},{name:long},[],['义乌市恩吉汽车用品有限公司','恩吉'])
 assert.equal(clean.title,'车载无线数显充气泵');assert.ok(JSON.parse(lastUser).forbiddenInTitle.includes('恩吉'))
 // Which names those are: brand-like attributes, the seller and its trade name — not the shop's own brand, not product words.
 assert.equal(tradeName('浙江省义乌市拓洋日用品有限公司'),'拓洋');assert.equal(tradeName('恩吉汽车用品旗舰店'),'恩吉');assert.equal(tradeName('深圳市电子科技有限公司'),'')
 assert.deepEqual(sourceNames({attributes:{品牌:'恩吉/ENJI',生产厂家:'无',材质:'ABS'},seller_name:'义乌市恩吉汽车用品有限公司',category_path:'汽车用品>充气泵'},{},['ENJI']),['义乌市恩吉汽车用品有限公司','恩吉'])
 assert.deepEqual(sourceNames({attributes:{品牌:'无品牌'},seller_name:'香薰工厂',category_path:'汽车用品>车载香薰'},{}),['香薰工厂'],'a trade name that names the goods stays')
 assert.equal(withoutNames('【恩吉】车载充气泵 ENJI 恩吉 便携',['恩吉','enji']),'车载充气泵 便携')
 calls=0;stillLong=true
 await assert.rejects(()=>prepareAgentFields(schema,{}, {name:long},[]),/AI 标题超过/);assert.equal(calls,2)
 calls=0;truncated=true
 await assert.rejects(()=>prepareAgentFields(schema,{}, {name:long},[]),/精简结果不完整/);assert.equal(calls,2)
 console.log(JSON.stringify({weightedLimit:'ok',exactBoundary:'ok',schemaLimit:'ok',generationPrompt:'ok',sourceNamesRemoved:'ok',oneRewrite:'ok',overLimitBlocked:'ok',incompleteBlocked:'ok',manualPublishGuard:'ok',livePlatformWrites:0}))
}finally{globalThis.fetch=originalFetch;await db.end()}
