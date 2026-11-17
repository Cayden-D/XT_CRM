import assert from 'node:assert/strict'
import {titleLength,titleLimit,truncateTitle} from '../shared/1688-title.js'
process.env.DASHSCOPE_API_KEY='title-fixture'
process.env.DASHSCOPE_BASE_URL='https://title-fixture.invalid/compatible-mode/v1'
const [{prepareAgentFields,applyAgentFields,sourceNames,tradeName,withoutNames},{validatePublishBody},{db}]=await Promise.all([import('../server/integrations/1688-agent.js'),import('../server/routes/1688.js'),import('../server/db.js')])
const originalFetch=globalThis.fetch
const schema={data:{title:{fields:{maxLength:60}}}}
const proposal=(title:string)=>({title,catProp:{},unknown:[]})
const long='恩吉车载无线充气泵便携式汽车用电动打气筒轿车轮胎高压数显充气宝'
let calls=0,truncated=false,lastUser='',rewritePrompt='',firstTitle=long,revisedTitle='恩吉车载无线数显充气泵'
try{
 assert.equal(titleLength(long),62)
 assert.equal(titleLength('中A1 '),5)
 assert.equal(titleLength('中'.repeat(30)),60)
 assert.equal(titleLength('A'.repeat(60)),60)
 assert.equal(titleLength('😀'),2)
 assert.equal(truncateTitle('12V 车载吸尘器',8),'12V 车载')
 assert.equal(truncateTitle('A😀B',2),'A')
 assert.equal(truncateTitle('车载,吸尘器',5),'车载')
 assert.equal(truncateTitle('车载吸尘器 18000Pa',15),'车载吸尘器')
 assert.equal(titleLimit({}),60)
 assert.equal(titleLimit({data:{title:{fields:{maxLength:100}}}}),60)
 assert.equal(titleLimit({data:{title:{fields:{maxLength:48}}}}),48)
 assert.equal(applyAgentFields(schema,{},proposal('中'.repeat(30))).title.length,30)
 assert.throws(()=>applyAgentFields(schema,{},proposal(long)),/AI 标题超过/)
 assert.throws(()=>applyAgentFields({data:{title:{fields:{maxLength:10}}}},{},proposal('中'.repeat(6))),/AI 标题超过/)
 const body=(title:string)=>({formValues:{title,primaryPicture:{imageList:[{url:'https://cbu01.alicdn.com/img/a.jpg'}]}}})
 assert.deepEqual(validatePublishBody(schema,body('中'.repeat(30))),[])
 assert.ok(validatePublishBody(schema,body(long)).some(x=>x.includes('标题超过')))
 globalThis.fetch=async(input,init)=>{
  assert.equal(String(input),'https://title-fixture.invalid/compatible-mode/v1/chat/completions')
  const data=JSON.parse(String(init?.body));calls++;if(data.max_tokens!==500)lastUser=data.messages.at(-1).content
  assert.match(data.messages[0].content,/纯中文最多 (?:24|30) 字/)
  const rewrite=data.max_tokens===500
  if(rewrite)rewritePrompt=data.messages[0].content
  else assert.match(data.messages[0].content,/(?:41–48|51–60).*跨境批发.*工厂直销/)
  const result=rewrite?{title:revisedTitle}:proposal(firstTitle)
  return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(result)},finish_reason:rewrite&&truncated?'length':'stop'}]}),{status:200})
 }
 const prepared=await prepareAgentFields(schema,{priceRange:[{pricerange_price:44}]},{name:long},[])
 assert.equal(prepared.title,long.slice(0,30));assert.equal(prepared.priceRange[0].pricerange_price,44);assert.equal(calls,1)
 // The source's brand and shop names never stay in the title: the model is told, and whatever it still writes is removed.
 calls=0
 firstTitle=long+'汽车'
 const clean=await prepareAgentFields(schema,{},{name:long},[],['义乌市恩吉汽车用品有限公司','恩吉'])
 assert.equal(clean.title,(long+'汽车').slice(2,32));assert.ok(JSON.parse(lastUser).forbiddenInTitle.includes('恩吉'));assert.equal(calls,1)
 // Which names those are: brand-like attributes, the seller and its trade name — not the shop's own brand, not product words.
 assert.equal(tradeName('浙江省义乌市拓洋日用品有限公司'),'拓洋');assert.equal(tradeName('恩吉汽车用品旗舰店'),'恩吉');assert.equal(tradeName('深圳市电子科技有限公司'),'')
 assert.deepEqual(sourceNames({attributes:{品牌:'恩吉/ENJI',生产厂家:'无',材质:'ABS'},seller_name:'义乌市恩吉汽车用品有限公司',category_path:'汽车用品>充气泵'},{},['ENJI']),['义乌市恩吉汽车用品有限公司','恩吉'])
 assert.deepEqual(sourceNames({attributes:{品牌:'无品牌'},seller_name:'香薰工厂',category_path:'汽车用品>车载香薰'},{}),['香薰工厂'],'a trade name that names the goods stays')
 assert.equal(withoutNames('【恩吉】车载充气泵 ENJI 恩吉 便携',['恩吉','enji']),'车载充气泵 便携')
 const strictSchema={data:{title:{fields:{maxLength:48}}}}
 calls=0;firstTitle='１２Ｖ '+long.repeat(5)
 const clipped=await prepareAgentFields(strictSchema,{}, {name:long},[])
 assert.equal(clipped.title,'12V '+long.slice(0,22));assert.equal(titleLength(clipped.title),48);assert.equal(calls,1)
 const short='恩吉车载充气泵'
 const details={name:'车载无线数显充气泵',category:'汽车用品',description:'适用汽车轮胎、自行车和球类，支持自动充停，适合跨境批发。'}
 calls=0;truncated=false;firstTitle=short;revisedTitle='恩吉车载无线数显充气泵，汽车轮胎自行车球类自动充停跨境批发'
 const expanded=await prepareAgentFields(schema,{},details,[],['恩吉'])
 assert.equal(expanded.title,'车载无线数显充气泵,汽车轮胎自行车球类自动充停跨境批发')
 assert.ok(titleLength(expanded.title)>=51&&titleLength(expanded.title)<=60)
 assert.match(rewritePrompt,/补入尚未覆盖的真实商品特征/);assert.equal(calls,2)
 for(const candidate of [long+'汽车','充气泵','恩吉']){
  calls=0;revisedTitle=candidate
  assert.equal((await prepareAgentFields(schema,{},details,[],['恩吉'])).title,'车载充气泵');assert.equal(calls,2)
 }
 calls=0;truncated=true
 assert.equal((await prepareAgentFields(schema,{},details,[],['恩吉'])).title,'车载充气泵');assert.equal(calls,2)
 calls=0;truncated=false;firstTitle='中'.repeat(30)
 assert.equal(titleLength((await prepareAgentFields(schema,{},details,[])).title),60);assert.equal(calls,1)
 console.log(JSON.stringify({weightedLimit:'ok',exactBoundary:'ok',schemaLimit:'ok',generationPrompt:'ok',sourceNamesRemoved:'ok',overLimitClipped:'ok',keywordExpansion:'ok',keepsValidShortTitle:'ok',manualPublishGuard:'ok',livePlatformWrites:0}))
}finally{globalThis.fetch=originalFetch;await db.end()}
