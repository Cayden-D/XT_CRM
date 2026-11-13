import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import sharp from 'sharp'

// The shop's own brands and how they reach generated pictures. Models, OSS and the 1688 CDN are mocked.
process.env.DASHSCOPE_API_KEY = 'brand-fixture-key'
process.env.DASHSCOPE_BASE_URL = 'https://dashscope.fixture.invalid/compatible-mode/v1'
process.env.APIMART_API_KEY = 'brand-apimart-key'
process.env.APIMART_BASE_URL = 'https://apimart.fixture.invalid/v1'
process.env.OSS_REGION = 'oss-cn-beijing'
process.env.OSS_BUCKET = 'brand-fixture-bucket'
process.env.OSS_ACCESS_KEY_ID = 'brand-fixture-id'
process.env.OSS_ACCESS_KEY_SECRET = 'brand-fixture-secret'
process.env.OSS_CUSTOM_DOMAIN = 'https://images.example.com'
const { default: OSS } = await import('ali-oss')
const originalOss = { put: OSS.prototype.put, get: OSS.prototype.get, delete: OSS.prototype.delete }
const objects = new Map<string, Buffer>()
;(OSS.prototype as any).put = async (key: string, bytes: Buffer) => { objects.set(key, bytes); return {} }
;(OSS.prototype as any).get = async (key: string) => { assert.ok(objects.has(key), `missing object ${key}`); return { content: objects.get(key) } }
;(OSS.prototype as any).delete = async (key: string) => { objects.delete(key); return {} }

const [{ buildApp }, { db }, workshop, { sameBrand, inspectPublishingImages }, { fillRequiredAttributes, attributeFacts }] = await Promise.all([import('../server/app.js'), import('../server/db.js'), import('../server/integrations/image-workshop.js'), import('../server/integrations/1688-agent.js'), import('../server/integrations/1688-attribute-fill.js')])
const app = await buildApp(), originalFetch = globalThis.fetch, tenants: string[] = []
const generated = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: '#203040' } }).png().toBuffer()
const logo = await sharp({ create: { width: 400, height: 200, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } } }).png().toBuffer()
const svgLogo = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><rect width="400" height="200" fill="red"/></svg>')
const tinyLogo = await sharp({ create: { width: 40, height: 40, channels: 3, background: '#ff0000' } }).png().toBuffer()
const b64 = (bytes: Buffer) => bytes.toString('base64')

let seen: { company?: string; brand?: string } = {}
const submits: any[] = []
const reply = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } })
globalThis.fetch = async (input, init) => {
  const url = String(input)
  if (url.endsWith('/compatible-mode/v1/chat/completions')) {
    const body = JSON.parse(String(init?.body)), images = body.messages.at(-1).content.filter((c: any) => c.type === 'image_url')
    return reply({ model: 'qwen3.8-flash', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ images: images.map((_: unknown, index: number) => ({ index, readable: true, companyWatermark: { detected: Boolean(seen.company), name: seen.company ?? '', confidence: seen.company ? 0.99 : 0 }, famousBrandLogo: { detected: Boolean(seen.brand), name: seen.brand ?? '', confidence: seen.brand ? 0.99 : 0 } })) }) } }] })
  }
  if (url === 'https://apimart.fixture.invalid/v1/images/generations') { submits.push(JSON.parse(String(init?.body))); return reply({ code: 200, data: [{ status: 'submitted', task_id: `task_${submits.length}` }] }) }
  if (url.startsWith('https://apimart.fixture.invalid/v1/tasks/')) return reply({ code: 200, data: { id: url.split('/').pop(), status: 'completed', progress: 100, cost: 0.01, result: { images: [{ url: ['https://upload.apimart.fixture/f/image/x.png'], expires_at: 1789000000 }] } } })
  if (url.startsWith('https://upload.apimart.fixture/')) return new Response(generated, { status: 200, headers: { 'content-type': 'image/png', 'content-length': String(generated.length) } })
  throw new Error(`unexpected request ${url}`)
}

const cdn = (name: string) => `https://cbu01.alicdn.com/img/ibank/${name}.jpg`
const drain = async () => { await db.query("UPDATE image_assets SET next_poll_at=now() WHERE status IN ('pending','processing')"); return workshop.runImageWorkerOnce() }
try {
  for (let i = 0; i < 2; i++) tenants.push((await db.query('INSERT INTO tenants(name,slug)VALUES($1,$2)RETURNING id', ['品牌测试', `brand-${randomUUID()}`])).rows[0].id)
  const tenant = tenants[0]
  const actor = (await db.query("INSERT INTO users(tenant_id,email,display_name,status)VALUES($1,$2,'品牌测试','active')RETURNING id", [tenant, `${randomUUID()}@fixture.local`])).rows[0].id
  const token = (tenantId = tenant, permissions = ['*']) => app.jwt.sign({ sub: actor, tenantId, email: 't', displayName: 't', roles: [], permissions })
  const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, payload?: object, bearer = token()) => app.inject({ method, url: `/api/image-workshop${path}`, headers: { authorization: `Bearer ${bearer}` }, ...(payload ? { payload } : {}) })
  const create = (body: object, bearer?: string) => call('POST', '/brands', { rightsConfirmed: true, ...body }, bearer)
  const objectCount = () => objects.size

  // Who may do what, and what counts as a logo.
  assert.equal((await create({ name: '拓洋' }, token(tenant, ['collection:create']))).statusCode, 403)
  assert.equal((await call('POST', '/brands', { name: '拓洋' })).statusCode, 400, 'ownership must be stated')
  assert.equal((await create({ name: '拓洋', logoContent: b64(svgLogo) })).statusCode, 400, 'vector files are not accepted')
  assert.equal((await create({ name: '拓洋', logoContent: b64(tinyLogo) })).statusCode, 400)
  assert.equal(objectCount(), 0)

  // A logo plainly another brand's is refused and not kept.
  seen = { brand: 'Nike' }
  const stolen = await create({ name: '拓洋', logoContent: b64(logo) })
  assert.equal(stolen.statusCode, 400); assert.match(stolen.json().message, /Nike/); assert.equal(objectCount(), 0)

  // Its own name read off the logo is fine.
  seen = { brand: 'TUOYANG' }
  const created = await create({ name: '拓洋', aliases: ['TuoYang'], logoContent: b64(logo) })
  assert.equal(created.statusCode, 200, created.body)
  const brand = created.json().data
  assert.deepEqual([brand.is_default, brand.logo_width, brand.logo_height, Boolean(brand.logo_url), brand.logo_key], [true, 400, 200, true, undefined], 'the first brand becomes the default; storage keys stay private')
  seen = {}
  assert.equal((await create({ name: '拓洋' })).statusCode, 409, 'one name once')
  const second = (await create({ name: '第二品牌' })).json().data
  assert.equal(second.is_default, false)
  assert.equal((await call('GET', '/brands', undefined, token(tenants[1]))).json().data.length, 0, 'another tenant sees nothing')
  assert.equal((await call('PATCH', `/brands/${brand.id}`, { name: '偷改' }, token(tenants[1]))).statusCode, 404)
  assert.equal((await call('PATCH', `/brands/${brand.id}`, { name: '新名字' })).statusCode, 400, 'renaming needs the statement again')

  // Own names are recognised; a different brand is still flagged.
  assert.equal(sameBrand('TUOYANG 官方', ['拓洋', 'TuoYang']), true)
  assert.equal(sameBrand('Nike', ['拓洋', 'TuoYang']), false)
  assert.equal(sameBrand('A', ['A']), false, 'single letters match nothing')
  seen = { brand: 'TuoYang' }
  assert.equal((await inspectPublishingImages([cdn('own')], ['拓洋', 'TuoYang']))[0].rightsRisk, false)
  seen = { brand: 'Nike', company: '某某贸易有限公司' }
  const other = (await inspectPublishingImages([cdn('other')], ['拓洋', 'TuoYang']))[0]
  assert.deepEqual([other.rightsRisk, other.watermark], [true, true])
  seen = {}

  // Suites: the default brand unless told otherwise.
  const product = (await db.query(`INSERT INTO collected_products(tenant_id,source,source_product_id,source_url,title,main_image_url,gallery_images,detail_images,attributes,collected_by)
    VALUES($1,'1688',$2,'https://detail.1688.com/offer/1.html','车载充气泵',$3,$4,'[]',$5,$6) RETURNING id`, [tenant, randomUUID().slice(0, 12), cdn('main'), JSON.stringify([cdn('main'), cdn('side')]), JSON.stringify({ 品牌: 'HENS/衡成', 电压: '12V' }), actor])).rows[0].id as string
  const suite = (body: object = {}) => call('POST', '/suites', { collectedProductId: product, references: [{ url: cdn('main') }], types: ['suite_white', 'suite_scene', 'suite_selling'], ...body })
  const made = await suite()
  assert.equal(made.statusCode, 200, made.body)
  const rows = async (batch: string) => Object.fromEntries((await db.query('SELECT operation,prompt,options,oss_key,status,findings FROM image_assets WHERE batch_id=$1', [batch])).rows.map(r => [r.operation, r]))
  const batch = made.json().data.batchId
  let assets = await rows(batch)
  assert.deepEqual([assets.suite_white.options.brand.logo, assets.suite_scene.options.brand.logo, assets.suite_selling.options.brand.logo], [false, true, true], 'the white main picture stays clean')
  assert.ok(assets.suite_scene.prompt.includes('左上角'), 'space is kept for the logo'); assert.ok(!assets.suite_white.prompt.includes('左上角'))
  assert.ok(assets.suite_selling.prompt.includes('品牌：拓洋')); assert.ok(!assets.suite_selling.prompt.includes('衡成'), 'the source seller’s brand is gone')

  // Generated with the mark from the model's reading included: the logo is there, exactly, and the picture is not flagged.
  seen = { brand: 'TUOYANG' }
  await drain(); await drain()
  seen = {}
  assets = await rows(batch)
  assert.deepEqual(['suite_white', 'suite_scene', 'suite_selling'].map(t => assets[t].status), ['completed', 'completed', 'completed'])
  assert.equal(assets.suite_scene.findings.rightsRisk, false, 'its own logo is not a risk')
  const pixel = async (key: string, x: number, y: number) => [...(await sharp(objects.get(key)!).extract({ left: x, top: y, width: 1, height: 1 }).removeAlpha().raw().toBuffer())]
  const logoAt = Math.round(1024 * 0.03 + 1024 * 0.012) + 10
  assert.deepEqual(await pixel(assets.suite_scene.oss_key, logoAt, logoAt), [255, 0, 0], 'logo in the corner, colours untouched')
  assert.deepEqual(await pixel(assets.suite_scene.oss_key, 900, 900), [32, 48, 64], 'the rest of the picture is unchanged')
  assert.deepEqual(await pixel(assets.suite_white.oss_key, logoAt, logoAt), [32, 48, 64], 'no logo on the white main picture')

  const none = (await suite({ brandId: null })).json().data.batchId
  const plain = await rows(none)
  assert.equal(plain.suite_scene.options.brand, undefined); assert.ok(plain.suite_selling.prompt.includes('衡成'), 'without a brand nothing changes')
  const textOnly = await rows((await suite({ brandId: second.id })).json().data.batchId)
  assert.equal(textOnly.suite_scene.options.brand.logo, false)
  assert.ok(textOnly.suite_selling.prompt.includes('品牌名“第二品牌”'), 'no logo: the name is written where text belongs'); assert.ok(!textOnly.suite_scene.prompt.includes('品牌名“'))
  assert.equal((await suite({ brandId: randomUUID() })).statusCode, 404)

  // While pictures wait for a logo it cannot be taken away; deleted afterwards, a retry says so before paying.
  assert.equal((await call('DELETE', `/brands/${second.id}`)).statusCode, 200, 'no logo work is waiting on the second brand once none uses it')
  await drain()
  const pending = (await suite()).json().data.batchId
  assert.equal((await call('DELETE', `/brands/${brand.id}`)).statusCode, 409)
  await drain(); await drain()
  const keyBefore = (await db.query('SELECT logo_key FROM brands WHERE id=$1', [brand.id])).rows[0].logo_key
  assert.ok(objects.has(keyBefore))
  const before = submits.length
  await db.query("UPDATE image_assets SET status='pending',task_id=NULL,oss_key=NULL,next_poll_at=now() WHERE batch_id=$1 AND operation='suite_scene'", [pending])
  await db.query("UPDATE image_assets SET status='completed' WHERE tenant_id=$1 AND status IN ('pending','processing') AND batch_id<>$2", [tenant, pending])
  await db.query('UPDATE image_assets SET options=jsonb_set(options,\'{brand,id}\',to_jsonb($2::text)) WHERE batch_id=$1 AND operation=\'suite_scene\'', [pending, randomUUID()])
  await drain()
  const failed = (await rows(pending)).suite_scene
  assert.equal(failed.status, 'failed'); assert.equal(submits.length, before, 'nothing was paid for')

  // Changing the logo replaces the file; removing the brand removes it.
  const updated = await call('PATCH', `/brands/${brand.id}`, { logoContent: b64(logo), rightsConfirmed: true })
  assert.equal(updated.statusCode, 200, updated.body); assert.equal(objects.has(keyBefore), false)
  const newKey = (await db.query('SELECT logo_key FROM brands WHERE id=$1', [brand.id])).rows[0].logo_key
  const third = (await create({ name: '第三品牌', isDefault: true })).json().data
  assert.equal(third.is_default, true)
  assert.equal((await db.query('SELECT count(*)::int AS n FROM brands WHERE tenant_id=$1 AND is_default', [tenant])).rows[0].n, 1, 'one default at a time')
  assert.equal((await call('PATCH', `/brands/${brand.id}`, { isDefault: true })).json().data.is_default, true)
  assert.equal((await call('DELETE', `/brands/${brand.id}`)).statusCode, 200); assert.equal(objects.has(newKey), false)

  // The listing's brand attribute.
  const schema = (brandField: object) => ({ data: { catProp: { fields: { dataSource: [{ name: 'b', label: '品牌', ...brandField }] } } } })
  const facts = attributeFacts({ name: '车载香薰', specifications: {} }, [], null, '拓洋')
  const fill = async (field: object, f = facts) => (await fillRequiredAttributes(schema(field) as any, { catProp: {} }, f, [])).values.catProp.b
  assert.equal(await fill({ required: true, uiType: 'input' }), '拓洋')
  assert.equal(await fill({ required: false, uiType: 'input' }), '拓洋', 'filled even where optional')
  assert.deepEqual(await fill({ required: true, uiType: 'select', dataSource: [{ value: 7, text: '拓洋' }, { value: 8, text: '其他' }] }), { value: 7, text: '拓洋' })
  assert.deepEqual(await fill({ required: true, uiType: 'select', customizable: true, dataSource: [{ value: 8, text: '其他' }] }), { value: -1, text: '拓洋', custom: true })
  assert.deepEqual(await fill({ required: true, uiType: 'select', dataSource: [{ value: 8, text: '其他' }] }), { value: 8, text: '其他' }, 'a closed list without it falls back')
  assert.equal(await fill({ required: false, uiType: 'input' }, attributeFacts({ name: '车载香薰', specifications: {} }, [], null)), undefined, 'no brand of its own: optional stays empty')
  // On a large picture the logo and its plate stay within 200×200 px in the top-left corner (1688 首图 rule).
  const big = await sharp({ create: { width: 2048, height: 2048, channels: 3, background: '#000000' } }).png().toBuffer()
  const marked = await sharp(await workshop.applyLogo(big, logo)).raw().toBuffer({ resolveWithObject: true })
  const lit = (x: number, y: number) => marked.data[(y * marked.info.width + x) * marked.info.channels] > 40
  let right = 0, bottom = 0
  for (let y = 0; y < 400; y++) for (let x = 0; x < 400; x++) if (lit(x, y)) { right = Math.max(right, x); bottom = Math.max(bottom, y) }
  const margin = Math.round(2048 * 0.03)
  assert.ok(right > margin && right - margin < 200 && bottom - margin < 200, `logo area ${right - margin}×${bottom - margin}`)
  console.log(JSON.stringify({ logoWithin200: 'ok', permissions: 'ok', rightsStatement: 'ok', rasterOnly: 'ok', foreignLogoRefused: 'ok', ownNameRecognised: 'ok', defaultBrand: 'ok', tenantIsolation: 'ok', sourceBrandRemoved: 'ok', logoExact: 'ok', whiteStaysClean: 'ok', textOnlyBrand: 'ok', deleteGuard: 'ok', noPayWithoutLogo: 'ok', attributeBrand: 'ok', liveModelCalls: 0 }))
} finally {
  globalThis.fetch = originalFetch
  Object.assign(OSS.prototype, originalOss)
  for (const id of tenants) { await db.query('DELETE FROM audit_logs WHERE tenant_id=$1', [id]); await db.query('DELETE FROM tenants WHERE id=$1', [id]) }
  await app.close(); await db.end()
}
