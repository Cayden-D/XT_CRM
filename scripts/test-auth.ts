import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import { db } from '../server/db.js'

export async function createTestAdmin(label:string){
  const email=`${label}.${randomUUID().slice(0,8)}@integration.local`
  const user=(await db.query(`INSERT INTO users(tenant_id,email,display_name,status) SELECT id,$1,'集成测试管理员','active' FROM tenants WHERE slug='default' RETURNING id,tenant_id`,[email])).rows[0]
  if(!user)throw new Error('Default tenant not found')
  await db.query(`INSERT INTO user_roles(user_id,role_id) SELECT $1,r.id FROM roles r JOIN tenants t ON t.id=r.tenant_id WHERE t.slug='default' AND r.code='super_admin'`,[user.id])
  return{email,userId:user.id as string,tenantId:user.tenant_id as string}
}

export const testAdminAuth = (app: FastifyInstance, identity: Awaited<ReturnType<typeof createTestAdmin>>) =>
  `Bearer ${app.jwt.sign({ sub: identity.userId, tenantId: identity.tenantId, email: identity.email, displayName: '集成测试管理员', roles: ['super_admin'], permissions: ['*'] })}`

export async function deleteTestAdmin(userId:string){if(userId)await db.query('DELETE FROM users WHERE id=$1',[userId])}
