import { createHash, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { db } from '../db.js'
import { requirePermission } from '../auth.js'
import { collectorExtensionZip } from '../integrations/collector-extension.js'
import { saveCollectedPackage } from '../integrations/product-attributes.js'

const idSchema=z.object({id:z.string().uuid()})
const listSchema=z.object({search:z.string().trim().max(100).optional(),source:z.enum(['1688','alibaba']).optional(),status:z.enum(['collected','ai_processing','ai_completed','ready','published','failed']).optional(),
  stage:z.enum(['pending','queue','attention','promoted','published']).optional(),page:z.coerce.number().int().min(1).max(10000).default(1),pageSize:z.coerce.number().int().min(1).max(100).default(24)})
/** Where a collected product stands, from its latest queue job and whether it became a catalogue product. */
const stageSql=`CASE WHEN q.status='published' THEN 'published' WHEN q.status IN ('blocked','failed','unknown') THEN 'attention' WHEN q.status IN ('queued','processing') THEN 'queue'
  WHEN cp.product_id IS NOT NULL THEN 'promoted' ELSE 'pending' END`
const nullableUrl=z.union([z.string().url().max(2000),z.literal(''),z.null()]).optional().transform(value=>value||null)
const variantSchema=z.object({externalSkuId:z.string().trim().max(200).optional().nullable(),label:z.string().trim().min(1).max(500),attributes:z.record(z.string(),z.string()).default({}),imageUrl:nullableUrl,priceText:z.string().trim().max(200).optional().nullable(),price:z.coerce.number().min(0).optional().nullable(),stockText:z.string().trim().max(200).optional().nullable(),stock:z.coerce.number().min(0).optional().nullable(),rawData:z.record(z.string(),z.unknown()).default({})})
const importSchema=z.object({source:z.enum(['1688','alibaba']),sourceProductId:z.string().trim().min(1).max(200),sourceUrl:z.string().url().max(2000),title:z.string().trim().min(1).max(500),mainImageUrl:nullableUrl,galleryImages:z.array(z.string().url().max(2000)).max(200).default([]),detailImages:z.array(z.string().url().max(2000)).max(500).default([]),videoUrl:nullableUrl,descriptionUrl:nullableUrl,currency:z.string().trim().min(1).max(10).default('CNY'),priceMin:z.coerce.number().min(0).optional().nullable(),priceMax:z.coerce.number().min(0).optional().nullable(),attributes:z.record(z.string(),z.string()).default({}),skuProps:z.array(z.unknown()).max(100).default([]),sellerName:z.string().trim().max(500).optional().nullable(),sellerId:z.string().trim().max(200).optional().nullable(),categoryPath:z.string().trim().max(1000).optional().nullable(),sourceCategoryId:z.string().trim().max(200).optional().nullable(),sourceCategoryAttributes:z.array(z.unknown()).max(1000).default([]),tags:z.array(z.string().trim().max(100)).max(100).default([]),collectorNote:z.string().trim().max(10000).optional().nullable(),sourceCollectedAt:z.string().datetime().optional().nullable(),collectorMode:z.string().trim().max(100).optional().nullable(),collectorVersion:z.string().trim().max(30).optional().nullable(),rawData:z.record(z.string(),z.unknown()).default({}),variants:z.array(variantSchema).max(2000).default([])}).refine(d=>d.priceMin==null||d.priceMax==null||d.priceMax>=d.priceMin,{message:'priceMax must be greater than or equal to priceMin',path:['priceMax']})

const hashKey=(key:string)=>createHash('sha256').update(key).digest('hex')

async function getCollectorIdentity(request:FastifyRequest,reply:FastifyReply){
  const key=request.headers['x-collector-key']
  if(typeof key!=='string'||!key.startsWith('crm1688_')){reply.code(401).send({error:'INVALID_COLLECTOR_KEY',message:'采集密钥缺失或格式无效。'});return null}
  const result=await db.query<{id:string;tenant_id:string;user_id:string}>(`SELECT id,tenant_id,user_id FROM product_collector_keys WHERE key_hash=$1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now())`,[hashKey(key)])
  const identity=result.rows[0]
  if(!identity){reply.code(401).send({error:'INVALID_COLLECTOR_KEY',message:'采集密钥无效或已被吊销。'});return null}
  await db.query('UPDATE product_collector_keys SET last_used_at=now() WHERE id=$1',[identity.id])
  return identity
}

export async function productCollectionRoutes(app:FastifyInstance){
  app.post('/:id/promote',{preHandler:[requirePermission('collection:read'),requirePermission('product:create')]},async(request,reply)=>{
    const id=idSchema.safeParse(request.params)
    const input=z.object({sku:z.string().trim().min(1).max(80),name:z.string().trim().min(1).max(200),category:z.string().trim().max(120).nullable().optional(),basePrice:z.number().finite().nonnegative(),description:z.string().max(10000).default(''),specifications:z.record(z.string(),z.string()).default({}),variants:z.array(z.object({id:z.string().uuid(),price:z.number().finite().nonnegative(),stock:z.number().int().nonnegative().nullable()})).max(2000),reviewed:z.literal(true)}).safeParse(request.body)
    if(!id.success||!input.success)return reply.code(400).send({error:'VALIDATION_ERROR',message:'请核对产品字段、SKU 价格和库存。'})
    const client=await db.connect()
    try{
      await client.query('BEGIN')
      const source=(await client.query('SELECT * FROM collected_products WHERE id=$1 AND tenant_id=$2 FOR UPDATE',[id.data.id,request.authUser.tenantId])).rows[0]
      if(!source){await client.query('ROLLBACK');return reply.code(404).send({error:'NOT_FOUND'})}
      if(source.product_id){await client.query('ROLLBACK');return reply.code(409).send({error:'ALREADY_PROMOTED',message:'该采集记录已关联正式产品。'})}
      if((await client.query("SELECT 1 FROM integration_1688_collection_queue_jobs WHERE collected_product_id=$1 AND status IN ('queued','processing','unknown')",[source.id])).rows.length){await client.query('ROLLBACK');return reply.code(409).send({error:'QUEUE_ACTIVE',message:'该商品正在自动上品或结果待核对，请先查看队列。'})}
      if(source.currency!=='CNY'){await client.query('ROLLBACK');return reply.code(400).send({error:'CURRENCY_MISMATCH',message:'当前正式产品只支持人民币，请先核实来源价格。'})}
      const variants=(await client.query('SELECT * FROM collected_product_variants WHERE collected_product_id=$1 AND tenant_id=$2 ORDER BY position',[source.id,request.authUser.tenantId])).rows
      const reviewed=new Map(input.data.variants.map(v=>[v.id,v]))
      if(reviewed.size!==variants.length||input.data.variants.length!==variants.length||variants.some(v=>!reviewed.has(v.id))){await client.query('ROLLBACK');return reply.code(409).send({error:'SOURCE_CHANGED',message:'采集 SKU 已变化，请重新打开审核。'})}
      const d=input.data
      const images=[...new Set([source.main_image_url,...source.gallery_images].filter(Boolean))]
      const product=(await client.query(`INSERT INTO products(tenant_id,sku,name,category,description,specifications,base_price,base_currency,status,images,detail_images,video_url)VALUES($1,$2,$3,$4,$5,$6,$7,'CNY','active',$8,$9,$10)RETURNING id,sku,name`,[request.authUser.tenantId,d.sku,d.name,d.category||null,d.description,JSON.stringify(d.specifications),d.basePrice,JSON.stringify(images),JSON.stringify(source.detail_images),source.video_url])).rows[0]
      for(const variant of variants){const value=reviewed.get(variant.id)!;await client.query('INSERT INTO product_variants(tenant_id,product_id,source_variant_id,position,label,attributes,image_url,unit_price,stock)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[request.authUser.tenantId,product.id,variant.id,variant.position,variant.label,JSON.stringify(variant.attributes),variant.image_url,value.price,value.stock])}
      await saveCollectedPackage(client,request.authUser.tenantId,product.id,request.authUser.sub,source.raw_data)
      await client.query("UPDATE collected_products SET product_id=$2,processing_status='ready',updated_at=now() WHERE id=$1",[source.id,product.id])
      await client.query(`INSERT INTO audit_logs(tenant_id,actor_id,action,entity_type,entity_id,after_data,request_id)VALUES($1,$2,'collection.promote','product',$3,$4,$5)`,[request.authUser.tenantId,request.authUser.sub,product.id,JSON.stringify({sourceId:source.id,sku:d.sku,reviewed:true,variantCount:variants.length}),request.id])
      await client.query('COMMIT')
      return reply.code(201).send({data:product})
    }catch(error){await client.query('ROLLBACK');if((error as {code?:string}).code==='23505')return reply.code(409).send({error:'SKU_EXISTS',message:'该产品 SKU 已存在，请更换货号。'});throw error}finally{client.release()}
  })
  app.get('/collector-script.user.js',async(_request,reply)=>{const script=await readFile(resolve(process.cwd(),'scripts','1688-product-collector.user.js'),'utf8');return reply.type('application/javascript; charset=utf-8').header('Content-Disposition','inline; filename="1688-product-collector.user.js"').send(script)})

  app.get('/session',async(request,reply)=>{const identity=await getCollectorIdentity(request,reply);if(!identity)return;const user=(await db.query(`SELECT id,email::text,display_name FROM users WHERE id=$1 AND tenant_id=$2 AND status='active' AND deleted_at IS NULL`,[identity.user_id,identity.tenant_id])).rows[0];if(!user)return reply.code(401).send({error:'INVALID_COLLECTOR_KEY',message:'采集密钥所属账号不可用。'});return{data:{id:user.id,email:user.email,username:user.display_name,displayName:user.display_name,teams:[]}}})

  // Connect by approval: the signed-in user approves a challenge; the collector redeems the matching verifier for a key.
  app.post('/connect/approve',{preHandler:requirePermission('collection:create')},async(request,reply)=>{
    const input=z.object({challenge:z.string().regex(/^[A-Za-z0-9_-]{43}$/)}).strict().safeParse(request.body)
    if(!input.success)return reply.code(400).send({error:'VALIDATION_ERROR',message:'授权链接无效，请在采集器中重新点击连接。'})
    await db.query('DELETE FROM product_collector_connects WHERE expires_at<now()')
    const row=(await db.query(`INSERT INTO product_collector_connects(challenge,tenant_id,user_id)VALUES($1,$2,$3) ON CONFLICT(challenge) DO NOTHING RETURNING challenge`,[input.data.challenge,request.authUser.tenantId,request.authUser.sub])).rows[0]
    if(!row)return reply.code(409).send({error:'ALREADY_APPROVED',message:'这个授权请求已处理，请在采集器中重新点击连接。'})
    await db.query("INSERT INTO audit_logs(tenant_id,actor_id,action,entity_type,request_id)VALUES($1,$2,'collector.connect.approve','collector',$3)",[request.authUser.tenantId,request.authUser.sub,request.id])
    return {data:{approved:true}}
  })
  app.post('/connect/redeem',async(request,reply)=>{
    const input=z.object({verifier:z.string().regex(/^[A-Za-z0-9_-]{43,128}$/),client:z.enum(['userscript','extension']).default('userscript')}).strict().safeParse(request.body)
    if(!input.success)return reply.code(400).send({error:'VALIDATION_ERROR',message:'授权参数无效。'})
    const challenge=createHash('sha256').update(input.data.verifier).digest('base64url')
    const client=await db.connect()
    try{
      await client.query('BEGIN')
      const grant=(await client.query(`UPDATE product_collector_connects SET redeemed_at=now() WHERE challenge=$1 AND redeemed_at IS NULL AND expires_at>now() RETURNING tenant_id,user_id`,[challenge])).rows[0]
      if(!grant){await client.query('ROLLBACK');return reply.code(202).send({data:{pending:true}})}
      const user=(await client.query(`SELECT id,email::text,display_name FROM users WHERE id=$1 AND tenant_id=$2 AND status='active' AND deleted_at IS NULL`,[grant.user_id,grant.tenant_id])).rows[0]
      if(!user){await client.query('ROLLBACK');return reply.code(403).send({error:'USER_INACTIVE',message:'授权账号已停用。'})}
      const plainKey=`crm1688_${randomBytes(24).toString('base64url')}`
      await client.query(`INSERT INTO product_collector_keys(tenant_id,user_id,name,key_prefix,key_hash)VALUES($1,$2,$3,$4,$5)`,[grant.tenant_id,grant.user_id,input.data.client==='extension'?'浏览器插件':'油猴脚本',plainKey.slice(0,16),hashKey(plainKey)])
      await client.query('COMMIT')
      return {data:{key:plainKey,user:{id:user.id,email:user.email,username:user.display_name,displayName:user.display_name,teams:[]}}}
    }catch(error){await client.query('ROLLBACK');throw error}finally{client.release()}
  })
  app.get('/collector-extension.zip',async(_request,reply)=>reply.type('application/zip').header('Content-Disposition','attachment; filename="xiaotu-1688-collector.zip"').send(await collectorExtensionZip()))

  app.post('/access-key',{preHandler:requirePermission('collection:create')},async(request)=>{
    const plainKey=`crm1688_${randomBytes(24).toString('base64url')}`
    const client=await db.connect()
    try{await client.query('BEGIN');await client.query('UPDATE product_collector_keys SET revoked_at=now() WHERE tenant_id=$1 AND user_id=$2 AND revoked_at IS NULL',[request.authUser.tenantId,request.authUser.sub]);const row=(await client.query(`INSERT INTO product_collector_keys(tenant_id,user_id,key_prefix,key_hash)VALUES($1,$2,$3,$4)RETURNING id,name,key_prefix,created_at`,[request.authUser.tenantId,request.authUser.sub,plainKey.slice(0,18),hashKey(plainKey)])).rows[0];await client.query('COMMIT');return{data:{...row,key:plainKey}}}catch(error){await client.query('ROLLBACK');throw error}finally{client.release()}
  })

  // Paginated card list with stage counts; only the columns the cards need (raw snapshots stay in the detail endpoint).
  app.get('/',{preHandler:requirePermission('collection:read')},async(request,reply)=>{
    const input=listSchema.safeParse(request.query);if(!input.success)return reply.code(400).send({error:'VALIDATION_ERROR'})
    const {search,source,status,stage,page,pageSize}=input.data
    const values:unknown[]=[request.authUser.tenantId];const where=['cp.tenant_id=$1']
    if(search){values.push(`%${search.replace(/[\\%_]/g,m=>`\\${m}`)}%`);where.push(`(cp.title ILIKE $${values.length} OR cp.source_product_id ILIKE $${values.length})`)}
    if(source){values.push(source);where.push(`cp.source=$${values.length}`)}
    if(status){values.push(status);where.push(`cp.processing_status=$${values.length}`)}
    const base=`SELECT cp.id,cp.source,cp.source_product_id,cp.source_url,cp.title,cp.main_image_url,cp.seller_name,cp.processing_status,cp.product_id,cp.collected_at,cp.updated_at,
        u.display_name AS collector_name,q.status AS queue_status,q.message AS queue_message,${stageSql} AS stage,
        (SELECT count(*)::int FROM collected_product_variants v WHERE v.collected_product_id=cp.id) AS variant_count,
        (SELECT min(price) FROM collected_product_variants v WHERE v.collected_product_id=cp.id) AS min_price,(SELECT max(price) FROM collected_product_variants v WHERE v.collected_product_id=cp.id) AS max_price
      FROM collected_products cp LEFT JOIN users u ON u.id=cp.collected_by
      LEFT JOIN LATERAL (SELECT status,message FROM integration_1688_collection_queue_jobs WHERE collected_product_id=cp.id ORDER BY created_at DESC LIMIT 1) q ON true
      WHERE ${where.join(' AND ')}`
    const listValues=[...values];let filter=''
    if(stage){listValues.push(stage);filter=`WHERE stage=$${listValues.length}`}
    listValues.push(pageSize,(page-1)*pageSize)
    const rows=(await db.query(`SELECT *,count(*) OVER()::int AS total_count FROM (${base}) c ${filter} ORDER BY collected_at DESC,id LIMIT $${listValues.length-1} OFFSET $${listValues.length}`,listValues)).rows
    // Stage counts ignore the stage filter so each tab shows what it would return.
    const facets=(await db.query(`SELECT count(*)::int AS all,${['pending','queue','attention','promoted','published'].map(k=>`count(*) FILTER(WHERE stage='${k}')::int AS ${k}`).join(',')} FROM (${base}) c`,values)).rows[0]
    const total=stage?facets[stage]:facets.all
    return{data:rows.map(({total_count:_t,...row})=>row),total,page,pageSize,facets}
  })

  app.get('/:id',{preHandler:requirePermission('collection:read')},async(request,reply)=>{const id=idSchema.safeParse(request.params);if(!id.success)return reply.code(400).send({error:'VALIDATION_ERROR'});const product=(await db.query('SELECT cp.*,q.status AS queue_status,q.message AS queue_message FROM collected_products cp LEFT JOIN LATERAL (SELECT status,message FROM integration_1688_collection_queue_jobs WHERE collected_product_id=cp.id ORDER BY created_at DESC LIMIT 1) q ON true WHERE cp.id=$1 AND cp.tenant_id=$2',[id.data.id,request.authUser.tenantId])).rows[0];if(!product)return reply.code(404).send({error:'NOT_FOUND'});const variants=await db.query('SELECT * FROM collected_product_variants WHERE collected_product_id=$1 ORDER BY position',[id.data.id]);return{data:{product,variants:variants.rows}}})

  app.delete('/:id',{preHandler:requirePermission('collection:delete')},async(request,reply)=>{
    const id=idSchema.safeParse(request.params)
    if(!id.success)return reply.code(400).send({error:'VALIDATION_ERROR'})
    const client=await db.connect()
    try{
      await client.query('BEGIN')
      const source=(await client.query('SELECT id,title FROM collected_products WHERE id=$1 AND tenant_id=$2 FOR UPDATE',[id.data.id,request.authUser.tenantId])).rows[0]
      if(!source){await client.query('ROLLBACK');return reply.code(404).send({error:'NOT_FOUND'})}
      if((await client.query("SELECT 1 FROM integration_1688_collection_queue_jobs WHERE collected_product_id=$1 AND status IN ('queued','processing','unknown')",[source.id])).rows.length){await client.query('ROLLBACK');return reply.code(409).send({error:'QUEUE_ACTIVE',message:'队列任务仍在执行或结果待核对，不能删除采集记录。'})}
      await client.query('DELETE FROM collected_products WHERE id=$1',[source.id])
      await client.query(`INSERT INTO audit_logs(tenant_id,actor_id,action,entity_type,entity_id,before_data,request_id)VALUES($1,$2,'collection.delete','collected_product',$3,$4,$5)`,[request.authUser.tenantId,request.authUser.sub,source.id,JSON.stringify(source),request.id])
      await client.query('COMMIT');return reply.code(204).send()
    }catch(error){await client.query('ROLLBACK');throw error}finally{client.release()}
  })

  app.post('/import',async(request,reply)=>{const identity=await getCollectorIdentity(request,reply);if(!identity)return;const input=importSchema.safeParse(request.body);if(!input.success)return reply.code(400).send({error:'VALIDATION_ERROR',message:'采集数据格式不正确。',details:input.error.flatten()});const d=input.data;const client=await db.connect();try{await client.query('BEGIN');const product=(await client.query(`INSERT INTO collected_products(tenant_id,source,source_product_id,source_url,title,main_image_url,gallery_images,detail_images,video_url,description_url,currency,price_min,price_max,attributes,sku_props,seller_name,seller_id,category_path,source_category_id,source_category_attributes,tags,collector_note,source_collected_at,raw_data,collector_mode,collector_version,collected_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27) ON CONFLICT(tenant_id,source,source_product_id) DO UPDATE SET source_url=excluded.source_url,title=excluded.title,main_image_url=excluded.main_image_url,gallery_images=excluded.gallery_images,detail_images=excluded.detail_images,video_url=excluded.video_url,description_url=excluded.description_url,currency=excluded.currency,price_min=excluded.price_min,price_max=excluded.price_max,attributes=excluded.attributes,sku_props=excluded.sku_props,seller_name=excluded.seller_name,seller_id=excluded.seller_id,category_path=excluded.category_path,source_category_id=excluded.source_category_id,source_category_attributes=excluded.source_category_attributes,tags=excluded.tags,collector_note=excluded.collector_note,source_collected_at=excluded.source_collected_at,raw_data=excluded.raw_data,collector_mode=excluded.collector_mode,collector_version=excluded.collector_version,collected_by=excluded.collected_by,collected_at=now(),updated_at=now() RETURNING *`,[identity.tenant_id,d.source,d.sourceProductId,d.sourceUrl,d.title,d.mainImageUrl,JSON.stringify(d.galleryImages),JSON.stringify(d.detailImages),d.videoUrl,d.descriptionUrl,d.currency,d.priceMin,d.priceMax,JSON.stringify(d.attributes),JSON.stringify(d.skuProps),d.sellerName,d.sellerId,d.categoryPath,d.sourceCategoryId,JSON.stringify(d.sourceCategoryAttributes),JSON.stringify(d.tags),d.collectorNote,d.sourceCollectedAt,JSON.stringify(d.rawData),d.collectorMode,d.collectorVersion,identity.user_id])).rows[0];await client.query('DELETE FROM collected_product_variants WHERE collected_product_id=$1',[product.id]);for(const [position,v] of d.variants.entries())await client.query(`INSERT INTO collected_product_variants(tenant_id,collected_product_id,position,external_sku_id,label,attributes,image_url,price_text,price,stock_text,stock,raw_data)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,[identity.tenant_id,product.id,position,v.externalSkuId,v.label,JSON.stringify(v.attributes),v.imageUrl,v.priceText,v.price,v.stockText,v.stock,JSON.stringify(v.rawData)]);await client.query(`INSERT INTO audit_logs(tenant_id,actor_id,action,entity_type,entity_id,after_data,request_id)VALUES($1,$2,'collection.import','collected_product',$3,$4,$5)`,[identity.tenant_id,identity.user_id,product.id,JSON.stringify({source:d.source,sourceProductId:d.sourceProductId,title:d.title,variantCount:d.variants.length}),request.id]);await client.query('COMMIT');return reply.code(201).send({data:{id:product.id,title:product.title,variantCount:d.variants.length,collectedAt:product.collected_at}})}catch(error){await client.query('ROLLBACK');throw error}finally{client.release()}})
}
