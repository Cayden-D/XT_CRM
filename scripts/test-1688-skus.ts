import assert from 'node:assert/strict'
import { buildSkuRows, mapReviewedVariants, numberCustomValues, platformImagePath, platformSaleValues, skuKey, type SaleDimension } from '../shared/1688-skus.js'
import { validatePublishBody } from '../server/routes/1688.js'
import { collectedSkuAttributes } from '../server/integrations/1688-collected-skus.js'

const dimensions:SaleDimension[]=[{name:'p-1',propertyId:1,label:'颜色',required:true,maxItems:5,dataSource:[{value:10,text:'红色'},{value:20,text:'蓝色'}]},{name:'p-2',propertyId:2,label:'尺码',customizable:true}]
const selected={'p-1':[{value:10,text:'红色'},{value:20,text:'蓝色'}],'p-2':[{value:-1,text:'L',custom:true},{value:-1,text:'M',custom:true}]}
const rows=buildSkuRows(dimensions,selected)
assert.equal(rows.length,4);assert.equal(rows[0].sku_amountOnSale,null)
rows[0].sku_price=15;rows[0].sku_amountOnSale=7;rows[0].sku_cargoNumber='red-L'
const regenerated=buildSkuRows([...dimensions].reverse(),selected,rows)
const retained=regenerated.find(row=>skuKey(row.sku_props)===skuKey(rows[0].sku_props))!
assert.equal(retained.sku_price,15);assert.equal(retained.sku_amountOnSale,7);assert.equal(retained.sku_cargoNumber,'red-L')
assert.throws(()=>buildSkuRows(dimensions,{'p-1':[{value:10,text:'红色'},{value:10,text:'红色'}]}),/重复/)
assert.throws(()=>buildSkuRows(dimensions,{'p-1':[{value:-1,text:'紫色',custom:true}]}),/不合法/)
assert.throws(()=>buildSkuRows(dimensions,{}),/必填/)
const large=[{name:'p-1',label:'a',customizable:true},{name:'p-2',label:'b',customizable:true}]
const choices=Array.from({length:50},(_,i)=>({value:-1,text:String(i),custom:true}))
assert.throws(()=>buildSkuRows(large,{'p-1':choices,'p-2':choices}),/2000/)
const variants=[{id:'1',label:'红 L',attributes:{颜色:'红色',尺码:'L'},unit_price:'12.34',stock:null,image_url:null},{id:'2',label:'蓝 M',attributes:{颜色:'蓝色',尺码:'M'},unit_price:'15',stock:'8',image_url:null}]
const mapped=mapReviewedVariants(dimensions,variants,{'p-1':'颜色','p-2':'尺码'})
assert.equal(mapped.skuTable.length,2,'mapping must not invent missing combinations')
assert.equal(mapped.skuTable[0].sku_amountOnSale,null);assert.equal(mapped.skuTable[0].sku_price,12.34)
assert.throws(()=>mapReviewedVariants(dimensions,[variants[0],variants[0]],{'p-1':'颜色'}),/同一平台组合/)
assert.throws(()=>mapReviewedVariants(dimensions,variants,{'p-1':'不存在'}),/缺少/)
assert.throws(()=>mapReviewedVariants(dimensions,variants,{'unknown':'颜色'}),/必填|未知/)
const schema={data:{saleProp:{fields:{dataSource:dimensions}}}}
const body={formValues:{title:'测试',primaryPicture:{imageList:[{url:'https://example.org/image.png'}]},...mapped}}
assert.ok(validatePublishBody(schema,body).includes('SKU 规格和库存'))
mapped.skuTable[0].sku_amountOnSale=0
assert.deepEqual(validatePublishBody(schema,body),[])
mapped.skuTable.push(mapped.skuTable[0]);assert.ok(validatePublishBody(schema,body).includes('销售规格与 SKU 组合不一致'))
const collected={sku_props:[{name:'颜色分类',values:[{name:'黑色'}]},{name:'规格尺寸',values:[{name:'有线款'},{name:'无线款'}]}]}
const first=collectedSkuAttributes(collected,{label:'黑色>有线款',attributes:{规格:'黑色>有线款'}})
const second=collectedSkuAttributes(collected,{label:'黑色>无线款',attributes:{规格:'黑色>无线款'}})
assert.deepEqual(first,{颜色分类:'黑色',规格尺寸:'有线款'})
assert.deepEqual(second,{颜色分类:'黑色',规格尺寸:'无线款'})
assert.deepEqual(collectedSkuAttributes(collected,{label:'无线款>黑色',attributes:{}}),{})
assert.deepEqual(collectedSkuAttributes(collected,{label:'黑色>未知款',attributes:{}}),{})
assert.deepEqual(collectedSkuAttributes(collected,{label:'黑色>有线款',attributes:{颜色分类:'白色'}}),{})
const sourceDimensions:SaleDimension[]=[{name:'p-1627207',propertyId:1627207,label:'颜色分类',customizable:true,fieldType:'string'},{name:'p-1235',propertyId:1235,label:'规格尺寸',customizable:true,fieldType:'string'}]
const sourceMapped=mapReviewedVariants(sourceDimensions,[{id:'1',label:'黑色>有线款',attributes:first,unit_price:18,stock:1134,image_url:null},{id:'2',label:'黑色>无线款',attributes:second,unit_price:28,stock:4142,image_url:null}],{'p-1627207':'颜色分类','p-1235':'规格尺寸'})
assert.equal(sourceMapped.skuTable.length,2);assert.equal(sourceMapped.skuTable[0].sku_props[0].text,'黑色');assert.equal(sourceMapped.skuTable[1].sku_props[1].text,'无线款')
// Pictures on sale values (颜色 shows them), album paths as the platform writes them, custom values numbered -1, -2, ….
const pictured:SaleDimension[]=[{name:'p-3216',propertyId:3216,label:'颜色',required:true,supportImg:true,customizable:true,fieldType:'string'},{name:'p-450',propertyId:450,label:'尺码',customizable:true,fieldType:'string'}]
const withPictures=mapReviewedVariants(pictured,[
  {id:'a',label:'黑S',attributes:{颜色:'黑色',尺码:'S'},unit_price:10,stock:1,image_url:'https://cbu01.alicdn.com/img/ibank/O1CN-black.jpg'},
  {id:'b',label:'黑M',attributes:{颜色:'黑色',尺码:'M'},unit_price:10,stock:1,image_url:null},
  {id:'c',label:'白S',attributes:{颜色:'白色',尺码:'S'},unit_price:10,stock:1,image_url:null}],{'p-3216':'颜色','p-450':'尺码'})
assert.deepEqual(withPictures.saleProp['p-3216'],[{value:-1,text:'黑色',custom:true,imgUrl:'img/ibank/O1CN-black.jpg'},{value:-2,text:'白色',custom:true}])
assert.deepEqual(withPictures.saleProp['p-450'].map(c=>c.value),[-3,-4],'every custom value has its own number')
assert.deepEqual(withPictures.skuTable.map(r=>r.sku_props.map(p=>p.value)),[[-1,-3],[-1,-4],[-2,-3]],'SKU rows follow the numbering')
assert.equal(new Set(withPictures.skuTable.map(r=>skuKey(r.sku_props))).size,3)
assert.equal(platformImagePath('https://img.alicdn.com/imgextra/a.jpg'),'https://img.alicdn.com/imgextra/a.jpg')
const editorDraft={saleProp:{'p-3216':[{value:-1,text:'红',custom:true},{value:-1,text:'蓝',custom:true}]},skuTable:[{sku_props:[{id:3216,name:'p-3216',label:'颜色',value:-1,text:'红'}],sku_amountOnSale:1},{sku_props:[{id:3216,name:'p-3216',label:'颜色',value:-1,text:'蓝'}],sku_amountOnSale:1}]}
const renumbered=numberCustomValues(editorDraft)
assert.deepEqual([(renumbered.saleProp as any)['p-3216'].map((c:any)=>c.value),(renumbered.skuTable as any[]).map(r=>r.sku_props[0].value)],[[-1,-2],[-1,-2]],'an editor draft with -1 everywhere is renumbered at publish')
// The body sent to the platform has the example's shape: bare SKU properties, no readonly picture, price only when quoting by SKU.
const sent=platformSaleValues({quotationType:{value:2},...withPictures}) as any
assert.deepEqual(sent.skuTable[0],{sku_props:[{id:3216,name:'p-3216',label:'颜色',value:-1,text:'黑色'},{id:450,name:'p-450',label:'尺码',value:-3,text:'S'}],sku_amountOnSale:1,sku_cargoNumber:'',sku_status:1})
assert.deepEqual(sent.saleProp.custom,[])
assert.equal(platformSaleValues({quotationType:{value:1},...withPictures}).skuTable[0].sku_price,10,'quoting by SKU keeps the price')
const foreign=platformSaleValues({saleProp:{'p-3216':[{value:-1,text:'红',custom:true,imgUrl:'https://img.alicdn.com/imgextra/a.jpg'}]},skuTable:[]}) as any
assert.deepEqual(foreign.saleProp['p-3216'][0],{value:-1,text:'红',custom:true},'a picture outside the album is not sent')
console.log(JSON.stringify({platformShape:'ok',salePictures:'ok',customNumbering:'ok',cartesianGeneration:'ok',unknownStock:'ok',stableCombinationRetention:'ok',duplicateChoiceGuard:'ok',enumGuard:'ok',requiredDimensions:'ok',combinationLimit:'ok',reviewedVariantMapping:'ok',sparseCombinations:'ok',duplicateMappingGuard:'ok',missingAttributeGuard:'ok',publishConsistency:'ok',collectedDimensionRecovery:'ok'}))
