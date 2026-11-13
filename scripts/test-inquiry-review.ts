import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { buildApp } from '../server/app.js'
import { db } from '../server/db.js'
import { saveConnection } from '../server/integrations/1688.js'
import { enqueueDueRuns, enqueueReviewRun, purgeReviewExcerpts, refreshSessionProducts, runChatReviewOnce, validateReviewOutput } from '../server/integrations/chat-review.js'
import { runTool } from '../server/integrations/ai-assistant-tools.js'

// What the model says is only kept if it can be traced to a message.
const timeline = [{ ref: 'm1', uuid: 'u1', who: 'buyer' as const, text: null }, { ref: 'm2', uuid: 'u2', who: 'agent' as const, text: '这款功率是 80W' }]
const facts = [{ facts: { 功率: '60W' } }]
const check = (value: object) => validateReviewOutput(JSON.stringify(value), timeline, facts)
assert.deepEqual(check({ loss_code: 'price', confidence: 'high', loss_ref: 'm2', findings: [], coaching: '' }).confidence, 'medium', 'never above medium: the buyer cannot be read')
assert.equal(check({ loss_code: 'price', confidence: 'low', loss_ref: '', findings: [] }).lossCode, 'unknown', 'a reason with no cited message is not a reason')
assert.equal(check({ loss_code: 'price', confidence: 'low', loss_ref: 'm99', findings: [] }).lossCode, 'unknown')
assert.equal(check({ loss_code: 'no_reply', confidence: 'medium', loss_ref: 'm2', findings: [] }).lossCode, 'unknown', 'rule-decided reasons are not the model’s to give')
assert.equal(check({ loss_code: '编的原因', confidence: 'medium', loss_ref: 'm2', findings: [] }).lossCode, 'unknown')
const findings = check({ loss_code: 'unknown', findings: [
  { type: 'wrong_fact', ref: 'm2', summary: '功率与资料不符', fact_label: '功率' }, { type: 'wrong_fact', ref: 'm2', summary: '资料里没有这项', fact_label: '重量' },
  { type: 'cannot_answer', ref: 'm1', summary: '引用了买家消息' }, { type: 'cannot_answer', ref: 'm9', summary: '不存在的消息' }, { type: 'other_issue', ref: 'm2', summary: '买家说太贵了' }, { type: 'made_up', ref: 'm2', summary: 'x' },
] }).findings
assert.deepEqual(findings, [{ type: 'wrong_fact', summary: '功率与资料不符', message_uuid: 'u2', excerpt: '这款功率是 80W', fact_ref: '功率' }])
assert.throws(() => validateReviewOutput('这不是 JSON', timeline, facts))

const DAY = 86_400_000
const dateAgo = (days: number) => new Date(Date.now() + 8 * 3_600_000 - days * DAY).toISOString().slice(0, 10)
const D = dateAgo(5), Y = dateAgo(1)
const at = (date: string, time: string) => `${date}T${time}+08:00`

const originalFetch = globalThis.fetch
const modelCalls: { model: string; messages: { role: string; content: string }[] }[] = []
let modelReply: (prompt: string) => object | string = () => ({ loss_code: 'unknown', confidence: 'low', loss_ref: '', findings: [], coaching: '' })
globalThis.fetch = async (input, init) => {
  const url = String(input)
  assert.ok(url.startsWith('https://model.example.test/'), `unexpected network call ${url}`)
  const body = JSON.parse(String(init!.body))
  modelCalls.push(body)
  const reply = modelReply(body.messages.at(-1).content)
  if (reply === 'FAIL') return new Response(JSON.stringify({ error: { message: 'down' } }), { status: 500 })
  return new Response(JSON.stringify({ model: body.model, usage: { prompt_tokens: 100, completion_tokens: 20 }, choices: [{ message: { content: typeof reply === 'string' ? reply : JSON.stringify(reply) }, finish_reason: 'stop' }] }), { status: 200 })
}

const app = await buildApp(), tenants: string[] = []
try {
  const marker = randomUUID().slice(0, 8)
  for (let i = 0; i < 2; i++) tenants.push((await db.query('INSERT INTO tenants(name,slug)VALUES($1,$2)RETURNING id', ['复盘测试', `review-${marker}-${i}`])).rows[0].id)
  const tenant = tenants[0]
  const user = async (name: string) => (await db.query("INSERT INTO users(tenant_id,email,password_hash,display_name,status)VALUES($1,$2,'x',$3,'active')RETURNING id", [tenant, `${randomUUID()}@review.test`, name])).rows[0].id as string
  const [boss, agentUser, otherUser] = [await user('主管'), await user('客服甲秘密姓名'), await user('客服乙')]
  const auth = (sub: string, permissions: string[], t = tenant) => ({ authorization: `Bearer ${app.jwt.sign({ sub, tenantId: t, email: 't', displayName: 't', roles: [], permissions })}` })
  const supervisor = auth(boss, ['performance:read', 'performance:review', 'performance:manage']), admin = auth(boss, ['*'])
  const own = auth(agentUser, ['performance:read_own']), otherAgent = auth(otherUser, ['performance:read_own']), finance = auth(otherUser, ['performance:read', 'payroll:read']), executive = auth(otherUser, ['performance:read', 'performance:review_read'])
  const base = '/api/integrations/1688/performance'
  const call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, headers: Record<string, string>, payload?: object) => app.inject({ method, url: `${base}${url}`, headers, ...(payload ? { payload } : {}) })

  const conn = await saveConnection(tenant, boss, { access_token: 'a', refresh_token: 'r', expires_in: 36000, aliId: `review-${marker}`, resource_owner: 'shop', refresh_token_timeout: '20991231000000000+0800' }, Date.now(), 'performance')
  const agent = (await db.query("INSERT INTO perf_agents(tenant_id,connection_id,login_id,is_main,user_id) VALUES($1,$2,'shop:甲',false,$3) RETURNING id", [tenant, conn.id, agentUser])).rows[0].id as string
  const agent2 = (await db.query("INSERT INTO perf_agents(tenant_id,connection_id,login_id,is_main,user_id) VALUES($1,$2,'shop:乙',false,$3) RETURNING id", [tenant, conn.id, otherUser])).rows[0].id as string
  const buyer = async (key: string) => (await db.query('INSERT INTO perf_buyers(tenant_id,connection_id,buyer_key,open_uid,first_chat_at,last_chat_at) VALUES($1,$2,$3,$3,now(),now()) RETURNING id', [tenant, conn.id, key])).rows[0].id as string
  const [b1, b2, b3, b4] = [await buyer(`secret-buyer-${marker}-1`), await buyer(`secret-buyer-${marker}-2`), await buyer(`secret-buyer-${marker}-3`), await buyer(`secret-buyer-${marker}-4`)]
  for (const [key, id] of [b1, b2, b3, b4].entries()) await db.query('INSERT INTO perf_buyer_identities(connection_id,open_uid,buyer_id)VALUES($1,$2,$3)', [conn.id, `secret-buyer-${marker}-${key + 1}`, id])
  type Message = { uuid: string; dir: 0 | 1; at: string; text?: string; chars?: number; offers?: string[]; keywords?: string[]; flags?: string[]; length?: number; types?: string[] }
  async function session(agentId: string, buyerId: string, date: string, cid: string, messages: Message[], reply: { at: string; replyAt: string | null } | null, counts: { agent?: number; other?: number } = {}) {
    const id = (await db.query(`INSERT INTO perf_chat_sessions(tenant_id,connection_id,agent_id,buyer_id,cid,chat_date,last_peer_at,needs_sync,buyer_messages,agent_messages,other_agent_messages)VALUES($1,$2,$3,$4,$5,$6,$7,false,$8,$9,$10)RETURNING id`,
      [tenant, conn.id, agentId, buyerId, cid, date, messages.at(-1)!.at, messages.filter(m => m.dir === 1).length, counts.agent ?? messages.filter(m => m.dir === 0).length, counts.other ?? 0])).rows[0].id as string
    for (const m of messages) await db.query(`INSERT INTO perf_chat_messages(tenant_id,connection_id,session_id,uuid,direction,sent_at,length,message_types,keywords,text_masked,char_count,flags,linked_offer_ids)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [tenant, conn.id, id, m.uuid, m.dir, m.at, m.length ?? 0, m.types ?? ['正常消息'], JSON.stringify((m.keywords ?? []).map(word => ({ word, count: 1 }))), m.text ?? null, m.text ? m.chars ?? [...m.text].length : m.dir === 0 ? 0 : null, m.flags ?? [], m.offers ?? []])
    if (reply) for (const mode of ['strict', 'loose']) await db.query('INSERT INTO perf_chat_turns(tenant_id,session_id,mode,turn_index,turn_at,reply_at,buyer_messages)VALUES($1,$2,$3,0,$4,$5,1)', [tenant, id, mode, reply.at, reply.replyAt])
    return id
  }
  await db.query('INSERT INTO perf_settings(tenant_id,work_hours_enabled) VALUES($1,false) ON CONFLICT(tenant_id) DO UPDATE SET work_hours_enabled=false', [tenant])
  const noReply = await session(agent, b1, D, 'c1', [{ uuid: `${marker}-a1`, dir: 1, at: at(D, '10:00:00'), length: 12 }], { at: at(D, '10:00:00'), replyAt: null })
  const OFFER = '712345678901'
  const lost = await session(agent, b2, D, 'c2', [
    { uuid: `${marker}-b1`, dir: 1, at: at(D, '11:00:00'), length: 20, keywords: ['太贵'] },
    { uuid: `${marker}-b2`, dir: 0, at: at(D, '11:00:30'), text: '亲这款是我们家的新款，功率是八十瓦的，已经是最低价了哦，您可以再看看对比一下', offers: [OFFER], flags: [] },
  ], { at: at(D, '11:00:00'), replyAt: at(D, '11:00:30') })
  const orderId = `9${Date.now()}`
  const paid = await session(agent, b3, D, 'c3', [{ uuid: `${marker}-c1`, dir: 1, at: at(D, '12:00:00'), length: 8 }, { uuid: `${marker}-c2`, dir: 0, at: at(D, '12:00:10'), text: '好的亲，马上给您安排发货' }], { at: at(D, '12:00:00'), replyAt: at(D, '12:00:10') })
  await db.query(`INSERT INTO perf_orders(tenant_id,connection_id,order_id,buyer_open_uid,status,total_amount,placed_at,paid_at,items)VALUES($1,$2,$3,$4,'success',88.8,$5,$5,$6)`,
    [tenant, conn.id, orderId, `secret-buyer-${marker}-3`, at(D, '13:00:00'), JSON.stringify([{ productId: '555555', name: '成交商品', quantity: 1 }])])
  await db.query(`INSERT INTO perf_refunds(tenant_id,connection_id,refund_id,order_id,status,apply_reason,applied_at)VALUES($1,$2,$3,$4,'refundsuccess','不想买了',$5)`, [tenant, conn.id, `r${marker}`, orderId, at(D, '15:00:00')])
  const TEMPLATE = '亲，是还有什么问题嘛，您这边下单后我们会尽快给您安排发货的哈'
  const templated = await session(agent2, b4, D, 'c4', [{ uuid: `${marker}-d1`, dir: 1, at: at(D, '14:00:00'), length: 6 }, { uuid: `${marker}-d2`, dir: 0, at: at(D, '14:00:05'), text: TEMPLATE }], { at: at(D, '14:00:00'), replyAt: at(D, '14:00:05') })
  // The same wording elsewhere makes it a template.
  for (let i = 0; i < 5; i++) await session(agent2, await buyer(`filler-${marker}-${i}`), dateAgo(10), `f${i}`, [{ uuid: `${marker}-f${i}`, dir: 0, at: at(dateAgo(10), '09:00:00'), text: TEMPLATE }], null)

  // Permissions: reviews are for supervisors. Finance reads performance figures but not these.
  const worklist = (headers = supervisor, extra = '') => call('GET', `/inquiry-review/worklist?connectionId=${conn.id}&from=${D}&to=${D}${extra}`, headers)
  assert.equal((await worklist(own)).statusCode, 403)
  assert.equal((await worklist(finance)).statusCode, 403, 'finance gets no AI inferences')
  assert.equal((await worklist(executive)).statusCode, 200)
  assert.equal((await worklist(auth(boss, ['*'], tenants[1]))).statusCode, 404, 'another tenant')

  await refreshSessionProducts(tenant, conn.id, D, D)
  const first = (await worklist()).json()
  const row = (id: string) => first.data.find((r: { id: string }) => r.id === id)
  assert.equal(row(paid), undefined, 'paid sessions are not on the list')
  assert.equal(row(noReply).rule_loss_code, 'no_reply')
  assert.equal(first.data[0].id, noReply, 'unanswered comes first')
  assert.deepEqual([row(lost).evidence_level, row(lost).products[0].offer_id, row(lost).products[0].confidence, row(lost).keywords], ['sufficient', OFFER, 'high', ['太贵']])
  assert.deepEqual([row(templated).real_chars, row(templated).evidence_level, row(templated).template_messages], [0, 'rules_only', 1], 'a repeated template says nothing about the person')
  assert.equal(first.totals.lost, 3)
  const links = (await db.query("SELECT source,offer_id,confidence FROM chat_session_products WHERE session_id=$1 ORDER BY source", [paid])).rows
  assert.deepEqual(links, [{ source: 'order_after', offer_id: '555555', confidence: 'high' }], 'orders link what was bought')
  assert.equal((await call('GET', `/inquiry/products?connectionId=${conn.id}&from=${D}&to=${D}`, supervisor)).json().data.products.find((p: { offer_id: string }) => p.offer_id === '555555').refunds, 1)
  const products = (await call('GET', `/inquiry/products?connectionId=${conn.id}&from=${D}&to=${D}`, supervisor)).json().data
  assert.deepEqual(products.products.find((p: { offer_id: string }) => p.offer_id === '555555').refund_reasons, ['不想买了'])
  assert.ok(products.coverage.no_order_linked < products.coverage.no_order, 'coverage shows what is missing')

  // Off by default: a run produces figures and links, and calls no model.
  assert.equal(modelCalls.length, 0)
  await enqueueReviewRun(tenant, conn.id, D)
  const off = await runChatReviewOnce() as { analyzed: number; aiEnabled: boolean; briefs: number }
  assert.deepEqual([off.aiEnabled, off.analyzed, modelCalls.length], [false, 0, 0], 'no model call until the shop turns it on')
  assert.ok(off.briefs >= 2)
  assert.equal((await db.query('SELECT stats->$2->>$3 AS n FROM chat_agent_daily_briefs WHERE agent_id=$1 AND brief_date=$4', [agent, 'today', 'no_reply', D])).rows[0].n, '1')

  // Scheduled reviews use the super administrator's team text model (there is no model choice in the settings any more).
  const superRole = (await db.query(`INSERT INTO roles(tenant_id,code,name,permissions) VALUES($1,'super_admin','超级管理员','["*"]') RETURNING id`, [tenant])).rows[0].id
  await db.query('INSERT INTO user_roles(user_id,role_id) VALUES($1,$2)', [boss, superRole])
  await db.query("INSERT INTO team_ai_settings(owner_user_id,tenant_id,text_model) VALUES($1,$2,'qwen3.7-flash')", [boss, tenant])
  // Settings: only managers change them.
  const settings = { enabled: true, dailySessionLimit: 10, minRealChars: 20 }
  assert.equal((await call('PUT', '/inquiry-review/settings', auth(boss, ['performance:read', 'performance:review']), settings)).statusCode, 403)
  assert.equal((await call('PUT', '/inquiry-review/settings', supervisor, settings)).statusCode, 200)

  modelReply = () => ({ loss_code: 'price', confidence: 'high', loss_ref: 'm2', findings: [{ type: 'wrong_fact', ref: 'm2', summary: '功率说法与资料不符', fact_label: '功率' }, { type: 'no_followup', ref: 'm2', summary: '没有主动推荐阶梯价' }], coaching: '先核对参数再报价' })
  await enqueueReviewRun(tenant, conn.id, D)
  const on = await runChatReviewOnce() as { analyzed: number; candidates: number; inputTokens: number; failed: number }
  assert.deepEqual([on.candidates, on.analyzed, on.failed], [1, 1, 0], 'only the session with real text goes to the model; unanswered and template-only ones do not')
  assert.equal(on.inputTokens, 100)
  assert.equal(modelCalls[0].model, 'qwen3.7-flash')
  const prompt = JSON.stringify(modelCalls[0].messages)
  assert.ok(prompt.includes('功率是八十瓦') && prompt.includes('太贵'), 'the prompt has the agent text and keyword hits')
  for (const secret of ['secret-buyer', '客服甲秘密姓名', 'shop:甲', '88.8']) assert.ok(!prompt.includes(secret), `the prompt must not contain ${secret}`)

  // A pending result: visible to reviewers, invisible to the agent, and not in the statistics.
  const detail = (headers: Record<string, string>, id = lost) => call('GET', `/inquiry-review/sessions/${id}`, headers)
  const pending = (await detail(supervisor)).json().data
  assert.deepEqual([pending.review.status, pending.review.ai_loss_code, pending.review.ai_loss_confidence, pending.review.model, pending.review.prompt_version], ['pending', 'price', 'medium', 'qwen3.7-flash', 'chat-review-1'])
  assert.deepEqual(pending.review.ai_findings.map((f: { type: string }) => f.type), ['no_followup'], 'no product facts on file, so “wrong fact” is dropped')
  const unpublished = await detail(own)
  assert.equal(unpublished.statusCode, 200)
  assert.equal(unpublished.json().data.review, null, 'an agent does not see an AI guess before a supervisor has decided')
  assert.equal((await detail(otherAgent)).statusCode, 404)
  assert.equal((await detail(finance)).statusCode, 404)
  const analysis = async (extra = '') => (await call('GET', `/inquiry/loss-analysis?connectionId=${conn.id}&from=${D}&to=${D}${extra}`, supervisor)).json().data
  const count = (data: { reasons: { code: string; sessions: number }[] }, code: string) => data.reasons.find(r => r.code === code)?.sessions ?? 0
  assert.deepEqual([count(await analysis(), 'price'), count(await analysis(), 'no_reply')], [0, 1], 'AI guesses stay out of the figures')
  assert.equal(count(await analysis('&includeAi=true'), 'price'), 1, 'until asked for')

  // Correcting: stale revisions refused; the AI's original kept; the result published to the agent.
  const revision = pending.review.revision
  assert.equal((await call('PUT', `/inquiry-review/sessions/${lost}/review`, executive, { revision, action: 'confirm' })).statusCode, 403, 'read-only reviewers cannot decide')
  assert.equal((await call('PUT', `/inquiry-review/sessions/${lost}/review`, supervisor, { revision: revision + 9, action: 'confirm' })).statusCode, 409)
  assert.equal((await call('PUT', `/inquiry-review/sessions/${lost}/review`, supervisor, { revision, action: 'correct' })).statusCode, 400)
  const corrected = await call('PUT', `/inquiry-review/sessions/${lost}/review`, supervisor, { revision, action: 'correct', lossCode: 'knowledge_gap', note: '千牛看过原文，是参数没答上来', publish: true, findings: [{ type: 'cannot_answer', summary: '功率答不准', message_uuid: `${marker}-b2`, excerpt: '功率是八十瓦' }] })
  assert.equal(corrected.statusCode, 200, corrected.body)
  assert.deepEqual([corrected.json().data.ai_loss_code, corrected.json().data.final_loss_code, corrected.json().data.status], ['price', 'knowledge_gap', 'corrected'])
  assert.equal(count(await analysis(), 'knowledge_gap'), 1)
  assert.ok((await db.query("SELECT 1 FROM audit_logs WHERE tenant_id=$1 AND action='performance.review.correct'", [tenant])).rowCount)

  // A decision survives a re-run and a manual re-analysis.
  await enqueueReviewRun(tenant, conn.id, D)
  await runChatReviewOnce()
  assert.equal((await call('POST', `/inquiry-review/sessions/${lost}/analyze`, supervisor)).statusCode, 409)
  assert.equal((await db.query('SELECT final_loss_code FROM chat_reviews WHERE session_id=$1', [lost])).rows[0].final_loss_code, 'knowledge_gap')

  // The agent now sees the conclusion (not the AI's discarded guess) and can respond.
  const published = (await detail(own)).json().data.review
  assert.deepEqual([published.final_loss_code, published.ai_loss_code, published.reviewer_note], ['knowledge_gap', undefined, '千牛看过原文，是参数没答上来'])
  assert.equal((await call('POST', `/inquiry-review/reviews/${published.id}/response`, otherAgent, { text: '不是我' })).statusCode, 404)
  assert.equal((await call('POST', `/inquiry-review/reviews/${published.id}/response`, own, { text: '当时确实不确定' })).statusCode, 200)

  // Judging without AI: a supervisor can decide on any session.
  const manual = await call('PUT', `/inquiry-review/sessions/${noReply}/review`, supervisor, { revision: 0, action: 'confirm' })
  assert.equal(manual.statusCode, 200, manual.body)
  assert.deepEqual([manual.json().data.status, manual.json().data.revision], ['confirmed', 1])
  const dismissed = await call('PUT', `/inquiry-review/sessions/${templated}/review`, supervisor, { revision: 0, action: 'dismiss', publish: true })
  assert.deepEqual([dismissed.json().data.status, dismissed.json().data.published_at], ['dismissed', null], 'a dismissed result is not published')

  // Manual product links: survive refreshes; only manual ones can be removed.
  assert.equal((await call('PUT', `/inquiry-review/sessions/${noReply}/products`, supervisor, { offerId: 'abc' })).statusCode, 400)
  assert.equal((await call('PUT', `/inquiry-review/sessions/${noReply}/products`, supervisor, { offerId: '333' })).statusCode, 200)
  await refreshSessionProducts(tenant, conn.id, D, D)
  assert.equal((await db.query("SELECT confidence FROM chat_session_products WHERE session_id=$1 AND offer_id='333'", [noReply])).rows[0].confidence, 'certain')
  assert.equal((await call('DELETE', `/inquiry-review/sessions/${lost}/products/${OFFER}`, supervisor)).statusCode, 204)
  assert.equal((await db.query('SELECT count(*)::int AS n FROM chat_session_products WHERE session_id=$1 AND offer_id=$2', [lost, OFFER])).rows[0].n, 1, 'evidence-based links stay')

  // Brief and coaching: figures for the agent; the AI summary and unpublished reviews only for reviewers.
  await call('PUT', `/agents/${agent}/brief`, supervisor, { date: D, note: '这周先把参数表背熟' })
  const bossBrief = (await call('GET', `/agents/${agent}/brief?date=${D}`, supervisor)).json().data
  assert.equal(bossBrief.stats.today.no_reply, 1)
  assert.equal(bossBrief.reviews.length, 2)
  const myBrief = (await call('GET', `/agents/${agent}/brief?date=${D}`, own)).json().data
  assert.deepEqual([myBrief.summary, myBrief.supervisorNote, myBrief.reviews.map((r: { session_id: string }) => r.session_id)], [null, '这周先把参数表背熟', [lost]], 'the unpublished confirmation stays hidden')
  assert.equal((await call('GET', `/agents/${agent}/brief?date=${D}`, otherAgent)).statusCode, 404)
  const item = await call('POST', '/coaching-items', supervisor, { agentId: agent, reviewId: published.id, title: '背熟主推款参数', dueDate: Y })
  assert.equal(item.statusCode, 201, item.body)
  assert.equal((await call('POST', '/coaching-items', own, { agentId: agent, title: 'x' })).statusCode, 403)
  const itemId = item.json().data.id
  assert.equal((await call('PATCH', `/coaching-items/${itemId}`, otherAgent, { status: 'done' })).statusCode, 404)
  assert.equal((await call('PATCH', `/coaching-items/${itemId}`, own, { status: 'dropped' })).statusCode, 403)
  assert.equal((await call('PATCH', `/coaching-items/${itemId}`, own, { status: 'done' })).statusCode, 200)
  assert.equal((await call('GET', `/agents/${agent}/brief?date=${D}`, own)).json().data.items[0].status, 'done')

  // A brief with a confirmed review gets a worded summary; a model that invents JSON gets ignored rather than saved.
  modelReply = () => ({ summary: '样本少，未回复 1 次，需关注响应。' })
  await enqueueReviewRun(tenant, conn.id, D)
  await runChatReviewOnce()
  assert.equal((await db.query('SELECT summary FROM chat_agent_daily_briefs WHERE agent_id=$1 AND brief_date=$2', [agent, D])).rows[0].summary, '样本少，未回复 1 次，需关注响应。')

  // Failures: bad output and outages are counted, and leave nothing behind.
  const bad = await session(agent, await buyer(`bad-${marker}`), Y, 'c9', [{ uuid: `${marker}-x1`, dir: 1, at: at(Y, '10:00:00'), length: 9 }, { uuid: `${marker}-x2`, dir: 0, at: at(Y, '10:00:05'), text: '这款我们有三个型号可以选择，您需要哪一种规格呢，我帮您看一下库存' }], { at: at(Y, '10:00:00'), replyAt: at(Y, '10:00:05') })
  modelReply = () => '不是 JSON'
  await enqueueReviewRun(tenant, conn.id, Y)
  const invalid = await runChatReviewOnce() as { failed: number; analyzed: number }
  assert.deepEqual([invalid.failed, invalid.analyzed], [1, 0])
  assert.equal((await db.query('SELECT count(*)::int AS n FROM chat_reviews WHERE session_id=$1', [bad])).rows[0].n, 0)
  modelReply = () => 'FAIL'
  assert.equal((await call('POST', `/inquiry-review/sessions/${bad}/analyze`, supervisor)).statusCode, 502)
  modelReply = () => '不是 JSON'
  assert.equal((await call('POST', `/inquiry-review/sessions/${bad}/analyze`, supervisor)).statusCode, 502)
  assert.equal((await call('POST', '/inquiry-review/runs', supervisor, { connectionId: conn.id, date: '2099-01-01' })).statusCode, 400)
  assert.equal((await call('POST', '/inquiry-review/runs', own, { connectionId: conn.id, date: Y })).statusCode, 403)

  // Wrong fact needs facts on file: with the offer's confirmed attributes the same claim is kept.
  const factSession = await session(agent, await buyer(`fact-${marker}`), Y, 'c10', [{ uuid: `${marker}-y1`, dir: 1, at: at(Y, '11:00:00'), length: 9 }, { uuid: `${marker}-y2`, dir: 0, at: at(Y, '11:00:05'), text: '这个型号的功率是八十瓦，比别家要大不少，您放心购买就可以了', offers: ['800800'] }], { at: at(Y, '11:00:00'), replyAt: at(Y, '11:00:05') })
  const shop = await saveConnection(tenant, boss, { access_token: 'p', refresh_token: 'r', expires_in: 36000, aliId: `review-product-${marker}`, resource_owner: 'shop2', refresh_token_timeout: '20991231000000000+0800' })
  const product = (await db.query("INSERT INTO products(tenant_id,sku,name)VALUES($1,$2,'充气泵')RETURNING id", [tenant, `S-${marker}`])).rows[0].id
  await db.query(`INSERT INTO integration_1688_listings(tenant_id,connection_id,offer_id,product_id,title,status,snapshot)VALUES($1,$2,'800800',$3,'充气泵','published',$4)`, [tenant, shop.id, product, JSON.stringify({ attributes: [{ attributeName: '材质', value: 'ABS' }] })])
  await db.query("INSERT INTO product_attributes(tenant_id,product_id,label,value,confirmed_at)VALUES($1,$2,'功率','60W',now()),($1,$2,'未核实','不能用',NULL)", [tenant, product])
  modelReply = prompt => { assert.ok(prompt.includes('60W') && prompt.includes('ABS') && !prompt.includes('不能用'), 'confirmed facts only'); return { loss_code: 'knowledge_gap', confidence: 'medium', loss_ref: 'm2', findings: [{ type: 'wrong_fact', ref: 'm2', summary: '功率与资料不符', fact_label: '功率' }], coaching: '' } }
  const withFacts = await call('POST', `/inquiry-review/sessions/${factSession}/analyze`, supervisor)
  assert.equal(withFacts.statusCode, 200, withFacts.body)
  assert.deepEqual(withFacts.json().data.ai_findings.map((f: { type: string; fact_ref: string }) => [f.type, f.fact_ref]), [['wrong_fact', '功率']])
  const ranked = (await call('GET', `/inquiry-review/worklist?connectionId=${conn.id}&from=${Y}&to=${Y}`, supervisor)).json().data
  assert.equal(ranked[0].id, factSession, 'a contradiction with the product data ranks high')

  // Retention: excerpts go with the text after 90 days; conclusions stay.
  await db.query("UPDATE chat_reviews SET chat_date=$2 WHERE session_id=$1", [lost, dateAgo(95)])
  await purgeReviewExcerpts()
  const purged = (await db.query('SELECT final_findings,final_loss_code FROM chat_reviews WHERE session_id=$1', [lost])).rows[0]
  assert.deepEqual([purged.final_findings[0].excerpt, purged.final_findings[0].summary, purged.final_loss_code], [undefined, '功率答不准', 'knowledge_gap'])
  await db.query('UPDATE chat_reviews SET chat_date=$2 WHERE session_id=$1', [lost, D])

  // Daily schedule: nothing before 06:00 Beijing, one run per shop per day.
  assert.equal(await enqueueDueRuns(Date.parse(`${dateAgo(0)}T05:30:00+08:00`)), 0)
  const scheduledFor = Date.parse(`${dateAgo(30)}T06:30:00+08:00`)
  const added = await enqueueDueRuns(scheduledFor)
  assert.ok(added >= 1)
  assert.equal(await enqueueDueRuns(scheduledFor), 0, 'not queued twice')
  await db.query('DELETE FROM chat_review_runs WHERE review_date=$1 AND tenant_id<>ALL($2::uuid[])', [dateAgo(31), tenants])

  // Assistant: confirmed conclusions only, for those allowed.
  const ctx = (permissions: string[]) => ({ tenantId: tenant, userId: boss, permissions, connectionId: conn.id, conversationId: randomUUID(), proposals: [] })
  const summary = JSON.parse((await runTool(ctx(['performance:review']), 'get_inquiry_review_summary', JSON.stringify({ from: D, to: D }))).content)
  assert.ok(summary.reasons.some((r: { reason: string }) => r.reason === '客服答不上或答错'))
  assert.ok(summary.notes.includes('不要转述'))
  assert.equal((await runTool(ctx(['performance:read']), 'get_inquiry_review_summary', '{}')).ok, false, 'finance-level access does not get it')
  console.log(JSON.stringify({ outputValidation: 'ok', permissions: 'ok', rules: 'ok', templates: 'ok', productLinks: 'ok', offByDefault: 'ok', promptPrivacy: 'ok', correction: 'ok', decisionsSurvive: 'ok', agentVisibility: 'ok', briefCoaching: 'ok', failures: 'ok', wrongFactNeedsFacts: 'ok', retention: 'ok', schedule: 'ok', assistant: 'ok', modelCalls: modelCalls.length }))
} finally {
  globalThis.fetch = originalFetch
  for (const id of tenants) {
    await db.query('DELETE FROM integration_1688_listings WHERE tenant_id=$1', [id])
    await db.query('DELETE FROM audit_logs WHERE tenant_id=$1', [id])
    await db.query('DELETE FROM tenants WHERE id=$1', [id])
  }
  await app.close(); await db.end()
}
