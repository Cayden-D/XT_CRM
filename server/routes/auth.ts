import { randomBytes } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { db } from '../db.js'
import { config } from '../config.js'
import { requireAuth } from '../auth.js'
import { appCredentials, getGrant, IntegrationError, stateHash } from '../integrations/1688.js'
import { signIn1688 } from '../integrations/1688-sign-in.js'

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
    const grant = await getGrant({ code }, 'performance')
    const user = await signIn1688(appKey, grant, Date.now())
    const token = await reply.jwtSign(user, { expiresIn: config.JWT_EXPIRES_IN })
    return { token, user }
  })

  app.get('/me', { preHandler: requireAuth }, async request => ({ user: request.authUser }))
}
