import type { ReviewedVariant } from '../../shared/1688-skus.js'
import { db } from '../db.js'

type Json=Record<string,any>

// Collector snapshots store the entire combination in the generic 规格 field.
const isCombinedLabel=(name:string,value:unknown,label:string)=>name==='规格'&&typeof value==='string'&&value.trim()===label.trim()

export function collectedSkuAttributes(source:Json,variant:Json):Record<string,string>{
  const dimensions=source.sku_props
  if(!Array.isArray(dimensions)||!dimensions.length||typeof variant.label!=='string')return {}
  const parts=variant.label.split(/[>＞]/).map((part:string)=>part.trim())
  if(parts.length!==dimensions.length||parts.some((part:string)=>!part))return {}
  const result:Record<string,string>={}
  for(let index=0;index<dimensions.length;index++){
    const dimension:Json=dimensions[index]
    const name=String(dimension?.name||'').trim(),value=parts[index]
    if(!name||name in result||!Array.isArray(dimension.values))return {}
    if(dimension.values.filter((choice:Json)=>String(choice?.name||'').trim()===value).length!==1)return {}
    const current=variant.attributes?.[name]
    if(current&&current!==value&&!isCombinedLabel(name,current,variant.label))return {}
    result[name]=value
  }
  return result
}

/** Restore missing dimensions on older products when loading their reviewed SKUs for a draft. */
export async function loadReviewedVariants(tenantId:string,productId:string):Promise<ReviewedVariant[]> {
  const {rows}=await db.query<ReviewedVariant&{source_label:string|null;source_attributes:Record<string,string>|null;sku_props:unknown}>(`SELECT
    pv.id,pv.label,pv.attributes,pv.unit_price,pv.stock,pv.image_url,
    cv.label AS source_label,cv.attributes AS source_attributes,cp.sku_props
    FROM product_variants pv
    LEFT JOIN collected_product_variants cv ON cv.id=pv.source_variant_id AND cv.tenant_id=pv.tenant_id
    LEFT JOIN collected_products cp ON cp.id=cv.collected_product_id AND cp.tenant_id=pv.tenant_id AND cp.product_id=pv.product_id
    WHERE pv.tenant_id=$1 AND pv.product_id=$2 ORDER BY pv.position`,[tenantId,productId])
  return rows.map(({source_label,source_attributes,sku_props,...variant})=>{
    if(!source_label||!sku_props)return variant
    const attributes={...variant.attributes}
    const recovered=collectedSkuAttributes({sku_props},{label:source_label,attributes:source_attributes})
    for(const [name,value] of Object.entries(recovered)){
      const current=attributes[name]
      if(typeof current!=='string'||!current.trim()||isCombinedLabel(name,current,source_label))attributes[name]=value
    }
    return {...variant,attributes}
  })
}
