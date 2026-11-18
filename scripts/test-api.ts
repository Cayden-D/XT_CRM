import assert from 'node:assert/strict'
import { buildApp } from '../server/app.js'
import { db } from '../server/db.js'
import { config } from '../server/config.js'
import { createTestAdmin, deleteTestAdmin, testAdminAuth } from './test-auth.js'


const app = await buildApp()
let testUserId = ''

try {
  const identity = await createTestAdmin('api')
  testUserId = identity.userId
  const health = await app.inject({ method: 'GET', url: '/api/health' })
  assert.equal(health.statusCode, 200)
  assert.equal(health.json().database, config.DB_NAME)

  const unauthorized = await app.inject({ method: 'GET', url: '/api/accounts' })
  assert.equal(unauthorized.statusCode, 401)

  const authorization = testAdminAuth(app, identity)

  const users = await app.inject({ method: 'GET', url: '/api/users/assignable', headers: { authorization } })
  assert.equal(users.statusCode, 200, users.body)
  assert.ok(users.json().data.length >= 1)

  // Leads, opportunities and quotes were retired on 2026-10-14; their endpoints are gone.
  for (const url of ['/api/leads', '/api/opportunities', '/api/quotes']) {
    assert.equal((await app.inject({ method: 'GET', url, headers: { authorization } })).statusCode, 404, url)
  }
  console.log(JSON.stringify({ health: 'ok', auth: 'ok', assignment: 'ok', retiredModules: 'ok' }))
} finally {
  await deleteTestAdmin(testUserId)
  await app.close()
  await db.end()
}
