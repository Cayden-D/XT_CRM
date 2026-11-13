import { useCallback, useEffect, useState } from 'react'
import { AlertCircle, Check, Coins, LoaderCircle, RefreshCw } from 'lucide-react'
import { request } from './api'

type Movement = { delta: number; balance_after: number; reason: 'adjust' | 'publish' | 'refund'; note: string | null; created_at: string }
type Team = { ownerId: string; name: string; email: string; status: string; unlimited: boolean; members: number; textModel: string; imageModel: string; credits: number; ledger: Movement[] }
type Teams = { data: Team[]; perListing: number; textModels: string[]; imageModels: { id: string; name: string }[] }
const message = (cause: unknown) => cause instanceof Error ? cause.message : '操作未完成，请稍后重试。'
const reasons: Record<Movement['reason'], string> = { adjust: '调整', publish: '上架', refund: '退回' }
const day = (value: string) => new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })

/**
 * 团队额度与模型 (super administrator): every team (a top-level account and the sub-accounts it opened) with the text and
 * image model it uses and its credits. Listing a collected product costs `perListing` credits.
 */
export default function TeamsAdmin() {
  const [teams, setTeams] = useState<Teams | null>(null), [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [amount, setAmount] = useState<Record<string, string>>({}), [note, setNote] = useState<Record<string, string>>({})
  const load = useCallback(async () => { try { setTeams(await request<Teams>('/api/users/teams')); setError('') } catch (cause) { setError(message(cause)) } }, [])
  useEffect(() => { void load() }, [load])

  async function save(team: Team, change: { textModel?: string; imageModel?: string; delta?: number; note?: string }, done: string) {
    setBusy(team.ownerId); setError(''); setNotice('')
    try {
      await request(`/api/users/teams/${team.ownerId}`, { method: 'PATCH', body: JSON.stringify(change) })
      if (change.delta) { setAmount(a => ({ ...a, [team.ownerId]: '' })); setNote(n => ({ ...n, [team.ownerId]: '' })) }
      setNotice(done); await load()
    } catch (cause) { setError(message(cause)) } finally { setBusy('') }
  }
  function adjust(team: Team, sign: 1 | -1) {
    const value = Math.trunc(Number(amount[team.ownerId]))
    if (!Number.isFinite(value) || value <= 0) { setError('请填写要调整的积分（正整数）。'); return }
    void save(team, { delta: sign * value, note: note[team.ownerId]?.trim() || undefined }, `${team.name} 团队${sign > 0 ? '增加' : '扣减'} ${value} 积分`)
  }

  return <section className="teams-admin" aria-label="团队额度与模型">
    <div className="shop-page-heading"><div><h3><Coins size={17} />团队额度与模型</h3><p>团队 = 顶层账号及其开设的子账号。采集商品上架成功每件扣 {teams?.perListing ?? 10} 积分，平台拒绝会退回；超级管理员团队不限额度。</p></div>
      <button className="shop-icon" title="刷新" aria-label="刷新团队" disabled={Boolean(busy)} onClick={() => void load()}><RefreshCw size={17} /></button></div>
    {error && <p className="shop-alert error" role="alert"><AlertCircle size={16} />{error}</p>}
    {notice && <p className="shop-alert" role="status"><Check size={16} />{notice}</p>}
    {!teams ? <div className="shop-empty"><LoaderCircle className="spin" /></div>
      : <div className="shop-table-scroll"><table className="shop-table teams-table"><thead><tr><th>团队负责人</th><th>成员</th><th>文字模型</th><th>图片模型</th><th>积分</th><th>调整额度</th></tr></thead>
        <tbody>{teams.data.map(team => <tr key={team.ownerId} className={team.status !== 'active' ? 'users-disabled' : ''}>
          <td><strong>{team.name}</strong><small className="users-sub">{team.email}</small></td>
          <td>{team.members} 个子账号</td>
          <td><select aria-label={`${team.name} 文字模型`} value={team.textModel} disabled={Boolean(busy)} onChange={e => void save(team, { textModel: e.target.value }, `${team.name} 团队的文字模型已改为 ${e.target.value}`)}>{teams.textModels.map(m => <option key={m} value={m}>{m}</option>)}</select></td>
          <td><select aria-label={`${team.name} 图片模型`} value={team.imageModel} disabled={Boolean(busy)} onChange={e => void save(team, { imageModel: e.target.value }, `${team.name} 团队的图片模型已改为 ${teams.imageModels.find(m => m.id === e.target.value)?.name ?? e.target.value}`)}>{teams.imageModels.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></td>
          <td>{team.unlimited ? <span className="shop-status positive">不限</span> : <strong className={team.credits < (teams.perListing) ? 'teams-low' : ''}>{team.credits}</strong>}
            {team.ledger.length > 0 && <small className="users-sub" title={team.ledger.map(m => `${day(m.created_at)} ${reasons[m.reason]} ${m.delta > 0 ? '+' : ''}${m.delta}${m.note ? `（${m.note}）` : ''}`).join('\n')}>最近：{reasons[team.ledger[0].reason]} {team.ledger[0].delta > 0 ? '+' : ''}{team.ledger[0].delta} · {day(team.ledger[0].created_at)}</small>}</td>
          <td>{team.unlimited ? <small className="users-sub">无需调整</small> : <div className="teams-adjust">
            <input aria-label={`${team.name} 调整积分`} type="number" min={1} step={1} inputMode="numeric" placeholder="积分" value={amount[team.ownerId] ?? ''} disabled={Boolean(busy)} onChange={e => setAmount(a => ({ ...a, [team.ownerId]: e.target.value }))} />
            <input aria-label={`${team.name} 调整备注`} placeholder="备注（可选）" maxLength={200} value={note[team.ownerId] ?? ''} disabled={Boolean(busy)} onChange={e => setNote(n => ({ ...n, [team.ownerId]: e.target.value }))} />
            <button className="shop-button" disabled={Boolean(busy)} onClick={() => adjust(team, 1)}>{busy === team.ownerId ? <LoaderCircle size={14} className="spin" /> : null}增加</button>
            <button className="shop-button" disabled={Boolean(busy)} onClick={() => adjust(team, -1)}>扣减</button>
          </div>}</td>
        </tr>)}</tbody></table></div>}
  </section>
}
