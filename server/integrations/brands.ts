import { db } from '../db.js'

export type OwnBrand = { id: string; name: string; aliases: string[]; logo_key: string | null }

const COLUMNS = 'id,name,aliases,logo_key'
export async function defaultBrand(tenantId: string): Promise<OwnBrand | null> {
  return (await db.query(`SELECT ${COLUMNS} FROM brands WHERE tenant_id=$1 AND is_default`, [tenantId])).rows[0] ?? null
}
export async function brandById(tenantId: string, id: string): Promise<OwnBrand | null> {
  return (await db.query(`SELECT ${COLUMNS} FROM brands WHERE tenant_id=$1 AND id=$2`, [tenantId, id])).rows[0] ?? null
}
/** Every name the shop's own brands go by; a logo or watermark reading one of them is not someone else's. */
export async function ownBrandNames(tenantId: string): Promise<string[]> {
  const rows = (await db.query('SELECT name,aliases FROM brands WHERE tenant_id=$1', [tenantId])).rows as Array<{ name: string; aliases: string[] }>
  return rows.flatMap(r => [r.name, ...r.aliases])
}
