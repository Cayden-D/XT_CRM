import { useEffect, useState } from 'react'
import { ExternalLink, Phone } from 'lucide-react'
import { request } from './api'
import { serviceText, type MarketplaceConnection, type MarketplaceData } from '../shared/1688-marketplace'
import './marketplace.css'

export const MARKETPLACE_URL = 'https://app.1688.com/'
export const supportWangwangUrl = (id: string) => `https://air.1688.com/app/ocms-fusion-components-1688/def_cbu_web_im/index.html?touid=${encodeURIComponent(`cnalichn${id}`)}&siteid=cnalichn&status=1#/`
export const getMarketplace = () => request<MarketplaceData>('/api/integrations/1688/marketplace/')

export default function MarketplaceHeader({ section }: { section: string }) {
  const [data, setData] = useState<MarketplaceData | null>(null)
  const [selected, setSelected] = useState('')
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const key = (connection: MarketplaceConnection) => `${connection.purpose}/${connection.id}`
  useEffect(() => {
    let cancelled = false
    const load = () => getMarketplace().then(value => { if (!cancelled) { setData(value); setError('') } }).catch(() => { if (!cancelled) setError('服务信息暂不可用') })
    void load()
    const timer = window.setInterval(load, 60_000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [retry])
  const preferred = ['performance', 'chats', 'orders', 'customers'].includes(section) ? 'performance' : 'product'
  const connection = data?.connections.find(c => key(c) === selected) || data?.connections.find(c => c.purpose === preferred) || data?.connections[0]
  const connectionKey = connection ? key(connection) : ''
  const refreshService = async () => {
    if (!connection) { setRetry(n => n + 1); return }
    setRefreshing(true)
    try {
      const result = await request<{ data: MarketplaceConnection }>(`/api/integrations/1688/marketplace/${connectionKey}/sync`, { method: 'POST', body: JSON.stringify({ refresh: true }) })
      setData(current => current ? { ...current, connections: current.connections.map(c => key(c) === connectionKey ? result.data : c) } : current)
      setError('')
    } catch { setError('服务期查询失败，请稍后重试') }
    finally { setRefreshing(false) }
  }
  useEffect(() => {
    if (!connection || !connection.needsSync) return
    let cancelled = false
    const timer = window.setTimeout(() => {
      void request<{ data: MarketplaceConnection }>(`/api/integrations/1688/marketplace/${connectionKey}/sync`, { method: 'POST' }).then(result => {
        if (!cancelled) setData(current => current ? { ...current, connections: current.connections.map(c => key(c) === connectionKey ? result.data : c) } : current)
      }).catch(() => { if (!cancelled) setError('服务期查询失败，请稍后重试') })
    }, 1000)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [connection, connectionKey, retry])
  return <section className="marketplace-header" aria-label="1688 服务市场">
    <a className="marketplace-brand" href={MARKETPLACE_URL} target="_blank" rel="noopener noreferrer"><strong>1688</strong><span>服务市场</span></a>
    <div className="marketplace-service">
      {data && data.connections.length > 1 && <select aria-label="查看应用与店铺服务期" value={connectionKey} onChange={event => setSelected(event.target.value)}>{data.connections.map(c => <option key={key(c)} value={key(c)}>{c.purpose === 'product' ? '商品应用' : '绩效应用'} · {c.name}</option>)}</select>}
      <span role="status" title={connection?.service.end ? `服务到期：${new Date(connection.service.end).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}${connection.checkedAt ? `；上次核实：${new Date(connection.checkedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}` : ''}` : undefined}>
        {error || (connection ? connection.error ? '服务期暂无法核实' : connection.syncing ? '正在核对订购服务期…' : serviceText(connection.service) : data ? '授权店铺后查询服务期' : '正在读取服务信息…')}
      </span>
      {(error || connection) && <button disabled={refreshing} title="刷新服务信息；平台查询至少间隔 15 分钟" onClick={() => void refreshService()}>{refreshing ? '查询中…' : '刷新状态'}</button>}
      {connection && <a className={`marketplace-renew ${connection.service.state === 'urgent' || connection.service.state === 'expired' ? 'marketplace-renew-urgent' : ''}`} href={connection.renewalUrl} target="_blank" rel="noopener noreferrer">{connection.service.state === 'expired' ? '重新订购' : '订购 / 续费'}</a>}
    </div>
    <nav aria-label="应用服务与帮助">
      <a href="#/help/guide">使用指南</a>
      <a href="#/help/support"><Phone size={14} aria-hidden="true" />联系客服</a>
      <a href={MARKETPLACE_URL} target="_blank" rel="noopener noreferrer">返回应用市场<ExternalLink size={13} aria-hidden="true" /></a>
    </nav>
  </section>
}
