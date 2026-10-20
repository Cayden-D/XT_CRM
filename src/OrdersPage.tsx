import { useCallback, useEffect, useState } from 'react'
import { AlertCircle, LoaderCircle, ReceiptText, Search, ShieldCheck, Store, X } from 'lucide-react'
import type { SessionUser } from './api'
import Pagination, { useDebounced } from './Pagination'
import { useAiFocusPart } from './aiFocus'
import { WangwangButton } from './PerformanceAnalysis'
import { agentLabel } from './PerformanceReports'
import { getOrderList, getPerformanceConnections, type OrderGroup, type OrderRow, type PerformanceConnection } from './performanceApi'
import OrderDrawer, { statusNames } from './OrderDrawer'
import './1688.css'

type Preset = 'today' | '7d' | '30d' | '90d'
const presets: [Preset, string][] = [['today', '今天'], ['7d', '近 7 天'], ['30d', '近 30 天'], ['90d', '近 90 天']]
const beijingDate = (offset = 0) => new Date(Date.now() + 8 * 3_600_000 + offset * 86_400_000).toISOString().slice(0, 10)
const rangeOf = (p: Preset) => p === 'today' ? { from: beijingDate(), to: beijingDate() } : { from: beijingDate(p === '7d' ? -6 : p === '30d' ? -29 : -89), to: beijingDate() }
const groups: [OrderGroup | '', string][] = [['', '全部'], ['unpaid', '待付款'], ['toship', '待发货'], ['shipped', '已发货'], ['done', '已完成'], ['closed', '已关闭'], ['refund', '有退款']]
const tone: Record<string, string> = { unpaid: 'warning', toship: 'warning', shipped: '', done: 'positive', closed: '', other: '' }
const yuan = (n: number) => `¥${n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const when = (v: string | null) => v ? new Date(v).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'
const message = (cause: unknown) => cause instanceof Error ? cause.message : '操作未完成，请稍后重试。'
const can = (user: SessionUser, name: string) => (user.permissions || []).some(v => v === '*' || v === name || v === `${name.split(':')[0]}:*`)

/** 订单: the shop's orders (synced by the performance app) with the live order detail from 1688. */
export default function OrdersPage({ user }: { user: SessionUser }) {
  const [shops, setShops] = useState<PerformanceConnection[]>([]), [shop, setShop] = useState(''), [ready, setReady] = useState(false)
  const [preset, setPreset] = useState<Preset | 'custom'>('30d'), [range, setRange] = useState(() => rangeOf('30d'))
  const [group, setGroup] = useState<OrderGroup | ''>(''), [search, setSearch] = useState(''), [page, setPage] = useState(1), [pageSize, setPageSize] = useState(20)
  const [rows, setRows] = useState<OrderRow[]>([]), [total, setTotal] = useState(0), [counts, setCounts] = useState<Record<string, number>>({}), [amount, setAmount] = useState(0)
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [open, setOpen] = useState<OrderRow | null>(null)
  const query = useDebounced(search.trim())
  useAiFocusPart({ connectionId: shop || undefined, view: 'orders' })
  const canRead = can(user, 'performance:read') || can(user, 'performance:read_own')
  useEffect(() => {
    if (!canRead) return
    getPerformanceConnections().then(r => { setShops(r.data); setShop((r.data.find(c => c.status === 'connected') || r.data[0])?.id || '') }).catch(cause => setError(message(cause))).finally(() => setReady(true))
  }, [canRead])
  useEffect(() => { setPage(1) }, [shop, range, group, query, pageSize])
  const load = useCallback(() => {
    if (!shop) { setLoading(false); return }
    let live = true; setLoading(true)
    getOrderList({ connectionId: shop, ...range, group: group || undefined, search: query || undefined, page, pageSize })
      .then(r => { if (live) { setRows(r.data); setTotal(r.total); setCounts(r.counts as Record<string, number>); setAmount(r.amount); setError('') } })
      .catch(cause => live && setError(message(cause))).finally(() => live && setLoading(false))
    return () => { live = false }
  }, [shop, range, group, query, page, pageSize])
  useEffect(load, [load])
  if (!canRead) return <section className="state-card"><ShieldCheck size={28} /><h2>暂无订单查看权限</h2><p>需要客服绩效的查看权限。</p></section>
  if (ready && !shop) return <div className="shop-empty"><Store size={28} /><p>请先在「客服绩效 → 绩效应用授权」中授权店铺，订单由绩效应用同步。</p></div>
  return <div className="shop-workspace performance-page orders-page">
    {error && <div className="shop-feedback error" role="alert"><AlertCircle size={16} /><span>{error}</span><button title="关闭错误" onClick={() => setError('')}><X size={15} /></button></div>}
    <div className="shop-controlbar perf-filters">
      <div className="shop-select"><Store size={17} /><select aria-label="店铺" value={shop} onChange={e => setShop(e.target.value)}>{shops.map(c => <option key={c.id} value={c.id}>{c.display_name}</option>)}</select></div>
      <div className="perf-range"><nav className="perf-metric-tabs" aria-label="下单日期">{presets.map(([id, label]) => <button key={id} aria-pressed={preset === id} className={preset === id ? 'active' : ''} onClick={() => { setPreset(id); setRange(rangeOf(id)) }}>{label}</button>)}</nav>
        <input type="date" aria-label="开始日期" value={range.from} max={range.to} onChange={e => { if (e.target.value) { setPreset('custom'); setRange({ ...range, from: e.target.value }) } }} /><span>至</span>
        <input type="date" aria-label="结束日期" value={range.to} min={range.from} max={beijingDate()} onChange={e => { if (e.target.value) { setPreset('custom'); setRange({ ...range, to: e.target.value }) } }} /></div>
    </div>
    <div className="orders-head">
      <nav className="catalog-tabs" aria-label="订单状态">{groups.map(([id, label]) => { const n = id ? counts[id] ?? 0 : counts.all ?? 0
        return <button key={id || 'all'} role="tab" aria-selected={group === id} className={`${group === id ? 'active' : ''} ${id === 'toship' && n > 0 ? 'warn' : ''}`} onClick={() => setGroup(id)}>{label}<span>{n}</span></button> })}</nav>
      <label className="orders-search"><Search size={15} /><input value={search} onChange={e => setSearch(e.target.value)} placeholder="订单号、商品名或备注" aria-label="搜索订单" />{search && <button onClick={() => setSearch('')} aria-label="清除搜索"><X size={13} /></button>}</label>
    </div>
    <p className="orders-sum">{range.from} 至 {range.to} 下单 <b>{counts.all ?? 0}</b> 笔，订单金额 <b>{yuan(amount)}</b>{counts.refund ? <>，其中 {counts.refund} 笔有退款</> : null}</p>
    <div className="shop-table-scroll"><table className={`shop-table perf-table orders-table ${loading ? 'is-loading' : ''}`}><thead><tr><th>下单时间</th><th>订单号</th><th>商品</th><th>买家</th><th>实付金额</th><th>状态</th><th>归属客服</th><th /></tr></thead>
      <tbody>{rows.map(o => { const first = o.items[0], qty = o.items.reduce((s, i) => s + (i.quantity || 0), 0)
        return <tr key={o.order_id}>
          <td>{when(o.placed_at)}{o.paid_at && <small>付 {when(o.paid_at)}</small>}</td>
          <td><button className="orders-id" onClick={() => setOpen(o)}>{o.order_id}</button>{o.seller_memo && <small title={o.seller_memo}>备注：{o.seller_memo}</small>}</td>
          <td className="orders-product"><span title={first?.name}>{first?.name ?? '—'}</span><small>{first?.sku ? `${first.sku} · ` : ''}{o.items.length > 1 ? `共 ${o.items.length} 种 ${qty} 件` : `${qty} 件`}</small></td>
          <td>{o.buyer_tail ? `…${o.buyer_tail}` : '—'}</td>
          <td><strong>{yuan(o.total_amount)}</strong>{o.shipping_fee > 0 && <small>含运费 {yuan(o.shipping_fee)}</small>}{o.refund_amount > 0 && <small className="orders-refund">退款 {yuan(o.refund_amount)}</small>}</td>
          <td><span className={`shop-status ${tone[o.status_group] ?? ''}`}>{statusNames[o.status] ?? o.status}</span></td>
          <td>{o.agents?.length ? o.agents.map(a => <small key={a.login_id}>{agentLabel(a)}{a.share < 1 ? ` ${Math.round(a.share * 100)}%` : ''}</small>) : <small>—</small>}</td>
          <td className="perf-row-actions">{o.buyer_id && <WangwangButton buyerId={o.buyer_id} setError={setError} />}<button className="shop-button" onClick={() => setOpen(o)}><ReceiptText size={15} />详情</button></td>
        </tr> })}</tbody></table>
      {!loading && !rows.length && <div className="shop-empty"><ReceiptText size={28} /><p>{query || group ? '没有符合条件的订单' : '所选日期内没有订单'}</p></div>}
      {loading && !rows.length && <div className="shop-empty"><LoaderCircle size={26} className="spin" /></div>}</div>
    <Pagination page={page} pageSize={pageSize} total={total} onPage={setPage} onPageSize={setPageSize} sizes={[20, 50, 100]} unit="笔" />
    <p className="shop-note">订单由绩效应用每 15 分钟同步（最近 90 天）。点「详情」时实时调用 1688「加密场景订单详情（卖家视角）」接口，买家与收货信息由平台脱敏，系统不保存。</p>
    {open && <OrderDrawer connectionId={shop} orderId={open.order_id} close={() => setOpen(null)} setError={setError} />}
  </div>
}
