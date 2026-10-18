import type { FastifyReply, FastifyRequest } from 'fastify'
import { db } from './db.js'
import type { AuthToken } from './types/fastify.js'

/**
 * Account state behind a token, cached briefly. A token stops working when its account is disabled or deleted, or
 * when it was issued before the account's session cut-off (password reset, role change).
 */
type Account = { active: boolean; revokedAt: number }
const accounts = new Map<string, { account: Account | null; at: number }>()
const CACHE_MS = 10_000
export const forgetAccount = (userId: string) => { accounts.delete(userId) }
async function accountOf(userId: string) {
  const cached = accounts.get(userId)
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.account
  const row = (await db.query<{ status: string; deleted_at: Date | null; sessions_revoked_at: Date | null }>('SELECT status,deleted_at,sessions_revoked_at FROM users WHERE id=$1', [userId])).rows[0]
  const account = row ? { active: row.status === 'active' && !row.deleted_at, revokedAt: row.sessions_revoked_at ? row.sessions_revoked_at.getTime() : 0 } : null
  accounts.set(userId, { account, at: Date.now() })
  return account
}

export async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
  try {
    await request.jwtVerify()
    request.authUser = request.user as AuthToken
  } catch {
    return reply.code(401).send({ error: 'UNAUTHORIZED', message: '登录已失效，请重新登录。' })
  }
  const account = /^[0-9a-f-]{36}$/i.test(request.authUser.sub) ? await accountOf(request.authUser.sub) : null
  const issuedAt = Number((request.user as { iat?: number }).iat ?? 0) * 1000
  // iat has second precision: only tokens issued in a full second before the cut-off are known to predate it.
  if (account && (!account.active || issuedAt + 1000 <= account.revokedAt)) {
    return reply.code(401).send({ error: 'UNAUTHORIZED', message: account.active ? '账号信息已变更，请重新登录。' : '账号已停用，请联系管理员。' })
  }
}

export function hasPermission(granted: string[], required: string) {
  if (granted.includes('*') || granted.includes(required)) return true
  return granted.includes(`${required.split(':')[0]}:*`)
}

export function requirePermission(permission: string) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    await requireAuth(request, reply)
    if (reply.sent) return
    if (!hasPermission(request.authUser.permissions, permission)) {
      return reply.code(403).send({ error: 'FORBIDDEN', message: '当前账号没有执行此操作的权限。' })
    }
  }
}
