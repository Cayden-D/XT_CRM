import { useEffect, useRef, useState } from 'react'
import { AlertCircle, CheckCircle2, LoaderCircle } from 'lucide-react'
import { completeShopAuthorization } from './1688Api'
import { completePerformanceAuthorization } from './performanceApi'

/**
 * 1688 sends the browser back to the configured callback address (this site) with ?code=…&state=… after the shop owner
 * authorizes. This page finishes the authorization by itself — no copying of addresses — and returns to 店铺授权.
 * Which app started it is remembered for the trip (`rememberAuthorization`); without that note the product app is tried
 * first, then the performance app (a state belongs to exactly one of them, and a wrong guess consumes nothing).
 */
const KEY = 'crm:1688-authorization'
export type AuthorizationApp = 'product' | 'performance'
export const rememberAuthorization = (app: AuthorizationApp) => { try { sessionStorage.setItem(KEY, app) } catch { /* private mode: the fallback order still works */ } }
export const isAuthorizationReturn = (search = window.location.search) => { const q = new URLSearchParams(search); return (q.has('code') && q.has('state')) || (q.has('error') && q.has('state')) }

const SETTINGS = '#/settings/shops'
// The address bar already shows 店铺授权 (the code was taken out of it), and a same-address replace does not reload: reload then.
const backToSettings = () => {
  const target = `${window.location.origin}/${SETTINGS}`
  if (window.location.href === target) window.location.reload()
  else window.location.replace(target)
}

export default function OAuthReturn() {
  const [state, setState] = useState<{ kind: 'working' | 'done' | 'failed'; text: string }>({ kind: 'working', text: '正在完成 1688 授权…' })
  const started = useRef(false)
  useEffect(() => {
    if (started.current) return
    started.current = true
    const query = new URLSearchParams(window.location.search)
    // The callback address exactly as 1688 called it (the server checks it against the configured one).
    const callbackUrl = `${window.location.origin}${window.location.pathname}${window.location.search}`
    let app: string | null = null
    try { app = sessionStorage.getItem(KEY); sessionStorage.removeItem(KEY) } catch { /* ignore */ }
    // The code is single-use: take it out of the address bar at once, so a reload cannot send it again.
    window.history.replaceState(null, '', `${window.location.origin}/${SETTINGS}`)
    if (query.has('error')) { setState({ kind: 'failed', text: '已取消 1688 授权，未连接任何店铺。' }); return }
    const order: AuthorizationApp[] = app === 'performance' ? ['performance', 'product'] : ['product', 'performance']
    const complete = { product: completeShopAuthorization, performance: completePerformanceAuthorization }
    const done = { product: '1688 店铺授权完成，正在返回店铺授权页…', performance: '绩效应用授权完成，请在店铺授权页点击「验证」确认主账号。正在返回…' }
    void (async () => {
      let last: unknown
      for (const which of order) {
        try {
          await complete[which](callbackUrl)
          setState({ kind: 'done', text: done[which] })
          setTimeout(backToSettings, 1500)
          return
        } catch (cause) {
          last = cause
          // Only "this state is not ours" moves on to the other app; any other answer is the real result.
          if (!(cause instanceof Error && /授权状态无效|INVALID_STATE/.test(cause.message))) break
        }
      }
      setState({ kind: 'failed', text: last instanceof Error ? last.message : '授权未完成，请回到店铺授权页重新发起。' })
    })()
  }, [])
  return <div className="app-loading oauth-return">
    {state.kind === 'working' ? <LoaderCircle size={28} className="spin" /> : state.kind === 'done' ? <CheckCircle2 size={28} color="#16a34a" /> : <AlertCircle size={28} color="#c2410c" />}
    <p>{state.text}</p>
    {state.kind === 'failed' && <button className="shop-button primary" onClick={backToSettings}>返回店铺授权</button>}
  </div>
}
