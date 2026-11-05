import { useCallback, useEffect, useState } from 'react'
import { Note } from './ui'
import { AlertCircle, Check, Copy, KeyRound, LoaderCircle, RefreshCw, UserPlus, X } from 'lucide-react'
import { request, type SessionUser } from './api'
import './1688.css'

type Role = { code:string; name:string; permissions:string[] }
type Account = { id:string; email:string; display_name:string; mobile:string|null; status:'active'|'disabled'|'invited'; last_login_at:string|null; created_at:string; roles:{code:string;name:string}[] }
const base = '/api/users'
const json = (method:string, body:unknown) => ({ method, body:JSON.stringify(body) })
const message = (cause:unknown) => cause instanceof Error ? cause.message : '操作未完成，请稍后重试。'
const when = (value:string|null) => value ? new Date(value).toLocaleString('zh-CN', { year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' }) : '—'
/** A 14-character password with letters and digits, from the browser's secure random source. */
function generatePassword() {
  const letters = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ', digits = '23456789', all = letters + digits
  const pick = (set:string, n:number) => Array.from(crypto.getRandomValues(new Uint32Array(n)), v => set[v % set.length]).join('')
  return [...pick(letters, 2) + pick(digits, 2) + pick(all, 10)].sort(() => crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32 - .5).join('')
}
const passwordProblem = (v:string) => v.length < 10 ? '至少 10 位' : !/[A-Za-z]/.test(v) || !/\d/.test(v) ? '需同时包含字母和数字' : ''

/** 账户管理: the super administrator opens accounts (default: 管理员), changes roles, disables and resets passwords. */
export default function UsersAdminPage({user}:{user:SessionUser}) {
  const [accounts, setAccounts] = useState<Account[]>([]), [roles, setRoles] = useState<Role[]>([]), [loading, setLoading] = useState(true), [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [creating, setCreating] = useState(false), [resetting, setResetting] = useState<Account|null>(null), [issued, setIssued] = useState<{title:string;email:string;password:string}|null>(null)
  const load = useCallback(async () => { setLoading(true); try { const r = await request<{data:Account[];roles:Role[]}>(base); setAccounts(r.data); setRoles(r.roles); setError('') } catch (cause) { setError(message(cause)) } finally { setLoading(false) } }, [])
  useEffect(() => { void load() }, [load])
  async function update(account:Account, change:{role?:string;status?:'active'|'disabled'}) {
    setBusy(account.id); setError(''); setNotice('')
    try {
      const r = await request<{data:Account}>(`${base}/${account.id}`, json('PATCH', change))
      setAccounts(list => list.map(a => a.id === account.id ? r.data : a))
      setNotice(change.status ? `已${change.status === 'active' ? '启用' : '停用'} ${account.display_name}${change.status === 'disabled' ? '，其登录已立即失效' : ''}` : `已把 ${account.display_name} 调整为${roles.find(r => r.code === change.role)?.name}，需重新登录后生效`)
    } catch (cause) { setError(message(cause)) } finally { setBusy('') }
  }
  const me = user.id ?? user.sub
  const isSuper = (a:Account) => a.roles.some(r => r.code === 'super_admin')
  const active = accounts.filter(a => a.status === 'active').length
  return <div className="shop-page users-admin">
    <div className="shop-page-heading"><div><p>{accounts.length} 个账号 · {active} 个启用中</p></div>
      <button className="shop-button primary" onClick={() => setCreating(true)}><UserPlus size={16}/>开设账号</button>
      <button className="shop-icon" title="刷新" aria-label="刷新" disabled={loading} onClick={() => void load()}><RefreshCw size={17}/></button></div>
    {error && <p className="shop-alert error" role="alert"><AlertCircle size={16}/>{error}</p>}
    {notice && <p className="shop-alert" role="status"><Check size={16}/>{notice}</p>}
    {loading && !accounts.length ? <div className="shop-empty"><LoaderCircle className="spin"/></div>
      : <div className="shop-table-scroll"><table className="shop-table"><thead><tr><th>姓名</th><th>登录邮箱</th><th>角色</th><th>状态</th><th>最近登录</th><th>开设时间</th><th/></tr></thead>
        <tbody>{accounts.map(a => { const self = a.id === me, locked = isSuper(a); return <tr key={a.id} className={a.status !== 'active' ? 'users-disabled' : ''}>
          <td><strong>{a.display_name}</strong>{self && <span className="shop-status positive users-self">我</span>}{a.mobile && <small className="users-sub">{a.mobile}</small>}</td>
          <td>{a.email}</td>
          <td>{locked || self ? <span className={`shop-status ${locked ? 'positive' : ''}`}>{a.roles.map(r => r.name).join('、') || '无角色'}</span>
            : <select aria-label={`${a.display_name} 的角色`} value={a.roles[0]?.code ?? ''} disabled={Boolean(busy)} onChange={e => void update(a, { role:e.target.value })}>
              {!a.roles.length && <option value="">无角色</option>}{roles.map(r => <option key={r.code} value={r.code}>{r.name}</option>)}</select>}</td>
          <td>{locked || self ? <span className="shop-status positive">启用</span>
            : <label className="agent-switch"><input type="checkbox" role="switch" aria-label={`${a.display_name} 启用状态`} checked={a.status === 'active'} disabled={Boolean(busy)} onChange={e => { if (e.target.checked || window.confirm(`停用 ${a.display_name}？该账号会被立即退出，且无法再登录。`)) void update(a, { status:e.target.checked ? 'active' : 'disabled' }) }}/><span>{a.status === 'active' ? '启用' : '已停用'}</span></label>}</td>
          <td>{when(a.last_login_at)}</td><td>{when(a.created_at)}</td>
          <td>{(!locked || self) && <button className="shop-button" disabled={Boolean(busy)} onClick={() => setResetting(a)}>{busy === a.id ? <LoaderCircle size={14} className="spin"/> : <KeyRound size={14}/>}重置密码</button>}</td>
        </tr> })}</tbody></table></div>}
    <Note label="角色说明">「管理员」可以使用全部业务功能（首页、客户、商品、绩效与工资、设置），但不能开设或管理账号。停用、重置密码、调整角色会让该账号已登录的会话立即失效。</Note>
    {creating && <CreateDialog roles={roles} close={() => setCreating(false)} created={(account, password) => { setCreating(false); setAccounts(list => [...list, account]); setIssued({ title:'账号已开设', email:account.email, password }) }}/>}
    {resetting && <ResetDialog account={resetting} self={resetting.id === me} close={() => setResetting(null)} done={password => { const a = resetting; setResetting(null); if (a.id === me) { window.dispatchEvent(new Event('crm:unauthorized')); return } setIssued({ title:'密码已重置', email:a.email, password }) }}/>}
    {issued && <Issued {...issued} close={() => setIssued(null)}/>}
  </div>
}

function PasswordField({value, onChange}:{value:string;onChange:(v:string)=>void}) {
  const problem = value ? passwordProblem(value) : ''
  return <label>初始密码<div className="users-password"><input value={value} autoComplete="new-password" spellCheck={false} onChange={e => onChange(e.target.value)} placeholder="至少 10 位，含字母和数字"/>
    <button type="button" className="shop-button" onClick={() => onChange(generatePassword())}><RefreshCw size={14}/>随机生成</button></div>{problem && <small className="shop-local-error">{problem}</small>}</label>
}

function CreateDialog({roles, close, created}:{roles:Role[];close:()=>void;created:(account:Account, password:string)=>void}) {
  const [form, setForm] = useState({ displayName:'', email:'', mobile:'', role:'admin', password:generatePassword() }), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const set = (key:keyof typeof form) => (value:string) => setForm(f => ({ ...f, [key]:value }))
  const role = roles.find(r => r.code === form.role)
  async function submit() {
    setBusy(true); setError('')
    try { created((await request<{data:Account}>(base, json('POST', { ...form, mobile:form.mobile || undefined }))).data, form.password) } catch (cause) { setError(message(cause)) } finally { setBusy(false) }
  }
  const valid = form.displayName.trim() && /^\S+@\S+\.\S+$/.test(form.email.trim()) && !passwordProblem(form.password)
  return <div className="dialog-layer shop-dialog"><button className="drawer-scrim" aria-label="取消" disabled={busy} onClick={close}/>
    <section className="shop-modal" role="dialog" aria-modal="true" aria-label="开设账号"><header><h2>开设账号</h2><button title="关闭" disabled={busy} onClick={close}><X size={18}/></button></header>
      <div className="shop-modal-body users-form">
        <label>姓名<input value={form.displayName} maxLength={80} onChange={e => set('displayName')(e.target.value)} placeholder="如：王店长"/></label>
        <label>登录邮箱<input type="email" value={form.email} maxLength={255} autoComplete="off" onChange={e => set('email')(e.target.value)} placeholder="登录时填写，如 wang@company.com"/></label>
        <label>手机（可选）<input value={form.mobile} maxLength={40} onChange={e => set('mobile')(e.target.value)}/></label>
        <label>角色<select value={form.role} onChange={e => set('role')(e.target.value)}>{roles.map(r => <option key={r.code} value={r.code}>{r.name}</option>)}</select></label>
        {role && <small className="users-role-hint">{role.code === 'admin' ? '可使用全部业务功能，不能管理账号。' : `权限：${role.permissions.join('、')}`}</small>}
        <PasswordField value={form.password} onChange={set('password')}/>
        {error && <p className="shop-local-error"><AlertCircle size={15}/>{error}</p>}
      </div>
      <footer><button className="shop-button" disabled={busy} onClick={close}>取消</button><button className="shop-button primary" disabled={busy || !valid} onClick={() => void submit()}>{busy ? <LoaderCircle size={16} className="spin"/> : <UserPlus size={16}/>}开设账号</button></footer>
    </section></div>
}

function ResetDialog({account, self, close, done}:{account:Account;self:boolean;close:()=>void;done:(password:string)=>void}) {
  const [password, setPassword] = useState(generatePassword()), [busy, setBusy] = useState(false), [error, setError] = useState('')
  async function submit() { setBusy(true); setError(''); try { await request(`${base}/${account.id}/password`, json('POST', { password })); done(password) } catch (cause) { setError(message(cause)) } finally { setBusy(false) } }
  return <div className="dialog-layer shop-dialog"><button className="drawer-scrim" aria-label="取消" disabled={busy} onClick={close}/>
    <section className="shop-modal" role="dialog" aria-modal="true" aria-label="重置密码"><header><h2>重置 {account.display_name} 的密码</h2><button title="关闭" disabled={busy} onClick={close}><X size={18}/></button></header>
      <div className="shop-modal-body users-form"><p>{self ? '重置后你需要用新密码重新登录。' : '重置后该账号已登录的会话会立即退出，需要用新密码重新登录。'}</p><PasswordField value={password} onChange={setPassword}/>{error && <p className="shop-local-error"><AlertCircle size={15}/>{error}</p>}</div>
      <footer><button className="shop-button" disabled={busy} onClick={close}>取消</button><button className="shop-button primary" disabled={busy || Boolean(passwordProblem(password))} onClick={() => void submit()}>{busy ? <LoaderCircle size={16} className="spin"/> : <KeyRound size={16}/>}重置密码</button></footer>
    </section></div>
}

/** Shows the login details once so they can be handed over; they are not stored anywhere readable. */
function Issued({title, email, password, close}:{title:string;email:string;password:string;close:()=>void}) {
  const [copied, setCopied] = useState(false)
  const text = `登录地址：${location.origin}\n登录邮箱：${email}\n密码：${password}\n首次登录后请妥善保管密码。`
  async function copy() { try { await navigator.clipboard.writeText(text); setCopied(true) } catch { setCopied(false) } }
  return <div className="dialog-layer shop-dialog"><button className="drawer-scrim" aria-label="关闭" onClick={close}/>
    <section className="shop-modal" role="dialog" aria-modal="true" aria-label={title}><header><h2>{title}</h2><button title="关闭" onClick={close}><X size={18}/></button></header>
      <div className="shop-modal-body users-form"><p>请把下面的登录信息交给使用者。密码只显示这一次，关闭后无法再查看。</p><pre className="users-issued">{text}</pre></div>
      <footer><button className="shop-button" onClick={() => void copy()}>{copied ? <Check size={16}/> : <Copy size={16}/>}{copied ? '已复制' : '复制登录信息'}</button><button className="shop-button primary" onClick={close}>完成</button></footer>
    </section></div>
}
