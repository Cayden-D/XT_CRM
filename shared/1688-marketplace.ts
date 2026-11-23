export type MarketplacePurpose = 'product' | 'performance'
export type ServiceOrder = { id: string; createdAt: string; begin: string; end: string; status: string; name: string; sku: string }
export type ServiceSummary = { state: 'active' | 'expiring' | 'urgent' | 'expired' | 'closed' | 'pending' | 'suspended' | 'unknown'; end: string | null; days: number | null; name: string | null }
export type MarketplaceConnection = { id: string; purpose: MarketplacePurpose; name: string; status: string; service: ServiceSummary; checkedAt: string | null; syncing: boolean; needsSync: boolean; error: string | null; renewalUrl: string }
export type MarketplaceData = { support: { phone: string; wangwang: string }; connections: MarketplaceConnection[] }

const DAY = 86_400_000
/** Only contiguous service periods extend today's entitlement; future orders across a gap do not. */
export function serviceSummary(orders: ServiceOrder[], now = Date.now()): ServiceSummary {
  const valid = orders.filter(o => Number.isFinite(Date.parse(o.begin)) && Number.isFinite(Date.parse(o.end)))
  const active = valid.filter(o => o.status === 'S' && Date.parse(o.begin) <= now && Date.parse(o.end) > now).sort((a, b) => Date.parse(b.end) - Date.parse(a.end))[0]
  if (active) {
    let end = Date.parse(active.end)
    for (const order of valid.filter(o => o.status === 'S' || o.status === 'B').sort((a, b) => Date.parse(a.begin) - Date.parse(b.begin))) {
      if (Date.parse(order.begin) <= end && Date.parse(order.end) > end) end = Date.parse(order.end)
    }
    const remaining = end - now, days = Math.ceil(remaining / DAY)
    return { state: remaining <= 7 * DAY ? 'urgent' : remaining <= 14 * DAY ? 'expiring' : 'active', end: new Date(end).toISOString(), days, name: active.name }
  }
  const suspended = valid.find(o => o.status === 'P' && Date.parse(o.begin) <= now && Date.parse(o.end) > now)
  const pending = valid.find(o => (o.status === 'B' && Date.parse(o.end) > now) || (o.status === 'S' && Date.parse(o.begin) > now))
  const closed = valid.find(o => o.status === 'E' && Date.parse(o.end) > now)
  const expired = valid.filter(o => o.status !== 'C' && Date.parse(o.end) <= now).sort((a, b) => Date.parse(b.end) - Date.parse(a.end))[0]
  const order = suspended || pending || closed || expired
  return { state: suspended ? 'suspended' : pending ? 'pending' : closed ? 'closed' : expired ? 'expired' : 'unknown', end: order?.end ?? null, days: null, name: order?.name ?? null }
}

export function serviceText(service: ServiceSummary) {
  if (service.state === 'active') return `剩余服务时间 ${service.days} 天`
  if (service.state === 'expiring') return `服务剩余 ${service.days} 天，请及时续费`
  if (service.state === 'urgent') return `服务即将到期，剩余 ${service.days} 天`
  return { expired: '服务已到期', closed: '服务已关闭', pending: '服务尚未开始', suspended: '服务已挂起', unknown: '服务期待核实' }[service.state]
}
