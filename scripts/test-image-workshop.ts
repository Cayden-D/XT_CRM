import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import sharp from 'sharp'
import { applyCustomHeroFrame, prepareCustomHeroFrame } from '../server/integrations/hero-reference-frame.js'

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
const original = { put: OSS.prototype.put, get: OSS.prototype.get, delete: OSS.prototype.delete, multipartUpload: OSS.prototype.multipartUpload }
const multipart: { key: string; size: number; options: any }[] = []
const objects = new Map<string, Buffer>()
;(OSS.prototype as any).put = async (key: string, bytes: Buffer, options: any) => { assert.equal(options.headers['x-oss-object-acl'], 'private'); objects.set(key, bytes); return {} }
;(OSS.prototype as any).get = async (key: string) => { assert.ok(objects.has(key), `missing object ${key}`); return { content: objects.get(key) } }
;(OSS.prototype as any).delete = async (key: string) => { objects.delete(key); return {} }
// Large pictures go up in parts (512 KB each), as Alibaba's OSS guide advises against connection timeouts.
;(OSS.prototype as any).multipartUpload = async (key: string, bytes: Buffer, options: any) => { multipart.push({ key, size: bytes.length, options }); objects.set(key, bytes); return {} }

const [{ buildApp }, { db }, workshop, { saveConnection }] = await Promise.all([import('../server/app.js'), import('../server/db.js'), import('../server/integrations/image-workshop.js'), import('../server/integrations/1688.js')])
const app = await buildApp(), originalFetch = globalThis.fetch, tenants: string[] = []
const png = await sharp({ create: { width: 1024, height: 1024, channels: 4, background: '#d7e2dc' } }).png().toBuffer()
const jpeg = await sharp({ create: { width: 1200, height: 900, channels: 3, background: '#a0b5c0' } }).jpeg().toBuffer()
const qwenResult = 'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/edit-fixture.png?Expires=2099999999'
const calls = { vision: 0, visionImages: [] as string[], qwen: [] as any[], submit: [] as any[], polls: 0 }
const tasks = new Map<string, { polls: number; fail: boolean }>()
let frameToScreen = ''
let copyInputs: string[] = []
let failNextTask = false
let photoMode: 'ok' | 'reject' | 'network' = 'ok'
const photos: { album: string; type: string; size: number }[] = []
const reply = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
globalThis.fetch = async (input, init) => {
  const url = String(input)
  if (url === 'https://dashscope.fixture.invalid/compatible-mode/v1/chat/completions') {
    const body = JSON.parse(String(init?.body))
    if (String(body.messages[0].content).includes('首图文案')) {
      const content = body.messages.at(-1).content as string
      copyInputs.push(content)
      if (content.includes('安全锤')) return reply({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
        headline: '安全锤', subline: '闪恩新品', features: ['23元', 'C07', '东莞产地', '闪恩精选', '割安全带', '塑料材质'],
      }) } }] })
      return reply({ choices: [{ finish_reason: 'stop', message: { content: '{}' } }] })
    }
    const images: string[] = body.messages.at(-1).content.filter((c: any) => c.type === 'image_url').map((c: any) => c.image_url.url)
    calls.vision++; calls.visionImages.push(...images)
    const item = (u: string, index: number) => ({ index, readable: true, companyWatermark: { detected: u.includes('mark'), name: u.includes('mark') ? '某某贸易有限公司' : '', confidence: u.includes('mark') ? 0.99 : 0 }, famousBrandLogo: { detected: u.includes('logo'), name: u.includes('logo') ? 'Nike' : '', confidence: u.includes('logo') ? 0.99 : 0 } })
    const findings = images.map((u, index) => frameToScreen && u.includes(frameToScreen) ? {
      index, readable: true,
      companyWatermark: { detected: true, name: '义乌拓洋', confidence: 0.99 },
      famousBrandLogo: { detected: true, name: '超级工厂', confidence: 0.99 },
    } : item(u, index))
    return reply({ model: 'qwen3.8-flash', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ images: findings }) } }] })
  }
  if (url === 'https://dashscope.fixture.invalid/compatible-mode/v1/images/generations') { calls.qwen.push(JSON.parse(String(init?.body))); return reply({ data: [{ url: qwenResult }] }) }
  // The first result link answers with a redirect to its CDN copy, as some result hosts do.
  if (url === 'https://upload.apimart.fixture/f/image/task_1.png') return new Response(null, { status: 302, headers: { location: 'https://cdn.apimart.fixture/f/image/task_1.png' } })
  if (url === qwenResult || url.startsWith('https://upload.apimart.fixture/') || url.startsWith('https://cdn.apimart.fixture/')) return new Response(png, { status: 200, headers: { 'content-type': 'image/png', 'content-length': String(png.length) } })
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
  const token = (tenantId = tenant, permissions = ['*'], roles: string[] = []) => app.jwt.sign({ sub: actor, tenantId, email: 't', displayName: 't', roles, permissions })
  const call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, payload?: object, bearer = token()) => app.inject({ method, url: `/api/image-workshop${path}`, headers: { authorization: `Bearer ${bearer}` }, ...(payload ? { payload } : {}) })
  const product = async (gallery: string[], extra: Record<string, unknown> = {}) => (await db.query(`INSERT INTO collected_products(tenant_id,source,source_product_id,source_url,title,main_image_url,gallery_images,detail_images,attributes,collected_by)
    VALUES($1,'1688',$2,'https://detail.1688.com/offer/1.html','车载充气泵 便携式',$3,$4,$5,$6,$7) RETURNING id`, [tenant, randomUUID().slice(0, 12), gallery[0], JSON.stringify(gallery), JSON.stringify([cdn('detail-1'), cdn('detail-2')]), JSON.stringify({ 电压: '12V', 尺寸: '15×7×5cm', ...extra }), actor])).rows[0].id as string

  // Settings: off by default; turning the agent on needs explicit consent; stale revisions are rejected.
  const initial = (await call('GET', '/settings')).json()
  assert.deepEqual([initial.data.auto_replace, initial.data.revision, initial.services.generation], [false, 0, true])
  assert.equal(initial.data.hero_reference_frame, undefined)
  assert.equal(initial.data.suite_model, undefined)
  assert.equal(initial.data.suite_quality, undefined)
  const admin = token(tenant, ['*'], ['super_admin'])
  const initialOutput = { replacementPlan: 'image-a', quality: 'medium', resolution: '1k', revision: 0 }
  assert.equal((await call('GET', '/generation-settings')).statusCode, 403)
  assert.equal((await call('PUT', '/generation-settings', initialOutput)).statusCode, 403, 'integration managers cannot configure generation')
  const adminView = await call('GET', '/generation-settings', undefined, admin)
  assert.deepEqual(adminView.json().data, initialOutput)
  assert.doesNotMatch(adminView.body, /gpt-image|apimart/i)
  const locked = await call('PUT', '/settings', { autoReplace: true, suiteModel: 'gpt-image-2.5-flare', suiteQuality: 'high', revision: 0, confirmed: true })
  assert.equal(locked.statusCode, 400)
  assert.equal(locked.json().error, 'VALIDATION_ERROR')
  assert.equal((await call('PUT', '/settings', { autoReplace: true, revision: 0 })).statusCode, 400)
  assert.equal((await call('PUT', '/settings', { autoReplace: false, revision: 0 }, token(tenant, ['collection:read']))).statusCode, 403)

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
  const editInput = { source: { url: cdn('side') }, operation: 'white_bg', collectedProductId: p1 }
  assert.equal((await call('POST', '/edits', { ...editInput, model: 'qwen-image-3.0' })).statusCode, 400)
  const edit = (await call('POST', '/edits', editInput)).json().data
  assert.deepEqual([edit.status, edit.url, edit.canRetry], ['pending', null, false])
  assert.deepEqual([edit.provider, edit.model, edit.options.quality, edit.options.resolution], [undefined, undefined, undefined, undefined])
  for (let i = 0; i < 3; i++) await drain()
  const [editCall] = calls.submit
  assert.deepEqual([editCall.model, editCall.size, editCall.image_urls], ['gpt-image-2.5-flare', '1:1', [cdn('side')]], 'edits use the server-assigned model')
  assert.match(editCall.prompt, /纯白色/)
  assert.equal(calls.qwen.length, 0)
  calls.submit.length = 0
  // (its result link redirected once to the CDN copy and was still saved; see `done` below)
  // A large picture (here random noise, a few MB as PNG) is saved in 512 KB parts with the same private headers.
  const noise = await sharp(Buffer.from(Array.from({ length: 1200 * 1200 * 3 }, () => Math.floor(Math.random() * 256))), { raw: { width: 1200, height: 1200, channels: 3 } }).png().toBuffer()
  assert.ok(noise.length > 1024 * 1024)
  const bigKey = await workshop.storeImage(tenant, randomUUID(), noise)
  assert.deepEqual([multipart.length, multipart[0].key, multipart[0].size, multipart[0].options.partSize, multipart[0].options.headers['x-oss-object-acl'], multipart[0].options.mime, multipart[0].options.timeout], [1, bigKey, noise.length, 512 * 1024, 'private', 'image/png', 120_000])
  assert.ok(objects.has(`image-workshop/${tenant}/${edit.id}.png`), 'small pictures stay a single upload')
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

  // 电商套图: flagged references are refused; seven tasks (with the 1688 首图) are submitted with the references, polled, stored and screened.
  assert.equal((await call('POST', '/suites', { collectedProductId: p1, references: [{ url: cdn('main') }, { url: cdn('logo-1') }] })).statusCode, 400)
  for (const override of [{ model: 'gpt-image-2' }, { quality: 'high' }, { resolution: '2k' }]) {
    assert.equal((await call('POST', '/suites', { collectedProductId: p1, references: [{ url: cdn('main') }], ...override })).statusCode, 400)
  }
  const suite = (await call('POST', '/suites', { collectedProductId: p1, points: '30 秒充满 / 数显胎压', references: [{ url: cdn('main') }, { assetId: upload.id }] })).json().data
  assert.equal(suite.assets.length, 7)
  await drain()
  assert.equal(calls.submit.length, 7)
  assert.deepEqual([calls.submit[0].model, calls.submit[0].quality, calls.submit[0].resolution, calls.submit[0].size, calls.submit[0].output_format, calls.submit[0].n], ['gpt-image-2.5-flare', 'medium', '1k', '1:1', 'png', 1])
  assert.equal(calls.submit[0].image_urls[0], cdn('main'))
  assert.ok(calls.submit[0].image_urls[1].startsWith('https://images.example.com/'), 'uploaded reference is sent as a signed link')
  const selling = calls.submit.find(s => s.prompt.includes('生成卖点图'))
  assert.match(selling.prompt, /30 秒充满/); assert.match(selling.prompt, /不得编造/)
  assert.match(calls.submit.find(s => s.prompt.includes('规格尺寸图')).prompt, /15×7×5cm/)
  // The 1688 首图 is made to catch the eye: the core terms in large type, a clean corner left for the logo.
  const hero = calls.submit.find(s => s.prompt.includes('1688 批发商品首图')).prompt
  assert.match(hero, /工厂直供、现货速发、支持定制/); assert.match(hero, /只绘制这些文案/)
  await drain() // first poll: still processing
  assert.equal((await call('GET', `/assets?batchId=${suite.batchId}`)).json().data.filter((a: any) => a.status === 'processing').length, 7)
  await drain() // second poll: completed
  const suiteDone = (await call('GET', `/assets?batchId=${suite.batchId}`)).json().data
  assert.deepEqual([suiteDone.every((a: any) => a.status === 'completed'), Number(suiteDone[0].cost)], [true, 0.01317])

  // A failed task is reported and can be retried.
  failNextTask = true
  const one = (await call('POST', '/suites', { title: '手提收纳箱', references: [{ url: cdn('main') }], types: ['suite_white'] })).json().data.assets[0]
  await drain(); await drain()
  const failed = (await call('GET', `/assets?ids=${one.id}`)).json().data[0]
  assert.deepEqual([failed.status, failed.error, failed.canRetry], ['failed', '图片生成未完成，请检查参考图及内容后重试。', true])
  await db.query("UPDATE image_assets SET error='APIMart 返回 GPT-Image-2.5 Flare 错误' WHERE id=$1", [one.id])
  const previous = (await call('GET', `/assets?ids=${one.id}`)).json().data[0]
  assert.equal(previous.error, '图片生成服务未能完成任务，请重试。')
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
  assert.deepEqual(slots.map(r => [r.replaces_index, r.operation]), [[2, 'suite_scene'], [4, 'suite_white']], 'chosen by 1688 position')
  assert.equal((await call('POST', `/products/${p1}/replace-flagged`, {})).json().data.queued, 0)
  const allBad = await product([cdn('mark-a'), cdn('logo-b')])
  assert.equal((await call('POST', `/products/${allBad}/replace-flagged`, {})).statusCode, 409)

  // Agent switch: products collected after it is turned on are screened once, and flagged slots get replacements.
  const old = await product([cdn('mark-old'), cdn('clean-old')])
  await db.query("UPDATE collected_products SET collected_at=now()-interval '1 hour' WHERE id=$1", [old])
  const on = (await call('PUT', '/settings', { autoReplace: true, revision: 0, confirmed: true })).json().data
  assert.deepEqual([on.auto_replace, on.revision], [true, 1])
  assert.equal((await call('PUT', '/settings', { autoReplace: true, revision: 0, confirmed: true })).statusCode, 409)

  // The 1688 首图 terms: three by default, changed by the shop (add, edit, remove), checked, and used for the next 首图.
  assert.deepEqual(on.hero_badges, ['工厂直供', '现货速发', '支持定制'])
  const badges = (list: string[], revision: number) => call('PUT', '/settings', { autoReplace: true, heroBadges: list, revision })
  assert.equal((await badges(['源头工厂', '源头工厂'], 1)).statusCode, 400, 'no duplicates')
  assert.equal((await badges(['一二三四五六七八九十一二三'], 1)).statusCode, 400, 'twelve characters at most')
  assert.equal((await badges(['a', 'b', 'c', 'd', 'e', 'f', 'g'], 1)).statusCode, 400, 'six at most')
  const editedReply = await badges(['源头工厂', '48小时发货'], 1); assert.equal(editedReply.statusCode, 200, editedReply.body)
  const edited = editedReply.json().data
  assert.deepEqual([edited.hero_badges, edited.revision, edited.auto_replace], [['源头工厂', '48小时发货'], 2, true])
  const heroPrompt = async () => {
    calls.submit.length = 0
    await call('POST', '/suites', { title: '手提收纳箱', references: [{ url: cdn('main') }], types: ['suite_hero'], brandId: null })
    await drain()
    return calls.submit[0].prompt as string
  }
  const custom = await heroPrompt()
  assert.match(custom, /源头工厂、48小时发货/); assert.ok(!custom.includes('工厂直供'))
  assert.equal((await call('PUT', '/settings', { autoReplace: true, heroBadges: [], revision: 2 })).json().data.hero_badges.length, 0)
  const plain = await heroPrompt()
  assert.ok(plain.includes('只写一句简短的商品名称') && !plain.includes('已配置的店铺优势'), 'no terms: name and known points only')
  // Brand without a logo: its name, as text, in the top-left corner of the 首图; with a logo the corner is kept clear.
  const facts = { title: '车载香薰', attributes: {}, skus: [], badges: ['工厂直供'] }
  assert.match(workshop.suitePrompt('suite_hero', facts, { name: '拓洋', hasLogo: false }), /左上角用醒目的字体准确写出品牌名“拓洋”/)
  assert.match(workshop.suitePrompt('suite_hero', facts, { name: '拓洋', hasLogo: true }), /左上角约 16% 宽、16% 高的区域保持干净/)
  const output = { replacementPlan: 'image-b', quality: 'low', resolution: '2k', revision: 3 }
  const savedOutput = await call('PUT', '/generation-settings', output, admin)
  assert.equal(savedOutput.statusCode, 200, savedOutput.body)
  assert.deepEqual(savedOutput.json().data, { ...output, revision: 4 })
  assert.equal((await call('PUT', '/generation-settings', output, admin)).statusCode, 409)
  const current = (await call('GET', '/settings')).json().data
  assert.deepEqual([current.auto_replace, current.hero_badges], [true, []], 'output settings preserve application settings')
  await heroPrompt()
  assert.deepEqual([calls.submit[0].quality, calls.submit[0].resolution], ['low', '2k'], 'merchant jobs use the administrator settings')
  const fresh = await product([cdn('clean-new'), cdn('mark-new')])
  while (await workshop.screenNextProduct()) { /* screen everything due */ }
  const agentRows = (await db.query('SELECT collected_product_id,trigger,model,options,replaces_index FROM image_assets WHERE collected_product_id=ANY($1::uuid[]) AND trigger=$2', [[old, fresh], 'agent'])).rows
  assert.deepEqual(agentRows.map(r => [r.collected_product_id, r.model, r.options.quality, r.options.resolution, r.replaces_index]), [[fresh, 'gpt-image-2.5-sunburst', 'low', '2k', 1]])
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

  // The frame setting is captured at enqueue time and applies only to first-slot images.
  const petShop = await saveConnection(tenant, actor, { aliId: `pets-${randomUUID()}`, resource_owner: '义乌市智珀宠物', access_token: 'fixture', expires_in: 36000 })
  const changeFrame = (id: string, mode: string, revision: number, templateId?: string, bearer = token()) => call('PUT', `/hero-templates/${id}`, { mode, revision, templateId }, bearer)
  assert.equal((await changeFrame(shop.id, 'tuoyang-v1', 0)).json().data.mode, 'tuoyang-v1')
  assert.equal((await changeFrame(shop.id, 'none', 0)).statusCode, 409)
  assert.equal((await changeFrame(shop.id, 'none', 1, undefined, token(tenants[1]))).statusCode, 404)
  assert.equal((await changeFrame(petShop.id, 'custom-v1', 0, undefined, token(tenant, ['collection:read']))).statusCode, 403)
  assert.deepEqual((await call('GET', '/hero-templates', undefined, token(tenants[1]))).json().data, [])
  const logoKey = await workshop.storeImage(tenant, randomUUID(), png)
  const brandId = (await db.query('INSERT INTO brands(tenant_id,name,logo_key,is_default,rights_confirmed_at) VALUES($1,$2,$3,true,now()) RETURNING id', [tenant, '测试店铺品牌', logoKey])).rows[0].id
  const frameSuite = await call('POST', '/suites', { title: '车载充气泵', points: '数显胎压', references: [{ url: cdn('main') }], types: ['suite_hero', 'suite_white', 'suite_scene'], brandId, connectionId: shop.id })
  assert.equal(frameSuite.statusCode, 200, frameSuite.body)
  const [framed, white, scene] = frameSuite.json().data.assets
  assert.equal(framed.options.heroFrame, 'tuoyang-v1')
  assert.equal(framed.options.brand, undefined, 'the selected logo cannot overlap the reference')
  assert.equal(white.options.heroFrame, undefined)
  assert.equal(white.options.brand.logo, false)
  assert.equal(scene.options.heroFrame, undefined)
  assert.equal(scene.options.brand.logo, true)
  const replacementProduct = await product([cdn('mark-front'), cdn('clean-side')])
  await db.query('UPDATE collected_products SET target_connection_id=$2,use_default_listing_shop=false WHERE id=$1', [replacementProduct, shop.id])
  assert.equal((await call('POST', '/products/' + replacementProduct + '/replace-flagged', {})).json().data.queued, 1)
  const replacement = (await db.query('SELECT options,prompt FROM image_assets WHERE collected_product_id=$1 AND replaces_index=0', [replacementProduct])).rows[0]
  assert.equal(replacement.options.heroFrame, 'tuoyang-v1')
  assert.match(replacement.prompt, /左侧居中排产品文案/)
  assert.equal((await changeFrame(shop.id, 'none', 1)).json().data.mode, 'none')
  const block = (width: number, height: number, background: string) => ({ create: { width, height, channels: 4 as const, background } })
  const transparentFrame = await sharp(block(640, 640, '#00000000')).composite([
    { input: block(410, 44, '#179f47'), left: 170, top: 0 },
    { input: block(640, 80, '#179f47'), left: 0, top: 560 },
    { input: block(24, 640, '#179f47'), left: 0, top: 0 },
  ]).png().toBuffer()
  const transparent = await prepareCustomHeroFrame(transparentFrame, 640, 640)
  assert.ok(transparent.insets)
  assert.equal(transparent.insets.right, 0)
  assert.deepEqual(transparent.frame, transparentFrame, 'transparent shapes are preserved')

  const flattened = await sharp(block(640, 640, '#ffffff')).composite([
    { input: block(245, 39, '#ca1224'), left: 199, top: 0 },
    { input: block(640, 437, '#234f87'), left: 0, top: 77 },
    { input: block(640, 82, '#4c1e80'), left: 0, top: 558 },
  ]).jpeg({ quality: 92 }).toBuffer()
  const extracted = await prepareCustomHeroFrame(flattened, 640, 640)
  assert.ok(extracted.insets, 'a completed JPEG can expose blank gutters on both sides of its sample')
  assert.ok(Math.abs(extracted.insets.top - 39 / 640) < 0.01)
  assert.ok(Math.abs(extracted.insets.bottom - 82 / 640) < 0.01)
  const portrait = await sharp(block(600, 800, '#d7e2dc')).png().toBuffer()
  const composed = await applyCustomHeroFrame(portrait, 600, 800, extracted.frame, extracted.insets)
  const composedPixel = async (y: number) => [...await sharp(composed).extract({ left: 300, top: y, width: 1, height: 1 }).removeAlpha().raw().toBuffer()]
  for (const y of [75, 400, 660]) assert.deepEqual(await composedPixel(y), [215, 226, 220], 'the body fills both gutters and replaces the sample')

  const coloredFrame = async (background: string) => (await sharp({ create: { width: 640, height: 640, channels: 3, background } }).png().toBuffer()).toString('base64')
  const customPath = `/hero-templates/${petShop.id}/custom`
  const firstContent = (await sharp(block(594, 504, '#ffffff'))
    .extend({ top: 40, bottom: 96, left: 15, right: 31, background: '#ca1224' }).png().toBuffer()).toString('base64')
  const secondContent = await coloredFrame('#13681d')
  const first = await call('POST', customPath, { name: '宠物红框', revision: 0, content: firstContent })
  assert.equal(first.statusCode, 201, first.body)
  const uploadedFrame = first.json().data
  assert.equal(uploadedFrame.mode, 'none', 'adding a template keeps the current selection')
  const firstTemplate = uploadedFrame.templates[0]
  assert.ok(firstTemplate.previewUrl)
  assert.equal(firstTemplate.adaptive, true)
  assert.equal(firstTemplate.storage_key, undefined)
  assert.equal((await changeFrame(shop.id, 'custom-v1', 2, firstTemplate.id)).statusCode, 404)
  assert.equal((await changeFrame(petShop.id, 'custom-v1', 1, firstTemplate.id)).json().data.activeTemplateId, firstTemplate.id)
  const customHero = (await call('POST', '/suites', { title: '宠物玩具', references: [{ url: cdn('main') }], types: ['suite_hero'], connectionId: petShop.id })).json().data.assets[0]
  assert.equal(customHero.options.heroFrame, 'custom-v1')
  assert.equal(customHero.options.heroShopId, petShop.id)
  assert.equal(customHero.options.heroFrameKey, undefined)
  assert.equal(customHero.options.brand, undefined)
  assert.ok(customHero.options.heroFrameInsets.left < customHero.options.heroFrameInsets.right)
  const { rows: [customJob] } = await db.query('SELECT prompt FROM image_assets WHERE id=$1', [customHero.id])
  assert.match(customJob.prompt, /上方 10%、下方 19%、左侧 6%、右侧 8%/)
  const duplicate = await call('POST', customPath, { name: '宠物红框', revision: 2, content: secondContent })
  assert.equal(duplicate.json().error, 'HERO_TEMPLATE_NAME_TAKEN')
  const secondUpload = await call('POST', customPath, { name: '宠物绿框', revision: 2, content: secondContent })
  assert.equal(secondUpload.statusCode, 201, secondUpload.body)
  const secondShopState = secondUpload.json().data
  const secondTemplate = secondShopState.templates.find((template: any) => template.name === '宠物绿框')
  assert.equal(secondTemplate.adaptive, false, 'an ambiguous opaque image uses fixed bands')
  assert.deepEqual(secondShopState.templates.map((template: any) => template.name).sort(), ['宠物红框', '宠物绿框'].sort())
  assert.equal(secondShopState.activeTemplateId, firstTemplate.id)
  const renamed = await call('PATCH', `${customPath}/${firstTemplate.id}`, { name: '宠物节日红框', revision: 3 })
  assert.equal(renamed.json().data.templates.find((template: any) => template.id === firstTemplate.id).name, '宠物节日红框')
  assert.equal(renamed.json().data.templates.find((template: any) => template.id === firstTemplate.id).adaptive, true)
  assert.equal(renamed.json().data.activeTemplateId, firstTemplate.id)
  assert.equal((await call('DELETE', `${customPath}/${firstTemplate.id}`, { revision: 3 })).statusCode, 409)
  assert.equal((await call('DELETE', `${customPath}/${firstTemplate.id}`, { revision: 4 }, token(tenants[1]))).statusCode, 404)
  assert.equal((await changeFrame(petShop.id, 'custom-v1', 4, secondTemplate.id)).json().data.activeTemplateId, secondTemplate.id)
  const removeInactive = (await call('DELETE', `${customPath}/${firstTemplate.id}`, { revision: 5 })).json().data
  assert.equal(removeInactive.activeTemplateId, secondTemplate.id)
  assert.deepEqual(removeInactive.templates.map((template: any) => template.id), [secondTemplate.id])
  const updatedImage = await call('PATCH', `${customPath}/${secondTemplate.id}`, { name: '宠物绿框', revision: 6, content: transparentFrame.toString('base64') })
  assert.equal(updatedImage.statusCode, 200, updatedImage.body)
  assert.equal(updatedImage.json().data.activeTemplateId, secondTemplate.id)
  assert.notEqual(updatedImage.json().data.templates[0].previewUrl, secondTemplate.previewUrl)
  assert.equal(updatedImage.json().data.templates[0].adaptive, true)
  const { frame: selectedFrame } = await (await import('../server/integrations/shop-hero-templates.js')).heroDesignForShop(tenant, petShop.id)
  assert.equal(selectedFrame?.mode, 'custom-v1')
  const secondBytes = objects.get(selectedFrame.key)!
  assert.deepEqual([...await sharp(secondBytes).extract({ left: 16, top: 16, width: 1, height: 1 }).removeAlpha().raw().toBuffer()], [23, 159, 71])
  const removeActive = (await call('DELETE', `${customPath}/${secondTemplate.id}`, { revision: 7 })).json().data
  assert.deepEqual([removeActive.mode, removeActive.activeTemplateId, removeActive.templates], ['none', null, []])
  const currentShops = (await call('GET', '/hero-templates')).json().data
  assert.deepEqual(currentShops.find((row: any) => row.id === petShop.id), removeActive)
  const defaultSuite = (await call('POST', '/suites', { title: '车载充气泵', references: [{ url: cdn('main') }], types: ['suite_hero'] })).json().data.assets[0]
  assert.equal(defaultSuite.options.brand.logo, true)
  assert.equal(defaultSuite.options.heroFrame, undefined)
  frameToScreen = framed.id
  for (let i = 0; i < 4; i++) await drain()
  const processed = (await call('GET', '/assets?ids=' + framed.id + ',' + white.id + ',' + customHero.id)).json().data
  assert.ok(processed.every((a: any) => a.status === 'completed' && !a.risky))
  const savedFrame = objects.get('image-workshop/' + tenant + '/' + framed.id + '.png')!
  const pixel = async (x: number, y: number) => [...await sharp(savedFrame).extract({ left: x, top: y, width: 1, height: 1 }).removeAlpha().raw().toBuffer()]
  assert.deepEqual(await pixel(8, 8), [0, 0, 0])
  assert.deepEqual(await pixel(512, 512), [215, 226, 220])
  const footer = await pixel(1000, 1000)
  assert.ok(footer[0] > footer[1] && footer[1] > footer[2], 'the original gold footer is present')
  assert.deepEqual(objects.get('image-workshop/' + tenant + '/' + white.id + '.png'), (await workshop.toPng(png)).png)
  const customBytes = objects.get('image-workshop/' + tenant + '/' + customHero.id + '.png')!
  const customPixel = async (y: number, x = 512) => [...await sharp(customBytes).extract({ left: x, top: y, width: 1, height: 1 }).removeAlpha().raw().toBuffer()]
  assert.deepEqual(await customPixel(16), [202, 18, 36], 'the queued task retains its first uploaded version')
  assert.deepEqual(await customPixel(100), [215, 226, 220], 'the template needs less than the legacy top band')
  assert.deepEqual(await customPixel(850), [215, 226, 220], 'the template needs less than the legacy bottom band')
  assert.deepEqual(await customPixel(512), [215, 226, 220], 'the sample center does not cover the generated product')
  assert.deepEqual(await customPixel(512, 8), [202, 18, 36], 'the uploaded side rail is preserved')
  assert.deepEqual(await customPixel(1000), [202, 18, 36], 'the matching custom footer is used')
  const wrongAlbum = await call('POST', `/assets/${customHero.id}/photo`, { connectionId: shop.id, albumId: '1001', confirmed: true })
  assert.equal(wrongAlbum.json().error, 'HERO_SHOP_MISMATCH')

  // Supplier identity and commercial metadata stay out of both model inputs, even without a selected brand.
  const dirty = {
    title: '闪恩 迷你安全锤 C07【现货】', sellerName: '闪恩汽车用品旗舰店',
    category: '汽车用品>安全锤', attributes: { 品牌: '闪恩', 货号: 'C07【现货】', 产地: '东莞', 价格区间: '23~24 元',
      是否IP授权: '否', 资质报告: '6份', 主要下游平台: 'LAZADA', 材质: '塑料', 尺寸: '81.5×19.5mm', 功能2: '割安全带' },
    skus: ['闪恩 C07 透明款'], points: '闪恩轻巧便携；价格 23 元；适用车内',
  }
  const cleanCopy = await workshop.heroCopy(dirty)
  assert.deepEqual(cleanCopy, { headline: '安全锤', subline: '', features: ['割安全带', '塑料材质'] })
  const hidden = /闪恩|C07|东莞|23~24|23 元|6份|LAZADA/
  assert.doesNotMatch(copyInputs.at(-1)!, hidden)
  const specPrompt = workshop.suitePrompt('suite_spec', dirty, null)
  assert.doesNotMatch(specPrompt, hidden)
  assert.match(specPrompt, /81.5×19.5mm/)
  assert.match(specPrompt, /不照搬参考图上的海报文字/)
  const copyPath = `/hero-templates/${shop.id}/copy`
  assert.equal((await call('PUT', copyPath, { revision: 2, origin: '浙江义乌', notes: [] }, token(tenants[1]))).statusCode, 404)
  const savedCopy = await call('PUT', copyPath, { revision: 2, origin: ' 浙江义乌 ', notes: ['支持定制'] })
  assert.equal(savedCopy.statusCode, 200, savedCopy.body)
  assert.deepEqual([savedCopy.json().data.heroOrigin, savedCopy.json().data.heroNotes], ['浙江义乌', ['支持定制']])
  assert.equal((await call('PUT', copyPath, { revision: 2, origin: null, notes: [] })).statusCode, 409)
  const shopSuite = (await call('POST', '/suites', { title: '迷你安全锤', references: [{ url: cdn('main') }], types: ['suite_hero', 'suite_spec'], connectionId: shop.id })).json().data
  const prompts = (await db.query('SELECT operation,prompt,options FROM image_assets WHERE batch_id=$1 ORDER BY operation', [shopSuite.batchId])).rows
  assert.match(prompts[0].prompt, /产地：浙江义乌.*支持定制/)
  assert.deepEqual(prompts[0].options.heroShopCopy, { origin: '浙江义乌', notes: ['支持定制'] })
  assert.doesNotMatch(prompts[1].prompt, /浙江义乌|支持定制/)
  assert.equal((await call('PUT', copyPath, { revision: 3, origin: null, notes: [] })).json().data.heroOrigin, null)

  console.log(JSON.stringify({ settings: 'ok', productImages: 'ok', screeningCache: 'ok', rightsGuard: 'ok', gptImageEdit: 'ok', multipartUpload: 'ok', heroBadges: 'ok', heroTextBrand: 'ok', heroReferenceFrame: 'ok', resize: 'ok', upload: 'ok', suite: 'ok', retry: 'ok', replacements: 'ok', agentSwitch: 'ok', albumApply: 'ok', undo: 'ok', uploadSafety: 'ok', isolation: 'ok' }))
} finally {
  globalThis.fetch = originalFetch
  Object.assign(OSS.prototype, original)
  for (const id of tenants) { await db.query('DELETE FROM audit_logs WHERE tenant_id=$1', [id]); await db.query('DELETE FROM tenants WHERE id=$1', [id]) }
  await app.close(); await db.end()
}
