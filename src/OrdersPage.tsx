import { useCallback, useEffect, useState } from 'react'
import { AlertCircle, ExternalLink, LoaderCircle, Lock, ReceiptText, Search, ShieldCheck, Store, Truck, X } from 'lucide-react'
import type { SessionUser } from './api'
import Pagination, { useDebounced } from './Pagination'
import { useAiFocusPart } from './aiFocus'
import { Drawer, WangwangButton } from './PerformanceAnalysis'
import { agentLabel } from './PerformanceReports'
import { getOrderDetail, getOrderList, getPerformanceConnections, type OrderDetail, type OrderGroup, type OrderRow, type PerformanceConnection } from './performanceApi'
import './1688.css'

type Preset = 'today' | '7d' | '30d' | '90d'
const presets: [Preset, string][] = [['today', '今天'], ['7d', '近 7 天'], ['30d', '近 30 天'], ['90d', '近 90 天']]
const beijingDate = (offset = 0) => new Date(Date.now() + 8 * 3_600_000 + offset * 86_400_000).toISOString().slice(0, 10)
const rangeOf = (p: Preset) => p === 'today' ? { from: beijingDate(), to: beijingDate() } : { from: beijingDate(p === '7d' ? -6 : p === '30d' ? -29 : -89), to: beijingDate() }
const groups: [OrderGroup | '', string][] = [['', '全部'], ['unpaid', '待付款'], ['toship', '待发货'], ['shipped', '已发货'], ['done', '已完成'], ['closed', '已关闭'], ['refund', '有退款']]
const statusNames: Record<string, string> = { waitbuyerpay: '待付款', waitbuyerrepayment: '待还款', waitsellersend: '待发货', waitsellerconfirm: '待卖家确认', waitbuyerconfirm: '待买家确认', waitbuyerreceive: '待收货', send_goods_but_not_fund: '已发货待到账', waitlogisticstakein: '待揽件', waitbuyersign: '待签收', signinsuccess: '已签收', signinfailed: '签收失败', success: '交易成功', confirm_goods: '已收货', confirm_goods_but_not_fund: '已收货待到账', confirm_goods_and_has_subsidy: '已收货已贴现', cancel: '已关闭', terminated: '已终止' }
const tone: Record<string, string> = { unpaid: 'warning', toship: 'warning', shipped: '', done: 'positive', closed: '', other: '' }
const yuan = (n: number) => `¥${n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const when = (v: string | null) => v ? new Date(v).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'
const message = (cause: unknown) => cause instanceof Error ? cause.message : '操作未完成，请稍后重试。'
const can = (user: SessionUser, name: string) => (user.permissions || []).some(v => v === '*' || v === name || v === `${name.split(':')[0]}:*`)
const shipmentStatus: Record<string, string> = { alreadysend: '已发货', waitingsend: '待发货', cancel: '已取消' }

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
    {open && <OrderDrawer connectionId={shop} row={open} close={() => setOpen(null)} setError={setError} />}
  </div>
}

function OrderDrawer({ connectionId, row, close, setError }: { connectionId: string; row: OrderRow; close: () => void; setError: (text: string) => void }) {
  const [detail, setDetail] = useState<OrderDetail | null>(null), [failed, setFailed] = useState('')
  useEffect(() => { let live = true; getOrderDetail(connectionId, row.order_id).then(r => live && setDetail(r.data)).catch(cause => live && setFailed(message(cause))); return () => { live = false } }, [connectionId, row.order_id])
  const o = detail?.order
  // Item discounts, coupons and price changes together: whatever separates the paid amount from goods + shipping.
  const adjust = o ? Math.round((o.total_amount - o.product_amount - o.shipping_fee) * 100) / 100 : 0
  return <Drawer title={`订单 ${row.order_id}`} close={close}>
    {!detail ? failed ? <p className="shop-local-error"><AlertCircle size={15} />{failed}</p> : <div className="shop-empty"><LoaderCircle size={24} className="spin" /><p>正在从 1688 读取订单详情…</p></div> : <div className="order-detail">
      <section className="order-status"><span className={`shop-status ${tone[row.status_group] ?? ''}`}>{statusNames[o!.status] ?? o!.status}</span><span>{o!.trade_type}</span>{o!.pay_channels.length > 0 && <span>{o!.pay_channels.join('、')}</span>}
        <a href={`https://trade.1688.com/order/new_step_order_detail.htm?orderId=${row.order_id}`} target="_blank" rel="noreferrer">在 1688 打开 <ExternalLink size={13} /></a></section>
      <ol className="order-timeline">{([['下单', o!.created_at], ['付款', o!.paid_at], ['发货', o!.delivered_at], ['收货', o!.received_at], ['完成', o!.completed_at]] as [string, string | null][]).map(([label, at]) => <li key={label} className={at ? 'done' : ''}><b>{label}</b><small>{at ? when(at) : '—'}</small></li>)}</ol>
      <section><h4>商品</h4><ul className="order-items">{detail.items.map((i, n) => <li key={n}>
        {i.image ? <img src={i.image} alt="" referrerPolicy="no-referrer" /> : <div className="order-noimg" />}
        <div><b title={i.name ?? ''}>{i.name}</b><small>{i.sku ?? '默认规格'}{i.cargo_number ? ` · 货号 ${i.cargo_number}` : ''}</small><small>{i.status}{i.refund > 0 ? ` · 退款 ${yuan(i.refund)}` : ''}</small></div>
        <div className="order-item-num"><span>{yuan(i.price)} × {i.quantity}{i.unit ?? ''}</span><b>{yuan(i.amount)}</b>{i.snapshot_url && <a href={i.snapshot_url} target="_blank" rel="noreferrer">快照</a>}</div></li>)}</ul></section>
      <section className="order-money"><h4>金额</h4><dl><dt>商品金额</dt><dd>{yuan(o!.product_amount)}</dd><dt>运费</dt><dd>{yuan(o!.shipping_fee)}</dd>{Math.abs(adjust) >= 0.01 && <><dt>优惠 / 改价</dt><dd>{adjust > 0 ? '+' : '-'}{yuan(Math.abs(adjust))}</dd></>}
        <dt>实付</dt><dd><b>{yuan(o!.total_amount)}</b></dd>{o!.refund > 0 && <><dt>已退款</dt><dd className="orders-refund">{yuan(o!.refund)}</dd></>}{o!.credit && <><dt>诚e赊</dt><dd>{o!.credit.status}{o!.credit.unpaid > 0 ? `，待还 ${yuan(o!.credit.unpaid)}` : ''}</dd></>}</dl></section>
      <section><h4><Truck size={15} />物流</h4>{detail.shipments.length ? <ul className="order-ship">{detail.shipments.map((s, n) => <li key={n}><b>{s.no_logistics ?? s.company ?? '物流'}</b><span>{s.bill_no ?? ''}</span><small>{shipmentStatus[s.status ?? ''] ?? s.status ?? ''} · {when(s.delivered_at)}</small></li>)}</ul> : <p className="shop-note">尚未发货</p>}
        <p className="order-receiver"><Lock size={13} /><span>{[detail.receiver.name, detail.receiver.mobile ?? detail.receiver.phone].filter(Boolean).join(' · ')}<br />{detail.receiver.region} {detail.receiver.address}</span></p></section>
      <section className="order-buyer"><h4>买家</h4><p>{detail.buyer.company ?? '—'}{detail.buyer.level ? ` · 等级 ${detail.buyer.level}` : ''}</p>{detail.buyer.buyer_id && <WangwangButton buyerId={detail.buyer.buyer_id} setError={setError} label="旺旺联系" />}</section>
      {(o!.buyer_memo || o!.seller_memo || o!.remark || o!.close_reason) && <section><h4>留言与备注</h4>{o!.buyer_memo && <p>买家留言：{o!.buyer_memo}</p>}{o!.seller_memo && <p>卖家备注：{o!.seller_memo}</p>}{o!.remark && <p>{o!.remark}</p>}{o!.close_reason && <p>关闭原因：{o!.close_reason}</p>}</section>}
      {detail.invoice && <section><h4>发票</h4><p>{detail.invoice.type} {detail.invoice.title}</p></section>}
      {detail.masked.length > 0 && <p className="shop-note"><Lock size={12} /> 买家与收货信息已由 1688 脱敏显示。</p>}
    </div>}
  </Drawer>
}
