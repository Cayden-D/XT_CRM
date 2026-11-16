import { db } from '../db.js'
import { IntegrationError } from './1688.js'
import { CUSTOM_HERO_FRAME, HERO_REFERENCE_FRAME } from './hero-reference-frame.js'

export const SHOP_HERO_MODES = ['none', HERO_REFERENCE_FRAME, CUSTOM_HERO_FRAME] as const
type Mode = typeof SHOP_HERO_MODES[number]
export type HeroFrame = { connectionId: string; name: string } & (
  { mode: typeof HERO_REFERENCE_FRAME } | { mode: typeof CUSTOM_HERO_FRAME; key: string }
)
type ShopRow = { id: string; display_name: string; mode: Mode; custom_key: string | null; revision: number }
const shops = `SELECT c.id,c.display_name,coalesce(t.mode,'none') AS mode,t.custom_key,coalesce(t.revision,0) AS revision
  FROM integration_1688_connections c LEFT JOIN image_shop_hero_templates t ON t.connection_id=c.id WHERE c.tenant_id=$1`

export async function listHeroShops(tenantId: string) {
  return (await db.query<ShopRow>(`${shops} ORDER BY c.created_at,c.id`, [tenantId])).rows
}

export async function heroShop(tenantId: string, id: string) {
  const row = (await db.query<ShopRow>(`${shops} AND c.id=$2`, [tenantId, id])).rows[0]
  if (!row) throw new IntegrationError('HERO_SHOP_NOT_FOUND', '店铺不存在。', 404)
  return row
}

export async function heroFrameForShop(tenantId: string, id: string | null | undefined): Promise<HeroFrame | null> {
  if (!id) return null
  const shop = await heroShop(tenantId, id)
  if (shop.mode === 'none') return null
  const identity = { connectionId: shop.id, name: shop.display_name }
  if (shop.mode === CUSTOM_HERO_FRAME) {
    if (!shop.custom_key) throw new IntegrationError('HERO_TEMPLATE_FILE', '该店铺的自定义首图模板缺少图片。', 409)
    return { ...identity, mode: CUSTOM_HERO_FRAME, key: shop.custom_key }
  }
  return { ...identity, mode: HERO_REFERENCE_FRAME }
}
