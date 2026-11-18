import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { buildApp } from '../server/app.js'
import { config } from '../server/config.js'
import { db } from '../server/db.js'

const app = await buildApp(), tenants: string[] = [], users: string[] = []
const appKey = config.ALI1688_PERFORMANCE_APP_KEY ?? '1688-test-members'
config.ALI1688_PERFORMANCE_APP_KEY = appKey
const call = (method: 'GET' | 'POST' | 'PATCH', url: string, token: string, payload?: object) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}) })
try {
  async function workspace() {
    const id = (await db.query("INSERT INTO tenants(name,slug)VALUES('成员测试',$1)RETURNING id", [`members-${randomUUID()}`])).rows[0].id as string
    tenants.push(id)
    return id
  }

  const t1 = await workspace(), t2 = await workspace()
  async function member(tenantId: string, role: string, permissions: string[], parent: string | null = null, linked = true) {
    const email = `${randomUUID()}@members.test`
    const sub: string = (await db.query("INSERT INTO users(tenant_id,email,display_name,parent_user_id)VALUES($1,$2,'成员',$3) RETURNING id", [tenantId, email, parent])).rows[0].id
    users.push(sub)
    await db.query('INSERT INTO roles(tenant_id,code,name,permissions) VALUES($1,$2,$2,$3) ON CONFLICT DO NOTHING', [tenantId, role, JSON.stringify(permissions)])
    await db.query('INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE tenant_id=$2 AND code=$3', [sub, tenantId, role])
    if (linked) await db.query('INSERT INTO auth_1688_identities(app_key,ali_id,user_id)VALUES($1,$2,$3)', [appKey, sub, sub])
    return { sub, token: app.jwt.sign({ sub, tenantId, email, displayName: '成员', roles: [role], permissions }) }
  }

  const boss = await member(t1, 'super_admin', ['*'])
  const lead = await member(t1, 'sales_manager', ['user:manage_team'])
  const rep = await member(t1, 'sales_rep', ['dashboard:read'], lead.sub)
  const peer = await member(t1, 'sales_rep', ['dashboard:read'])
  const legacy = await member(t1, 'sales_rep', ['dashboard:read'], lead.sub, false)
  const outsider = await member(t2, 'super_admin', ['*'])
  await db.query("INSERT INTO roles(tenant_id,code,name,permissions) VALUES($1,'order_specialist','跟单员','[\"order:*\"]')", [t1])

  assert.deepEqual((await call('GET', '/api/users', boss.token)).json().data.map((u: { id: string }) => u.id).sort(), [boss.sub, lead.sub, peer.sub, rep.sub].sort())
  const mine = (await call('GET', '/api/users', lead.token)).json()
  assert.equal(mine.scope, 'team')
  assert.deepEqual(mine.data.map((u: { id: string }) => u.id), [rep.sub])
  assert.equal((await call('GET', '/api/users', rep.token)).statusCode, 403)

  assert.equal((await call('POST', '/api/users', boss.token, { email: 'new@members.test', password: 'Unused-test-1' })).statusCode, 404)
  assert.equal((await call('POST', `/api/users/${rep.sub}/password`, boss.token, { password: 'Unused-test-2' })).statusCode, 404)
  assert.equal((await call('PATCH', `/api/users/${rep.sub}`, lead.token, { displayName: '改名' })).statusCode, 400)
  assert.equal((await call('PATCH', `/api/users/${rep.sub}`, lead.token, { role: 'admin' })).statusCode, 400)
  assert.equal((await call('PATCH', `/api/users/${peer.sub}`, lead.token, { status: 'disabled' })).statusCode, 404)
  assert.equal((await call('PATCH', `/api/users/${legacy.sub}`, boss.token, { status: 'disabled' })).statusCode, 404)
  assert.equal((await call('PATCH', `/api/users/${rep.sub}`, outsider.token, { status: 'disabled' })).statusCode, 404)
  assert.equal((await call('PATCH', `/api/users/${boss.sub}`, boss.token, { status: 'disabled' })).statusCode, 409)
  assert.equal((await call('PATCH', `/api/users/${rep.sub}`, lead.token, { role: 'order_specialist' })).json().data.roles[0].code, 'order_specialist')
  assert.equal((await call('PATCH', `/api/users/${rep.sub}`, lead.token, { status: 'disabled' })).json().data.status, 'disabled')
  assert.equal((await call('GET', '/api/auth/me', rep.token)).statusCode, 401)
  console.log('1688 成员权限、跨工作区隔离及旧账号接口下线已验证')
} finally {
  await db.query('DELETE FROM auth_1688_identities WHERE user_id=ANY($1::uuid[])', [users])
  await db.query('DELETE FROM audit_logs WHERE tenant_id=ANY($1::uuid[])', [tenants])
  await db.query('DELETE FROM tenants WHERE id=ANY($1::uuid[])', [tenants])
  await app.close()
  await db.end()
}
