import { useState } from 'react'
import { AlertCircle, Check, LoaderCircle, PlugZap } from 'lucide-react'
import { request, type SessionUser } from './api'

const challengeOf = (hash: string) => new URLSearchParams(hash.split('?')[1] ?? '').get('c') ?? ''
const canCollect = (user: SessionUser) => (user.permissions || []).some(p => p === '*' || p === 'collection:*' || p === 'collection:create')

/** Opened by the collector (userscript or extension): the signed-in user approves it to collect into this account. */
export default function CollectorConnect({ user, hash }: { user: SessionUser; hash: string }) {
  const challenge = challengeOf(hash), valid = /^[A-Za-z0-9_-]{43}$/.test(challenge)
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle'), [error, setError] = useState('')
  async function approve() {
    setState('busy'); setError('')
    try {
      await request(`/api/product-collections/connect/approve`, { method: 'POST', body: JSON.stringify({ challenge }) })
      setState('done')
      setTimeout(() => window.close(), 1500)
    } catch (cause) { setError(cause instanceof Error ? cause.message : '授权失败，请重试。'); setState('idle') }
  }
  const leave = () => { window.location.hash = '#/products/collect' }
  return <div className="collector-connect">
    <section>
      <div className="collector-connect-icon">{state === 'done' ? <Check size={26}/> : <PlugZap size={26}/>}</div>
      {state === 'done' ? <><h1>采集器已连接</h1><p>回到 1688 页面即可开始采集。这个页面可以关闭。</p><button onClick={leave}>进入采集箱</button></>
        : !valid ? <><h1>授权链接无效</h1><p>请回到 1688 页面，在采集器里重新点击“连接 CRM”。</p><button onClick={leave}>进入 CRM</button></>
        : !canCollect(user) ? <><h1>当前账号不能采集商品</h1><p>{user.displayName ?? user.email} 没有采集权限，请联系主管开通，或换一个账号登录。</p><button onClick={leave}>进入 CRM</button></>
        : <><h1>授权商品采集器</h1><p>授权后，采集器采集的商品会以 <b>{user.displayName ?? user.email}</b> 的身份保存到采集箱。只在你刚刚在 1688 页面点击了“连接 CRM”时授权。</p>
          {error && <p className="collector-connect-error"><AlertCircle size={14}/>{error}</p>}
          <div><button onClick={leave} disabled={state === 'busy'}>取消</button><button className="primary" onClick={() => void approve()} disabled={state === 'busy'}>{state === 'busy' ? <LoaderCircle size={15} className="spin"/> : <Check size={15}/>}授权</button></div></>}
    </section>
  </div>
}
