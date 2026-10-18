type Json=Record<string,any>

const normalized=(value:unknown)=>String(value??'').trim().toLocaleLowerCase().replace(/[\s/／_-]+/g,'')
const placeholder=/^(详情可咨询客服|详情咨询客服|请咨询客服|咨询客服|详询|暂无|未知|不详|[-—]+)$/
/**
 * Names the same attribute goes by in different categories of the same site (e.g. a seller's "电压" is the platform's
 * "额定电压"). Used only when no source attribute has the field's exact name, and only when it gives a single value.
 */
const SYNONYMS=[
  ['额定电压','电压','输入电压','工作电压'],
  ['额定输入功率','额定功率','输入功率','功率'],
  ['外形尺寸','尺寸','产品尺寸','商品尺寸','规格尺寸'],
  ['净重','重量','产品重量','商品重量'],
  ['主要适用范围','适用范围','适用场景'],
  ['电源型式','供电方式','电源方式'],
  ['额定转速','转速'],
  ['电源线长','电源线长度','电源线尺寸'],
  ['充气管长','充气管长度','气管长度'],
  ['材质','材料','产品材质'],
  ['型号','规格型号','产品型号'],
].map(group=>group.map(normalized))
const synonymsOf=(label:string)=>SYNONYMS.find(group=>group.includes(normalized(label)))??[]

/** Source value for a platform field: by platform attribute ID, then exact name, then a synonym. */
function sourceFor(field:Json,rows:Json[],attributes:Json){
  const byRow=rows.filter(row=>row&&typeof row==='object'&&(field.propertyId&&String(row.attrNameId||'')===String(field.propertyId)||normalized(row.attrName)===normalized(field.label)))
  if(byRow.length>1)return null
  if(byRow.length===1)return {value:String(byRow[0].attrValue??'').trim(),ids:Array.isArray(byRow[0].attrValueIds)?byRow[0].attrValueIds.map(String):[],
    sameProperty:Boolean(field.propertyId)&&String(byRow[0].attrNameId||'')===String(field.propertyId)}
  const exact=Object.entries(attributes).filter(([label])=>normalized(label)===normalized(field.label))
  if(exact.length>1)return null
  if(exact.length===1)return {value:String(exact[0][1]??'').trim(),ids:[] as string[],sameProperty:false}
  const names=synonymsOf(field.label)
  const values=[...new Set([...rows.filter(row=>names.includes(normalized(row?.attrName))).map(row=>String(row.attrValue??'').trim()),
    ...Object.entries(attributes).filter(([label])=>names.includes(normalized(label))).map(([,value])=>String(value??'').trim())].filter(Boolean))]
  return values.length===1?{value:values[0],ids:[] as string[],sameProperty:false}:null
}

export function collectedCategoryDefaults(schema:Json,source:Json|null){
  const result:Json={}
  if(!source||source.source!=='1688'||String(source.source_category_id||'')!==String(schema.global?.systemParam?.catId||''))return result
  const rows=Array.isArray(source.source_category_attributes)?source.source_category_attributes:[]
  const attributes=source.attributes&&typeof source.attributes==='object'?source.attributes:{}
  for(const field of schema.data?.catProp?.fields?.dataSource||[]){
    if(!field?.name||!field.label||field.readonly||field.visible===false)continue
    const found=sourceFor(field,rows,attributes)
    const sourceValue=found?.value??''
    if(!sourceValue||placeholder.test(sourceValue)||field.maxLength&&sourceValue.length>field.maxLength)continue
    if(!Array.isArray(field.dataSource)||!field.dataSource.length){
      if(['input','cbuinput'].includes(field.uiType))result[field.name]=sourceValue
      continue
    }
    // Multi-select values cannot be represented by the single-choice editor yet; leave them for review.
    if(field.uiType==='checkbox')continue
    const sourceIds=(found?.ids??[]).filter(id=>id&&id!=='0')
    const fits=(option:Json)=>sourceIds.length===0||sourceIds.includes(String(option.value))
    let matches=field.dataSource.filter((option:Json)=>String(option.text||'').trim()===sourceValue&&fits(option))
    if(!matches.length)matches=field.dataSource.filter((option:Json)=>normalized(option.text)===normalized(sourceValue)&&fits(option))
    if(matches.length===1)result[field.name]={value:matches[0].value,text:matches[0].text}
    // Customizable fields only: on the same site and attribute, the source listing's value ID is a platform value even
    // when the publishing rules list only the common options; without an ID the seller's own text is used.
    else if(!matches.length&&field.customizable===true&&found?.sameProperty&&sourceIds.length===1&&/^\d{1,15}$/.test(sourceIds[0]))result[field.name]={value:Number(sourceIds[0]),text:sourceValue}
    else if(!matches.length&&field.customizable===true&&!sourceIds.length)result[field.name]={value:-1,text:sourceValue,custom:true}
  }
  return result
}
