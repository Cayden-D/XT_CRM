import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import sharp from 'sharp'

// Collect → (AI images on) new main and detail pictures, unchecked → album → AI fill → publish, with every external
// service mocked (vision and text model, image generation, OSS, the 1688 gateway).
process.env.DASHSCOPE_API_KEY = 'queue-images-key'
process.env.DASHSCOPE_BASE_URL = 'https://dashscope.fixture.invalid/compatible-mode/v1'
process.env.APIMART_API_KEY = 'queue-images-apimart'
process.env.APIMART_BASE_URL = 'https://apimart.fixture.invalid/v1'
process.env.OSS_REGION = 'oss-cn-beijing'
process.env.OSS_BUCKET = 'queue-images-bucket'
process.env.OSS_ACCESS_KEY_ID = 'queue-images-id'
process.env.OSS_ACCESS_KEY_SECRET = 'queue-images-secret'
process.env.OSS_CUSTOM_DOMAIN = 'https://images.example.com'
const { default: OSS } = await import('ali-oss')
const originalOss = { put: OSS.prototype.put, get: OSS.prototype.get, delete: OSS.prototype.delete }
const objects = new Map<string, Buffer>()
;(OSS.prototype as any).put = async (key: string, bytes: Buffer) => { objects.set(key, bytes); return {} }
;(OSS.prototype as any).get = async (key: string) => ({ content: objects.get(key) })
;(OSS.prototype as any).delete = async (key: string) => { objects.delete(key); return {} }

const [{ db }, { saveConnection }, { runClaimedCollectionQueueJob }, workshop] = await Promise.all([import('../server/db.js'), import('../server/integrations/1688.js'), import('../server/integrations/1688-collection-queue.js'), import('../server/integrations/image-workshop.js')])
const png = await sharp({ create: { width: 800, height: 800, channels: 3, background: '#cfd8dc' } }).png().toBuffer()
const schema = { global: { systemParam: { catId: '101' } }, data: { title: { fields: { label: '标题', required: true, maxLength: 100 } }, primaryPicture: { fields: { label: '主图', required: true, maxItems: 5 } }, description: { fields: { label: '详情', required: true, value: { detailList: [{ id: '0', title: '图文详情', content: null, contentUrl: null, isRequired: true }], smartDetail: { kept: true }, sizeTableDescriptionBlackIdList: '[1]' } } }, catProp: { fields: { label: '属性', dataSource: [] } }, beginAmount: { fields: { label: '最小起订量' } }, saleProp: { fields: { dataSource: [{ name: 'p-3216', propertyId: 3216, label: '颜色', required: true, supportImg: true, customizable: true, fieldType: 'string' }] } }, skuTable: { fields: { column: [] } }, priceRange: { fields: { label: '报价', required: true, column: [{ name: 'pricerange_beginAmount', required: true, uiType: 'cbunumber' }, { name: 'pricerange_price', required: true, uiType: 'cbunumber' }] } } } }
let albumUploads = 0, published: any = null, submits = 0, visionCalls = 0, addCalls = 0, listFails = true
let albums: { albumID: number; name: string }[] = [{ albumID: 5, name: '其他相册' }]
const uploadedTo: string[] = []
const reply = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } })
const originalFetch = globalThis.fetch
globalThis.fetch = async (input, init) => {
  const url = String(input)
  if (url.endsWith('/chat/completions')) {
    const body = JSON.parse(String(init?.body)), content = body.messages.at(-1).content
    if (Array.isArray(content) && String(body.messages[0].content).includes('视觉检查器')) {
      visionCalls++
      const images = content.filter((c: any) => c.type === 'image_url').map((c: any) => c.image_url.url as string)
      return reply({ model: 'qwen3.8-flash', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ images: images.map((u, index) => ({ index, readable: true, companyWatermark: { detected: false, name: '', confidence: 0 }, famousBrandLogo: { detected: u.includes('mark'), name: u.includes('mark') ? '奔驰' : '', confidence: u.includes('mark') ? 0.99 : 0 } })) }) } }] })
    }
    const answer = String(body.messages[0].content).includes('资料整理器') ? { title: '车载香薰机', catProp: {}, unknown: [] } : { fields: [], cannot: [] }
    return reply({ model: 'qwen3.8-flash', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(answer) } }] })
  }
  if (url === 'https://apimart.fixture.invalid/v1/images/generations') { submits++; return reply({ code: 200, data: [{ status: 'submitted', task_id: `task_${submits}` }] }) }
  if (url.startsWith('https://apimart.fixture.invalid/v1/tasks/')) return reply({ code: 200, data: { id: url.split('/').pop(), status: 'completed', progress: 100, cost: 0.01, result: { images: [{ url: ['https://upload.apimart.fixture/f/image/x.png'], expires_at: 1789000000 }] } } })
  // The collected SKU picture, read so it can be copied into the shop album.
  if (url === 'https://cbu01.alicdn.com/img/ibank/sku-mark.jpg') return new Response(png, { status: 200, headers: { 'content-type': 'image/png', 'content-length': String(png.length) } })
  if (url.startsWith('https://upload.apimart.fixture/')) return new Response(png, { status: 200, headers: { 'content-type': 'image/png', 'content-length': String(png.length) } })
  assert.ok(url.startsWith('https://gw.open.1688.com/openapi/'), `unexpected request ${url}`)
  if (url.includes('alibaba.photobank.album.getList')) {
    const form = init?.body as URLSearchParams
    assert.deepEqual([form.get('webSite'), form.get('albumType')], ['1688', 'CUSTOM'])
    // Success carries an error code of "0" next to the data, as the live API answers.
    return reply(listFails ? { errorCode: 'ISP_ERROR', errorMsg: '相册服务暂不可用' } : { albumInfos: albums, errorCode: '0', errorMsg: '' })
  }
  if (url.includes('alibaba.photobank.album.add')) {
    const form = init?.body as URLSearchParams
    assert.deepEqual([form.get('name'), form.get('authority'), form.get('webSite')], ['销途 AI 生图', '0', '1688'])
    addCalls++; albums = [...albums, { albumID: 777, name: '销途 AI 生图' }]; return reply({ albumID: 777, errCode: '0', errMsg: '' })
  }
  if (url.includes('alibaba.photobank.photo.add')) { uploadedTo.push(String((init?.body as FormData).get('albumID'))); albumUploads++; return reply({ image: { id: `photo-${albumUploads}`, url: `https://cbu01.alicdn.com/img/ibank/album-${albumUploads}.jpg` } }) }
  if (url.includes('alibaba.new.product.getSchema')) return reply({ result: { success: true, bizData: schema } })
  if (url.includes('alibaba.new.product.add')) { published = JSON.parse((init?.body as URLSearchParams).get('dataBody')!); return reply({ result: { success: true, bizData: { dataJson: JSON.stringify({ itemId: '990001', offerStatus: 'auditing' }) } } }) }
  throw new Error(`unexpected gateway endpoint ${url}`)
}

const cdn = (name: string) => `https://cbu01.alicdn.com/img/ibank/${name}.jpg`
const tenants: string[] = []
try {
  const tenant = (await db.query('INSERT INTO tenants(name,slug)VALUES($1,$2)RETURNING id', ['队列图片测试', `queue-img-${randomUUID().slice(0, 8)}`])).rows[0].id
  tenants.push(tenant)
  const actor = (await db.query("INSERT INTO users(tenant_id,email,display_name,status)VALUES($1,$2,'采集员','active')RETURNING id", [tenant, `${randomUUID()}@fixture.local`])).rows[0].id
  const connection = await saveConnection(tenant, actor, { aliId: `queue-img-${randomUUID()}`, access_token: 'fixture', expires_in: 36000 })
  await db.query('INSERT INTO integration_1688_agent_settings(connection_id,tenant_id,enabled)VALUES($1,$2,true)', [connection.id, tenant])
  await db.query('INSERT INTO integration_1688_collection_queue_settings(connection_id,tenant_id,enabled)VALUES($1,$2,true)', [connection.id, tenant])
  const imageSettings = (on: boolean) => db.query(`INSERT INTO image_workshop_settings(tenant_id,auto_replace,suite_model,suite_quality,enabled_at,revision) VALUES($1,$2,'gpt-image-2.5-flare','medium',now(),1)
    ON CONFLICT(tenant_id) DO UPDATE SET auto_replace=excluded.auto_replace`, [tenant, on])
  const collect = async () => {
    const source = (await db.query(`INSERT INTO collected_products(tenant_id,source,source_product_id,source_url,title,main_image_url,gallery_images,detail_images,currency,price_min,price_max,attributes,source_category_id,collected_by)
      VALUES($1,'1688',$2,$3,'车载香薰机',$4,$5,$6,'CNY',39,39,$8,'101',$7) RETURNING id`, [tenant, randomUUID(), `https://detail.1688.com/offer/${randomUUID()}.html`, cdn('main-mark'), JSON.stringify([cdn('main-mark'), cdn('side')]), JSON.stringify([cdn('detail-ok'), cdn('detail-mark')]), actor, JSON.stringify({ 阶梯价格: '¥39.00 (2 pieces) / ¥35.00 (10 pieces) / ¥30.00 (50 pieces) / ¥28.00 (100 pieces)' })])).rows[0]
    await db.query(`INSERT INTO collected_product_variants(tenant_id,collected_product_id,position,label,attributes,image_url,price,stock)VALUES($1,$2,0,'黑色','{"颜色":"黑色"}',$3,39,10)`, [tenant, source.id, cdn('sku-mark')])
    return source.id as string
  }
  const job = async (sourceId: string) => (await db.query('SELECT * FROM integration_1688_collection_queue_jobs WHERE collected_product_id=$1', [sourceId])).rows[0]
  const run = async (sourceId: string) => {
    const workerId = randomUUID()
    const claimed = (await db.query("UPDATE integration_1688_collection_queue_jobs SET status='processing',worker_id=$2,lease_until=now()+interval '1 hour',attempts=attempts+1 WHERE collected_product_id=$1 RETURNING id", [sourceId, workerId])).rows[0]
    assert.ok(claimed, 'the collection trigger queued the job')
    await runClaimedCollectionQueueJob(claimed.id, workerId)
    return job(sourceId)
  }
  const drain = async () => { for (let i = 0; i < 3; i++) { await db.query("UPDATE image_assets SET next_poll_at=now() WHERE status IN ('pending','processing')"); await workshop.runImageWorkerOnce() } }

  // Image processing off: the old behaviour, with a hint.
  await imageSettings(false)
  const off = await run(await collect())
  assert.equal(off.status, 'blocked'); assert.match(off.message, /开启.*AI 图片自动处理/)

  // On: no screening at all; nine new pictures are generated (six main, three detail) and the job waits for them.
  await imageSettings(true)
  const before = visionCalls
  const sourceId = await collect()
  let state = await run(sourceId)
  assert.deepEqual([state.status, state.attempts], ['queued', 0], state.message)
  assert.match(state.message, /正在用 AI 生成 6 张主图和 3 张详情图/)
  const generated = (await db.query("SELECT operation,options FROM image_assets WHERE collected_product_id=$1 ORDER BY operation", [sourceId])).rows
  assert.equal(generated.length, 9)
  assert.ok(generated.every(r => r.options.unchecked === true))
  assert.deepEqual(generated.filter(r => r.operation.startsWith('detail_')).map(r => r.options.size), ['3:4', '3:4', '3:4'])
  await drain()
  assert.equal(submits, 9)
  assert.ok((await db.query("SELECT bool_and(status='completed') AS ok FROM image_assets WHERE collected_product_id=$1", [sourceId])).rows[0].ok)

  // No album chosen and the album service fails: a clear stop with the platform's reason.
  state = await run(sourceId)
  assert.equal(state.status, 'blocked'); assert.match(state.message, /没能确定店铺相册.*相册服务暂不可用/)
  assert.equal(albumUploads, 0)

  // As 重新入队 does (report cleared): the finished batch is reused; the album is created once, then upload and publish.
  listFails = false
  await db.query("UPDATE integration_1688_collection_queue_jobs j SET status='queued',report='{}',source_updated_at=p.updated_at FROM collected_products p WHERE p.id=j.collected_product_id AND j.collected_product_id=$1", [sourceId])
  state = await run(sourceId)
  assert.equal(state.status, 'queued', state.message); assert.match(state.message, /已生成并上传 9 张/)
  assert.equal(submits, 9, 'a retry does not generate again'); assert.equal(albumUploads, 9, 'the nine generated pictures')
  assert.equal(addCalls, 1); assert.ok(uploadedTo.every(id => id === '777'), 'uploaded into the new album')
  assert.equal((await db.query('SELECT album_id FROM integration_1688_album_settings WHERE connection_id=$1', [connection.id])).rows[0].album_id, '777')
  const source = (await db.query('SELECT main_image_url,gallery_images,detail_images FROM collected_products WHERE id=$1', [sourceId])).rows[0]
  assert.equal(source.main_image_url, 'https://cbu01.alicdn.com/img/ibank/album-1.jpg', 'the white main picture comes first')
  assert.equal(source.gallery_images.length, 6)
  assert.deepEqual(source.detail_images, [7, 8, 9].map(n => `https://cbu01.alicdn.com/img/ibank/album-${n}.jpg`))
  state = await run(sourceId)
  assert.equal(state.status, 'published', state.message)
  const body = JSON.stringify(published)
  assert.ok(body.includes('album-1.jpg') && body.includes('album-9.jpg')); assert.ok(!body.includes('main-mark') && !body.includes('detail-ok'), 'only the new pictures')
  // The SKU picture is copied into the album (not regenerated) and shown on the colour value; minimum order = first tier.
  assert.equal(albumUploads, 10)
  assert.equal((await db.query('SELECT v.image_url FROM product_variants v JOIN collected_products p ON p.product_id=v.product_id WHERE p.id=$1', [sourceId])).rows[0].image_url, 'https://cbu01.alicdn.com/img/ibank/album-10.jpg')
  assert.deepEqual(published.formValues.saleProp['p-3216'], [{ value: -1, text: '黑色', custom: true, imgUrl: 'img/ibank/album-10.jpg' }])
  assert.equal(published.formValues.skuTable[0].sku_props[0].value, -1)
  assert.equal(published.formValues.beginAmount, 2, 'the minimum order matches the first quantity tier')
  assert.deepEqual(state.report.skuPictures, { uploaded: 1, failed: 0 })
  assert.equal(visionCalls, before, 'nothing was screened: originals, generated pictures and the final check all skipped')
  assert.equal(state.report.imagesUnchecked, true)
  // The collected ladder is the quantity quote (three tiers at most); the platform's description structure is kept.
  assert.deepEqual(published.formValues.priceRange, [{ pricerange_beginAmount: 2, pricerange_price: 39 }, { pricerange_beginAmount: 10, pricerange_price: 35 }, { pricerange_beginAmount: 50, pricerange_price: 30 }])
  assert.deepEqual([published.formValues.description.smartDetail, published.formValues.description.sizeTableDescriptionBlackIdList], [{ kept: true }, '[1]'])
  assert.match(published.formValues.description.detailList[0].content, /album-7\.jpg[\s\S]*album-9\.jpg/, 'the generated detail pictures are in the text')
  assert.equal(albumUploads, 10, 'nothing is uploaded twice')
  // A shop that already has the album (e.g. settings lost) finds it by name instead of creating another.
  await db.query('DELETE FROM integration_1688_album_settings WHERE connection_id=$1', [connection.id])
  const { ensureAlbum } = await import('../server/integrations/image-album.js')
  assert.equal(await ensureAlbum({ tenantId: tenant, actorId: actor, requestId: randomUUID() }, connection.id), '777')
  assert.equal(addCalls, 1, 'found by name, not created again')
  console.log(JSON.stringify({ offKeepsBlocking: 'ok', generatesNine: 'ok', albumFailureStops: 'ok', albumCreatedOnce: 'ok', albumFoundByName: 'ok', retryReusesBatch: 'ok', publishedUnchecked: 'ok', skuAsCollected: 'ok', livePlatformWrites: 0 }))
} finally {
  globalThis.fetch = originalFetch
  Object.assign(OSS.prototype, originalOss)
  for (const id of tenants) { await db.query('DELETE FROM audit_logs WHERE tenant_id=$1', [id]); await db.query('DELETE FROM tenants WHERE id=$1', [id]) }
  await db.end()
}
