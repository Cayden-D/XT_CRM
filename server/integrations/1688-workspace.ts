import type { PoolClient } from 'pg'
import { IntegrationError } from './1688.js'

const isolationRequired = () => new IntegrationError(
  'WORKSPACE_ISOLATION_REQUIRED',
  '历史工作区存在其他 1688 账号的数据，需要运营方完成店铺隔离后才能访问。',
  409,
)

// Distinct 1688 accounts across both integrations and any previous login bindings.
const workspaceAccounts = `
  SELECT ali_id FROM integration_1688_connections WHERE tenant_id=$1
  UNION
  SELECT ali_id FROM integration_1688_perf_connections WHERE tenant_id=$1
  UNION
  SELECT i.ali_id FROM auth_1688_identities i JOIN users u ON u.id=i.user_id WHERE u.tenant_id=$1`

export async function collectorCanAccessWorkspace(client: Pick<PoolClient, 'query'>, tenantId: string, userId: string) {
  const result = await client.query<{ allowed: boolean }>(`
    SELECT CASE WHEN t.ali1688_owner_id IS NULL
      THEN (SELECT count(*) <= 1 FROM (${workspaceAccounts}) accounts)
      ELSE EXISTS(SELECT 1 FROM auth_1688_identities i WHERE i.user_id=$2 AND i.ali_id=t.ali1688_owner_id)
    END AS allowed FROM tenants t WHERE t.id=$1 AND t.status='active'`, [tenantId, userId])
  return result.rows[0]?.allowed === true
}

export async function claim1688Workspace(client: PoolClient, tenantId: string, aliId: string) {
  const workspace = (await client.query<{ ali1688_owner_id: string | null }>(
    "SELECT ali1688_owner_id FROM tenants WHERE id=$1 AND status='active' FOR UPDATE", [tenantId],
  )).rows[0]
  if (!workspace || (workspace.ali1688_owner_id && workspace.ali1688_owner_id !== aliId)) throw isolationRequired()

  // Every business route scopes data to tenant_id. Reject a tenant containing a second merchant
  // rather than issue a session that would see both merchants' records.
  const { conflict } = (await client.query<{ conflict: boolean }>(`
    SELECT EXISTS (
      SELECT 1 FROM (${workspaceAccounts}) accounts WHERE ali_id<>$2
      UNION ALL
      SELECT 1 FROM tenants WHERE ali1688_owner_id=$2 AND id<>$1
    ) AS conflict`, [tenantId, aliId])).rows[0]
  if (conflict) throw isolationRequired()
  if (!workspace.ali1688_owner_id) {
    await client.query('UPDATE tenants SET ali1688_owner_id=$2 WHERE id=$1', [tenantId, aliId])
  }
}
