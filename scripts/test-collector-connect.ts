import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildApp } from '../server/app.js'
import { db } from '../server/db.js'

// Connecting a collector by approval in the CRM, and the browser-extension package.
const app = await buildApp(), tenants: string[] = []
const base = '/api/product-collections'
const verifierPair = () => { const verifier = randomBytes(32).toString('base64url'); return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') } }
try {
  for (let i = 0; i < 2; i++) tenants.push((await db.query('INSERT INTO tenants(name,slug)VALUES($1,$2)RETURNING id', ['采集连接测试', `connect-${randomUUID().slice(0, 8)}`])).rows[0].id)
  const user = (await db.query("INSERT INTO users(tenant_id,email,display_name,status)VALUES($1,$2,'业务员甲','active')RETURNING id", [tenants[0], `${randomUUID()}@fixture.local`])).rows[0].id
  const token = (permissions: string[]) => app.jwt.sign({ sub: user, tenantId: tenants[0], email: 't', displayName: 't', roles: [], permissions })
  const approve = (challenge: string, permissions = ['collection:create']) => app.inject({ method: 'POST', url: `${base}/connect/approve`, headers: { authorization: `Bearer ${token(permissions)}` }, payload: { challenge } })
  const redeem = (verifier: string, client = 'extension') => app.inject({ method: 'POST', url: `${base}/connect/redeem`, payload: { verifier, client } })

  const { verifier, challenge } = verifierPair()
  assert.equal((await redeem(verifier)).statusCode, 202, 'waiting until approved')
  assert.equal((await approve(challenge, ['collection:read'])).statusCode, 403, 'only someone who may collect can approve')
  assert.equal((await app.inject({ method: 'POST', url: `${base}/connect/approve`, payload: { challenge } })).statusCode, 401)
  assert.equal((await approve('short')).statusCode, 400)
  assert.equal((await approve(challenge)).statusCode, 200)
  assert.equal((await approve(challenge)).statusCode, 409, 'a challenge is approved once')
  assert.equal((await redeem(verifierPair().verifier)).statusCode, 202, 'another verifier gets nothing')
  const granted = await redeem(verifier)
  assert.equal(granted.statusCode, 200, granted.body)
  const key = granted.json().data.key as string
  assert.match(key, /^crm1688_/); assert.equal(granted.json().data.user.displayName, '业务员甲')
  assert.equal((await redeem(verifier)).statusCode, 202, 'redeemed once only')
  assert.equal((await db.query('SELECT name FROM product_collector_keys WHERE user_id=$1', [user])).rows[0].name, '浏览器插件')
  const session = await app.inject({ method: 'GET', url: `${base}/session`, headers: { 'x-collector-key': key } })
  assert.equal(session.json().data.id, user, 'the key collects as the approving user')
  // An expired approval is worthless.
  const late = verifierPair()
  assert.equal((await approve(late.challenge)).statusCode, 200)
  await db.query("UPDATE product_collector_connects SET expires_at=now()-interval '1 second' WHERE challenge=$1", [late.challenge])
  assert.equal((await redeem(late.verifier)).statusCode, 202)

  // The extension package: manifest, background, bridge, and the userscript behind the shim.
  const zip = await app.inject({ method: 'GET', url: `${base}/collector-extension.zip` })
  assert.equal(zip.statusCode, 200); assert.equal(zip.headers['content-type'], 'application/zip')
  const dir = mkdtempSync(join(tmpdir(), 'collector-zip-'))
  try {
    writeFileSync(join(dir, 'x.zip'), zip.rawPayload)
    execFileSync('unzip', ['-q', '-o', join(dir, 'x.zip'), '-d', join(dir, 'out')])
    const manifest = JSON.parse(readFileSync(join(dir, 'out', 'manifest.json'), 'utf8'))
    assert.equal(manifest.manifest_version, 3)
    const collector = readFileSync(join(dir, 'out', 'collector.js'), 'utf8')
    assert.ok(collector.startsWith('// Page world'), 'the shim runs first'); assert.ok(collector.includes('connectByApproval'))
    for (const file of ['background.js', 'bridge.js', 'collector.js']) execFileSync(process.execPath, ['--check', join(dir, 'out', file)])
  } finally { rmSync(dir, { recursive: true, force: true }) }
  console.log(JSON.stringify({ pendingUntilApproved: 'ok', approvePermission: 'ok', singleUse: 'ok', expiry: 'ok', keyIdentity: 'ok', extensionZip: 'ok' }))
} finally {
  for (const id of tenants) { await db.query('DELETE FROM audit_logs WHERE tenant_id=$1', [id]); await db.query('DELETE FROM tenants WHERE id=$1', [id]) }
  await app.close(); await db.end()
}
