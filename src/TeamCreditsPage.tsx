import { useEffect, useState } from 'react'
import { AlertCircle, LoaderCircle, RefreshCw } from 'lucide-react'
import { request } from './api'
import Pagination from './Pagination'
import './1688.css'
import './teamCredits.css'

type CreditEntry = {
  id: string
  reason: 'publish' | 'refund' | 'adjust'
  delta: number
  balance_after: number
  created_at: string
  actor_name: string | null
  product_title: string | null
  note: string | null
}
type CreditActivity = {
  name: string
  unlimited: boolean
  credits: number
  perListing: number
  ledger: CreditEntry[]
  total: number
  page: number
  pageSize: number
}

const reasonLabels = { publish: '上品扣费', refund: '积分退回', adjust: '额度调整' }
const pointsFormat = new Intl.NumberFormat('zh-CN')
const deltaFormat = new Intl.NumberFormat('zh-CN', { signDisplay: 'always' })
const dateFormat = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short', hour12: false })

export default function TeamCreditsPage() {
  const [query, setQuery] = useState({ page: 1 })
  const [activity, setActivity] = useState<CreditActivity | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError('')
    request<{ data: CreditActivity }>(`/api/users/team/credits?page=${query.page}`, { signal: controller.signal })
      .then(({ data }) => { if (!controller.signal.aborted) setActivity(data) })
      .catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '积分明细读取失败。') })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [query])

  return <div className="shop-page team-credits">
    <header className="shop-page-heading">
      <div>
        <h2>我的积分</h2>
        {activity && <p>{activity.name} 团队 · 团队成员共用积分</p>}
      </div>
      <button type="button" className="shop-button" onClick={() => setQuery({ page: 1 })} disabled={loading}>
        <RefreshCw size={15} aria-hidden="true" />刷新
      </button>
    </header>
    {error && <div className="shop-feedback error" role="alert"><AlertCircle size={16} aria-hidden="true" /><span>{error}</span></div>}
    {loading && !activity && <div className="shop-empty" role="status"><LoaderCircle className="spin" aria-hidden="true" />正在读取积分…</div>}
    {activity && <>
      <dl className="team-credits-summary">
        <div><dt>积分余额</dt><dd><strong>{activity.unlimited ? '不限额度' : pointsFormat.format(activity.credits)}</strong>{!activity.unlimited && ' 积分'}</dd></div>
        {!activity.unlimited && <div><dt>采集商品上品费用</dt><dd><strong>{pointsFormat.format(activity.perListing)}</strong> 积分 / 件</dd></div>}
      </dl>
      <section className="team-credits-activity" aria-labelledby="team-credits-records" aria-busy={loading}>
        <h3 id="team-credits-records">积分明细</h3>
        {activity.ledger.length > 0 ? <div className="shop-table-scroll">
          <table className="shop-table team-credits-table" aria-labelledby="team-credits-records" role="table">
            <thead role="rowgroup"><tr role="row">
              <th scope="col" role="columnheader">类型与说明</th><th scope="col" role="columnheader">时间</th><th scope="col" role="columnheader">操作账号</th>
              <th scope="col" role="columnheader">积分变动</th><th scope="col" role="columnheader">变动后余额</th>
            </tr></thead>
            <tbody role="rowgroup">{activity.ledger.map(entry => <tr key={entry.id} role="row">
              <td role="cell"><strong>{reasonLabels[entry.reason]}</strong>{entry.product_title && <small>{entry.product_title}</small>}{entry.note && <small>{entry.note}</small>}</td>
              <td role="cell"><span className="credits-mobile-label" aria-hidden="true">时间</span><time dateTime={entry.created_at}>{dateFormat.format(new Date(entry.created_at))}</time></td>
              <td role="cell"><span className="credits-mobile-label" aria-hidden="true">操作账号</span>{entry.actor_name ?? '—'}</td>
              <td role="cell"><span className="credits-mobile-label" aria-hidden="true">积分变动</span><strong className={entry.delta < 0 ? 'credits-debit' : 'credits-credit'}>{deltaFormat.format(entry.delta)}</strong></td>
              <td role="cell"><span className="credits-mobile-label" aria-hidden="true">变动后余额</span>{pointsFormat.format(entry.balance_after)}</td>
            </tr>)}</tbody>
          </table>
        </div> : <p className="team-credits-empty">暂无积分变动记录。</p>}
        <Pagination page={activity.page} pageSize={activity.pageSize} total={activity.total} sizes={[activity.pageSize]} onPage={page => setQuery({ page })} />
      </section>
    </>}
  </div>
}
