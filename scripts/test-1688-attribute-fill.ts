import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

// AI filling of required attributes and repair after a platform rejection. Every model and platform call is mocked.
process.env.DASHSCOPE_API_KEY = 'attribute-fixture-key'
process.env.DASHSCOPE_BASE_URL = 'https://attribute-fixture.invalid/compatible-mode/v1'
const [{ buildApp }, { db }, { saveConnection, IntegrationError }, { runClaimedCollectionQueueJob }, { fillRequiredAttributes, isAttributeRejection, attributeFacts }] = await Promise.all([import('../server/app.js'), import('../server/db.js'), import('../server/integrations/1688.js'), import('../server/integrations/1688-collection-queue.js'), import('../server/integrations/1688-attribute-fill.js')])

type Answer = { name: string; values: Array<string | number>; evidence: string; confidence: number; reason: string }
const good: Answer[] = [
  { name: 'p-scent', values: ['海洋'], evidence: 'title', confidence: 0.9, reason: '标题写明海洋香' },
  { name: 'p-place', values: ['风口香水'], evidence: 'image', confidence: 0.8, reason: '主图可见出风口夹' },
  { name: 'p-func', values: ['芳香', '除异味', '不存在的功能'], evidence: 'inferred', confidence: 0.8, reason: '香薰用途' },
  { name: 'p-volt', values: ['12V'], evidence: 'title', confidence: 0.9, reason: '标题写明 12V' },
]
const schema = (extra: object[] = []) => ({ global: { systemParam: { catId: 101 } }, data: { title: { fields: { required: true, maxLength: 60 } }, primaryPicture: { fields: { required: true } }, catProp: { fields: { dataSource: [
  { name: 'p-brand', label: '品牌', required: true, uiType: 'input', customizable: true },
  { name: 'p-scent', label: '香型', required: true, uiType: 'select', dataSource: [{ value: 1, text: '森林' }, { value: 2, text: '海洋' }, { value: 3, text: '其它' }] },
  { name: 'p-place', label: '摆放方式', required: true, uiType: 'select', customizable: true, dataSource: [{ value: 11, text: '挂式香水' }, { value: 12, text: '风口香水' }] },
  { name: 'p-func', label: '功能', required: true, uiType: 'checkbox', dataSource: [{ value: 21, text: '芳香' }, { value: 22, text: '除异味' }] },
  { name: 'p-patent', label: '是否专利货源', required: true, uiType: 'select', dataSource: [{ value: 31, text: '是' }, { value: 32, text: '否' }] },
  { name: 'p-volt', label: '额定电压', required: true, uiType: 'input', unit: 'V', maxLength: 20 },
  { name: 'p-keep', label: '颜色分类', required: false, uiType: 'input' },
  ...extra,
] } }, priceRange: { fields: { required: true } }, saleProp: { fields: { dataSource: [{ name: 'p-2', propertyId: 2, label: '颜色', required: true, dataSource: [{ value: 10, text: '红色' }] }] } }, skuTable: { fields: { column: [] } } } })

let answers = good, repairAnswers: Answer[] = [], repairQueue: Answer[][] = [], repairTitle: string | undefined, malformed = false
let currentSchema: object = schema(), publishCalls = 0, offerSeq = 0, published: any = null
let rejections: Array<{ code: string; message?: string } | 'transport'> = []
const fillerFields: string[][] = [], repairInputs: any[] = []

const response = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })
const model = (value: unknown) => response({ model: 'qwen3.8-flash', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] })
const originalFetch = globalThis.fetch
globalThis.fetch = async (input, init) => {
  const url = String(input)
  if (url.startsWith('https://attribute-fixture.invalid/')) {
    const body = JSON.parse(String(init?.body)), system = String(body.messages[0].content), content = body.messages.at(-1).content
    const text = Array.isArray(content) ? content.find((part: any) => part.type === 'text').text : content
    if (system.includes('视觉检查器')) return model({ images: content.filter((p: any) => p.type === 'image_url').map((_: unknown, index: number) => ({ index, readable: true, companyWatermark: { detected: false, name: '', confidence: 0 }, famousBrandLogo: { detected: false, name: '', confidence: 0 } })) })
    if (system.includes('类目属性填写员')) { fillerFields.push(JSON.parse(text).fields.map((f: any) => f.label)); return model(malformed ? { nope: true } : { fields: answers, cannot: [] }) }
    if (system.includes('发布修复员')) { repairInputs.push(JSON.parse(text)); return model({ diagnosis: '平台认为香型不对', title: repairTitle, fields: repairQueue.shift() ?? repairAnswers, cannot: [] }) }
    return model({ title: '车载香薰测试商品', catProp: {}, unknown: ['香型'] })
  }
  assert.ok(url.startsWith('https://gw.open.1688.com/openapi/'), 'unexpected external request')
  if (url.includes('alibaba.new.product.getSchema')) return response({ result: { success: true, bizData: currentSchema } })
  if (url.includes('alibaba.new.product.add')) {
    publishCalls++; published = JSON.parse((init?.body as URLSearchParams).get('dataBody')!)
    const next = rejections.shift()
    if (next === 'transport') throw new Error('fixture timeout')
    if (next) return response({ result: { success: false, errorCode: next.code, errorMessage: next.message } })
    return response({ result: { success: true, bizData: { dataJson: JSON.stringify({ itemId: String(800000 + ++offerSeq), offerStatus: 'auditing' }) } } })
  }
  throw new Error(`unexpected mocked API ${url}`)
}

const app = await buildApp(), tenants: string[] = []
try {
  const facts = attributeFacts({ name: '车载香薰 12V 海洋香', description: '<p>风口款</p>', specifications: {} }, [], null)
  const fields = (values: object = {}) => fillRequiredAttributes(schema() as any, { catProp: values }, facts, [])

  // Each kind of field gets the treatment meant for it.
  const first = await fields()
  assert.deepEqual(fillerFields.at(-1), ['香型', '摆放方式', '功能', '额定电压'], 'brand and declarations never go through the model')
  assert.equal(first.values.catProp['p-brand'], '无品牌')
  assert.deepEqual(first.values.catProp['p-patent'], { value: 32, text: '否' })
  assert.deepEqual(first.values.catProp['p-scent'], { value: 2, text: '海洋' })
  assert.deepEqual(first.values.catProp['p-func'], [{ value: 21, text: '芳香' }, { value: 22, text: '除异味' }], 'an option the platform does not list is dropped')
  assert.equal(first.values.catProp['p-volt'], '12V')
  assert.equal(first.refused.length, 0)

  answers = [{ ...good[3], values: ['24V'] }]
  assert.equal((await fields()).values.catProp['p-volt'], undefined, 'a number the listing never states is refused')
  answers = [{ ...good[3], evidence: 'inferred' }]
  assert.match((await fields()).refused.find(r => r.name === 'p-volt')!.reason, /数值/)
  answers = [{ ...good[3], evidence: 'image', confidence: 0.7 }]
  assert.equal((await fields()).values.catProp['p-volt'], undefined, 'a number read off a picture needs high confidence')
  answers = [{ ...good[0], values: ['虚构香型'] }]
  assert.equal((await fields()).values.catProp['p-scent'], undefined, 'a value outside the options of a closed list is refused')
  answers = [{ ...good[1], values: ['吸盘式'] }]
  assert.deepEqual((await fields()).values.catProp['p-place'], { value: -1, text: '吸盘式', custom: true })
  answers = [{ ...good[0], confidence: 0.4 }]
  assert.equal((await fields()).values.catProp['p-scent'], undefined, 'low confidence is refused')
  answers = [{ ...good[0], values: ['森林'], evidence: 'default', confidence: 0 }]
  assert.equal((await fields()).values.catProp['p-scent'], undefined, 'a guess is only allowed for the 其它 option')
  answers = [{ ...good[0], values: ['其它'], evidence: 'default', confidence: 0 }]
  assert.deepEqual((await fields()).values.catProp['p-scent'], { value: 3, text: '其它' })
  answers = good
  assert.deepEqual((await fields({ 'p-scent': { value: 1, text: '森林' } })).values.catProp['p-scent'], { value: 1, text: '森林' }, 'what is already filled stays')
  malformed = true
  assert.equal((await fields()).values.catProp['p-scent'], undefined, 'an unusable answer fills nothing'); malformed = false

  assert.equal(isAttributeRejection(new IntegrationError('CHK_ATTR', 'x', 400)), true)
  assert.equal(isAttributeRejection(new IntegrationError('CHK_LOGISTICS_ITEM_NUM_ERROR', 'x', 400)), false)
  assert.equal(isAttributeRejection(new IntegrationError('isv.permission-denied', 'x')), false)
  assert.equal(isAttributeRejection(new Error('x')), false)

  // Through the real route and the mocked platform.
  for (let i = 0; i < 2; i++) tenants.push((await db.query('INSERT INTO tenants(name,slug)VALUES($1,$2)RETURNING id', ['属性填充测试', `attr-${randomUUID()}`])).rows[0].id)
  const tenant = tenants[0], actor = (await db.query("INSERT INTO users(tenant_id,email,display_name,status)VALUES($1,$2,'属性测试','active')RETURNING id", [tenant, `${randomUUID()}@fixture.local`])).rows[0].id
  const token = app.jwt.sign({ sub: actor, tenantId: tenant, email: 't', displayName: 't', permissions: ['*'], roles: [] })
  const request = (method: 'GET' | 'POST' | 'PUT', path: string, payload?: object) => app.inject({ method, url: `/api/integrations/1688${path}`, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}) })
  const connection = await saveConnection(tenant, actor, { aliId: `attr-${randomUUID()}`, access_token: 'fixture-access', expires_in: 36000 })
  assert.equal((await request('PUT', `/connections/${connection.id}/agent-settings`, { enabled: true, revision: 0, confirmed: true })).statusCode, 200)
  const draft = async () => {
    const product = (await db.query("INSERT INTO products(tenant_id,sku,name,description,base_price,base_currency,status,images)VALUES($1,$2,'车载香薰 12V 海洋香','风口款',12,'CNY','active',$3)RETURNING id", [tenant, `attr-${randomUUID()}`, JSON.stringify(['https://cbu01.alicdn.com/img/fixture.png'])])).rows[0]
    await db.query("INSERT INTO product_variants(tenant_id,product_id,position,label,attributes,unit_price,stock,image_url)VALUES($1,$2,0,'红色','{\"颜色\":\"红色\"}',15,7,'https://cbu01.alicdn.com/img/sku.png')", [tenant, product.id])
    const created = await request('POST', '/drafts', { connectionId: connection.id, productId: product.id, catId: '101', scene: 'cbu' })
    assert.equal(created.statusCode, 201, created.body)
    return created.json().data
  }
  const run = async (d: any) => { const result = await request('POST', `/drafts/${d.id}/agent`, { revision: d.revision }); assert.equal(result.statusCode, 200, result.body); return result.json().data }
  const draftStatus = async (id: string) => (await db.query('SELECT status FROM integration_1688_publish_drafts WHERE id=$1', [id])).rows[0].status

  const clean = await run(await draft())
  assert.equal(clean.status, 'published', clean.message)
  assert.equal(publishCalls, 1)
  assert.match(clean.message, /AI 代填 6 项/)
  assert.equal(clean.report.ai.filled.length, 6)
  assert.deepEqual(published.formValues.catProp['p-func'], [{ value: 21, text: '芳香' }, { value: 22, text: '除异味' }])
  assert.equal(published.formValues.skuTable[0].sku_price, 15, 'prices are not the AI’s to touch')

  // Rejected for a named attribute: corrected, sent again, published.
  publishCalls = 0; rejections = [{ code: 'CHK_ATTR_VALUE', message: '属性香型取值错误' }]
  repairAnswers = [{ name: 'p-scent', values: ['森林'], evidence: 'inferred', confidence: 0.8, reason: '改选' }, { name: 'p-keep', values: ['红'], evidence: 'title', confidence: 0.9, reason: '无关字段' }]
  const repaired = await run(await draft())
  assert.equal(repaired.status, 'published', repaired.message); assert.equal(publishCalls, 2)
  assert.deepEqual(published.formValues.catProp['p-scent'], { value: 1, text: '森林' })
  assert.deepEqual([repairInputs.at(-1).platformError.code, repairInputs.at(-1).platformError.detail], ['CHK_ATTR_VALUE', '属性香型取值错误'], 'the model reads the platform’s own words')
  assert.equal(repaired.report.ai.repairs[0].changed.includes('香型'), true)
  assert.match(repaired.message, /自动修复 1 次/)

  // A title rejection may shorten the title, never lengthen it.
  publishCalls = 0; rejections = [{ code: 'CHK_BASIC_LENGTH_LONG_BYTE', message: '标题过长' }]; repairAnswers = []; repairTitle = '车载香薰'
  const shortened = await run(await draft())
  assert.equal(shortened.status, 'published', shortened.message); assert.equal(published.formValues.title, '车载香薰')
  publishCalls = 0; rejections = [{ code: 'CHK_BASIC_LENGTH_LONG_BYTE', message: '标题过长' }]; repairTitle = '车载香薰测试商品加上更多更多更多宣传词'
  const longer = await run(await draft())
  assert.equal(longer.status, 'blocked'); assert.equal(publishCalls, 1); assert.match(longer.message, /未找到可修改/); repairTitle = undefined

  // Repairs are bounded, and each try really changes something.
  publishCalls = 0; rejections = [{ code: 'CHK_ATTR', message: '属性香型错误' }, { code: 'CHK_ATTR', message: '属性香型错误' }, { code: 'CHK_ATTR', message: '属性香型错误' }, { code: 'CHK_ATTR', message: '属性香型错误' }]
  const rounds = [['森林'], ['其它'], ['海洋']]
  const target = await draft()
  repairQueue = rounds.map(values => [{ name: 'p-scent', values, evidence: 'inferred', confidence: 0.8, reason: '再试' }])
  const exhausted = await run(target)
  assert.equal(exhausted.status, 'blocked'); assert.equal(publishCalls, 3, 'at most two repairs'); assert.match(exhausted.message, /重试 2 次/)
  assert.equal(await draftStatus(target.id), 'failed')
  repairQueue = []

  // Refused without a reason: the platform's own answer is kept in the message for diagnosis.
  publishCalls = 0; rejections = [{ code: 'CHK_WHOLESALE_PRICE_RANGE_BEGIN_LIMIT' }]; repairAnswers = []
  const silent = await run(await draft())
  assert.equal(silent.status, 'blocked'); assert.match(silent.message, /平台原始返回：.*CHK_WHOLESALE_PRICE_RANGE_BEGIN_LIMIT/)

  // Not about the listing's content: never sent twice.
  publishCalls = 0; rejections = [{ code: 'isv.permission-denied' }]
  assert.equal((await run(await draft())).status, 'blocked'); assert.equal(publishCalls, 1)
  // Whether it reached the shop is unknown: never sent twice.
  publishCalls = 0; rejections = ['transport']
  const uncertainDraft = await draft()
  assert.equal((await run(uncertainDraft)).status, 'unknown'); assert.equal(publishCalls, 1); assert.equal(await draftStatus(uncertainDraft.id), 'unknown')

  // A licence number is a person's job.
  currentSchema = schema([{ name: 'p-cert', label: '生产许可证编号', required: true, uiType: 'input' }]); publishCalls = 0
  const licensed = await draft()
  const blocked = await run(licensed)
  assert.equal(blocked.status, 'blocked'); assert.equal(publishCalls, 0); assert.match(blocked.message, /生产许可证编号（涉及资质/)
  assert.ok(!fillerFields.at(-1)!.includes('生产许可证编号'))

  // A job blocked after its draft exists can run again, and resumes from the draft.
  currentSchema = schema()
  await db.query('UPDATE integration_1688_publish_drafts SET platform_schema=$2 WHERE id=$1', [licensed.id, JSON.stringify(currentSchema)])
  assert.equal((await request('PUT', `/connections/${connection.id}/agent-queue-settings`, { enabled: true, revision: 0, confirmed: true })).statusCode, 200)
  const queued = async (draftId: string, productId: string) => {
    const source = (await db.query("INSERT INTO collected_products(tenant_id,source,source_product_id,source_url,title,main_image_url,gallery_images,detail_images,currency,attributes,source_category_id,product_id,collected_by)VALUES($1,'1688',$2,$3,'车载香薰','https://cbu01.alicdn.com/img/fixture.png','[]','[]','CNY','{}','101',$4,$5)RETURNING id,updated_at", [tenant, randomUUID(), `https://detail.1688.com/offer/${randomUUID()}.html`, productId, actor])).rows[0]
    return (await db.query("INSERT INTO integration_1688_collection_queue_jobs(tenant_id,connection_id,collected_product_id,actor_id,source_updated_at,status,phase,product_id,draft_id,message)VALUES($1,$2,$3,$4,$5,'blocked','publishing',$6,$7,'发布规则未通过：品牌')RETURNING id", [tenant, connection.id, source.id, actor, source.updated_at, productId, draftId])).rows[0].id as string
  }
  publishCalls = 0
  const jobId = await queued(licensed.id, licensed.product_id)
  assert.equal((await request('POST', `/agent/queue-jobs/${jobId}/retry`, {})).statusCode, 200)
  const workerId = randomUUID()
  await db.query("UPDATE integration_1688_collection_queue_jobs SET status='processing',worker_id=$2,lease_until=now()+interval '1 hour',attempts=1 WHERE id=$1", [jobId, workerId])
  assert.equal(await runClaimedCollectionQueueJob(jobId, workerId), true)
  const finished = (await request('GET', '/agent/queue')).json().data.jobs.find((j: any) => j.id === jobId)
  assert.equal(finished.status, 'published', finished.message); assert.equal(publishCalls, 1)
  assert.equal(finished.ai_fill.filled.length, 6, 'the queue shows what AI wrote')

  const unknownJob = await queued(uncertainDraft.id, uncertainDraft.product_id)
  assert.equal((await request('POST', `/agent/queue-jobs/${unknownJob}/retry`, {})).statusCode, 409, 'a draft that may have reached the shop cannot be retried')
  console.log(JSON.stringify({ groundingRules: 'ok', brandAndDeclarationsByRule: 'ok', multiSelect: 'ok', measuredValues: 'ok', fillAndPublish: 'ok', repairFromPlatformReason: 'ok', titleOnlyShorter: 'ok', repairBounded: 'ok', nonContentNoResend: 'ok', unknownNoResend: 'ok', licenceBlocked: 'ok', resumeFromDraft: 'ok', livePlatformWrites: 0 }))
} finally {
  globalThis.fetch = originalFetch
  for (const id of tenants) { await db.query('DELETE FROM audit_logs WHERE tenant_id=$1', [id]); await db.query('DELETE FROM tenants WHERE id=$1', [id]) }
  await app.close(); await db.end()
}
