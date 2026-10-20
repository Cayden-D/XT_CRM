import { db } from '../db.js'
import { callProductApi } from './1688.js'

/**
 * Category names for display. alibaba.category.get returns one category with its parent IDs; names are cached for 30
 * days (the tree is platform-wide), so a path costs API calls only the first time. Failures fall back to the ID.
 */
const FRESH_DAYS = 30
type Row = { cat_id: string; name: string; parent_id: string | null }

async function fetchCategory(connectionId: string, tenantId: string, actorId: string, catId: string, requestId?: string) {
  const response = await callProductApi(connectionId, tenantId, actorId, 'alibaba.category.get', { categoryID: catId }, requestId) as { categoryInfo?: Array<{ categoryID?: unknown; name?: unknown; parentIDs?: unknown; isLeaf?: unknown }> }
  const info = response.categoryInfo?.find(c => String(c.categoryID) === catId) ?? response.categoryInfo?.[0]
  if (!info || typeof info.name !== 'string' || !info.name.trim()) return null
  const parents = Array.isArray(info.parentIDs) ? info.parentIDs.map(String).filter(id => /^\d+$/.test(id) && id !== '0') : []
  const row = { cat_id: catId, name: info.name.trim().slice(0, 200), parent_id: parents[0] ?? null }
  await db.query(`INSERT INTO integration_1688_categories(cat_id,name,parent_id,is_leaf) VALUES($1,$2,$3,$4)
    ON CONFLICT(cat_id) DO UPDATE SET name=excluded.name,parent_id=excluded.parent_id,is_leaf=excluded.is_leaf,fetched_at=now()`, [catId, row.name, row.parent_id, info.isLeaf === true])
  return row
}

/** Names from the top level down to the category, e.g. ["汽车用品", "汽车内饰", "座垫、座套"]; null when unavailable. */
export async function categoryPath(connectionId: string, tenantId: string, actorId: string, catId: string | number, requestId?: string): Promise<string[] | null> {
  const names: string[] = []
  let current: string | null = String(catId)
  try {
    for (let depth = 0; current && /^\d{1,20}$/.test(current) && depth < 8; depth++) {
      let row: Row | null = (await db.query<Row>(`SELECT cat_id::text,name,parent_id::text FROM integration_1688_categories WHERE cat_id=$1 AND fetched_at>now()-make_interval(days=>$2)`, [current, FRESH_DAYS])).rows[0] ?? null
      if (!row) row = await fetchCategory(connectionId, tenantId, actorId, current, requestId)
      if (!row) break
      names.unshift(row.name)
      current = row.parent_id
    }
  } catch {
    // Names are a convenience: keep whatever part of the path is known.
  }
  return names.length ? names : null
}
