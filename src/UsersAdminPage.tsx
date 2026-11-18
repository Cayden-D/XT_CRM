import { useCallback, useEffect, useState } from 'react'
import { AlertCircle, Check, LoaderCircle, RefreshCw } from 'lucide-react'
import { request, type SessionUser } from './api'
import TeamsAdmin from './TeamsAdmin'
import ImageGenerationAdmin from './ImageGenerationAdmin'
import './1688.css'

type Role = { code: string; name: string }
type Member = { id: string; display_name: string; status: 'active' | 'disabled'; last_login_at: string | null; roles: Role[]; parent_name: string | null }
type MemberList = { data: Member[]; roles: Role[]; scope: 'all' | 'team' }
const base = '/api/users'
const message = (cause: unknown) => cause instanceof Error ? cause.message : '操作未完成，请稍后重试。'
const when = (value: string | null) => value ? new Date(value).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'

export default function UsersAdminPage({ user }: { user: SessionUser }) {
  const [members, setMembers] = useState<MemberList | null>(null)
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const load = useCallback(async () => {
    setLoading(true); setError('')
    try { setMembers(await request<MemberList>(base)) }
    catch (cause) { setError(message(cause)) }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { void load() }, [load])

  async function update(member: Member, change: { role?: string; status?: Member['status'] }) {
    setBusy(member.id); setError(''); setNotice('')
    try {
      const { data } = await request<{ data: Member }>(`${base}/${member.id}`, { method: 'PATCH', body: JSON.stringify(change) })
      setMembers(list => list && { ...list, data: list.data.map(row => row.id === member.id ? data : row) })
      setNotice(change.status ? `已${change.status === 'active' ? '启用' : '停用'} ${member.display_name} 的工作区访问权限。` : '角色已更新，下次授权登录后生效。')
    } catch (cause) { setError(message(cause)) }
    finally { setBusy('') }
  }

  return <div className="shop-page users-admin">
    <div className="shop-page-heading">
      <div><h2>成员权限</h2><p>查看通过 1688 登录的{members?.scope === 'team' ? '团队' : '工作区'}成员，并管理其使用权限。</p></div>
      <button className="shop-icon" type="button" aria-label="刷新成员" disabled={loading || Boolean(busy)} onClick={() => void load()}><RefreshCw size={17} /></button>
    </div>
    {error && <p className="shop-alert error" role="alert"><AlertCircle size={16} />{error}</p>}
    {notice && <p className="shop-alert" role="status"><Check size={16} />{notice}</p>}
    {loading ? <div className="shop-empty" role="status"><LoaderCircle className="spin" />正在读取成员…</div>
      : members?.data.length ? <div className="shop-table-scroll">
        <table className="shop-table">
          <thead><tr><th>成员</th><th>角色</th><th>最近登录</th><th>工作区权限</th></tr></thead>
          <tbody>{members.data.map(member => {
            const editable = member.id !== (user.sub ?? user.id) && !member.roles.some(r => r.code === 'super_admin')
            const role = member.roles.length === 1 ? member.roles[0].code : ''
            return <tr key={member.id}>
              <td><strong>{member.display_name}</strong>{member.parent_name && <small className="users-sub">团队：{member.parent_name}</small>}</td>
              <td>{editable ? <select aria-label={`${member.display_name} 的角色`} value={members.roles.some(r => r.code === role) ? role : ''} disabled={Boolean(busy)} onChange={event => void update(member, { role: event.target.value })}>
                <option value="" disabled>{member.roles.map(r => r.name).join('、') || '选择角色'}</option>
                {members.roles.map(r => <option key={r.code} value={r.code}>{r.name}</option>)}
              </select> : member.roles.map(r => r.name).join('、')}</td>
              <td>{when(member.last_login_at)}</td>
              <td><span className={`shop-status ${member.status === 'active' ? 'positive' : ''}`}>{member.status === 'active' ? '已启用' : '已停用'}</span>
                {editable && <button className="shop-button" type="button" disabled={Boolean(busy)} aria-label={`${member.status === 'active' ? '停用' : '启用'} ${member.display_name}`}
                  onClick={() => void update(member, { status: member.status === 'active' ? 'disabled' : 'active' })}>{member.status === 'active' ? '停用' : '启用'}</button>}</td>
            </tr>
          })}</tbody>
        </table>
      </div> : members && <p className="shop-empty">暂无 1688 成员。</p>}
    {members?.scope === 'all' && <TeamsAdmin />}
    {user.roles.includes('super_admin') && <ImageGenerationAdmin />}
  </div>
}
