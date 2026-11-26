import { db } from '../db.js'
import { appCredentials } from './1688.js'
import { lock1688Identity } from './1688-sign-in.js'
import { claim1688Workspace, workspaceAccounts } from './1688-workspace.js'

/** Authorize specified existing shops, with a read-only preview by default. */
export async function authorizeWorkspaceShops(slug: string, accounts: string[], apply = false) {
  const aliIds = [...new Set(accounts)].sort()
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    for (const aliId of aliIds) await lock1688Identity(client, aliId)
    const tenant = (await client.query<{ id: string; ali1688_owner_id: string | null }>(
      "SELECT id,ali1688_owner_id FROM tenants WHERE slug=$1 AND status='active' FOR UPDATE", [slug],
    )).rows[0]
    if (!tenant) throw new Error('找不到启用的工作区。')

    const existing = (await client.query<{ ali_id: string }>(workspaceAccounts, [tenant.id])).rows.map(r => r.ali_id)
    if (aliIds.some(aliId => !existing.includes(aliId))) {
      throw new Error('指定账号未在该工作区的店铺或登录记录中找到，请核对账号 ID。')
    }
    if (existing.some(aliId => !aliIds.includes(aliId))) {
      throw new Error('授权列表未包含该工作区的全部历史账号，请先核对所有店铺归属。')
    }
    const foreign = await client.query(`
      SELECT ali_id FROM integration_1688_connections WHERE tenant_id<>$1 AND ali_id=ANY($2)
      UNION SELECT ali_id FROM integration_1688_perf_connections WHERE tenant_id<>$1 AND ali_id=ANY($2)
      UNION SELECT i.ali_id FROM auth_1688_identities i JOIN users u ON u.id=i.user_id
        WHERE u.tenant_id<>$1 AND i.ali_id=ANY($2)
      UNION SELECT ali1688_owner_id FROM tenants WHERE id<>$1 AND ali1688_owner_id=ANY($2)
      UNION SELECT ali_id FROM tenant_1688_shops WHERE tenant_id<>$1 AND ali_id=ANY($2)`,
    [tenant.id, aliIds])
    if (foreign.rowCount) throw new Error('指定账号已出现在其他工作区，需先核对其归属。')

    const { appKey } = appCredentials('performance')
    const admin = (await client.query<{ id: string; ali_id: string }>(`
      SELECT u.id,i.ali_id FROM users u
      JOIN auth_1688_identities i ON i.user_id=u.id AND i.app_key=$2
      WHERE u.tenant_id=$1 AND u.status='active' AND u.deleted_at IS NULL
        AND EXISTS(SELECT 1 FROM user_roles ur JOIN roles r ON r.id=ur.role_id
          WHERE ur.user_id=u.id AND r.tenant_id=u.tenant_id AND r.code='super_admin')
      ORDER BY u.created_at LIMIT 1`, [tenant.id, appKey])).rows[0]
    if (!admin || !aliIds.includes(admin.ali_id)) throw new Error('找不到已绑定所列 1688 账号的超级管理员。')
    if (tenant.ali1688_owner_id && !aliIds.includes(tenant.ali1688_owner_id)) {
      throw new Error('该工作区的负责人不在授权列表中，请先核对。')
    }

    const shops = (await client.query<{ source: string; name: string; ali_id: string }>(`
      SELECT '商品店铺' AS source,display_name AS name,ali_id FROM integration_1688_connections WHERE tenant_id=$1
      UNION ALL SELECT '绩效店铺',display_name,ali_id FROM integration_1688_perf_connections WHERE tenant_id=$1
      ORDER BY ali_id,source`, [tenant.id])).rows
    if (apply) {
      await client.query(`
        INSERT INTO tenant_1688_shops(tenant_id,ali_id)
        SELECT $1,unnest($2::text[]) ON CONFLICT(ali_id) DO NOTHING`, [tenant.id, aliIds])
      await claim1688Workspace(client, tenant.id, tenant.ali1688_owner_id ?? admin.ali_id)
      await client.query(`
        INSERT INTO audit_logs(tenant_id,actor_id,action,entity_type,entity_id,after_data)
        VALUES($1,$2,'1688.workspace.shops.authorize','tenant',$1,$3)`,
      [tenant.id, admin.id, JSON.stringify({ aliIds })])
    }
    await client.query(apply ? 'COMMIT' : 'ROLLBACK')
    return { workspace: slug, adminAliId: admin.ali_id, applied: apply, shops }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally { client.release() }
}
