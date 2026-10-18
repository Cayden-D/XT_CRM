import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { buildApp } from '../server/app.js'
import { db } from '../server/db.js'
import { createTestAdmin,deleteTestAdmin } from './test-auth.js'

// Product catalogue (products created by 1688 collection, edited in 产品目录). Quotes were retired on 2026-10-14.
const password=process.env.CRM_ADMIN_PASSWORD
if(!password)throw new Error('CRM_ADMIN_PASSWORD is required')
const app=await buildApp();let productId='',testUserId=''
try{const identity=await createTestAdmin('product');testUserId=identity.userId;const login=await app.inject({method:'POST',url:'/api/auth/login',payload:{email:identity.email,password,tenant:'default'}});assert.equal(login.statusCode,200,login.body);const authorization=`Bearer ${login.json().token}`;const marker=randomUUID().slice(0,8)
const product=await app.inject({method:'POST',url:'/api/products',headers:{authorization},payload:{sku:`SKU-${marker}`,name:'Smart controller',category:'Controls',description:'Integration fixture',basePrice:120,specifications:{voltage:'220V'},prices:[{minQuantity:1,unitPrice:100},{minQuantity:100,unitPrice:80,customerLevel:'A'}]}});assert.equal(product.statusCode,201,product.body);productId=product.json().data.id
const listed=await app.inject({method:'GET',url:`/api/products?search=${marker}`,headers:{authorization}});assert.equal(listed.statusCode,200,listed.body);assert.equal(listed.json().data.length,1);assert.equal(listed.json().data[0].prices.length,2)
const updatedProduct=await app.inject({method:'PATCH',url:`/api/products/${productId}`,headers:{authorization},payload:{description:'Updated integration fixture'}});assert.equal(updatedProduct.statusCode,200,updatedProduct.body)
const removedProduct=await app.inject({method:'DELETE',url:`/api/products/${productId}`,headers:{authorization}});assert.equal(removedProduct.statusCode,204,removedProduct.body)
const productAudits=await db.query<{count:string}>(`SELECT count(*)::text FROM audit_logs WHERE entity_type='product' AND entity_id=$1`,[productId]);assert.equal(Number(productAudits.rows[0].count),3)
console.log(JSON.stringify({productCrud:'ok',domesticTierPricing:'ok',productAudit:3}))
}finally{if(productId){await db.query('DELETE FROM audit_logs WHERE entity_id=$1',[productId]);await db.query('DELETE FROM products WHERE id=$1',[productId])}await deleteTestAdmin(testUserId);await app.close();await db.end()}
