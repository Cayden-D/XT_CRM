import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import sharp from 'sharp'

// Image workshop against mocked DashScope (Qwen vision + Qwen image), APIMart (GPT-Image-2.5, async tasks) and OSS.
process.env.DASHSCOPE_API_KEY = 'workshop-fixture-key'
process.env.DASHSCOPE_BASE_URL = 'https://dashscope.fixture.invalid/compatible-mode/v1'
process.env.APIMART_API_KEY = 'apimart-fixture-key'
process.env.APIMART_BASE_URL = 'https://apimart.fixture.invalid/v1'
process.env.OSS_REGION = 'oss-cn-beijing'
process.env.OSS_BUCKET = 'workshop-fixture-bucket'
process.env.OSS_ACCESS_KEY_ID = 'workshop-fixture-id'
process.env.OSS_ACCESS_KEY_SECRET = 'workshop-fixture-secret'
process.env.OSS_CUSTOM_DOMAIN = 'https://images.example.com'
const { default: OSS } = await import('ali-oss')
const original = { put: OSS.prototype.put, get: OSS.prototype.get, delete: OSS.prototype.delete }
const objects = new Map<string, Buffer>()
;(OSS.prototype as any).put = async (key: string, bytes: Buffer, options: any) => { assert.equal(options.headers['x-oss-object-acl'], 'private'); objects.set(key, bytes); return {} }
;(OSS.prototype as any).get = async (key: string) => { assert.ok(objects.has(key), `missing object ${key}`); return { content: objects.get(key) } }
;(OSS.prototype as any).delete = async (key: string) => { objects.delete(key); return {} }

const [{ buildApp }, { db }, workshop, { saveConnection }] = await Promise.all([import('../server/app.js'), import('../server/db.js'), import('../server/integrations/image-workshop.js'), import('../server/integrations/1688.js')])
const app = await buildApp(), originalFetch = globalThis.fetch, tenants: string[] = []
const png = await sharp({ create: { width: 1024, height: 1024, channels: 4, background: '#d7e2dc' } }).png().toBuffer()
const jpeg = await sharp({ create: { width: 1200, height: 900, channels: 3, background: '#a0b5c0' } }).jpeg().toBuffer()
const qwenResult = 'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/edit-fixture.png?Expires=2099999999'
const calls = { vision: 0, visionImages: [] as string[], qwen: [] as any[], submit: [] as any[], polls: 0 }
const tasks = new Map<string, { polls: number; fail: boolean }>()
let failNextTask = false
let photoMode: 'ok' | 'reject' | 'network' = 'ok'
const photos: { album: string; type: string; size: number }[] = []
const reply = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
globalThis.fetch = async (input, init) => {
  const url = String(input)
  if (url === 'https://dashscope.fixture.invalid/compatible-mode/v1/chat/completions') {
    const body = JSON.parse(String(init?.body)), images = body.messages.at(-1).content.filter((c: any) => c.type === 'image_url').map((c: any) => c.image_url.url as string)
    calls.vision++; calls.visionImages.push(...images)
    const item = (u: string, index: number) => ({ index, readable: true, companyWatermark: { detected: u.includes('mark'), name: u.includes('mark') ? '某某贸易有限公司' : '', confidence: u.includes('mark') ? 0.99 : 0 }, famousBrandLogo: { detected: u.includes('logo'), name: u.includes('logo') ? 'Nike' : '', confidence: u.includes('logo') ? 0.99 : 0 } })
    return reply({ model: 'qwen3.8-flash', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ images: images.map(item) }) } }] })
  }
  if (url === 'https://dashscope.fixture.invalid/compatible-mode/v1/images/generations') { calls.qwen.push(JSON.parse(String(init?.body))); return reply({ data: [{ url: qwenResult }] }) }
  if (url === qwenResult || url.startsWith('https://upload.apimart.fixture/')) return new Response(png, { status: 200, headers: { 'content-type': 'image/png', 'content-length': String(png.length) } })
  if (url === 'https://apimart.fixture.invalid/v1/images/generations') {
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer apimart-fixture-key')
    const body = JSON.parse(String(init?.body)); calls.submit.push(body)
    const id = `task_${calls.submit.length}`; tasks.set(id, { polls: 0, fail: failNextTask }); failNextTask = false
    return reply({ code: 200, data: [{ status: 'submitted', task_id: id }] })
  }
  if (url.startsWith('https://apimart.fixture.invalid/v1/tasks/')) {
    calls.polls++
    const id = url.split('/').pop()!, task = tasks.get(id)!
    task.polls++
    if (task.fail) return reply({ code: 200, data: { id, status: 'failed', error: { message: '内容审核未通过' } } })
    if (task.polls < 2) return reply({ code: 200, data: { id, status: 'processing', progress: 40 } })
    return reply({ code: 200, data: { id, status: 'completed', progress: 100, cost: 0.01317, result: { images: [{ url: [`https://upload.apimart.fixture/f/image/${id}.png`], expires_at: 1789000000 }] } } })
  }
  if (url.startsWith('https://gw.open.1688.com/openapi/param2/1/com.alibaba.product/alibaba.photobank.photo.add/')) {
    const form = init?.body as FormData, file = form.get('imageBytes') as Blob
    if (photoMode === 'network') throw new TypeError('fetch failed')
    if (photoMode === 'reject') return reply({ error_code: 'ALBUM_NOT_EXIST', error_message: 'album not exist' })
    photos.push({ album: String(form.get('albumID')), type: file.type, size: file.size })
    return reply({ image: { id: `photo-${photos.length}`, url: `https://cbu01.alicdn.com/img/ibank/album-${photos.length}.jpg` } })
  }
  throw new Error(`unexpected request ${url}`)
}

const cdn = (name: string) => `https://cbu01.alicdn.com/img/ibank/${name}.jpg`
const drain = async () => { await db.query("UPDATE image_assets SET next_poll_at=now() WHERE status IN ('pending','processing')"); return workshop.runImageWorkerOnce() }
try {
  for (let i = 0; i < 2; i++) tenants.push((await db.query('INSERT INTO tenants(name,slug)VALUES($1,$2)RETURNING id', ['workshop fixture', `workshop-${randomUUID()}`])).rows[0].id)
  const tenant = tenants[0]
  const actor = (await db.query("INSERT INTO users(tenant_id,email,display_name,status)VALUES($1,$2,'图片测试','active')RETURNING id", [tenant, `${randomUUID()}@fixture.local`])).rows[0].id
  const token = (tenantId = tenant, permissions = ['*']) => app.jwt.sign({ sub: actor, tenantId, email: 't', displayName: 't', roles: [], permissions })
  const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, payload?: object, bearer = token()) => app.inject({ method, url: `/api/image-workshop${path}`, headers: { authorization: `Bearer ${bearer}` }, ...(payload ? { payload } : {}) })
  const product = async (gallery: string[], extra: Record<string, unknown> = {}) => (await db.query(`INSERT INTO collected_products(tenant_id,source,source_product_id,source_url,title,main_image_url,gallery_images,detail_images,attributes,collected_by)
    VALUES($1,'1688',$2,'https://detail.1688.com/offer/1.html','车载充气泵 便携式',$3,$4,$5,$6,$7) RETURNING id`, [tenant, randomUUID().slice(0, 12), gallery[0], JSON.stringify(gallery), JSON.stringify([cdn('detail-1'), cdn('detail-2')]), JSON.stringify({ 电压: '12V', 尺寸: '15×7×5cm', ...extra }), actor])).rows[0].id as string

  // Settings: off by default; turning the agent on needs explicit consent; stale revisions are rejected.
  const initial = (await call('GET', '/settings')).json()
  assert.deepEqual([initial.data.auto_replace, initial.data.revision, initial.services.apimart], [false, 0, true])
  assert.equal((await call('PUT', '/settings', { autoReplace: true, suiteModel: 'gpt-image-2.5-flare', suiteQuality: 'medium', revision: 0 })).statusCode, 400)
  assert.equal((await call('PUT', '/settings', { autoReplace: false, suiteModel: 'gpt-image-2.5-flare', suiteQuality: 'medium', revision: 0 }, token(tenant, ['collection:read']))).statusCode, 403)

  // Product pictures: main image first, deduplicated, at most six; nothing screened yet.
  const gallery = [cdn('main'), cdn('main'), cdn('side'), cdn('mark-1'), cdn('back'), cdn('logo-1'), cdn('top'), cdn('extra')]
  const p1 = await product(gallery)
  const images = (await call('GET', `/products/${p1}`)).json().data
  assert.deepEqual(images.gallery.map((g: any) => g.url), [cdn('main'), cdn('side'), cdn('mark-1'), cdn('back'), cdn('logo-1'), cdn('top')])
  assert.ok(images.gallery.every((g: any) => g.finding === null))
  assert.equal(images.details.length, 2)

  // Screening flags the watermark and the logo, caches results, and is not repeated for the same pictures.
  const screened = (await call('POST', `/products/${p1}/screen`, {})).json().data
  assert.deepEqual(screened.map((s: any) => [s.finding.watermark, s.finding.rightsRisk]), [[false, false], [false, false], [true, false], [false, false], [false, true], [false, false]])
  const visionCalls = calls.vision
  await call('POST', `/products/${p1}/screen`, {})
  assert.equal(calls.vision, visionCalls, 'cached screening results are reused')

  // Edits refuse flagged pictures, foreign hosts and prompts asking to remove marks.
  const refused = await call('POST', '/edits', { source: { url: cdn('mark-1') }, operation: 'white_bg' })
  assert.deepEqual([refused.statusCode, refused.json().error], [400, 'IMAGE_SOURCE_RISK'])
  assert.equal((await call('POST', '/edits', { source: { url: 'https://evil.example.com/a.jpg' }, operation: 'white_bg' })).statusCode, 400)
  const removal = await call('POST', '/edits', { source: { url: cdn('side') }, operation: 'background', scene: '去掉水印换成木桌' })
  assert.deepEqual([removal.statusCode, removal.json().error], [400, 'IMAGE_RIGHTS'])

  // 白底图: queued, then the worker sends the source picture to GPT-Image (the team's image model), stores the result
  // privately and screens it again. No Qwen image model is used any more.
  const edit = (await call('POST', '/edits', { source: { url: cdn('side') }, operation: 'white_bg', collectedProductId: p1, model: 'qwen-image-3.0' })).json().data
  assert.deepEqual([edit.status, edit.provider, edit.model, edit.url], ['pending', 'apimart', 'gpt-image-2.5-flare', null])
  for (let i = 0; i < 3; i++) await drain()
  const [editCall] = calls.submit
  assert.deepEqual([editCall.model, editCall.size, editCall.image_urls], ['gpt-image-2.5-flare', '1:1', [cdn('side')]], 'a model sent by the page is ignored')
  assert.match(editCall.prompt, /纯白色/)
  assert.equal(calls.qwen.length, 0)
  calls.submit.length = 0
  const done = (await call('GET', `/assets?ids=${edit.id}`)).json().data[0]
  assert.deepEqual([done.status, done.width, done.risky], ['completed', 1024, false])
  assert.ok(done.url.startsWith('https://images.example.com/'), 'signed link on the configured domain')
  assert.ok(objects.has(`image-workshop/${tenant}/${edit.id}.png`))
  assert.ok(calls.visionImages.some(u => u.startsWith('https://images.example.com/')), 'generated picture is screened again')

  // 改尺寸 from that result: done immediately, exact canvas.
  const resized = (await call('POST', '/edits', { source: { assetId: edit.id }, operation: 'resize', preset: '750x1000', fit: 'pad' })).json().data
  assert.deepEqual([resized.status, resized.width, resized.height], ['completed', 750, 1000])
  const meta = await sharp(objects.get(`image-workshop/${tenant}/${resized.id}.png`)!).metadata()
  assert.deepEqual([meta.width, meta.height], [750, 1000])
  const file = await call('GET', `/assets/${resized.id}/file`)
  assert.deepEqual([file.statusCode, file.headers['content-type']], [200, 'image/png'])

  // Uploads: decoded to PNG; garbage is refused.
  const upload = (await call('POST', '/uploads', { content: jpeg.toString('base64') })).json().data
  assert.deepEqual([upload.operation, upload.status, upload.width], ['upload', 'completed', 1200])
  assert.equal((await call('POST', '/uploads', { content: Buffer.from('not an image').toString('base64') })).statusCode, 400)

  // 电商套图: flagged references are refused; six tasks are submitted with the references, polled, stored and screened.
  assert.equal((await call('POST', '/suites', { collectedProductId: p1, references: [{ url: cdn('main') }, { url: cdn('logo-1') }] })).statusCode, 400)
  const suite = (await call('POST', '/suites', { collectedProductId: p1, points: '30 秒充满 / 数显胎压', references: [{ url: cdn('main') }, { assetId: upload.id }] })).json().data
  assert.equal(suite.assets.length, 6)
  await drain()
  assert.equal(calls.submit.length, 6)
  assert.deepEqual([calls.submit[0].model, calls.submit[0].quality, calls.submit[0].size, calls.submit[0].output_format, calls.submit[0].n], ['gpt-image-2.5-flare', 'medium', '1:1', 'png', 1])
  assert.equal(calls.submit[0].image_urls[0], cdn('main'))
  assert.ok(calls.submit[0].image_urls[1].startsWith('https://images.example.com/'), 'uploaded reference is sent as a signed link')
  const selling = calls.submit.find(s => s.prompt.includes('生成卖点图'))
  assert.match(selling.prompt, /30 秒充满/); assert.match(selling.prompt, /不得编造/)
  assert.match(calls.submit.find(s => s.prompt.includes('规格尺寸图')).prompt, /15×7×5cm/)
  await drain() // first poll: still processing
  assert.equal((await call('GET', `/assets?batchId=${suite.batchId}`)).json().data.filter((a: any) => a.status === 'processing').length, 6)
  await drain() // second poll: completed
  const suiteDone = (await call('GET', `/assets?batchId=${suite.batchId}`)).json().data
  assert.deepEqual([suiteDone.every((a: any) => a.status === 'completed'), Number(suiteDone[0].cost)], [true, 0.01317])

  // A failed task is reported and can be retried.
  failNextTask = true
  const one = (await call('POST', '/suites', { title: '手提收纳箱', references: [{ url: cdn('main') }], types: ['suite_white'] })).json().data.assets[0]
  await drain(); await drain()
  const failed = (await call('GET', `/assets?ids=${one.id}`)).json().data[0]
  assert.deepEqual([failed.status, failed.error], ['failed', '生成失败：内容审核未通过'])
  assert.equal((await call('POST', `/assets/${one.id}/retry`)).json().data.status, 'pending')
  await drain(); await drain(); await drain()
  assert.equal((await call('GET', `/assets?ids=${one.id}`)).json().data[0].status, 'completed')

  // Replacements: one new picture per flagged main picture, made only from the unflagged ones; not queued twice.
  const before = calls.submit.length
  const replaced = (await call('POST', `/products/${p1}/replace-flagged`, {})).json().data
  assert.deepEqual([replaced.flagged, replaced.queued, replaced.clean], [2, 2, 4])
  await drain()
  const subs = calls.submit.slice(before)
  assert.equal(subs.length, 2)
  assert.ok(subs.every(s => s.image_urls.every((u: string) => !u.includes('mark') && !u.includes('logo'))), 'flagged pictures are never sent as references')
  const slots = (await db.query('SELECT replaces_index,operation FROM image_assets WHERE collected_product_id=$1 AND replaces_index IS NOT NULL ORDER BY replaces_index', [p1])).rows
  assert.deepEqual(slots.map(r => [r.replaces_index, r.operation]), [[2, 'suite_detail'], [4, 'suite_selling']])
  assert.equal((await call('POST', `/products/${p1}/replace-flagged`, {})).json().data.queued, 0)
  const allBad = await product([cdn('mark-a'), cdn('logo-b')])
  assert.equal((await call('POST', `/products/${allBad}/replace-flagged`, {})).statusCode, 409)

  // Agent switch: products collected after it is turned on are screened once, and flagged slots get replacements.
  const old = await product([cdn('mark-old'), cdn('clean-old')])
  await db.query("UPDATE collected_products SET collected_at=now()-interval '1 hour' WHERE id=$1", [old])
  const on = (await call('PUT', '/settings', { autoReplace: true, suiteModel: 'gpt-image-2.5-sunburst', suiteQuality: 'low', revision: 0, confirmed: true })).json().data
  assert.deepEqual([on.auto_replace, on.revision], [true, 1])
  assert.equal((await call('PUT', '/settings', { autoReplace: true, suiteModel: 'gpt-image-2.5-flare', suiteQuality: 'low', revision: 0, confirmed: true })).statusCode, 409)
  const fresh = await product([cdn('clean-new'), cdn('mark-new')])
  while (await workshop.screenNextProduct()) { /* screen everything due */ }
  const agentRows = (await db.query('SELECT collected_product_id,trigger,model,options,replaces_index FROM image_assets WHERE collected_product_id=ANY($1::uuid[]) AND trigger=$2', [[old, fresh], 'agent'])).rows
  assert.deepEqual(agentRows.map(r => [r.collected_product_id, r.model, r.options.quality, r.replaces_index]), [[fresh, 'gpt-image-2.5-sunburst', 'low', 1]])
  assert.equal((await db.query('SELECT images_screened_at FROM collected_products WHERE id=$1', [old])).rows[0].images_screened_at, null, 'products collected before the switch are left alone')

  // 上传相册并替换主图: upload once (JPEG), replace the slot, keep the previous picture, sync the formal product, undo.
  const shop = await saveConnection(tenant, actor, { aliId: `workshop-${randomUUID()}`, access_token: 'fixture', expires_in: 36000 })
  const before1 = (await call('GET', `/products/${p1}`)).json().data.gallery.map((g: any) => g.url)
  const formal = (await db.query("INSERT INTO products(tenant_id,sku,name,base_price,base_currency,status,images) VALUES($1,$2,'正式产品',10,'CNY','active',$3) RETURNING id", [tenant, `ws-${randomUUID().slice(0, 8)}`, JSON.stringify(before1)])).rows[0].id
  await db.query('UPDATE collected_products SET product_id=$2 WHERE id=$1', [p1, formal])
  assert.equal((await call('POST', `/assets/${edit.id}/apply`, { connectionId: shop.id, albumId: '1001', placement: 'replace', index: 1, confirmed: true }, token(tenant, ['collection:create', 'collection:read']))).statusCode, 403, 'album writes need integration:publish')
  assert.equal((await call('POST', `/assets/${edit.id}/apply`, { connectionId: shop.id, placement: 'replace', index: 1, confirmed: true })).statusCode, 400, 'album id required for the first upload')
  const applied = (await call('POST', `/assets/${edit.id}/apply`, { connectionId: shop.id, albumId: '1001', placement: 'replace', index: 1, confirmed: true })).json().data
  assert.deepEqual(photos, [{ album: '1001', type: 'image/jpeg', size: photos[0]?.size }]); assert.ok(photos[0].size > 0 && photos[0].size <= 2 * 1024 * 1024)
  assert.deepEqual([applied.asset.photo_status, applied.asset.photo_url, applied.applied.index, applied.applied.previousUrl], ['uploaded', 'https://cbu01.alicdn.com/img/ibank/album-1.jpg', 1, before1[1]])
  const after1 = (await call('GET', `/products/${p1}`)).json().data.gallery
  assert.deepEqual(after1.map((g: any) => g.url), [before1[0], 'https://cbu01.alicdn.com/img/ibank/album-1.jpg', ...before1.slice(2)])
  assert.equal(after1[1].finding.watermark, false, 'the album copy carries the screening result')
  assert.deepEqual((await db.query('SELECT images FROM products WHERE id=$1', [formal])).rows[0].images, after1.map((g: any) => g.url), 'formal product follows')
  assert.equal((await db.query('SELECT album_id FROM integration_1688_album_settings WHERE connection_id=$1', [shop.id])).rows[0].album_id, '1001')
  assert.equal((await call('GET', '/albums')).json().data.find((a: any) => a.id === shop.id).album_id, '1001')
  // The same picture is not uploaded twice and cannot occupy two slots.
  assert.equal((await call('POST', `/assets/${edit.id}/apply`, { placement: 'replace', index: 2, confirmed: true })).statusCode, 409)
  assert.equal(photos.length, 1)
  // Undo restores the previous picture in both places.
  assert.equal((await call('POST', `/assets/${edit.id}/revert`)).json().data.applied_to, null)
  assert.deepEqual((await call('GET', `/products/${p1}`)).json().data.gallery.map((g: any) => g.url), before1)
  assert.deepEqual((await db.query('SELECT images FROM products WHERE id=$1', [formal])).rows[0].images, before1)
  // Re-applying reuses the earlier upload; append adds a slot.
  const appended = (await call('POST', `/assets/${edit.id}/apply`, { placement: 'append', confirmed: true })).json().data
  assert.deepEqual([appended.applied.index, appended.applied.previousUrl, photos.length], [7, null, 1])
  // Pictures that failed screening are never uploaded.
  const risky = suiteDone[0].id
  await db.query("UPDATE image_assets SET findings=$2 WHERE id=$1", [risky, JSON.stringify({ readable: true, watermark: true, rightsRisk: false, reason: '水印' })])
  assert.equal((await call('POST', `/assets/${risky}/apply`, { connectionId: shop.id, albumId: '1001', placement: 'replace', index: 0, confirmed: true })).statusCode, 409)
  // A platform rejection leaves the picture free to upload again; a network failure marks it unknown and blocks re-upload.
  const second = suiteDone[1].id
  photoMode = 'reject'
  assert.equal((await call('POST', `/assets/${second}/photo`, { connectionId: shop.id, albumId: '1001', confirmed: true })).json().error, 'ALBUM_NOT_EXIST')
  assert.equal((await db.query('SELECT photo_status FROM image_assets WHERE id=$1', [second])).rows[0].photo_status, null)
  photoMode = 'network'
  assert.equal((await call('POST', `/assets/${second}/photo`, { connectionId: shop.id, albumId: '1001', confirmed: true })).json().error, 'PHOTO_UPLOAD_UNKNOWN')
  photoMode = 'ok'
  assert.equal((await call('POST', `/assets/${second}/apply`, { connectionId: shop.id, albumId: '1001', placement: 'replace', index: 0, confirmed: true })).json().error, 'PHOTO_UPLOAD_UNKNOWN')
  assert.equal(photos.length, 1, 'no automatic re-upload after an unknown outcome')
  // A product blocked in the agent queue is reported so it can be re-queued after the swap.
  await db.query('UPDATE collected_products SET product_id=NULL WHERE id=$1', [p1])
  await db.query("INSERT INTO integration_1688_collection_queue_jobs(tenant_id,connection_id,collected_product_id,source_updated_at,status,message) VALUES($1,$2,$3,now(),'blocked','图片检查未通过')", [tenant, shop.id, p1])
  const third = (await call('POST', `/assets/${suiteDone[2].id}/apply`, { connectionId: shop.id, albumId: '1001', placement: 'replace', index: 0, confirmed: true })).json().data
  assert.deepEqual([third.queueJob.status, third.applied.index, photos.length], ['blocked', 0, 2])
  assert.equal((await db.query('SELECT main_image_url FROM collected_products WHERE id=$1', [p1])).rows[0].main_image_url, 'https://cbu01.alicdn.com/img/ibank/album-2.jpg', 'slot 0 is the main image')
  assert.equal((await call('POST', `/assets/${edit.id}/revert`, undefined, token(tenants[1]))).statusCode, 404)

  // Isolation and deletion.
  assert.equal((await call('GET', `/products/${p1}`, undefined, token(tenants[1]))).statusCode, 404)
  assert.equal((await call('GET', `/assets/${resized.id}/file`, undefined, token(tenants[1]))).statusCode, 404)
  assert.equal((await call('GET', '/assets', undefined, token(tenants[1]))).json().total, 0)
  assert.equal((await call('DELETE', `/assets/${resized.id}`)).statusCode, 200)
  assert.ok(!objects.has(`image-workshop/${tenant}/${resized.id}.png`))

  console.log(JSON.stringify({ settings: 'ok', productImages: 'ok', screeningCache: 'ok', rightsGuard: 'ok', gptImageEdit: 'ok', resize: 'ok', upload: 'ok', suite: 'ok', retry: 'ok', replacements: 'ok', agentSwitch: 'ok', albumApply: 'ok', undo: 'ok', uploadSafety: 'ok', isolation: 'ok' }))
} finally {
  globalThis.fetch = originalFetch
  Object.assign(OSS.prototype, original)
  for (const id of tenants) { await db.query('DELETE FROM audit_logs WHERE tenant_id=$1', [id]); await db.query('DELETE FROM tenants WHERE id=$1', [id]) }
  await app.close(); await db.end()
}
