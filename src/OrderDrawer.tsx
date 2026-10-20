import { useEffect, useState } from 'react'
import { AlertCircle, ExternalLink, LoaderCircle, Lock, Truck } from 'lucide-react'
import { Drawer, WangwangButton } from './PerformanceAnalysis'
import { getOrderDetail, type OrderDetail } from './performanceApi'

export const statusNames: Record<string, string> = { waitbuyerpay: '待付款', waitbuyerrepayment: '待还款', waitsellersend: '待发货', waitsellerconfirm: '待卖家确认', waitbuyerconfirm: '待买家确认', waitbuyerreceive: '待收货', send_goods_but_not_fund: '已发货待到账', waitlogisticstakein: '待揽件', waitbuyersign: '待签收', signinsuccess: '已签收', signinfailed: '签收失败', success: '交易成功', confirm_goods: '已收货', confirm_goods_but_not_fund: '已收货待到账', confirm_goods_and_has_subsidy: '已收货已贴现', cancel: '已关闭', terminated: '已终止' }
const statusTone = (status: string) => ['waitbuyerpay', 'waitbuyerrepayment', 'waitsellersend'].includes(status) ? 'warning' : ['success', 'confirm_goods', 'confirm_goods_but_not_fund'].includes(status) ? 'positive' : ''
const shipmentStatus: Record<string, string> = { alreadysend: '已发货', waitingsend: '待发货', cancel: '已取消' }
const yuan = (n: number) => `¥${n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const when = (v: string | null) => v ? new Date(v).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'
const message = (cause: unknown) => cause instanceof Error ? cause.message : '操作未完成，请稍后重试。'

/** Live order detail from 1688, opened from the order list, chats or a customer's orders. */
export default function OrderDrawer({ connectionId, orderId, close, setError }: { connectionId: string; orderId: string; close: () => void; setError: (text: string) => void }) {
  const [detail, setDetail] = useState<OrderDetail | null>(null), [failed, setFailed] = useState('')
  useEffect(() => { let live = true; getOrderDetail(connectionId, orderId).then(r => live && setDetail(r.data)).catch(cause => live && setFailed(message(cause))); return () => { live = false } }, [connectionId, orderId])
  const o = detail?.order
  // Item discounts, coupons and price changes together: whatever separates the paid amount from goods + shipping.
  const adjust = o ? Math.round((o.total_amount - o.product_amount - o.shipping_fee) * 100) / 100 : 0
  return <Drawer title={`订单 ${orderId}`} close={close}>
    {!detail ? failed ? <p className="shop-local-error"><AlertCircle size={15} />{failed}</p> : <div className="shop-empty"><LoaderCircle size={24} className="spin" /><p>正在从 1688 读取订单详情…</p></div> : <div className="order-detail">
      <section className="order-status"><span className={`shop-status ${statusTone(o!.status)}`}>{statusNames[o!.status] ?? o!.status}</span><span>{o!.trade_type}</span>{o!.pay_channels.length > 0 && <span>{o!.pay_channels.join('、')}</span>}
        <a href={`https://trade.1688.com/order/new_step_order_detail.htm?orderId=${orderId}`} target="_blank" rel="noreferrer">在 1688 打开 <ExternalLink size={13} /></a></section>
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
