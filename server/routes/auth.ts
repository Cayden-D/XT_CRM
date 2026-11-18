import { randomBytes } from 'node:crypto'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import { db } from '../db.js'
import { config } from '../config.js'
import { requireAuth } from '../auth.js'
import { appCredentials, getGrant, IntegrationError, stateHash } from '../integrations/1688.js'
import { signIn1688 } from '../integrations/1688-sign-in.js'
import { CRM_ACCESS_TOKEN_KEY } from '../../shared/crm-session.js'

const marketplaceOrigins = new Set(['https://auth.1688.com', 'https://fuwu.1688.com', 'https://open.1688.com'])

function isMarketplaceNavigation(referer: string | undefined, mode: string | undefined, destination: string | undefined) {
  if (!referer || (mode && mode !== 'navigate') || (destination && !['document', 'iframe', 'frame'].includes(destination))) return false
  try { return marketplaceOrigins.has(new URL(referer).origin) }
  catch { return false }
}

function marketplacePage(reply: FastifyReply, status: number, message: string, token?: string) {
  const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
  const nonce = randomBytes(18).toString('base64')
  // Passing the CRM token in this protected HTML response avoids putting either token in a URL or shared browser storage.
  const script = token ? `<script nonce="${nonce}">
    try {
      sessionStorage.setItem(${JSON.stringify(CRM_ACCESS_TOKEN_KEY)}, ${JSON.stringify(token)});
      location.replace('/#/home/overview');
    } catch {
      document.getElementById('status').textContent = '当前浏览器限制了嵌入页面的登录会话，请在新标签页打开销途。';
    }
  </script>` : ''
  return reply.code(status)
    .type('text/html; charset=utf-8')
    .header('Referrer-Policy', 'no-referrer')
    .header('X-Content-Type-Options', 'nosniff')
    .header('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; frame-ancestors https://*.1688.com; base-uri 'none'; form-action 'none'`)
    .send(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>销途绩效</title>
      <main><p id="status" role="status">${escape(message)}</p><a href="/" target="_blank" rel="noopener noreferrer">在新标签页打开销途</a></main>${script}</html>`)
}

async function exchangeSignInCode(code: string, appKey: string, reply: FastifyReply) {
  const grant = await getGrant({ code }, 'performance')
  const { oauth1688, ...user } = await signIn1688(appKey, grant, Date.now())
  const token = await reply.jwtSign({ ...user, oauth1688 }, { expiresIn: config.JWT_EXPIRES_IN })
  return { token, user }
}

const digest = /^[a-f0-9]{64}$/
const loginState = /^login_[a-f0-9]{64}$/

export async function authRoutes(app: FastifyInstance) {
  app.addHook('onRequest', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store')
  })
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof IntegrationError) return reply.code(error.statusCode).send({ error: error.code, message: error.message })
    if (error instanceof z.ZodError) return reply.code(400).send({ error: 'VALIDATION_ERROR', message: '1688 登录请求无效，请重新发起。' })
    request.log.error(error)
    return reply.code(500).send({ error: 'INTERNAL_SERVER_ERROR', message: '暂时无法登录，请稍后重试。' })
  })

  // Nginx internally rewrites only the registered entry's code-only navigations to this route.
  // Ordinary web OAuth still requires the application-issued state and browser verifier.
  app.get('/1688/marketplace', { exposeHeadRoute: false }, async (request, reply) => {
    const query = z.object({ code: z.string().trim().min(1).max(4096), state: z.never().optional(), error: z.never().optional() }).safeParse(request.query)
    if (!query.success) return marketplacePage(reply, 400, '未收到有效的 1688 服务市场授权，请从「我的服务」重新打开应用。')
    if (!isMarketplaceNavigation(request.headers.referer, request.headers['sec-fetch-mode']?.toString(), request.headers['sec-fetch-dest']?.toString())) {
      return marketplacePage(reply, 403, '无法确认本次服务市场来源，请从「我的服务」重新打开应用。')
    }
    try {
      const { appKey, redirect } = appCredentials('performance')
      if (request.headers.host?.toLowerCase() !== new URL(redirect).host) {
        return marketplacePage(reply, 400, '服务市场入口与销途登记的地址不一致，请联系运营方。')
      }
      const { token } = await exchangeSignInCode(query.data.code, appKey, reply)
      return marketplacePage(reply, 200, '正在进入销途工作台…', token)
    } catch (error) {
      if (error instanceof IntegrationError && error.statusCode === 409) return marketplacePage(reply, 409, error.message)
      request.log.warn({ error: error instanceof IntegrationError ? error.code : 'MARKETPLACE_LOGIN_FAILED' }, '1688 marketplace sign-in failed')
      return marketplacePage(reply, 400, '本次服务市场授权未完成，请从「我的服务」重新打开应用。')
    }
  })

  app.post('/1688/start', async request => {
    const { challenge } = z.object({ challenge: z.string().regex(digest) }).strict().parse(request.body)
    const { appKey, redirect } = appCredentials('performance')
    const state = `login_${randomBytes(32).toString('hex')}`
    await db.query('DELETE FROM auth_1688_sign_in_states WHERE expires_at<=now()')
    await db.query(`
      INSERT INTO auth_1688_sign_in_states(state_hash,browser_challenge,app_key,redirect_uri,expires_at)
      VALUES($1,$2,$3,$4,now()+interval '10 minutes')`, [stateHash(state), challenge, appKey, redirect])
    const url = new URL('https://auth.1688.com/oauth/authorize')
    url.search = new URLSearchParams({ client_id: appKey, site: '1688', redirect_uri: redirect, state }).toString()
    return { authorizationUrl: url.href }
  })

  app.post('/1688/complete', async (request, reply) => {
    const { callbackUrl, verifier } = z.object({ callbackUrl: z.string().url().max(8192), verifier: z.string().regex(digest) }).strict().parse(request.body)
    const { appKey, redirect } = appCredentials('performance')
    const callback = new URL(callbackUrl), expected = new URL(redirect)
    const code = callback.searchParams.get('code'), state = callback.searchParams.get('state')
    if (callback.origin !== expected.origin || callback.pathname !== expected.pathname || callback.username || callback.password ||
        callback.searchParams.getAll('code').length !== 1 || callback.searchParams.getAll('state').length !== 1 ||
        callback.searchParams.has('error') || !code || code.length > 4096 || !state || !loginState.test(state)) {
      throw new IntegrationError('INVALID_CALLBACK', '1688 登录回调无效，请重新发起。', 400)
    }
    // Consume atomically before using the one-time code. A copied callback cannot log in from another browser tab.
    const consumed = await db.query(`
      DELETE FROM auth_1688_sign_in_states WHERE state_hash=$1 AND browser_challenge=$2 AND app_key=$3 AND redirect_uri=$4
      AND expires_at>now() RETURNING state_hash`, [stateHash(state), stateHash(verifier), appKey, redirect])
    if (!consumed.rowCount) throw new IntegrationError('INVALID_STATE', '1688 登录已过期或已使用，请重新发起。', 409)
    return exchangeSignInCode(code, appKey, reply)
  })

  app.get('/me', { preHandler: requireAuth }, async request => {
    const { oauth1688: _identity, ...user } = request.authUser
    return { user }
  })
}
