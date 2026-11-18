import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { db } from '../db.js'
import { config } from '../config.js'
import { forgetAccount, hasPermission, requireAuth, requireSuperAdmin } from '../auth.js'
import { QWEN_MODELS } from '../llm/qwen.js'
import { imagePlanOptions, imagePlans } from '../integrations/image-generation-settings.js'
import { IntegrationError } from '../integrations/1688.js'
import { adjustTeamCredits, CREDITS_PER_LISTING, listTeams, teamCreditActivity, teamOf } from '../integrations/teams.js'

// Role and access settings for existing 1688 identities. Supervisors manage only their own team.
export const TEAM_ROLES = ['sales_rep', 'order_specialist']
const ADMIN_PERMISSIONS = ['dashboard:*', 'report:*', 'account:*', 'product:*', 'collection:*', 'integration:*', 'performance:*', 'payroll:*', 'customer_ops:*', 'order:*', 'settlement:*']
const tenant = (request: FastifyRequest) => request.authUser.tenantId
const idParams = z.object({ id: z.string().uuid() })
class AccountError extends Error { constructor(public statusCode: number, public code: string, message: string) { super(message) } }
const audit = (request: FastifyRequest, action: string, userId: string, data: object) => db.query(
  "INSERT INTO audit_logs(tenant_id,actor_id,action,entity_type,entity_id,after_data,request_id)VALUES($1,$2,$3,'user',$4,$5,$6)",
  [tenant(request), request.authUser.sub, action, userId, JSON.stringify(data), request.id])

/** Whole tenant (user:manage) or own team only (user:manage_team). */
const fullAccess = (request: FastifyRequest) => hasPermission(request.authUser.permissions, 'user:manage')
async function manageAccounts(request: FastifyRequest, reply: import('fastify').FastifyReply) {
  await requireAuth(request, reply)
  if (reply.sent) return
  if (!fullAccess(request) && !hasPermission(request.authUser.permissions, 'user:manage_team')) return reply.code(403).send({ error: 'FORBIDDEN', message: '当前账号没有执行此操作的权限。' })
}

/** Roles that can be given out here: every role of the tenant except the super administrator (admin is created if missing); a team, only its roles. */
async function assignableRoles(tenantId: string, team = false) {
  await db.query(`INSERT INTO roles(tenant_id,code,name,permissions,is_system) VALUES($1,'admin','管理员',$2,true) ON CONFLICT(tenant_id,code) DO NOTHING`, [tenantId, JSON.stringify(ADMIN_PERMISSIONS)])
  return (await db.query<{ id: string; code: string; name: string; permissions: string[] }>(
    "SELECT id,code,name,permissions FROM roles WHERE tenant_id=$1 AND code<>'super_admin' AND (NOT $2 OR code=ANY($3)) ORDER BY code<>'admin',name", [tenantId, team, TEAM_ROLES])).rows
}
async function roleId(request: FastifyRequest, code: string) {
  const role = (await assignableRoles(tenant(request), !fullAccess(request))).find(r => r.code === code)
  if (!role) throw new AccountError(400, 'ROLE_INVALID', '角色不存在或不能分配。')
  return role.id
}
async function target(request: FastifyRequest, id: string) {
  const row = (await db.query<{ id: string; parent_user_id: string | null; roles: string[] }>(`SELECT u.id,u.parent_user_id,array_remove(array_agg(r.code),NULL) AS roles FROM users u
    LEFT JOIN user_roles ur ON ur.user_id=u.id LEFT JOIN roles r ON r.id=ur.role_id WHERE u.id=$1 AND u.tenant_id=$2 AND u.deleted_at IS NULL
    AND EXISTS(SELECT 1 FROM auth_1688_identities i WHERE i.user_id=u.id AND i.app_key=$3) GROUP BY u.id`, [id, tenant(request), config.ALI1688_PERFORMANCE_APP_KEY])).rows[0]
  if (!row) throw new AccountError(404, 'NOT_FOUND', '账号不存在。')
  // A supervisor reaches only their existing direct team members, and only while those still hold team roles; others look absent.
  if (!fullAccess(request) && (row.parent_user_id !== request.authUser.sub || row.roles.some(r => !TEAM_ROLES.includes(r)))) throw new AccountError(404, 'NOT_FOUND', '账号不存在。')
  if (row.roles.includes('super_admin') && row.id !== request.authUser.sub) throw new AccountError(403, 'PROTECTED', '超级管理员账号不能在这里修改。')
  return row
}
/** The members whose 1688 sign-in is associated with this workspace. */
const listUsers = (tenantId: string, parent: string | null = null) => db.query(`SELECT u.id,u.display_name,u.status,u.last_login_at,
    u.parent_user_id,pu.display_name AS parent_name,
    coalesce(json_agg(json_build_object('code',r.code,'name',r.name) ORDER BY r.code) FILTER (WHERE r.id IS NOT NULL),'[]') AS roles
  FROM users u LEFT JOIN users pu ON pu.id=u.parent_user_id LEFT JOIN user_roles ur ON ur.user_id=u.id LEFT JOIN roles r ON r.id=ur.role_id
  WHERE u.tenant_id=$1 AND u.deleted_at IS NULL AND ($2::uuid IS NULL OR u.parent_user_id=$2)
  AND EXISTS(SELECT 1 FROM auth_1688_identities i WHERE i.user_id=u.id AND i.app_key=$3)
  GROUP BY u.id,pu.display_name ORDER BY bool_or(r.code='super_admin') DESC NULLS LAST,u.created_at`, [tenantId, parent, config.ALI1688_PERFORMANCE_APP_KEY]).then(r => r.rows)
const scopeOf = (request: FastifyRequest) => fullAccess(request) ? null : request.authUser.sub
const revoke = async (userId: string) => { await db.query('UPDATE users SET sessions_revoked_at=now(),updated_at=now() WHERE id=$1', [userId]); forgetAccount(userId) }

export async function userRoutes(app: FastifyInstance) {
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AccountError) return reply.code(error.statusCode).send({ error: error.code, message: error.message })
    if (error instanceof IntegrationError) return reply.code(error.statusCode).send({ error: error.code, message: error.message })
    if (error instanceof z.ZodError) { const issue = error.issues[0]; return reply.code(400).send({ error: 'VALIDATION_ERROR', message: issue?.code === 'custom' || issue?.message?.match(/[一-龥]/) ? issue.message : `请求参数不正确${issue?.path.length ? `（${issue.path.join('.')}）` : ''}。` }) }
    request.log.error(error)
    return reply.code(500).send({ error: 'INTERNAL_SERVER_ERROR', message: '服务器处理请求时发生错误。' })
  })

  // 团队积分 (super administrator).
  const superOnly = async (request: FastifyRequest, reply: import('fastify').FastifyReply) => {
    await requireAuth(request, reply)
    if (reply.sent) return
    if (!fullAccess(request)) return reply.code(403).send({ error: 'FORBIDDEN', message: '只有超级管理员可以调整团队积分。' })
  }
  app.get('/teams', { preHandler: superOnly }, async request => {
    const includeModels = request.authUser.roles.includes('super_admin')
    return {
      data: await listTeams(tenant(request), includeModels), perListing: CREDITS_PER_LISTING,
      ...(includeModels ? { textModels: QWEN_MODELS, imagePlans: imagePlanOptions } : {}),
    }
  })
  app.patch('/teams/:id/models', { preHandler: requireSuperAdmin }, async request => {
    const { id } = idParams.parse(request.params)
    const input = z.object({
      textModel: z.enum(QWEN_MODELS).optional(),
      imagePlan: z.enum(['image-a', 'image-b', 'image-c']).optional(),
    }).strict().refine(v => v.textModel || v.imagePlan, '请选择要更新的模型方案。').parse(request.body)
    const saved = await db.query(`
      WITH saved AS (
        INSERT INTO team_ai_settings(owner_user_id,tenant_id,text_model,image_model,updated_by)
        SELECT u.id,u.tenant_id,$3,$4,$5 FROM users u
        WHERE u.id=$2 AND u.tenant_id=$1 AND u.parent_user_id IS NULL AND u.deleted_at IS NULL
        ON CONFLICT(owner_user_id) DO UPDATE SET
          text_model=coalesce(excluded.text_model,team_ai_settings.text_model),
          image_model=coalesce(excluded.image_model,team_ai_settings.image_model),
          updated_by=excluded.updated_by,updated_at=now()
        RETURNING owner_user_id
      ) INSERT INTO audit_logs(tenant_id,actor_id,action,entity_type,entity_id,after_data,request_id)
      SELECT $1,$5,'team.models.update','user',owner_user_id,$6,$7 FROM saved`,
    [tenant(request), id, input.textModel ?? null, input.imagePlan ? imagePlans[input.imagePlan].model : null,
      request.authUser.sub, JSON.stringify(input), request.id])
    if (!saved.rowCount) throw new AccountError(404, 'TEAM_NOT_FOUND', '团队不存在。')
    return { ok: true }
  })
  app.patch('/teams/:id', { preHandler: superOnly }, async request => {
    const { id } = idParams.parse(request.params)
    const input = z.object({
      delta: z.number().int().min(-1_000_000).max(1_000_000).refine(v => v !== 0, '调整积分不能为 0。'), note: z.string().trim().max(200).optional(),
    }).strict().parse(request.body)
    return { data: await adjustTeamCredits(tenant(request), id, request.authUser.sub, input) }
  })
  // The signed-in account's own team: credits left and what a listing costs.
  app.get('/team', { preHandler: requireAuth }, async request => {
    const team = await teamOf(tenant(request), request.authUser.sub)
    return { data: { name: team.ownerName, unlimited: team.unlimited, credits: team.credits, perListing: CREDITS_PER_LISTING } }
  })
  app.get('/team/credits', { preHandler: requireAuth }, async (request, reply) => {
    const { sub, permissions } = request.authUser
    if (!['user:manage', 'user:manage_team', 'integration:manage'].some(permission => hasPermission(permissions, permission))) {
      throw new AccountError(403, 'FORBIDDEN', '当前账号没有查看团队积分明细的权限。')
    }
    const { page, pageSize } = z.object({
      page: z.coerce.number().int().positive().default(1),
      pageSize: z.coerce.number().int().min(1).max(50).default(20),
    }).strict().parse(request.query)
    reply.header('Cache-Control', 'no-store')
    return { data: await teamCreditActivity(tenant(request), sub, page, pageSize) }
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

  app.get('/', { preHandler: manageAccounts }, async request => ({
    data: await listUsers(tenant(request), scopeOf(request)),
    roles: (await assignableRoles(tenant(request), !fullAccess(request))).map(({ code, name, permissions }) => ({ code, name, permissions })),
    scope: fullAccess(request) ? 'all' : 'team',
  }))

  app.patch('/:id', { preHandler: manageAccounts }, async request => {
    const { id } = idParams.parse(request.params)
    const input = z.object({ role: z.string().min(1).max(50).optional(), status: z.enum(['active', 'disabled']).optional() }).strict().refine(v => v.role || v.status, '没有要保存的修改。').parse(request.body)
    const user = await target(request, id)
    const self = id === request.authUser.sub
    if (self && (input.role || input.status)) throw new AccountError(409, 'SELF_PROTECTED', '不能停用自己或修改自己的角色。')
    if (input.role && !(user.roles.length === 1 && user.roles[0] === input.role)) {
      const role = await roleId(request, input.role)
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
    return { data: (await listUsers(tenant(request), scopeOf(request))).find(u => u.id === id) }
  })
}
