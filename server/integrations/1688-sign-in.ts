import { db } from '../db.js'
import type { AuthToken } from '../types/fastify.js'
import { IntegrationError, saveConnection, stateHash, type Grant } from './1688.js'
import type { PoolClient } from 'pg'
import { claim1688Workspace } from './1688-workspace.js'

const OWNER_PERMISSIONS = [
  'dashboard:*', 'report:*', 'account:*', 'product:*', 'collection:*', 'integration:*',
  'performance:*', 'payroll:*', 'customer_ops:*', 'order:*', 'settlement:*',
]

export async function lock1688Identity(client: PoolClient, aliId: string) {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify(['1688-workspace', aliId])])
}

export async function signIn1688(appKey: string, grant: Grant, obtainedAt: number): Promise<AuthToken & { oauth1688: { appKey: string; aliId: string } }> {
  // Only identity from the server-to-server exchange is trusted. Never match a nickname, email, or callback parameter.
  const aliId = typeof grant.aliId === 'string' || Number.isSafeInteger(grant.aliId) ? String(grant.aliId).trim() : ''
  if (!aliId || aliId.length > 255) throw new IntegrationError('IDENTITY_MISSING', '1688 未返回有效的账号标识，请重新授权。', 502)
  grant = { ...grant,
    resource_owner: typeof grant.resource_owner === 'string' ? grant.resource_owner.trim() : undefined,
    memberId: typeof grant.memberId === 'string' ? grant.memberId.trim() : undefined,
  }
  const displayName = [...(grant.resource_owner || grant.memberId || '1688 商家')].slice(0, 80).join('')
  const fingerprint = stateHash(JSON.stringify([appKey, aliId]))

  const client = await db.connect()
  try {
    await client.query('BEGIN')
    await lock1688Identity(client, aliId)
    const identity = await client.query<{ id: string; tenant_id: string; active: boolean }>(`
      SELECT u.id,u.tenant_id,(u.status='active' AND u.deleted_at IS NULL AND t.status='active') AS active
      FROM auth_1688_identities i JOIN users u ON u.id=i.user_id JOIN tenants t ON t.id=u.tenant_id
      WHERE i.app_key=$1 AND i.ali_id=$2`, [appKey, aliId])
    const existing = identity.rows[0]
    if (existing && !existing.active) throw new IntegrationError('ACCOUNT_DISABLED', '当前工作区或成员权限已停用，请联系管理员。', 403)

    const connection = (await client.query<{ tenant_id: string }>(
      'SELECT tenant_id FROM integration_1688_perf_connections WHERE app_key=$1 AND ali_id=$2', [appKey, aliId])).rows[0]
    // A legacy shop may live alongside other merchants. Its grant alone cannot give access to that whole workspace.
    if (connection && !existing) throw new IntegrationError('LEGACY_WORKSPACE', '该 1688 账号已关联旧版店铺。请联系应用运营方完成历史工作区迁移后重试。', 409)

    let tenantId = existing?.tenant_id
    let userId = existing?.id
    if (!tenantId || !userId) {
      tenantId = (await client.query<{ id: string }>(`
        INSERT INTO tenants(name,slug,default_currency) VALUES($1,$2,'CNY') RETURNING id`,
      [displayName, `1688-${fingerprint}`])).rows[0].id
      userId = (await client.query<{ id: string }>(`
        INSERT INTO users(tenant_id,email,display_name) VALUES($1,$2,$3) RETURNING id`,
      [tenantId, `${fingerprint}@1688.invalid`, displayName])).rows[0].id
      const roleId = (await client.query<{ id: string }>(`
        INSERT INTO roles(tenant_id,code,name,permissions,is_system)
        VALUES($1,'shop_owner','店铺负责人',$2,true) RETURNING id`,
      [tenantId, JSON.stringify(OWNER_PERMISSIONS)])).rows[0].id
      await client.query('INSERT INTO user_roles(user_id,role_id) VALUES($1,$2)', [userId, roleId])
      await client.query('INSERT INTO auth_1688_identities(app_key,ali_id,user_id) VALUES($1,$2,$3)', [appKey, aliId, userId])
    }

    if (connection && connection.tenant_id !== tenantId) {
      throw new IntegrationError('WORKSPACE_ISOLATION_REQUIRED', '该店铺的历史连接和登录工作区不一致，请联系运营方核对。', 409)
    }
    await claim1688Workspace(client, tenantId, aliId)

    // Keep a store's existing verification and suspension settings. An existing member login cannot move or attach a store.
    if (!existing || connection?.tenant_id === tenantId) {
      await saveConnection(tenantId, userId, { ...grant, aliId }, obtainedAt, 'performance', { client, preserveConnectionSettings: true })
    }

    const session = (await client.query<AuthToken>(`
      SELECT u.id AS sub,u.tenant_id AS "tenantId",u.email::text,u.display_name AS "displayName",
        array_remove(array_agg(DISTINCT r.code),NULL) AS roles,
        coalesce(jsonb_agg(DISTINCT p.permission) FILTER(WHERE p.permission IS NOT NULL),'[]') AS permissions
      FROM users u JOIN tenants t ON t.id=u.tenant_id
      LEFT JOIN user_roles ur ON ur.user_id=u.id
      LEFT JOIN roles r ON r.id=ur.role_id AND r.tenant_id=u.tenant_id
      LEFT JOIN LATERAL jsonb_array_elements_text(coalesce(r.permissions,'[]')) p(permission) ON true
      WHERE u.id=$1 AND u.status='active' AND u.deleted_at IS NULL AND t.status='active' GROUP BY u.id`, [userId])).rows[0]
    if (!session) throw new IntegrationError('ACCOUNT_DISABLED', '当前工作区或成员权限已停用，请联系管理员。', 403)
    await client.query('UPDATE users SET last_login_at=now() WHERE id=$1', [userId])
    await client.query('COMMIT')
    return { ...session, oauth1688: { appKey, aliId } }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally { client.release() }
}
