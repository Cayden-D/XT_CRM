import { randomBytes } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { hasPermission, requireAuth, requirePermission } from '../auth.js'
import { config } from '../config.js'
import { db } from '../db.js'
import { appCredentials, connectionToken, getGrant, IntegrationError, publicPerfConnectionColumns, recordOperation, saveConnection, stateHash } from '../integrations/1688.js'
import { testPerformanceConnection } from '../integrations/1688-performance.js'
import { enqueuePerformanceSync } from '../integrations/1688-performance-sync.js'
import { assignOwners } from '../integrations/customer-ops.js'
import { availableSchemes } from '../integrations/1688-performance-orders.js'
import { agentMetrics } from '../integrations/1688-performance-reports.js'
import type { FastifyReply, FastifyRequest } from 'fastify'

const idSchema = z.object({ id: z.string().uuid() })
export const attributionSchemes = ['order_first','payment_first','order_only','payment_only','memo_flag','payment_day_chat','order_payment_split','owner_only','owner_collaborator_split'] as const
const settingsColumns = "attribution_window_hours,unanswered_threshold_seconds,count_other_as_reply,work_hours_enabled,to_char(work_start,'HH24:MI') AS work_start,to_char(work_end,'HH24:MI') AS work_end,default_scheme,split_order_share::float,owner_share::float,auto_assign_owner,revision,updated_at"
const settingsInput = z.object({
  revision: z.number().int().positive(),
  attributionWindowHours: z.number().int().min(1).max(720).optional(),
  unansweredThresholdSeconds: z.number().int().min(10).max(86400).optional(),
  countOtherAsReply: z.boolean().optional(),
  workHoursEnabled: z.boolean().optional(),
  workStart: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  workEnd: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$|^24:00$/).optional(),
  defaultScheme: z.enum(attributionSchemes).optional(),
  splitOrderShare: z.number().min(0.1).max(0.9).multipleOf(0.01).optional(),
  ownerShare: z.number().min(0.1).max(0.9).multipleOf(0.01).optional(),
  autoAssignOwner: z.boolean().optional(),
}).strict()

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
export const reportQuery = z.object({ connectionId: z.string().uuid(), from: dateString, to: dateString }).refine(q => q.from <= q.to && (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 <= 92, '日期范围需在 93 天以内且开始不晚于结束')
// Reception buckets as in the shop's staffing view: night hours merged, then one bucket per hour.
export const hourBuckets = [{ key: 0, label: '00:00-09:00' }, ...Array.from({ length: 15 }, (_, i) => ({ key: i + 9, label: `${String(i + 9).padStart(2, '0')}:00-${String(i + 10).padStart(2, '0')}:00` }))]

/** Full read access, or only the agents bound to the current user. */
export async function readScope(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply)
  if (reply.sent) return
  const granted = request.authUser.permissions
  if (!hasPermission(granted, 'performance:read') && !hasPermission(granted, 'performance:read_own')) return reply.code(403).send({ error: 'FORBIDDEN', message: '当前账号没有查看客服绩效的权限。' })
}
export const ownOnly = (request: FastifyRequest) => !hasPermission(request.authUser.permissions, 'performance:read')

export async function ensureConnection(tenantId: string, id: string) {
  if (!(await db.query('SELECT 1 FROM integration_1688_perf_connections WHERE id=$1 AND tenant_id=$2', [id, tenantId])).rows.length) throw new IntegrationError('NOT_FOUND', '绩效连接不存在。', 404)
}

async function audit(tenantId: string, actorId: string, entityType: string, id: string, action: string, requestId: string, after?: object) {
  await db.query('INSERT INTO audit_logs(tenant_id,actor_id,action,entity_type,entity_id,after_data,request_id)VALUES($1,$2,$3,$4,$5,$6,$7)',
    [tenantId, actorId, action, entityType, id, after ? JSON.stringify(after) : null, requestId])
}

/** What deleting a performance connection would remove (or why it cannot be deleted). */
async function perfConnectionUsage(id: string, tenantId: string) {
  const row = (await db.query(`SELECT c.status,c.display_name,
      (SELECT count(*) FROM perf_orders o WHERE o.connection_id=c.id)::int AS orders,
      (SELECT count(*) FROM perf_chat_sessions s WHERE s.connection_id=c.id)::int AS sessions,
      (SELECT count(*) FROM perf_buyers b WHERE b.connection_id=c.id)::int AS buyers,
      (SELECT count(*) FROM perf_agents a WHERE a.connection_id=c.id)::int AS agents,
      (SELECT count(*) FROM cust_followups f JOIN perf_buyers b ON b.id=f.buyer_id WHERE b.connection_id=c.id)::int AS followups,
      (SELECT count(*) FROM cust_attachments t JOIN perf_buyers b ON b.id=t.buyer_id WHERE b.connection_id=c.id)::int AS attachments,
      (SELECT count(*) FROM perf_payroll_periods p WHERE p.connection_id=c.id)::int AS payrolls,
      (SELECT count(*) FROM perf_payroll_periods p WHERE p.connection_id=c.id AND p.status='locked')::int AS locked_payrolls
    FROM integration_1688_perf_connections c WHERE c.id=$1 AND c.tenant_id=$2`, [id, tenantId])).rows[0]
  if (!row) throw new IntegrationError('NOT_FOUND', '绩效连接不存在。', 404)
  return row as { status: string; display_name: string; orders: number; sessions: number; buyers: number; agents: number; followups: number; attachments: number; payrolls: number; locked_payrolls: number }
}

export async function performanceRoutes(app: FastifyInstance) {
  app.get('/connections', { preHandler: readScope }, async request => {
    const rows = await db.query(`SELECT ${publicPerfConnectionColumns} FROM integration_1688_perf_connections WHERE tenant_id=$1 ORDER BY created_at`, [request.authUser.tenantId])
    return { data: rows.rows, configured: Boolean(config.ALI1688_PERFORMANCE_APP_KEY && config.ALI1688_PERFORMANCE_APP_SECRET && config.ALI1688_PERFORMANCE_REDIRECT_URI) }
  })
  app.post('/authorizations', { preHandler: requirePermission('performance:manage') }, async request => {
    const credentials = appCredentials('performance')
    const state = randomBytes(32).toString('hex')
    await db.query('INSERT INTO integration_1688_perf_oauth_states(state_hash,tenant_id,created_by,app_key,redirect_uri,expires_at)VALUES($1,$2,$3,$4,$5,now()+interval \'10 minutes\')', [stateHash(state), request.authUser.tenantId, request.authUser.sub, credentials.appKey, credentials.redirect])
    const url = new URL('https://auth.1688.com/oauth/authorize')
    url.search = new URLSearchParams({ client_id: credentials.appKey, site: '1688', redirect_uri: credentials.redirect, state }).toString()
    return { data: { authorizationUrl: url.href } }
  })
  app.post('/authorizations/complete', { preHandler: requirePermission('performance:manage') }, async (request, reply) => {
    const input = z.object({ callbackUrl: z.string().url().max(8192) }).parse(request.body)
    const credentials = appCredentials('performance')
    const callback = new URL(input.callbackUrl), expected = new URL(credentials.redirect)
    if (callback.origin !== expected.origin || callback.pathname !== expected.pathname || callback.searchParams.getAll('code').length !== 1 || callback.searchParams.getAll('state').length !== 1 || callback.searchParams.has('error')) throw new IntegrationError('INVALID_CALLBACK', '请填写本次绩效应用成功授权的完整回跳地址。', 400)
    const code = callback.searchParams.get('code'), state = callback.searchParams.get('state')
    if (!code || !state) throw new IntegrationError('INVALID_CALLBACK', '回跳地址缺少授权码或 state。', 400)
    // Only a state issued by the performance app is accepted, so a product authorization callback cannot be replayed here.
    const consumed = await db.query('UPDATE integration_1688_perf_oauth_states SET consumed_at=now() WHERE state_hash=$1 AND tenant_id=$2 AND created_by=$3 AND app_key=$4 AND redirect_uri=$5 AND consumed_at IS NULL AND expires_at>now() RETURNING state_hash', [stateHash(state), request.authUser.tenantId, request.authUser.sub, credentials.appKey, credentials.redirect])
    if (!consumed.rows.length) throw new IntegrationError('INVALID_STATE', '授权状态无效、过期或已使用，请重新发起。', 409)
    const start = Date.now()
    try {
      const row = await saveConnection(request.authUser.tenantId, request.authUser.sub, await getGrant({ code }, 'performance'), Date.now(), 'performance')
      await recordOperation(request.authUser.tenantId, row.id, request.authUser.sub, 'oauth.authorize', start, undefined, request.id, 'performance')
      await audit(request.authUser.tenantId, request.authUser.sub, '1688_perf_connection', row.id, '1688.performance.authorize', request.id)
      return reply.code(201).send({ data: row })
    } catch (error) { await recordOperation(request.authUser.tenantId, null, request.authUser.sub, 'oauth.authorize', start, error, request.id, 'performance'); throw error }
  })
  app.post('/connections/:id/test', { preHandler: requirePermission('performance:manage') }, async request => {
    const { id } = idSchema.parse(request.params)
    return { data: await testPerformanceConnection(id, request.authUser.tenantId, request.authUser.sub, request.id) }
  })
  app.post('/connections/:id/refresh', { preHandler: requirePermission('performance:manage') }, async request => {
    const { id } = idSchema.parse(request.params)
    await connectionToken(id, request.authUser.tenantId, request.authUser.sub, true, 'performance')
    return { data: { refreshed: true } }
  })
  app.post('/connections/:id/disable', { preHandler: requirePermission('performance:manage') }, async request => {
    const { id } = idSchema.parse(request.params)
    const result = await db.query("UPDATE integration_1688_perf_connections SET status='disabled',updated_at=now() WHERE id=$1 AND tenant_id=$2 RETURNING id", [id, request.authUser.tenantId])
    if (!result.rows.length) throw new IntegrationError('NOT_FOUND', '绩效连接不存在。', 404)
    await audit(request.authUser.tenantId, request.authUser.sub, '1688_perf_connection', id, '1688.performance.disable', request.id)
    return { data: { disabled: true } }
  })
  // Removing a performance connection nobody uses. Only a disabled one, and never one holding work people typed in
  // (follow-ups, attachments) or locked payroll: those stay with the shop. Orders, chats and buyers synced from 1688
  // go with it (a new authorization syncs them again).
  app.get('/connections/:id/usage', { preHandler: requirePermission('performance:manage') }, async request => {
    const { id } = idSchema.parse(request.params)
    return { data: await perfConnectionUsage(id, request.authUser.tenantId) }
  })
  app.delete('/connections/:id', { preHandler: requirePermission('performance:manage') }, async request => {
    const { id } = idSchema.parse(request.params)
    const usage = await perfConnectionUsage(id, request.authUser.tenantId)
    if (usage.status !== 'disabled') throw new IntegrationError('CONNECTION_ACTIVE', '请先停用这个绩效应用连接，再删除。', 409)
    const kept = [usage.followups && `${usage.followups} 条跟进记录`, usage.attachments && `${usage.attachments} 个客户附件`, usage.locked_payrolls && `${usage.locked_payrolls} 期已锁定工资单`].filter(Boolean)
    if (kept.length) throw new IntegrationError('CONNECTION_IN_USE', `这个店铺有 ${kept.join('、')}，需要保留，不能删除；保持停用即可。`, 409)
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      const removed = await client.query("DELETE FROM integration_1688_perf_connections WHERE id=$1 AND tenant_id=$2 AND status='disabled' RETURNING id", [id, request.authUser.tenantId])
      if (!removed.rows.length) throw new IntegrationError('NOT_FOUND', '连接不存在或状态已变化，请刷新后重试。', 409)
      await client.query('INSERT INTO audit_logs(tenant_id,actor_id,action,entity_type,entity_id,after_data,request_id)VALUES($1,$2,$3,$4,$5,$6,$7)',
        [request.authUser.tenantId, request.authUser.sub, '1688.performance.delete', '1688_perf_connection', id, JSON.stringify(usage), request.id])
      await client.query('COMMIT')
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
    return { data: { deleted: true } }
  })
  app.get('/operations', { preHandler: requirePermission('performance:read') }, async request => {
    const { page } = z.object({ page: z.coerce.number().int().min(1).default(1) }).parse(request.query)
    return { data: (await db.query("SELECT o.id,o.api_name,o.outcome,o.error_code,o.duration_ms,o.created_at,c.display_name FROM integration_1688_operations o LEFT JOIN integration_1688_perf_connections c ON c.id=o.perf_connection_id WHERE o.tenant_id=$1 AND o.app_purpose='performance' ORDER BY o.created_at DESC LIMIT 50 OFFSET $2", [request.authUser.tenantId, (page - 1) * 50])).rows }
  })

  app.get('/settings', { preHandler: requirePermission('performance:read') }, async request => {
    await db.query('INSERT INTO perf_settings(tenant_id) VALUES($1) ON CONFLICT DO NOTHING', [request.authUser.tenantId])
    return { data: (await db.query(`SELECT ${settingsColumns} FROM perf_settings WHERE tenant_id=$1`, [request.authUser.tenantId])).rows[0] }
  })
  // Metric thresholds belong to performance managers; the attribution scheme decides commission, so it belongs to finance.
  app.put('/settings', { preHandler: requireAuth }, async (request, reply) => {
    const input = settingsInput.parse(request.body)
    const granted = request.authUser.permissions
    const touchesMetrics = input.attributionWindowHours !== undefined || input.unansweredThresholdSeconds !== undefined || input.countOtherAsReply !== undefined
      || input.workHoursEnabled !== undefined || input.workStart !== undefined || input.workEnd !== undefined
    // Scheme, split ratios and ownership decide commission, so they belong to finance.
    const touchesCredit = input.defaultScheme !== undefined || input.splitOrderShare !== undefined || input.ownerShare !== undefined || input.autoAssignOwner !== undefined
    if ((touchesMetrics && !hasPermission(granted, 'performance:manage')) || (touchesCredit && !hasPermission(granted, 'payroll:manage')) || (!touchesMetrics && !touchesCredit)) {
      return reply.code(403).send({ error: 'FORBIDDEN', message: '当前账号没有修改这些绩效设置的权限。' })
    }
    if (input.defaultScheme && !(availableSchemes as readonly string[]).includes(input.defaultScheme)) throw new IntegrationError('SCHEME_UNAVAILABLE', '该绩效方案需要订单插旗备注或会员所属客服数据，当前未启用。', 400)
    await db.query('INSERT INTO perf_settings(tenant_id) VALUES($1) ON CONFLICT DO NOTHING', [request.authUser.tenantId])
    if (input.workStart !== undefined || input.workEnd !== undefined) {
      const current = (await db.query("SELECT to_char(work_start,'HH24:MI') AS work_start,to_char(work_end,'HH24:MI') AS work_end FROM perf_settings WHERE tenant_id=$1", [request.authUser.tenantId])).rows[0]
      const start = input.workStart ?? current.work_start, end = input.workEnd === '24:00' ? '24:00' : input.workEnd ?? current.work_end
      if (start >= end) throw new IntegrationError('INVALID_WORK_HOURS', '上班时间需早于下班时间。', 400)
    }
    const updated = await db.query(`UPDATE perf_settings SET attribution_window_hours=coalesce($3,attribution_window_hours),unanswered_threshold_seconds=coalesce($4,unanswered_threshold_seconds),
      default_scheme=coalesce($5,default_scheme),count_other_as_reply=coalesce($7,count_other_as_reply),work_hours_enabled=coalesce($8,work_hours_enabled),
      work_start=coalesce($9::time,work_start),work_end=coalesce($10::time,work_end),split_order_share=coalesce($11,split_order_share),owner_share=coalesce($12,owner_share),
      auto_assign_owner=coalesce($13,auto_assign_owner),revision=revision+1,updated_by=$6,updated_at=now() WHERE tenant_id=$1 AND revision=$2 RETURNING ${settingsColumns}`,
    [request.authUser.tenantId, input.revision, input.attributionWindowHours ?? null, input.unansweredThresholdSeconds ?? null, input.defaultScheme ?? null, request.authUser.sub, input.countOtherAsReply ?? null,
      input.workHoursEnabled ?? null, input.workStart ?? null, input.workEnd ?? null, input.splitOrderShare ?? null, input.ownerShare ?? null, input.autoAssignOwner ?? null])
    if (!updated.rows.length) throw new IntegrationError('REVISION_CONFLICT', '设置已被他人修改，请刷新后重试。', 409)
    await audit(request.authUser.tenantId, request.authUser.sub, 'perf_settings', request.authUser.tenantId, 'performance.settings.update', request.id, updated.rows[0])
    // Window and reply rule change order credit; recompute without waiting for the next scheduled sync.
    if (input.attributionWindowHours !== undefined || input.countOtherAsReply !== undefined || input.splitOrderShare !== undefined || input.ownerShare !== undefined || input.autoAssignOwner !== undefined) {
      const shops = (await db.query("SELECT id FROM integration_1688_perf_connections WHERE tenant_id=$1 AND status='connected' AND account_role<>'sub'", [request.authUser.tenantId])).rows
      for (const shop of shops) {
        if (input.autoAssignOwner !== undefined) await assignOwners(request.authUser.tenantId, shop.id)
        await enqueuePerformanceSync(request.authUser.tenantId, shop.id, request.authUser.sub, 'manual')
      }
    }
    return { data: updated.rows[0] }
  })

  // Scheme 5: order flag colour → agent, per shop. Counts help match colours to how the team actually flags orders.
  app.get('/connections/:id/flag-rules', { preHandler: readScope }, async request => {
    const { id } = idSchema.parse(request.params)
    await ensureConnection(request.authUser.tenantId, id)
    const rules = (await db.query('SELECT flag,agent_id FROM perf_flag_rules WHERE connection_id=$1 ORDER BY flag', [id])).rows
    const usage = (await db.query(`SELECT seller_flag AS flag,count(*)::int AS orders FROM perf_orders WHERE connection_id=$1 AND seller_flag IS NOT NULL AND placed_at>now()-interval '90 days' GROUP BY 1 ORDER BY 1`, [id])).rows
    const mentions = (await db.query(`SELECT count(*)::int AS n FROM perf_orders WHERE connection_id=$1 AND seller_memo LIKE '%@%' AND placed_at>now()-interval '90 days'`, [id])).rows[0].n
    const credited = (await db.query(`SELECT count(DISTINCT a.order_id)::int AS n FROM perf_order_attributions a JOIN perf_orders o ON o.id=a.order_id
      WHERE o.connection_id=$1 AND a.scheme='memo_flag' AND o.placed_at>now()-interval '90 days'`, [id])).rows[0].n
    return { data: { rules, usage, memoMentions: mentions, creditedOrders: credited } }
  })
  app.put('/connections/:id/flag-rules', { preHandler: requirePermission('payroll:manage') }, async request => {
    const { id } = idSchema.parse(request.params)
    const { rules } = z.object({ rules: z.array(z.object({ flag: z.number().int().min(1).max(10), agentId: z.string().uuid() }).strict()).max(10) }).strict().parse(request.body)
    await ensureConnection(request.authUser.tenantId, id)
    if (new Set(rules.map(r => r.flag)).size !== rules.length) throw new IntegrationError('DUPLICATE_FLAG', '每个旗帜只能对应一个客服。', 400)
    const agentIds = [...new Set(rules.map(r => r.agentId))]
    if (agentIds.length && (await db.query('SELECT count(*)::int AS n FROM perf_agents WHERE connection_id=$1 AND id=ANY($2)', [id, agentIds])).rows[0].n !== agentIds.length) throw new IntegrationError('AGENT_NOT_FOUND', '所选客服账号不属于该店铺。', 400)
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      await client.query('DELETE FROM perf_flag_rules WHERE connection_id=$1', [id])
      for (const rule of rules) await client.query('INSERT INTO perf_flag_rules(connection_id,flag,agent_id,updated_by) VALUES($1,$2,$3,$4)', [id, rule.flag, rule.agentId, request.authUser.sub])
      // Flagged orders are re-attributed by the next sync, which is queued right away.
      await client.query('UPDATE perf_orders SET attribution_key=NULL WHERE connection_id=$1 AND seller_flag IS NOT NULL', [id])
      await client.query('COMMIT')
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
    await audit(request.authUser.tenantId, request.authUser.sub, 'perf_flag_rules', id, 'performance.flag_rules.update', request.id, { rules })
    await enqueuePerformanceSync(request.authUser.tenantId, id, request.authUser.sub, 'manual')
    return { data: (await db.query('SELECT flag,agent_id FROM perf_flag_rules WHERE connection_id=$1 ORDER BY flag', [id])).rows }
  })

  app.get('/agents', { preHandler: readScope }, async request => {
    const { connectionId } = z.object({ connectionId: z.string().uuid() }).parse(request.query)
    await ensureConnection(request.authUser.tenantId, connectionId)
    const rows = await db.query(`SELECT a.id,a.login_id,a.is_main,a.platform_status,a.present,a.user_id,a.binding_revision,a.relations_synced_until,u.display_name AS user_name
      FROM perf_agents a LEFT JOIN users u ON u.id=a.user_id WHERE a.tenant_id=$1 AND a.connection_id=$2 AND ($3::uuid IS NULL OR a.user_id=$3) ORDER BY a.is_main DESC,a.login_id`,
    [request.authUser.tenantId, connectionId, ownOnly(request) ? request.authUser.sub : null])
    return { data: rows.rows }
  })
  app.put('/agents/:id/binding', { preHandler: requirePermission('performance:manage') }, async request => {
    const { id } = idSchema.parse(request.params)
    const input = z.object({ userId: z.string().uuid().nullable(), revision: z.number().int().positive() }).strict().parse(request.body)
    if (input.userId && !(await db.query("SELECT 1 FROM users WHERE id=$1 AND tenant_id=$2 AND status='active' AND deleted_at IS NULL", [input.userId, request.authUser.tenantId])).rows.length) throw new IntegrationError('USER_NOT_FOUND', '所选用户不存在或已停用。', 400)
    let updated
    try {
      updated = await db.query(`UPDATE perf_agents SET user_id=$3,binding_revision=binding_revision+1,updated_at=now() WHERE id=$1 AND tenant_id=$2 AND binding_revision=$4
        RETURNING id,login_id,user_id,binding_revision,(SELECT display_name FROM users WHERE id=$3) AS user_name`, [id, request.authUser.tenantId, input.userId, input.revision])
    } catch (error) {
      if ((error as { code?: string }).code === '23505') throw new IntegrationError('USER_ALREADY_BOUND', '该用户已绑定本店铺的其他客服账号。', 409)
      throw error
    }
    if (!updated.rows.length) {
      const exists = (await db.query('SELECT 1 FROM perf_agents WHERE id=$1 AND tenant_id=$2', [id, request.authUser.tenantId])).rows.length
      throw exists ? new IntegrationError('REVISION_CONFLICT', '绑定已被他人修改，请刷新后重试。', 409) : new IntegrationError('NOT_FOUND', '客服账号不存在。', 404)
    }
    await audit(request.authUser.tenantId, request.authUser.sub, 'perf_agent', id, input.userId ? 'performance.agent.bind' : 'performance.agent.unbind', request.id, { userId: input.userId })
    return { data: updated.rows[0] }
  })

  app.post('/connections/:id/sync', { preHandler: requirePermission('performance:manage') }, async (request, reply) => {
    const { id } = idSchema.parse(request.params)
    // scopeDays limits this run to today / the last 7 / 30 days; omitted = full run including history up to the shop's range.
    const { scopeDays } = z.object({ scopeDays: z.union([z.literal(1), z.literal(7), z.literal(30)]).optional() }).strict().parse(request.body ?? {})
    const connection = (await db.query('SELECT status,account_role FROM integration_1688_perf_connections WHERE id=$1 AND tenant_id=$2', [id, request.authUser.tenantId])).rows[0]
    if (!connection) throw new IntegrationError('NOT_FOUND', '绩效连接不存在。', 404)
    if (connection.status !== 'connected') throw new IntegrationError('CONNECTION_INACTIVE', '连接已停用或需要重新授权。', 409)
    if (connection.account_role === 'sub') throw new IntegrationError('SUB_ACCOUNT_GRANT', '当前授权的是子账号，请使用主账号重新授权后再同步。', 409)
    const runId = await enqueuePerformanceSync(request.authUser.tenantId, id, request.authUser.sub, 'manual', scopeDays)
    if (!runId) throw new IntegrationError('SYNC_IN_PROGRESS', '该店铺已有同步任务在排队或进行中。', 409)
    return reply.code(202).send({ data: { id: runId } })
  })
  // How far back to keep filling history. Lowering it keeps data already synced; raising it is filled by the next runs.
  app.put('/connections/:id/history-days', { preHandler: requirePermission('performance:manage') }, async request => {
    const { id } = idSchema.parse(request.params)
    const { days } = z.object({ days: z.union([z.literal(7), z.literal(30), z.literal(60), z.literal(90)]) }).strict().parse(request.body)
    const row = (await db.query('UPDATE integration_1688_perf_connections SET history_days=$3,updated_at=now() WHERE id=$1 AND tenant_id=$2 RETURNING id', [id, request.authUser.tenantId, days])).rows[0]
    if (!row) throw new IntegrationError('NOT_FOUND', '绩效连接不存在。', 404)
    await audit(request.authUser.tenantId, request.authUser.sub, '1688_perf_connection', id, '1688.performance.history_days', request.id, { days })
    return { data: { historyDays: days } }
  })

  // Progress of the shop's data against its history range: how far back each feed is complete and what is still pending.
  app.get('/connections/:id/sync-status', { preHandler: readScope }, async request => {
    const { id } = idSchema.parse(request.params)
    const row = (await db.query(`WITH c AS (SELECT c.*,(now() AT TIME ZONE 'Asia/Shanghai')::date-(c.history_days-1) AS history_from FROM integration_1688_perf_connections c WHERE c.id=$1 AND c.tenant_id=$2)
      SELECT c.history_days,c.history_from::text AS history_from,c.orders_synced_from,c.refunds_synced_from,
        (SELECT min(relations_synced_from) FROM perf_agents a WHERE a.connection_id=c.id AND a.present) AS chats_synced_from,
        (SELECT count(*)::int FROM perf_chat_sessions s WHERE s.connection_id=c.id AND s.needs_sync AND s.chat_date>=c.history_from) AS pending_sessions,
        (SELECT count(*)::int FROM perf_chat_sessions s WHERE s.connection_id=c.id AND s.needs_sync AND s.chat_date<c.history_from) AS skipped_sessions,
        (SELECT count(*)::int FROM integration_1688_operations o WHERE o.perf_connection_id=c.id AND o.created_at>=(date_trunc('day',now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai')) AS calls_today
      FROM c`, [id, request.authUser.tenantId])).rows[0]
    if (!row) throw new IntegrationError('NOT_FOUND', '绩效连接不存在。', 404)
    return { data: { ...row, daily_call_limit: config.PERF_SYNC_DAILY_CALLS } }
  })

  app.get('/sync-runs', { preHandler: requirePermission('performance:read') }, async request => {
    const { connectionId } = z.object({ connectionId: z.string().uuid() }).parse(request.query)
    return { data: (await db.query(`SELECT id,trigger,backfill_days,scope_days,status,phase,attempts,stats,error_code,error_message,created_at,started_at,finished_at FROM perf_sync_runs
      WHERE tenant_id=$1 AND connection_id=$2 ORDER BY created_at DESC LIMIT 20`, [request.authUser.tenantId, connectionId])).rows }
  })

  // Reception metrics per agent. The unanswered threshold is applied at query time, so a settings change re-scores history.
  app.get('/metrics', { preHandler: readScope }, async request => {
    const query = reportQuery.parse(request.query)
    await ensureConnection(request.authUser.tenantId, query.connectionId)
    const result = await agentMetrics(request.authUser.tenantId, query.connectionId, query.from, query.to, ownOnly(request) ? request.authUser.sub : null)
    const synced = (await db.query("SELECT max(finished_at) AS at FROM perf_sync_runs WHERE tenant_id=$1 AND connection_id=$2 AND status='succeeded'", [request.authUser.tenantId, query.connectionId])).rows[0].at
    return { data: result.rows, syncedAt: synced, scheme: result.scheme }
  })
  app.get('/metrics/hourly', { preHandler: readScope }, async request => {
    const query = reportQuery.parse(request.query)
    await ensureConnection(request.authUser.tenantId, query.connectionId)
    const rows = await db.query(`SELECT s.agent_id,CASE WHEN h<9 THEN 0 ELSE h END AS bucket,count(DISTINCT (s.buyer_id,s.chat_date))::int AS reception
      FROM perf_chat_turns t JOIN perf_chat_sessions s ON s.id=t.session_id JOIN perf_agents a ON a.id=s.agent_id
      CROSS JOIN LATERAL (SELECT extract(hour FROM t.turn_at AT TIME ZONE 'Asia/Shanghai')::int AS h) hour
      WHERE s.tenant_id=$1 AND s.connection_id=$2 AND s.chat_date BETWEEN $3::date AND $4::date AND ($5::uuid IS NULL OR a.user_id=$5) AND t.mode='strict'
      GROUP BY s.agent_id,bucket`, [request.authUser.tenantId, query.connectionId, query.from, query.to, ownOnly(request) ? request.authUser.sub : null])
    return { data: { buckets: hourBuckets, cells: rows.rows } }
  })
}
