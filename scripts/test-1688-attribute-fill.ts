import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

// AI filling of required attributes and repair after a platform rejection. Every model and platform call is mocked.
process.env.DASHSCOPE_API_KEY = 'attribute-fixture-key'
process.env.DASHSCOPE_BASE_URL = 'https://attribute-fixture.invalid/compatible-mode/v1'
const [{ buildApp }, { db }, { saveConnection, IntegrationError }, { runClaimedCollectionQueueJob }, { fillRequiredAttributes, estimateMissingRequiredAttributes, isAttributeRejection, attributeFacts }] = await Promise.all([import('../server/app.js'), import('../server/db.js'), import('../server/integrations/1688.js'), import('../server/integrations/1688-collection-queue.js'), import('../server/integrations/1688-attribute-fill.js')])

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
let rejections: Array<{ code: string; message?: string; form?: string } | 'transport'> = []
let fillerAnswerQueue: Answer[][] = []
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
    if (system.includes('类目属性填写员')) { fillerFields.push(JSON.parse(text).fields.map((f: any) => f.label)); return model(malformed ? { nope: true } : { fields: fillerAnswerQueue.shift() ?? answers, cannot: [] }) }
    if (system.includes('发布修复员')) { repairInputs.push(JSON.parse(text)); return model({ diagnosis: '平台认为香型不对', title: repairTitle, fields: repairQueue.shift() ?? repairAnswers, cannot: [] }) }
    return model({ title: '车载香薰测试商品', catProp: {}, unknown: ['香型'] })
  }
  assert.ok(url.startsWith('https://gw.open.1688.com/openapi/'), 'unexpected external request')
  if (url.includes('alibaba.new.product.getSchema')) return response({ result: { success: true, bizData: currentSchema } })
  if (url.includes('alibaba.new.product.add')) {
    publishCalls++; published = JSON.parse((init?.body as URLSearchParams).get('dataBody')!)
    const next = rejections.shift()
    if (next === 'transport') throw new Error('fixture timeout')
    if (next?.form) return response({ result: { success: false, bizCode: next.code, bizMsg: next.message, bizData: { dataJson: JSON.stringify({ data: { models: { formError: { beginAmount: { message: [{ type: 'error', code: next.code, msg: next.form }] } } } } }) } } })
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
  assert.equal(first.values.catProp['p-volt'], '12')
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

  // The source already states the voltage: even an empty model answer cannot lose it.
  const sourceFacts = attributeFacts({ name: '手持吸尘器', specifications: {} }, [], { attributes: { 额定电压: '11.1（V）', 颜色分类: '银紫色' } })
  answers = []
  const sourceFilled = await fillRequiredAttributes(schema() as any, { catProp: {} }, sourceFacts, [])
  assert.equal(sourceFilled.values.catProp['p-volt'], '11.1')
  assert.equal(sourceFilled.values.catProp['p-keep'], '银紫色', 'optional source attributes are copied too')
  assert.equal(sourceFilled.refused.some(r => r.name === 'p-volt'), false)
  assert.ok(sourceFilled.filled.some(f => f.name === 'p-volt' && f.evidence === 'attributes'))
  const beforeRetry = fillerFields.length
  fillerAnswerQueue = [[], good]
  const retried = await fields()
  assert.equal(retried.values.catProp['p-volt'], '12')
  assert.equal(retried.refused.length, 0, 'retry clears earlier missing reasons')
  assert.equal(fillerFields.length - beforeRetry, 2, 'only one missing-field retry')
  answers = good

  // Estimation is a separate bounded fallback: it accepts ungrounded measurements,
  // keeps existing values, and never sends credentials or optional attributes to the model.
  const estimateSchema = schema([{ name: 'p-cert', label: '生产许可证编号', required: true, uiType: 'input' }])
  const kept = { ...first.values.catProp, 'p-volt': undefined }
  answers = [{ ...good[3], values: ['24V'], confidence: 0.2, evidence: 'attributes', reason: '同类产品常见电压' }]
  const estimated = await estimateMissingRequiredAttributes(estimateSchema, { catProp: kept }, facts, [])
  assert.equal(estimated.values.catProp['p-volt'], '24')
  assert.equal(estimated.filled[0].evidence, 'estimated', 'fallback never represents guesses as collected facts')
  assert.match(estimated.filled[0].reason, /待人工审核/)
  assert.equal(estimated.values.catProp['p-cert'], undefined)
  assert.deepEqual(fillerFields.at(-1), ['额定电压'])
  answers = [{ ...good[3], values: ['未知'] }]
  const estimateCalls = fillerFields.length
  const failedEstimate = await estimateMissingRequiredAttributes(schema(), { catProp: kept }, facts, [])
  assert.equal(failedEstimate.values.catProp['p-volt'], undefined)
  assert.equal(fillerFields.length - estimateCalls, 2, 'estimation cannot loop forever')
  answers = [{ ...good[0], values: ['非法选项'], confidence: 0.1 }]
  const badOption = await estimateMissingRequiredAttributes(schema(), { catProp: { ...first.values.catProp, 'p-scent': undefined } }, facts, [])
  assert.equal(badOption.values.catProp['p-scent'], undefined, 'estimation still respects closed platform options')
  answers = good

  assert.equal(isAttributeRejection(new IntegrationError('CHK_ATTR', 'x', 400)), true)
  assert.equal(isAttributeRejection(new IntegrationError('CHK_LOGISTICS_ITEM_NUM_ERROR', 'x', 400)), false)
  assert.equal(isAttributeRejection(new IntegrationError('isv.permission-denied', 'x')), false)
  assert.equal(isAttributeRejection(new Error('x')), false)

  // Through the real route and the mocked platform.
  for (let i = 0; i < 2; i++) tenants.push((await db.query('INSERT INTO tenants(name,slug)VALUES($1,$2)RETURNING id', ['属性填充测试', `attr-${randomUUID()}`])).rows[0].id)
  const tenant = tenants[0], actor = (await db.query("INSERT INTO users(tenant_id,email,display_name,status)VALUES($1,$2,'属性测试','active')RETURNING id", [tenant, `${randomUUID()}@fixture.local`])).rows[0].id
  // Listing collected products costs team credits; this team has enough for the whole test.
  await db.query('INSERT INTO team_ai_settings(owner_user_id,tenant_id,credits) VALUES($1,$2,1000)', [actor, tenant])
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
  assert.equal((await db.query('SELECT data_body FROM integration_1688_publish_drafts WHERE status=$1 ORDER BY updated_at DESC LIMIT 1', ['published'])).rows[0].data_body.formValues.skuTable[0].sku_price, 15, 'prices are not the AI’s to touch')
  assert.equal(published.formValues.skuTable[0].sku_price, 15)

  // End to end: a collected product from a different category supplies voltage,
  // even though the model does not answer that field at all.
  const voltageDraft = await draft()
  await db.query("INSERT INTO collected_products(tenant_id,source,source_product_id,source_url,title,currency,attributes,source_category_id,product_id,collected_by)VALUES($1,'1688',$2,$3,'手持吸尘器','CNY',$4,'different-category',$5,$6)", [tenant, randomUUID(), 'https://detail.1688.com/offer/fixture.html', JSON.stringify({额定电压:'11.1（V）'}), voltageDraft.product_id, actor])
  answers = good.filter(a => a.name !== 'p-volt')
  const voltagePublished = await run(voltageDraft)
  assert.equal(voltagePublished.status, 'published', voltagePublished.message)
  assert.equal(published.formValues.catProp['p-volt'], '11.1')
  assert.ok(!fillerFields.at(-1)!.includes('额定电压'), 'known voltage never depends on the model')
  answers = good

  // Local missing-field failure is repaired before publishing with an explicit review warning.
  publishCalls = 0
  const guessedDraft = await draft()
  await db.query("UPDATE products SET name='手持吸尘器',description='无线款' WHERE id=$1", [guessedDraft.product_id])
  fillerAnswerQueue = [good.filter(a => a.name !== 'p-volt'), [], [{ ...good[3], values: ['11.1V'], evidence: 'inferred', confidence: 0.3, reason: '同类无线吸尘器常见电压' }]]
  const guessedPublished = await run(guessedDraft)
  assert.equal(guessedPublished.status, 'published', guessedPublished.message)
  assert.equal(publishCalls, 1, 'no need to send an incomplete listing first')
  assert.equal(published.formValues.catProp['p-volt'], '11.1')
  assert.equal(guessedPublished.report.ai.filled.find((f: any) => f.name === 'p-volt').evidence, 'estimated')
  assert.equal(guessedPublished.report.ai.refused.some((f: any) => f.name === 'p-volt'), false)
  assert.match(guessedPublished.message, /1 项为 AI 推测.*人工审核/)

  // The platform may require a field the schema marks optional: infer it after a definite rejection and resend.
  currentSchema = schema([{ name: 'p-current', label: '额定电流', required: false, uiType: 'input', unit: 'A' }])
  publishCalls = 0; rejections = [{ code: 'CHK_ATTR_REQUIRED', message: '属性额定电流不能为空' }]
  repairAnswers = [{ name: 'p-current', values: ['2A'], evidence: 'inferred', confidence: 0.2, reason: '按同类产品推测' }]
  const platformMissing = await run(await draft())
  assert.equal(platformMissing.status, 'published', platformMissing.message)
  assert.equal(publishCalls, 2)
  assert.equal(published.formValues.catProp['p-current'], '2')
  assert.equal(platformMissing.report.ai.filled.find((f: any) => f.name === 'p-current').evidence, 'estimated')
  assert.ok(repairInputs.at(-1).estimateFields.includes('p-current'))
  currentSchema = schema(); repairAnswers = []

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

  // The platform's own words (bizMsg / form errors) are shown; a wholesale-quantity rejection is not the AI's to repair.
  publishCalls = 0; rejections = [{ code: 'CHK_WHOLESALE_BEGIN_AMOUNT_LIMIT', message: '批发起订量必须大于等于2，请在发布页修改。', form: '批发起订量必须大于等于2，请在发布页修改。' }]
  const wholesale = await run(await draft())
  assert.equal(wholesale.status, 'blocked'); assert.equal(publishCalls, 1, 'not resent by the AI repair')
  assert.match(wholesale.message, /1688 拒绝发布（CHK_WHOLESALE_BEGIN_AMOUNT_LIMIT）：批发起订量必须大于等于2/)
  assert.ok(published.formValues.beginAmount >= 2 && published.formValues.priceRange.every((r: any) => r.pricerange_beginAmount >= 2), 'a minimum order of 1 is never sent')

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

  // Running AI directly from a previously blocked draft must synchronize its queue too.
  const directDraft = await draft()
  const directJob = await queued(directDraft.id, directDraft.product_id)
  const directResult = await run(directDraft)
  assert.equal(directResult.status, 'published', directResult.message)
  const directQueue = (await request('GET', '/agent/queue')).json().data.jobs.find((j: any) => j.id === directJob)
  assert.equal(directQueue.status, 'published')
  assert.doesNotMatch(directQueue.message, /未通过/)
  const directSource = (await db.query('SELECT processing_status FROM collected_products WHERE product_id=$1', [directDraft.product_id])).rows[0]
  assert.equal(directSource.processing_status, 'published')
  const completedWorker = (await db.query('SELECT worker_id,lease_until FROM integration_1688_collection_queue_jobs WHERE id=$1', [jobId])).rows[0]
  assert.equal(completedWorker.worker_id, null, 'worker still finishes and releases the lease after the publication trigger')
  assert.equal(completedWorker.lease_until, null)

  const unknownJob = await queued(uncertainDraft.id, uncertainDraft.product_id)
  assert.equal((await request('POST', `/agent/queue-jobs/${unknownJob}/retry`, {})).statusCode, 409, 'a draft that may have reached the shop cannot be retried')
  console.log(JSON.stringify({ groundingRules: 'ok', brandAndDeclarationsByRule: 'ok', multiSelect: 'ok', measuredValues: 'ok', estimatedMissingBeforePublish: 'ok', estimatedPlatformMissing: 'ok', estimatesMarkedForReview: 'ok', estimationBounded: 'ok', fillAndPublish: 'ok', repairFromPlatformReason: 'ok', titleOnlyShorter: 'ok', repairBounded: 'ok', nonContentNoResend: 'ok', unknownNoResend: 'ok', licenceBlocked: 'ok', resumeFromDraft: 'ok', directAgentStatusSync: 'ok', workerReportPreserved: 'ok', livePlatformWrites: 0 }))
} finally {
  globalThis.fetch = originalFetch
  for (const id of tenants) { await db.query('DELETE FROM audit_logs WHERE tenant_id=$1', [id]); await db.query('DELETE FROM tenants WHERE id=$1', [id]) }
  await app.close(); await db.end()
}
