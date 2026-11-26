import type { PoolClient } from 'pg'
import { IntegrationError } from './1688.js'

const isolationRequired = () => new IntegrationError(
  'WORKSPACE_ISOLATION_REQUIRED',
  '历史工作区包含尚未确认归属的 1688 店铺，请由运营方授权自有店铺或完成数据隔离。',
  409,
)

// Distinct 1688 accounts across both integrations and any previous login bindings.
export const workspaceAccounts = `
  SELECT ali_id FROM integration_1688_connections WHERE tenant_id=$1
  UNION
  SELECT ali_id FROM integration_1688_perf_connections WHERE tenant_id=$1
  UNION
  SELECT i.ali_id FROM auth_1688_identities i JOIN users u ON u.id=i.user_id WHERE u.tenant_id=$1`

export async function collectorCanAccessWorkspace(client: Pick<PoolClient, 'query'>, tenantId: string, userId: string) {
  const result = await client.query<{ allowed: boolean }>(`
    SELECT CASE WHEN t.ali1688_owner_id IS NULL
      THEN (SELECT count(*) <= 1 FROM (${workspaceAccounts}) accounts)
      ELSE EXISTS(
        SELECT 1 FROM auth_1688_identities i WHERE i.user_id=$2
          AND (i.ali_id=t.ali1688_owner_id OR EXISTS(
            SELECT 1 FROM tenant_1688_shops s WHERE s.tenant_id=t.id AND s.ali_id=i.ali_id)))
    END AS allowed FROM tenants t WHERE t.id=$1 AND t.status='active'`, [tenantId, userId])
  return result.rows[0]?.allowed === true
}

export async function claim1688Workspace(client: PoolClient, tenantId: string, aliId: string) {
  const workspace = (await client.query<{ ali1688_owner_id: string | null }>(
    "SELECT ali1688_owner_id FROM tenants WHERE id=$1 AND status='active' FOR UPDATE", [tenantId],
  )).rows[0]
  const approved = (await client.query('SELECT 1 FROM tenant_1688_shops WHERE tenant_id=$1 AND ali_id=$2', [tenantId, aliId])).rowCount
  if (!workspace || (workspace.ali1688_owner_id && workspace.ali1688_owner_id !== aliId && !approved)) throw isolationRequired()

  // Additional accounts require explicit approval before members may see their shared workspace.
  const { conflict } = (await client.query<{ conflict: boolean }>(`
    SELECT EXISTS (
      SELECT 1 FROM (${workspaceAccounts}) accounts
      WHERE ali_id<>$2 AND NOT EXISTS(
        SELECT 1 FROM tenant_1688_shops s WHERE s.tenant_id=$1 AND s.ali_id=accounts.ali_id)
      UNION ALL
      SELECT 1 FROM tenants WHERE ali1688_owner_id=$2 AND id<>$1
      UNION ALL
      SELECT 1 FROM tenant_1688_shops WHERE ali_id=$2 AND tenant_id<>$1
    ) AS conflict`, [tenantId, aliId])).rows[0]
  if (conflict) throw isolationRequired()
  if (!workspace.ali1688_owner_id) {
    await client.query('UPDATE tenants SET ali1688_owner_id=$2 WHERE id=$1', [tenantId, aliId])
  }
}
