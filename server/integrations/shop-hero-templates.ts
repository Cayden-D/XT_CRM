import type { PoolClient } from 'pg'
import { db } from '../db.js'
import { IntegrationError } from './1688.js'
import { CUSTOM_HERO_FRAME, HERO_REFERENCE_FRAME } from './hero-reference-frame.js'

export const SHOP_HERO_MODES = ['none', HERO_REFERENCE_FRAME, CUSTOM_HERO_FRAME] as const
export type ShopHeroMode = typeof SHOP_HERO_MODES[number]
export type HeroFrame = { connectionId: string; name: string } & (
  { mode: typeof HERO_REFERENCE_FRAME } | { mode: typeof CUSTOM_HERO_FRAME; key: string }
)
type CustomTemplate = { id: string; name: string; storage_key: string }
export type ShopHeroCopy = { origin: string | null; notes: string[] }
type ShopState = { id: string; display_name: string; mode: ShopHeroMode; active_template_id: string | null; revision: number; hero_origin: string | null; hero_notes: string[] }
type ShopRow = ShopState & { templates: CustomTemplate[] }
const stateColumns = `c.id,c.display_name,coalesce(t.mode,'none') AS mode,t.active_template_id,coalesce(t.revision,0) AS revision,
  t.hero_origin,coalesce(t.hero_notes,'[]'::jsonb) AS hero_notes`
const shopTables = `FROM integration_1688_connections c LEFT JOIN image_shop_hero_templates t ON t.connection_id=c.id`
const shops = `SELECT ${stateColumns}, coalesce((SELECT jsonb_agg(jsonb_build_object(
    'id', custom.id, 'name', custom.name, 'storage_key', custom.storage_key) ORDER BY custom.created_at, custom.id)
    FROM image_shop_hero_custom_templates custom WHERE custom.connection_id=c.id),'[]'::jsonb) AS templates
  ${shopTables} WHERE c.tenant_id=$1`

export async function listHeroShops(tenantId: string) {
  return (await db.query<ShopRow>(`${shops} ORDER BY c.created_at,c.id`, [tenantId])).rows
}

export async function heroShop(tenantId: string, id: string, client: PoolClient | typeof db = db) {
  const row = (await client.query<ShopRow>(`${shops} AND c.id=$2`, [tenantId, id])).rows[0]
  if (!row) throw new IntegrationError('HERO_SHOP_NOT_FOUND', '店铺不存在。', 404)
  return row
}

export async function heroDesignForShop(tenantId: string, id: string | null | undefined): Promise<{ frame: HeroFrame | null; copy: ShopHeroCopy | null }> {
  if (!id) return { frame: null, copy: null }
  const shop = (await db.query<ShopState & { storage_key: string | null }>(`SELECT ${stateColumns}, custom.storage_key
    ${shopTables} LEFT JOIN image_shop_hero_custom_templates custom ON custom.connection_id=c.id AND custom.id=t.active_template_id
    WHERE c.tenant_id=$1 AND c.id=$2`, [tenantId, id])).rows[0]
  if (!shop) throw new IntegrationError('HERO_SHOP_NOT_FOUND', '店铺不存在。', 404)
  const copy = shop.hero_origin || shop.hero_notes.length ? { origin: shop.hero_origin, notes: shop.hero_notes } : null
  if (shop.mode === 'none') return { frame: null, copy }
  const identity = { connectionId: shop.id, name: shop.display_name }
  if (shop.mode === CUSTOM_HERO_FRAME) {
    if (!shop.storage_key) throw new IntegrationError('HERO_TEMPLATE_FILE', '该店铺的自定义首图模板缺少图片。', 409)
    return { frame: { ...identity, mode: CUSTOM_HERO_FRAME, key: shop.storage_key }, copy }
  }
  return { frame: { ...identity, mode: HERO_REFERENCE_FRAME }, copy }
}
