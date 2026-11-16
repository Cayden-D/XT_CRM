import { createHash } from 'node:crypto'
import { db } from '../db.js'
import { IntegrationError } from './1688.js'

export type OwnBrand = { id: string; name: string; aliases: string[]; logo_key: string | null; connection_id: string | null }

export const BRAND_SCOPE = '(connection_id IS NULL OR connection_id=$2::uuid)'
const COLUMNS = 'id,name,aliases,logo_key,connection_id'
export async function defaultBrand(tenantId: string, connectionId?: string | null): Promise<OwnBrand | null> {
  return (await db.query(`SELECT ${COLUMNS} FROM brands WHERE tenant_id=$1 AND ${BRAND_SCOPE} AND is_default
    ORDER BY connection_id NULLS LAST LIMIT 1`, [tenantId, connectionId ?? null])).rows[0] ?? null
}
// A worker resolves an already-queued brand by its tenant and ID. New jobs must pass their destination.
export async function brandById(tenantId: string, id: string, connectionId?: string | null): Promise<OwnBrand | null> {
  const scope = connectionId === undefined ? '' : ' AND (connection_id IS NULL OR connection_id=$3::uuid)'
  const values = connectionId === undefined ? [tenantId, id] : [tenantId, id, connectionId]
  return (await db.query(`SELECT ${COLUMNS} FROM brands WHERE tenant_id=$1 AND id=$2${scope}`, values)).rows[0] ?? null
}
/** Every name the shop's own brands go by; a logo or watermark reading one of them is not someone else's. */
export async function ownBrandNames(tenantId: string, connectionId?: string | null): Promise<string[]> {
  const rows = (await db.query<{ name: string; aliases: string[] }>(`SELECT name,aliases FROM brands WHERE tenant_id=$1 AND ${BRAND_SCOPE}`, [tenantId, connectionId ?? null])).rows
  return rows.flatMap(r => [r.name, ...r.aliases])
}

export async function otherShopBrandNames(tenantId: string, connectionId: string, ownNames: string[]) {
  const rows = (await db.query<{ name: string; aliases: string[] }>('SELECT name,aliases FROM brands WHERE tenant_id=$1 AND connection_id<>$2', [tenantId, connectionId])).rows
  const own = new Set(ownNames.map(name => name.trim().toLowerCase()))
  return [...new Set(rows.flatMap(row => [row.name, ...row.aliases]).map(name => name.trim()).filter(name => !own.has(name.toLowerCase())))]
}

export const brandPolicy = (names: string[]) =>
  createHash('sha256').update(JSON.stringify([...new Set(names)].sort())).digest('hex')

export async function checkBrandShop(tenantId: string, connectionId?: string | null) {
  if (connectionId && !(await db.query('SELECT 1 FROM integration_1688_connections WHERE tenant_id=$1 AND id=$2', [tenantId, connectionId])).rows.length) {
    throw new IntegrationError('NOT_FOUND', '店铺不存在。', 404)
  }
}
