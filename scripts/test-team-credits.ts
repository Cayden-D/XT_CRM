import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

// Teams (a top-level account with its sub-accounts): models and credits set by the super administrator, credits taken
// when a collected product is listed and given back when the platform refuses it. Every external service is mocked.
process.env.DASHSCOPE_API_KEY = 'team-credits-key'
process.env.DASHSCOPE_BASE_URL = 'https://dashscope.fixture.invalid/compatible-mode/v1'
process.env.APIMART_API_KEY = 'team-credits-apimart'
process.env.APIMART_BASE_URL = 'https://apimart.fixture.invalid/v1'
process.env.APIMART_POLL_MS = '0'
const [{ buildApp }, { db }, teams, qwen, apimart] = await Promise.all([import('../server/app.js'), import('../server/db.js'), import('../server/integrations/teams.js'), import('../server/llm/qwen.js'), import('../server/llm/apimart-image.js')])

const sent: { url: string; body: any }[] = []
const originalFetch = globalThis.fetch
globalThis.fetch = async (input, init) => {
  const url = String(input), body = init?.body ? JSON.parse(String(init.body)) : null
  sent.push({ url, body })
  const reply = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } })
  if (url.endsWith('/chat/completions')) return reply({ model: body.model, choices: [{ finish_reason: 'stop', message: { content: 'OK' } }] })
  if (url.endsWith('/images/generations')) return reply({ code: 200, data: [{ status: 'submitted', task_id: 'task_team_1' }] })
  if (url.includes('/tasks/')) return reply({ code: 200, data: { status: 'completed', result: { images: [{ url: ['https://upload.apimart.fixture/f/image/x.png'] }] } } })
  throw new Error(`unexpected request ${url}`)
}

const app = await buildApp()
const tenant = (await db.query('INSERT INTO tenants(name,slug)VALUES($1,$2)RETURNING id', ['团队额度测试', `teams-${randomUUID().slice(0, 8)}`])).rows[0].id as string
try {
  const user = async (name: string, role: string | null, parent: string | null = null) => {
    const id = (await db.query("INSERT INTO users(tenant_id,email,display_name,status,parent_user_id)VALUES($1,$2,$3,'active',$4)RETURNING id", [tenant, `${randomUUID()}@fixture.local`, name, parent])).rows[0].id as string
    if (role) {
      const roleId = (await db.query(`INSERT INTO roles(tenant_id,code,name,permissions) VALUES($1,$2,$2,'["*"]') ON CONFLICT(tenant_id,code) DO UPDATE SET name=excluded.name RETURNING id`, [tenant, role])).rows[0].id
      await db.query('INSERT INTO user_roles(user_id,role_id) VALUES($1,$2)', [id, roleId])
    }
    return id
  }
  const owner = await user('超管', 'super_admin'), manager = await user('主管甲', 'sales_manager'), rep = await user('业务员甲', 'sales_rep', manager)
  const token = (sub: string, permissions: string[]) => app.jwt.sign({ sub, tenantId: tenant, email: 't', displayName: 't', roles: [], permissions })
  const call = (method: 'GET' | 'PATCH', url: string, sub: string, permissions: string[], payload?: object) => app.inject({ method, url, headers: { authorization: `Bearer ${token(sub, permissions)}` }, payload })

  // A sub-account belongs to the team of the account that opened it; a new team has no credits and the default models.
  const repTeam = await teams.teamOf(tenant, rep)
  assert.deepEqual([repTeam.ownerId, repTeam.unlimited, repTeam.credits, repTeam.imageModel], [manager, false, 0, 'gpt-image-2.5-flare'])
  assert.equal((await teams.teamOf(tenant, owner)).unlimited, true, 'the super administrator is not limited')

  // Only the super administrator sees and changes teams.
  assert.equal((await call('GET', '/api/users/teams', manager, ['user:manage_team'])).statusCode, 403)
  const listed = await call('GET', '/api/users/teams', owner, ['*'])
  assert.equal(listed.statusCode, 200, listed.body)
  assert.deepEqual(listed.json().data.map((t: { name: string }) => t.name).sort(), ['主管甲', '超管'].sort(), 'sub-accounts are members, not teams')
  assert.deepEqual(listed.json().imageModels.map((m: { id: string }) => m.id), ['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst', 'gpt-image-2'])
  assert.equal(listed.json().data.find((t: { name: string }) => t.name === '主管甲').members, 1)
  const changed = await call('PATCH', `/api/users/teams/${manager}`, owner, ['*'], { textModel: 'qwen3.7-plus', imageModel: 'gpt-image-2', delta: 25, note: '首充' })
  assert.equal(changed.statusCode, 200, changed.body)
  assert.deepEqual([changed.json().data.credits, changed.json().data.textModel, changed.json().data.imageModel], [25, 'qwen3.7-plus', 'gpt-image-2'])
  assert.equal((await call('PATCH', `/api/users/teams/${manager}`, owner, ['*'], { delta: -30 })).statusCode, 400, 'never below zero')
  assert.equal((await call('PATCH', `/api/users/teams/${rep}`, owner, ['*'], { delta: 5 })).statusCode, 404, 'a sub-account is not a team')
  assert.equal((await call('PATCH', `/api/users/teams/${manager}`, owner, ['*'], { textModel: 'gpt-4' })).statusCode, 400)
  const own = await call('GET', '/api/users/team', rep, [])
  assert.deepEqual(own.json().data, { name: '主管甲', unlimited: false, credits: 25, perListing: 10 }, 'members see their team credits')

  // The team's text model is used for its work; calls with an explicit model keep it.
  sent.length = 0
  await qwen.withTextModel((await teams.teamOf(tenant, rep)).textModel, () => qwen.generateQwenText({ messages: [{ role: 'user', content: 'hi' }] }))
  await qwen.generateQwenText({ messages: [{ role: 'user', content: 'hi' }] })
  assert.deepEqual(sent.map(s => s.body.model), ['qwen3.7-plus', 'qwen3.8-flash'])

  // GPT-Image-2 is called without quality/output format; GPT-Image-2.5 keeps them.
  sent.length = 0
  await apimart.generateAndWait({ model: 'gpt-image-2', prompt: '白底图', imageUrls: ['https://cbu01.alicdn.com/img/ibank/a.jpg'] })
  await apimart.submitImageTask({ model: 'gpt-image-2.5-flare', prompt: '白底图', imageUrls: [], size: '1:1', resolution: '1k', quality: 'medium' })
  const [v2, v25] = sent.filter(s => s.url.endsWith('/images/generations')).map(s => s.body)
  assert.deepEqual([v2.model, v2.quality, v2.output_format, v2.image_urls.length], ['gpt-image-2', undefined, undefined, 1])
  assert.deepEqual([v25.quality, v25.output_format], ['medium', 'png'])

  // Credits for listing a collected product: taken in the claim transaction, refused when short, given back on refusal.
  const product = async (collected: boolean) => {
    const id = (await db.query("INSERT INTO products(tenant_id,sku,name,base_price,base_currency,status)VALUES($1,$2,'测试产品',10,'CNY','active')RETURNING id", [tenant, `T-${randomUUID().slice(0, 8)}`])).rows[0].id as string
    if (collected) await db.query("INSERT INTO collected_products(tenant_id,source,source_product_id,source_url,title,currency,product_id,collected_by)VALUES($1,'1688',$2,'https://detail.1688.com/offer/1.html','测试','CNY',$3,$4)", [tenant, randomUUID(), id, rep])
    return id
  }
  const charge = async (sub: string, productId: string) => {
    const client = await db.connect()
    try { await client.query('BEGIN'); const team = await teams.chargeListing(client, tenant, sub, productId, randomUUID()); await client.query('COMMIT'); return team }
    catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  }
  const collected = await product(true)
  assert.equal(await charge(rep, collected), manager)
  assert.equal(await charge(rep, collected), manager)
  assert.equal((await teams.teamOf(tenant, rep)).credits, 5)
  await assert.rejects(teams.requireListingCredits(tenant, rep), /团队积分不足.*每件需 10 积分，当前剩余 5/, 'checked before any paid work')
  await assert.rejects(charge(rep, collected), (e: any) => e.code === 'CREDITS_INSUFFICIENT')
  assert.equal((await teams.teamOf(tenant, rep)).credits, 5, 'a refused charge takes nothing')
  assert.equal(await charge(rep, await product(false)), null, 'a product added by hand costs nothing')
  assert.equal(await charge(owner, collected), null, 'the super administrator is not charged')
  await teams.refundListing(tenant, manager, rep, randomUUID())
  assert.equal((await teams.teamOf(tenant, rep)).credits, 15)
  assert.deepEqual((await db.query('SELECT reason,delta,balance_after FROM team_credit_ledger WHERE owner_user_id=$1 ORDER BY created_at', [manager])).rows.map(r => [r.reason, r.delta, r.balance_after]),
    [['adjust', 25, 25], ['publish', -10, 15], ['publish', -10, 5], ['refund', 10, 15]])

  console.log(JSON.stringify({ teamOfSubAccount: 'ok', superAdminOnly: 'ok', modelsAndCredits: 'ok', teamTextModel: 'ok', gptImage2: 'ok', listingCharge: 'ok', shortageBlocks: 'ok', refund: 'ok' }))
} finally {
  globalThis.fetch = originalFetch
  await db.query('DELETE FROM audit_logs WHERE tenant_id=$1', [tenant]); await db.query('DELETE FROM tenants WHERE id=$1', [tenant])
  await app.close(); await db.end()
}
