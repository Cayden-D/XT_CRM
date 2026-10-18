import bcrypt from 'bcryptjs'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { db } from '../db.js'
import { forgetAccount, requireAuth, requirePermission } from '../auth.js'

/**
 * 账户管理 (super administrator only, permission user:manage): open accounts, change roles, disable/enable and reset
 * passwords. The super administrator account itself cannot be changed here, and nobody can disable or demote
 * themselves. Disabling, password resets and role changes end the account's existing sessions at once.
 */
const ADMIN_PERMISSIONS = ['dashboard:*', 'report:*', 'account:*', 'product:*', 'collection:*', 'integration:*', 'performance:*', 'payroll:*', 'customer_ops:*', 'order:*', 'settlement:*']
const tenant = (request: FastifyRequest) => request.authUser.tenantId
const idParams = z.object({ id: z.string().uuid() })
const password = z.string().min(10, '密码至少 10 位。').max(72, '密码最多 72 位。')
  .refine(v => /[A-Za-z]/.test(v) && /\d/.test(v), '密码需同时包含字母和数字。')
class AccountError extends Error { constructor(public statusCode: number, public code: string, message: string) { super(message) } }
const audit = (request: FastifyRequest, action: string, userId: string, data: object) => db.query(
  "INSERT INTO audit_logs(tenant_id,actor_id,action,entity_type,entity_id,after_data,request_id)VALUES($1,$2,$3,'user',$4,$5,$6)",
  [tenant(request), request.authUser.sub, action, userId, JSON.stringify(data), request.id])

/** Roles that can be given out here: every role of the tenant except the super administrator (admin is created if missing). */
async function assignableRoles(tenantId: string) {
  await db.query(`INSERT INTO roles(tenant_id,code,name,permissions,is_system) VALUES($1,'admin','管理员',$2,true) ON CONFLICT(tenant_id,code) DO NOTHING`, [tenantId, JSON.stringify(ADMIN_PERMISSIONS)])
  return (await db.query<{ id: string; code: string; name: string; permissions: string[] }>(
    "SELECT id,code,name,permissions FROM roles WHERE tenant_id=$1 AND code<>'super_admin' ORDER BY code<>'admin',name", [tenantId])).rows
}
async function roleId(tenantId: string, code: string) {
  const role = (await assignableRoles(tenantId)).find(r => r.code === code)
  if (!role) throw new AccountError(400, 'ROLE_INVALID', '角色不存在或不能分配。')
  return role.id
}
async function target(request: FastifyRequest, id: string) {
  const row = (await db.query<{ id: string; email: string; roles: string[] }>(`SELECT u.id,u.email::text,array_remove(array_agg(r.code),NULL) AS roles FROM users u
    LEFT JOIN user_roles ur ON ur.user_id=u.id LEFT JOIN roles r ON r.id=ur.role_id WHERE u.id=$1 AND u.tenant_id=$2 AND u.deleted_at IS NULL GROUP BY u.id`, [id, tenant(request)])).rows[0]
  if (!row) throw new AccountError(404, 'NOT_FOUND', '账号不存在。')
  if (row.roles.includes('super_admin') && row.id !== request.authUser.sub) throw new AccountError(403, 'PROTECTED', '超级管理员账号不能在这里修改。')
  return row
}
const listUsers = (tenantId: string) => db.query(`SELECT u.id,u.email::text,u.display_name,u.mobile,u.status,u.last_login_at,u.created_at,
    coalesce(json_agg(json_build_object('code',r.code,'name',r.name) ORDER BY r.code) FILTER (WHERE r.id IS NOT NULL),'[]') AS roles
  FROM users u LEFT JOIN user_roles ur ON ur.user_id=u.id LEFT JOIN roles r ON r.id=ur.role_id
  WHERE u.tenant_id=$1 AND u.deleted_at IS NULL GROUP BY u.id ORDER BY bool_or(r.code='super_admin') DESC NULLS LAST,u.created_at`, [tenantId]).then(r => r.rows)
const revoke = async (userId: string) => { await db.query('UPDATE users SET sessions_revoked_at=now(),updated_at=now() WHERE id=$1', [userId]); forgetAccount(userId) }

export async function userRoutes(app: FastifyInstance) {
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AccountError) return reply.code(error.statusCode).send({ error: error.code, message: error.message })
    if (error instanceof z.ZodError) { const issue = error.issues[0]; return reply.code(400).send({ error: 'VALIDATION_ERROR', message: issue?.code === 'custom' || issue?.message?.match(/[一-龥]/) ? issue.message : `请求参数不正确${issue?.path.length ? `（${issue.path.join('.')}）` : ''}。` }) }
    request.log.error(error)
    return reply.code(500).send({ error: 'INTERNAL_SERVER_ERROR', message: '服务器处理请求时发生错误。' })
  })

  app.get('/assignable', { preHandler: requireAuth }, async request => {
    const result = await db.query(`
      SELECT u.id, u.display_name, u.email::text,
        array_remove(array_agg(DISTINCT r.code), NULL) AS roles
      FROM users u
      LEFT JOIN user_roles ur ON ur.user_id = u.id
      LEFT JOIN roles r ON r.id = ur.role_id
      WHERE u.tenant_id = $1 AND u.status = 'active' AND u.deleted_at IS NULL
      GROUP BY u.id ORDER BY u.display_name
    `, [request.authUser.tenantId])
    return { data: result.rows }
  })

  app.get('/', { preHandler: requirePermission('user:manage') }, async request => ({
    data: await listUsers(tenant(request)),
    roles: (await assignableRoles(tenant(request))).map(({ code, name, permissions }) => ({ code, name, permissions })),
  }))

  app.post('/', { preHandler: requirePermission('user:manage') }, async request => {
    const input = z.object({
      email: z.string().trim().email('请填写有效的登录邮箱。').max(255).transform(v => v.toLowerCase()), displayName: z.string().trim().min(1, '请填写姓名。').max(80),
      mobile: z.string().trim().max(40).optional(), password, role: z.string().default('admin'),
    }).strict().parse(request.body)
    const role = await roleId(tenant(request), input.role)
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      const taken = (await client.query('SELECT deleted_at FROM users WHERE tenant_id=$1 AND email=$2', [tenant(request), input.email])).rows[0]
      if (taken) throw new AccountError(409, 'EMAIL_TAKEN', taken.deleted_at ? '该邮箱属于已删除的账号，请换一个邮箱。' : '该邮箱已被其他账号使用。')
      const user = (await client.query("INSERT INTO users(tenant_id,email,password_hash,display_name,mobile,status) VALUES($1,$2,$3,$4,$5,'active') RETURNING id",
        [tenant(request), input.email, await bcrypt.hash(input.password, 12), input.displayName, input.mobile || null])).rows[0]
      await client.query('INSERT INTO user_roles(user_id,role_id) VALUES($1,$2)', [user.id, role])
      await client.query('COMMIT')
      await audit(request, 'user.create', user.id, { email: input.email, role: input.role })
      return { data: (await listUsers(tenant(request))).find(u => u.id === user.id) }
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  })

  app.patch('/:id', { preHandler: requirePermission('user:manage') }, async request => {
    const { id } = idParams.parse(request.params)
    const input = z.object({ displayName: z.string().trim().min(1).max(80).optional(), mobile: z.string().trim().max(40).nullable().optional(), role: z.string().optional(), status: z.enum(['active', 'disabled']).optional() }).strict().parse(request.body)
    const user = await target(request, id)
    const self = id === request.authUser.sub
    if (self && (input.role || input.status)) throw new AccountError(409, 'SELF_PROTECTED', '不能停用自己或修改自己的角色。')
    if (input.displayName !== undefined || input.mobile !== undefined) await db.query('UPDATE users SET display_name=coalesce($2,display_name),mobile=CASE WHEN $3 THEN $4 ELSE mobile END,updated_at=now() WHERE id=$1', [id, input.displayName ?? null, input.mobile !== undefined, input.mobile || null])
    if (input.role && !(user.roles.length === 1 && user.roles[0] === input.role)) {
      const role = await roleId(tenant(request), input.role)
      const client = await db.connect()
      try {
        await client.query('BEGIN')
        await client.query('DELETE FROM user_roles WHERE user_id=$1', [id])
        await client.query('INSERT INTO user_roles(user_id,role_id) VALUES($1,$2)', [id, role])
        await client.query('COMMIT')
      } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
      await revoke(id)
    }
    if (input.status) { await db.query('UPDATE users SET status=$2,updated_at=now() WHERE id=$1', [id, input.status]); await revoke(id) }
    await audit(request, 'user.update', id, input)
    return { data: (await listUsers(tenant(request))).find(u => u.id === id) }
  })

  app.post('/:id/password', { preHandler: requirePermission('user:manage') }, async request => {
    const { id } = idParams.parse(request.params)
    const input = z.object({ password }).strict().parse(request.body)
    await target(request, id)
    await db.query('UPDATE users SET password_hash=$2,updated_at=now() WHERE id=$1', [id, await bcrypt.hash(input.password, 12)])
    await revoke(id)
    await audit(request, 'user.password_reset', id, {})
    return { ok: true, self: id === request.authUser.sub }
  })
}
