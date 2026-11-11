import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import bcrypt from 'bcryptjs'
import { buildApp } from '../server/app.js'
import { db } from '../server/db.js'

// 账户管理: super administrator opens accounts; roles, disabling and password resets take effect on live sessions.
const app = await buildApp(), tenants: { id: string; slug: string }[] = []
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
try {
  for (let i = 0; i < 2; i++) {
    const slug = `users-${randomUUID().slice(0, 8)}`
    tenants.push({ id: (await db.query('INSERT INTO tenants(name,slug)VALUES($1,$2)RETURNING id', ['账户测试', slug])).rows[0].id, slug })
  }
  const [t1, t2] = tenants
  const superAdmin = async (t: { id: string }, email: string) => {
    const role = (await db.query("INSERT INTO roles(tenant_id,code,name,permissions,is_system) VALUES($1,'super_admin','超级管理员','[\"*\"]',true) RETURNING id", [t.id])).rows[0].id
    const user = (await db.query("INSERT INTO users(tenant_id,email,password_hash,display_name,status) VALUES($1,$2,$3,'老板','active') RETURNING id", [t.id, email, await bcrypt.hash('Boss-pass-2026', 4)])).rows[0].id
    await db.query('INSERT INTO user_roles(user_id,role_id) VALUES($1,$2)', [user, role])
    return user as string
  }
  const bossId = await superAdmin(t1, 'boss@users.test'), otherBoss = await superAdmin(t2, 'boss@other.test')
  await db.query("INSERT INTO roles(tenant_id,code,name,permissions) VALUES($1,'viewer','只读','[\"dashboard:read\"]')", [t1.id])
  const login = (email: string, password: string, tenant = t1.slug) => app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password, tenant } })
  const tokenOf = async (email: string, password: string, tenant = t1.slug) => { const r = await login(email, password, tenant); assert.equal(r.statusCode, 200, r.body); return r.json().token as string }
  const call = (method: 'GET' | 'POST' | 'PATCH', url: string, token: string, payload?: object) => app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}) })
  const boss = await tokenOf('boss@users.test', 'Boss-pass-2026')

  // Listing: the admin role exists (created on demand) and super_admin is never offered.
  const listed = (await call('GET', '/api/users', boss)).json()
  assert.deepEqual(listed.roles.map((r: { code: string }) => r.code), ['admin', 'viewer'])
  assert.equal(listed.data.length, 1)

  // Opening an account: validation, duplicates and role limits.
  const weak = await call('POST', '/api/users', boss, { email: 'mgr@users.test', displayName: '店长', password: 'short1' })
  assert.deepEqual([weak.statusCode, weak.json().message], [400, '密码至少 10 位。'])
  assert.equal((await call('POST', '/api/users', boss, { email: 'mgr@users.test', displayName: '店长', password: 'onlyletters' })).json().message, '密码需同时包含字母和数字。')
  assert.equal((await call('POST', '/api/users', boss, { email: 'x@users.test', displayName: 'x', password: 'Valid-pass-1', role: 'super_admin' })).statusCode, 400)
  const created = await call('POST', '/api/users', boss, { email: 'MGR@users.test', displayName: '店长', password: 'Manager-pass-1' })
  assert.equal(created.statusCode, 200, created.body)
  const mgr = created.json().data
  assert.deepEqual([mgr.email, mgr.status, mgr.roles.map((r: { code: string }) => r.code)], ['mgr@users.test', 'active', ['admin']])
  assert.equal((await call('POST', '/api/users', boss, { email: 'mgr@users.test', displayName: '重复', password: 'Manager-pass-1' })).statusCode, 409)
  assert.equal((await db.query("SELECT count(*)::int n FROM audit_logs WHERE tenant_id=$1 AND action='user.create'", [t1.id])).rows[0].n, 1)

  // The new administrator can work but cannot manage accounts.
  let manager = await tokenOf('mgr@users.test', 'Manager-pass-1')
  const me = (await call('GET', '/api/auth/me', manager)).json().user
  assert.ok(me.permissions.includes('performance:*') && me.permissions.includes('integration:*') && !me.permissions.includes('*'))
  assert.equal((await call('GET', '/api/users', manager)).statusCode, 403)
  assert.equal((await call('POST', '/api/users', manager, { email: 'y@users.test', displayName: 'y', password: 'Valid-pass-1' })).statusCode, 403)
  assert.equal((await call('GET', '/api/image-workshop/settings', manager)).statusCode, 200)

  // Role change ends the session; the next login carries the new role.
  await pause(1100)
  assert.equal((await call('PATCH', `/api/users/${mgr.id}`, boss, { role: 'viewer' })).json().data.roles[0].code, 'viewer')
  assert.equal((await call('GET', '/api/auth/me', manager)).statusCode, 401)
  manager = await tokenOf('mgr@users.test', 'Manager-pass-1')
  assert.deepEqual((await call('GET', '/api/auth/me', manager)).json().user.permissions, ['dashboard:read'])
  await call('PATCH', `/api/users/${mgr.id}`, boss, { role: 'admin' })

  // Disabling: live session and new logins refused; enabling restores login.
  manager = await tokenOf('mgr@users.test', 'Manager-pass-1')
  await pause(1100)
  assert.equal((await call('PATCH', `/api/users/${mgr.id}`, boss, { status: 'disabled' })).json().data.status, 'disabled')
  const off = await call('GET', '/api/auth/me', manager)
  assert.deepEqual([off.statusCode, off.json().message], [401, '账号已停用，请联系管理员。'])
  assert.equal((await login('mgr@users.test', 'Manager-pass-1')).statusCode, 401)
  await call('PATCH', `/api/users/${mgr.id}`, boss, { status: 'active' })
  manager = await tokenOf('mgr@users.test', 'Manager-pass-1')

  // Password reset: old session and old password stop working.
  await pause(1100)
  assert.equal((await call('POST', `/api/users/${mgr.id}/password`, boss, { password: 'Fresh-pass-2026' })).statusCode, 200)
  assert.equal((await call('GET', '/api/auth/me', manager)).statusCode, 401)
  assert.equal((await login('mgr@users.test', 'Manager-pass-1')).statusCode, 401)
  await tokenOf('mgr@users.test', 'Fresh-pass-2026')

  // Guards: no self-disable/demotion, the super administrator is protected, other tenants are invisible.
  assert.equal((await call('PATCH', `/api/users/${bossId}`, boss, { status: 'disabled' })).statusCode, 409)
  assert.equal((await call('PATCH', `/api/users/${bossId}`, boss, { role: 'admin' })).statusCode, 409)
  assert.equal((await call('PATCH', `/api/users/${bossId}`, boss, { displayName: '老板娘' })).json().data.display_name, '老板娘')
  const otherToken = await tokenOf('boss@other.test', 'Boss-pass-2026', t2.slug)
  assert.equal((await call('PATCH', `/api/users/${mgr.id}`, otherToken, { status: 'disabled' })).statusCode, 404)
  assert.equal((await call('GET', '/api/users', otherToken)).json().data.length, 1)
  const secondBoss = (await db.query("INSERT INTO users(tenant_id,email,password_hash,display_name,status) VALUES($1,'boss2@users.test','x','二号','active') RETURNING id", [t1.id])).rows[0].id
  await db.query("INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE tenant_id=$2 AND code='super_admin'", [secondBoss, t1.id])
  assert.equal((await call('PATCH', `/api/users/${secondBoss}`, boss, { status: 'disabled' })).statusCode, 403)
  assert.equal((await call('POST', `/api/users/${secondBoss}/password`, boss, { password: 'Valid-pass-123' })).statusCode, 403)
  void otherBoss

  // 子账号: a supervisor opens and manages only their own team, with team roles only.
  for (const [code, name, perms] of [['sales_manager', '销售经理', ['user:manage_team', 'dashboard:*']], ['sales_rep', '外贸业务员', ['dashboard:read']], ['order_specialist', '跟单员', ['order:*']]] as const)
    await db.query('INSERT INTO roles(tenant_id,code,name,permissions) VALUES($1,$2,$3,$4) ON CONFLICT(tenant_id,code) DO UPDATE SET permissions=excluded.permissions', [t1.id, code, name, JSON.stringify(perms)])
  const openManager = async (email: string) => { const r = await call('POST', '/api/users', boss, { email, displayName: email.split('@')[0], password: 'Manager-team-1', role: 'sales_manager' }); assert.equal(r.statusCode, 200, r.body); return { id: r.json().data.id as string, token: await tokenOf(email, 'Manager-team-1') } }
  const lead = await openManager('lead@users.test'), rival = await openManager('rival@users.test')
  const teamView = (await call('GET', '/api/users', lead.token)).json()
  assert.deepEqual([teamView.scope, teamView.data.length, teamView.roles.map((r: { code: string }) => r.code).sort()], ['team', 0, ['order_specialist', 'sales_rep']], 'a supervisor starts with an empty team and two roles to give')
  assert.equal((await call('POST', '/api/users', lead.token, { email: 'up@users.test', displayName: '越权', password: 'Valid-pass-12', role: 'admin' })).statusCode, 400, 'no admin from a supervisor')
  assert.equal((await call('POST', '/api/users', lead.token, { email: 'up2@users.test', displayName: '越权', password: 'Valid-pass-12', role: 'sales_manager' })).statusCode, 400)
  const member = await call('POST', '/api/users', lead.token, { email: 'rep@users.test', displayName: '业务员甲', password: 'Member-pass-12' })
  assert.equal(member.statusCode, 200, member.body)
  const memberId = member.json().data.id as string
  assert.deepEqual(member.json().data.roles.map((r: { code: string }) => r.code), ['sales_rep'], 'the first team role by default')
  assert.equal((await db.query('SELECT parent_user_id FROM users WHERE id=$1', [memberId])).rows[0].parent_user_id, lead.id)
  assert.deepEqual((await call('GET', '/api/users', lead.token)).json().data.map((u: { id: string }) => u.id), [memberId], 'only their own')
  assert.equal((await call('GET', '/api/users', rival.token)).json().data.length, 0)
  assert.equal((await call('PATCH', `/api/users/${memberId}`, lead.token, { role: 'order_specialist' })).statusCode, 200)
  assert.equal((await call('PATCH', `/api/users/${memberId}`, lead.token, { role: 'admin' })).statusCode, 400)
  for (const [method, url, body] of [['PATCH', `/api/users/${memberId}`, { status: 'disabled' }], ['POST', `/api/users/${memberId}/password`, { password: 'Valid-pass-123' }], ['PATCH', `/api/users/${rival.id}`, { status: 'disabled' }], ['PATCH', `/api/users/${bossId}`, { displayName: '改名' }]] as const)
    assert.equal((await call(method, url, rival.token, body)).statusCode, 404, `a supervisor cannot reach other accounts: ${url}`)
  assert.equal((await call('POST', `/api/users/${memberId}/password`, lead.token, { password: 'Member-pass-34' })).statusCode, 200)
  assert.equal((await call('PATCH', `/api/users/${memberId}`, lead.token, { status: 'disabled' })).statusCode, 200)
  const all = (await call('GET', '/api/users', boss)).json()
  assert.equal(all.scope, 'all'); assert.equal(all.data.find((u: { id: string }) => u.id === memberId).parent_name, 'lead', 'the administrator sees who opened it')
  // Promoted out of the team by the administrator, the account is no longer the supervisor's to manage.
  assert.equal((await call('PATCH', `/api/users/${memberId}`, boss, { role: 'admin' })).statusCode, 200)
  assert.equal((await call('PATCH', `/api/users/${memberId}`, lead.token, { status: 'active' })).statusCode, 404)
  assert.equal((await call('GET', '/api/users', await tokenOf('rep@users.test', 'Member-pass-34').catch(() => 'disabled'))).statusCode, 401, 'disabled stays disabled')
  assert.equal((await call('GET', '/api/users', (await call('POST', '/api/users', boss, { email: 'plain@users.test', displayName: '普通', password: 'Plain-pass-123', role: 'viewer' }), await tokenOf('plain@users.test', 'Plain-pass-123')))).statusCode, 403, 'no account permission, no page')

  // Own password reset: the current session ends too.
  await pause(1100)
  assert.equal((await call('POST', `/api/users/${bossId}/password`, boss, { password: 'Boss-new-2026' })).json().self, true)
  assert.equal((await call('GET', '/api/users', boss)).statusCode, 401)
  await tokenOf('boss@users.test', 'Boss-new-2026')

  console.log(JSON.stringify({ listRoles: 'ok', createValidation: 'ok', adminScope: 'ok', roleChangeRevokes: 'ok', disable: 'ok', passwordReset: 'ok', guards: 'ok', isolation: 'ok', selfReset: 'ok', teamAccounts: 'ok' }))
} finally {
  for (const t of tenants) { await db.query('DELETE FROM audit_logs WHERE tenant_id=$1', [t.id]); await db.query('DELETE FROM tenants WHERE id=$1', [t.id]) }
  await app.close(); await db.end()
}
