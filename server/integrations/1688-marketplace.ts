import { config } from '../config.js'
import { db } from '../db.js'
import { appCredentials, connectionToken, gateway, IntegrationError, parseRefreshExpiry, recordOperation, signApi, type AppPurpose } from './1688.js'
import { serviceSummary, type MarketplaceConnection, type ServiceOrder } from '../../shared/1688-marketplace.js'

const DAY = 86_400_000
const tables = { product: 'integration_1688_connections', performance: 'integration_1688_perf_connections' } as const
type Scan = { from: string; page: number }
type Snapshot = { orders?: ServiceOrder[]; checkedAt?: string; attemptedAt?: string; error?: string; scan?: Scan; pending?: Scan[]; historyComplete?: boolean; working?: ServiceOrder[] }
type Connection = { id: string; app_key: string; member_id: string | null; login_id: string | null; display_name: string; status: string; marketplace_subscription: Snapshot }
const iso = (time: number) => new Date(time).toISOString()
const recentFrom = (now: number) => iso(now - 29 * DAY)
export const marketplaceDate = (value: string) => new Date(Date.parse(value) + 8 * 3_600_000).toISOString().replace(/[-:TZ.]/g, '').slice(0, 17) + '+0800'

/** Use the documented subscriber identity; never infer an order's owner from aliId or a tenant. */
export function normalizeServiceOrders(raw: unknown, memberId: string | null, loginId: string | null): ServiceOrder[] {
  if (!Array.isArray(raw)) throw new IntegrationError('INVALID_RESPONSE', '订购接口未返回订单列表。')
  return raw.flatMap(value => {
    if (!value || typeof value !== 'object') throw new IntegrationError('INVALID_RESPONSE', '订购订单格式异常。')
    const row = value as Record<string, unknown>
    const member = typeof row.memberId === 'string' ? row.memberId : null, login = typeof row.loginId === 'string' ? row.loginId : null
    if ((memberId && member && member !== memberId) || (loginId && login && login !== loginId)) return []
    if (!(memberId && member === memberId) && !(loginId && login === loginId)) return []
    if (row.payStatus === 'payment_none' || row.bizStatus === 'C' || row.bizStatusExt === 'cancel') return []
    if (typeof row.orderItemNum !== 'string' || !row.orderItemNum || typeof row.bizStatus !== 'string' || !['S', 'B', 'P', 'E'].includes(row.bizStatus)) throw new IntegrationError('INVALID_RESPONSE', '订购订单缺少编号或服务状态。')
    const parse = (v: unknown) => typeof v === 'string' ? parseRefreshExpiry(v)?.toISOString() : null
    const createdAt = parse(row.gmtCreate), begin = parse(row.gmtServiceBegin), end = parse(row.gmtServiceEnd)
    if (!createdAt || !begin || !end || Date.parse(end) <= Date.parse(begin)) throw new IntegrationError('INVALID_RESPONSE', '订购订单缺少有效的服务起止时间。')
    const status = row.bizStatusExt === 'closed' ? 'E' : row.bizStatusExt === 'suspend' || row.bizStatusExt === 'arrear_suspend' ? 'P' : row.bizStatus
    return [{ id: row.orderItemNum, status, createdAt, begin, end, name: typeof row.productName === 'string' ? row.productName.slice(0, 200) : '1688 应用', sku: typeof row.skuName === 'string' ? row.skuName.slice(0, 100) : '' }]
  })
}

export function publicMarketplaceConnection(row: Connection, purpose: AppPurpose, now = Date.now()): MarketplaceConnection {
  const snapshot = row.marketplace_subscription
  const cooling = snapshot.error && snapshot.attemptedAt && now - Date.parse(snapshot.attemptedAt) < 15 * 60_000
  const due = !snapshot.checkedAt || now - Date.parse(snapshot.checkedAt) >= DAY
  const matchingApp = row.app_key === (purpose === 'product' ? config.ALI1688_APP_KEY : config.ALI1688_PERFORMANCE_APP_KEY)
  // Until all historical windows are checked, absence of an active period proves nothing.
  const service = serviceSummary(snapshot.orders || [], now)
  if (snapshot.scan && service.state !== 'active' && service.state !== 'expiring' && service.state !== 'urgent') Object.assign(service, { state: 'unknown', days: null, end: null })
  return { id: row.id, purpose, name: row.display_name, status: row.status, service, checkedAt: snapshot.checkedAt || null, syncing: Boolean(snapshot.scan), needsSync: matchingApp && row.status === 'connected' && !cooling && (Boolean(snapshot.scan) || due), error: snapshot.error || (!matchingApp ? '应用配置已变更，请重新授权店铺。' : null), renewalUrl: purpose === 'product' ? config.MARKETPLACE_PRODUCT_URL : config.MARKETPLACE_PERFORMANCE_URL }
}

export async function marketplaceConnections(tenantId: string, purposes: AppPurpose[]) {
  const data: MarketplaceConnection[] = []
  for (const purpose of purposes) {
    const rows = (await db.query<Connection>(`SELECT id,app_key,member_id,login_id,display_name,status,marketplace_subscription FROM ${tables[purpose]} WHERE tenant_id=$1 AND status<>'disabled' ORDER BY created_at`, [tenantId])).rows
    data.push(...rows.map(row => publicMarketplaceConnection(row, purpose)))
  }
  return data
}

/** One gateway page per request, persisted for reloads and shared across tabs/processes. */
export async function syncMarketplace(tenantId: string, actorId: string, purpose: AppPurpose, id: string, requestId: string, refresh = false) {
  const client = await db.connect(), table = tables[purpose], now = Date.now()
  try {
    await client.query('BEGIN')
    const locked = (await client.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked', [`marketplace:${purpose}:${id}`])).rows[0].locked
    const row = (await client.query<Connection>(`SELECT id,app_key,member_id,login_id,display_name,status,marketplace_subscription FROM ${table} WHERE id=$1 AND tenant_id=$2`, [id, tenantId])).rows[0]
    if (!row) throw new IntegrationError('NOT_FOUND', '店铺连接不存在。', 404)
    let snapshot = row.marketplace_subscription
    const forced = refresh && !snapshot.scan && row.status === 'connected' && row.app_key === appCredentials(purpose).appKey && (!snapshot.attemptedAt || now - Date.parse(snapshot.attemptedAt) >= 15 * 60_000)
    const tooSoon = snapshot.attemptedAt && now - Date.parse(snapshot.attemptedAt) < 750
    if (!locked || tooSoon || (!forced && !publicMarketplaceConnection(row, purpose, now).needsSync)) {
      await client.query('COMMIT')
      return publicMarketplaceConnection(row, purpose)
    }
    const started = Date.now()
    try {
      if (!row.member_id && !row.login_id) throw new IntegrationError('IDENTITY_MISSING', '缺少订购会员身份，请重新授权店铺。', 409)
      if (!snapshot.scan) {
        // After the initial backfill, refresh recent orders and every known live order's creation window.
        // Query both sides of each anchor: the supplied API description says "近30天"
        // without specifying which side of gmtCreate the gateway uses.
        const pending = snapshot.historyComplete ? [...new Set([recentFrom(now), ...(snapshot.orders || []).filter(o => ['S', 'B', 'P'].includes(o.status)).flatMap(o => [iso(Date.parse(o.createdAt) - DAY), iso(Date.parse(o.createdAt) + DAY)])])].map(from => ({ from, page: 1 })) : []
        snapshot = { ...snapshot, scan: { from: iso(now), page: 1 }, pending, working: [] }
      }
      const scan = snapshot.scan!
      const { grant } = await connectionToken(id, tenantId, actorId, false, purpose)
      const { appKey, secret } = appCredentials(purpose)
      const path = `param2/1/cn.alibaba.open/app.order.get/${appKey}`
      const params: Record<string, string> = { gmtCreate: marketplaceDate(scan.from), pageSize: '50', startIndex: String(scan.page), access_token: grant.access_token, _aop_timestamp: String(now), ...(row.member_id ? { memberId: row.member_id } : { loginId: row.login_id! }) }
      const response = await gateway(path, { ...params, _aop_signature: signApi(path, params, secret) })
      const data = response.result && typeof response.result === 'object' ? response.result as Record<string, unknown> : response
      if (data.successed !== true && data.successed !== 'true') throw new IntegrationError('ORDER_QUERY_FAILED', '1688 未确认订购查询成功，请检查服务市场接口权限。')
      const orders = normalizeServiceOrders(data.returnValue, row.member_id, row.login_id)
      const working = new Map((snapshot.working || []).map(o => [o.id, o]))
      orders.forEach(o => working.set(o.id, o))
      snapshot.working = [...working.values()]
      snapshot.attemptedAt = iso(now)
      delete snapshot.error
      if ((data.returnValue as unknown[]).length >= 50) {
        if (scan.page >= 1000) throw new IntegrationError('PAGE_LIMIT', '订购订单超出单窗口分页上限，请联系客服核实。')
        snapshot.scan = { ...scan, page: scan.page + 1 }
      } else if (!snapshot.historyComplete && Date.parse(scan.from) > Date.parse(config.ALI1688_MARKETPLACE_HISTORY_START + 'T00:00:00+08:00')) {
        snapshot.scan = { from: iso(Math.max(Date.parse(scan.from) - 29 * DAY, Date.parse(config.ALI1688_MARKETPLACE_HISTORY_START + 'T00:00:00+08:00'))), page: 1 }
      } else if (snapshot.pending?.length) {
        snapshot.scan = snapshot.pending.shift()
      } else {
        snapshot.orders = snapshot.working
        snapshot.checkedAt = iso(now)
        snapshot.historyComplete = true
        delete snapshot.scan; delete snapshot.pending; delete snapshot.working
      }
      await recordOperation(tenantId, id, actorId, 'app.order.get', started, undefined, requestId, purpose)
    } catch (error) {
      snapshot.attemptedAt = iso(now)
      snapshot.error = error instanceof IntegrationError ? error.message : '订购服务期暂时无法查询，请稍后重试。'
      await recordOperation(tenantId, id, actorId, 'app.order.get', started, error, requestId, purpose)
    }
    await client.query(`UPDATE ${table} SET marketplace_subscription=$3 WHERE id=$1 AND tenant_id=$2 AND app_key=$4`, [id, tenantId, JSON.stringify(snapshot), row.app_key])
    await client.query('COMMIT')
    return publicMarketplaceConnection({ ...row, marketplace_subscription: snapshot }, purpose)
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}
