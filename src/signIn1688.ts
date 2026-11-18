import { request, setToken } from './api'

const STORAGE_KEY = 'crm:1688-sign-in'
const hex = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')

export const is1688SignInReturn = (search: string) => new URLSearchParams(search).get('state')?.startsWith('login_') ?? false

export async function start1688SignIn() {
  const verifier = hex(crypto.getRandomValues(new Uint8Array(32)))
  const challenge = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))
  const { authorizationUrl } = await request<{ authorizationUrl: string }>('/api/auth/1688/start', {
    method: 'POST', body: JSON.stringify({ challenge }),
  })
  const url = new URL(authorizationUrl)
  const redirect = new URL(url.searchParams.get('redirect_uri') ?? '')
  if (redirect.origin !== window.location.origin) {
    throw new Error(`请从 ${redirect.origin} 打开销途绩效后再授权登录。`)
  }
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ verifier, state: url.searchParams.get('state'), hash: window.location.hash }))
  window.location.assign(url.href)
}

export async function finish1688SignIn() {
  const callbackUrl = window.location.href
  const query = new URLSearchParams(window.location.search)
  // Clear the code immediately, including on cancellation or an invalid callback.
  window.history.replaceState(null, '', window.location.pathname)
  const raw = sessionStorage.getItem(STORAGE_KEY)
  const pending = raw ? JSON.parse(raw) as { verifier: string; state: string; hash: string } : null
  if (!pending || pending.state !== query.get('state')) throw new Error('1688 登录已过期，请重新发起。')
  sessionStorage.removeItem(STORAGE_KEY)
  if (query.has('error')) throw new Error('未完成 1688 授权，可以重新发起登录。')
  const { token } = await request<{ token: string }>('/api/auth/1688/complete', {
    method: 'POST', body: JSON.stringify({ callbackUrl, verifier: pending.verifier }),
  })
  setToken(token)
  const target = pending.hash.startsWith('#/') ? pending.hash : '#/home/overview'
  window.history.replaceState(null, '', '/' + target)
  window.location.reload()
}
