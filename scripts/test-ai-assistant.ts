import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'

// AI sidebar with tools: a fake Qwen endpoint scripts the tool calls, the real tools read seeded mirror tables.
type Body = { model: string; messages: { role: string; content: string | null; tool_call_id?: string; tool_calls?: unknown[] }[]; tools?: { function: { name: string } }[] }
const requests: Body[] = []
let respond: (body: Body) => object = () => ({ content: 'ok' })
const call = (name: string, args: object) => ({ id: `call-${randomUUID().slice(0, 8)}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })
const fake = createServer((request, response) => {
  let raw = ''
  request.on('data', chunk => raw += chunk)
  request.on('end', () => {
    const body = JSON.parse(raw) as Body
    requests.push(body)
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ model: body.model, choices: [{ message: { role: 'assistant', ...respond(body) }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }))
  })
})
await new Promise<void>(resolve => fake.listen(0, '127.0.0.1', resolve))
const address = fake.address()
if (!address || typeof address === 'string') throw new Error('fake Qwen failed to start')
process.env.DASHSCOPE_API_KEY = 'test-key'
process.env.DASHSCOPE_BASE_URL = `http://127.0.0.1:${address.port}/v1`

const [{ buildApp }, { db }, { saveConnection }, { ensureOrderBuyers, refreshCustomerStats, resolveBuyer }] = await Promise.all([
  import('../server/app.js'), import('../server/db.js'), import('../server/integrations/1688.js'), import('../server/integrations/customer-ops.js')])
const marker = randomUUID(), tenantIds: string[] = []
const app = await buildApp()
const HOUR = 3_600_000, DAY = 24 * HOUR
const beijingDate = (offset: number) => new Date(Date.now() + 8 * HOUR + offset * DAY).toISOString().slice(0, 10)
const noon = (offset: number) => new Date(`${beijingDate(offset)}T12:00:00+08:00`)
/** Script: one response per model request, in order; a request without tools always gets a final text answer. */
const script = (...steps: object[]) => { let i = 0; respond = body => body.tools ? steps[i++] ?? { content: '完成' } : { content: '工具轮次用尽后的总结' } }
const toolResults = (body: Body) => body.messages.filter(m => m.role === 'tool').map(m => JSON.parse(m.content!))

try {
  for (let i = 0; i < 2; i++) tenantIds.push((await db.query('INSERT INTO tenants(name,slug)VALUES($1,$2)RETURNING id', ['ai assistant test', `test-ai-assistant-${marker}-${i}`])).rows[0].id)
  const tenantId = tenantIds[0]
  const user = async (tenant: string, name: string) => (await db.query("INSERT INTO users(tenant_id,email,password_hash,display_name,status)VALUES($1,$2,'unused',$3,'active')RETURNING id", [tenant, `${name}-${marker}@integration.local`, name])).rows[0].id as string
  const [admin, viewer, outsider] = [await user(tenantId, '店长'), await user(tenantId, '只读'), await user(tenantIds[1], '外人')]
  const auth = (sub: string, permissions: string[], tenant = tenantId) => ({ authorization: `Bearer ${app.jwt.sign({ sub, tenantId: tenant, email: 't', displayName: sub === admin ? '店长' : '其他', roles: [], permissions })}` })
  const chat = (headers: Record<string, string>, payload: object) => app.inject({ method: 'POST', url: '/api/ai/chat', headers, payload })

  const c = await saveConnection(tenantId, admin, { access_token: 'x', refresh_token: 'x', expires_in: 36000, aliId: `ai-${marker}`, resource_owner: '测试旗舰店', refresh_token_timeout: '20990101000000000+0800' }, Date.now(), 'performance')
  await db.query("UPDATE integration_1688_perf_connections SET status='disabled',display_name='测试旗舰店' WHERE id=$1", [c.id])
  const agent = (await db.query("INSERT INTO perf_agents(tenant_id,connection_id,login_id,is_main) VALUES($1,$2,'测试旗舰店:小王',false) RETURNING id", [tenantId, c.id])).rows[0].id
  const A = (await resolveBuyer(tenantId, c.id, { key: 'buyerA', openUid: 'buyerA', adminOpenUid: null, taobaoNick: null, at: new Date() })).buyerId
  await db.query(`INSERT INTO cust_profiles(buyer_id,tenant_id,name) VALUES($1,$2,'张老板')`, [A, tenantId])
  await db.query(`INSERT INTO perf_chat_sessions(tenant_id,connection_id,agent_id,buyer_id,cid,chat_date,last_peer_at,needs_sync,buyer_messages,agent_messages) VALUES($1,$2,$3,$4,'cid1',$5::date,now(),false,3,2)`, [tenantId, c.id, agent, A, beijingDate(-1)])
  const items = (name: string, qty: number, amount: number) => JSON.stringify([{ productId: name, name, sku: '黑色', quantity: qty, amount, price: amount / qty }])
  await db.query(`INSERT INTO perf_orders(tenant_id,connection_id,order_id,buyer_open_uid,status,total_amount,placed_at,paid_at,items) VALUES
    ($1,$2,'9001','buyerA','success',300,$3,$3,$4),($1,$2,'9002','buyerA','success',120,$5,$5,$6),($1,$2,'9003','buyerB','waitbuyerpay',50,$5,NULL,$7)`,
    [tenantId, c.id, noon(-1), items('遮阳帘', 10, 300), noon(0), items('吸盘', 4, 120), items('遮阳帘', 1, 50)])
  await ensureOrderBuyers(c.id); await refreshCustomerStats(c.id)

  // 1. The model gets every tool the admin may use plus pointers to the page, shop and open customer; tool results carry real figures.
  script({ content: null, tool_calls: [call('list_customers', { segment: 'all', limit: 5 }), call('get_business_overview', { range: '7d' })] },
    { content: null, tool_calls: [call('get_customer', { customerId: A }), call('get_top_products', {}), call('get_agent_performance', {})] },
    { content: null, tool_calls: [call('propose_followup', { customerId: A, content: '回访遮阳帘使用情况，推荐吸盘套装', nextFollowUpDate: beijingDate(1) })] },
    { content: '**建议**：先跟进张老板。' })
  const first = await chat(auth(admin, ['*']), { message: '今天该跟进谁？', context: { page: 'customerOps', pageTitle: '客户经营', view: 'due', connectionId: c.id, customerId: A, customerName: '张老板' } })
  assert.equal(first.statusCode, 200, first.body)
  assert.deepEqual(requests[0].tools!.map(t => t.function.name).sort(), ['get_agent_performance', 'get_business_overview', 'get_customer', 'get_customer_options', 'get_keyword_hits', 'get_reply_quality', 'get_top_products', 'list_customers', 'propose_followup', 'propose_owner', 'propose_tags'])
  const system = requests[0].messages[0].content!
  for (const text of ['测试旗舰店', '客户经营 / due', '张老板', A, beijingDate(0), '店长']) assert.ok(system.includes(text), `system prompt mentions ${text}`)
  const [customers, overview] = toolResults(requests[1])
  assert.equal(customers.customers[0].name, '张老板'); assert.equal(customers.customers[0].paidAmount, 420); assert.equal(customers.customers[0].paidOrders, 2)
  assert.equal(overview.shop, '测试旗舰店'); assert.equal(overview.kpis.current.paidAmount, 420); assert.equal(overview.customers.unpaid, 1)
  const [detail, products, agents] = toolResults(requests[2]).slice(2)
  assert.equal(detail.orders.length, 2); assert.match(detail.orders[0].items[0], /吸盘（黑色） ×4 ¥120/); assert.equal(detail.chatDays[0].agent, '测试旗舰店:小王')
  assert.deepEqual(products.products.map((p: { name: string; amount: number }) => [p.name, p.amount]), [['遮阳帘', 300], ['吸盘', 120]], 'unpaid order 9003 excluded')
  assert.equal(agents.agents[0].reception, 1)
  const reply = first.json().data.message
  assert.equal(reply.content, '**建议**：先跟进张老板。')
  assert.equal(reply.tools.length, 6); assert.equal(reply.input_tokens, 40)
  assert.equal(reply.actions.length, 1); assert.equal(reply.actions[0].status, 'pending'); assert.equal(reply.actions[0].payload.customerName, '张老板')
  assert.equal((await db.query('SELECT count(*)::int AS n FROM cust_followups WHERE buyer_id=$1', [A])).rows[0].n, 0, 'nothing written before confirmation')

  // 2. Confirmation: only the requester, only once; the follow-up lands with 09:00 Beijing on the planned day.
  const actionId = reply.actions[0].id
  assert.equal((await app.inject({ method: 'POST', url: `/api/ai/actions/${actionId}/confirm`, headers: auth(viewer, ['*']) })).statusCode, 404, 'another user cannot confirm')
  const confirmed = await app.inject({ method: 'POST', url: `/api/ai/actions/${actionId}/confirm`, headers: auth(admin, ['*']) })
  assert.equal(confirmed.statusCode, 200, confirmed.body); assert.equal(confirmed.json().data.status, 'executed')
  const followup = (await db.query('SELECT content,need_follow_up,next_follow_up_at,created_by FROM cust_followups WHERE buyer_id=$1', [A])).rows
  assert.equal(followup.length, 1); assert.equal(followup[0].created_by, admin); assert.equal(followup[0].need_follow_up, true)
  assert.equal(followup[0].next_follow_up_at.toISOString(), new Date(`${beijingDate(1)}T09:00:00+08:00`).toISOString())
  assert.equal((await app.inject({ method: 'POST', url: `/api/ai/actions/${actionId}/confirm`, headers: auth(admin, ['*']) })).statusCode, 409, 'no double execution')
  const history = (await app.inject({ method: 'GET', url: `/api/ai/conversations/${first.json().data.conversationId}/messages`, headers: auth(admin, ['*']) })).json().data.messages
  assert.equal(history[1].actions[0].status, 'executed'); assert.equal(history[1].tools.length, 6)

  // 3. A read-only user is offered only read tools; a forbidden call made anyway is refused inside the tool layer.
  requests.length = 0
  script({ content: null, tool_calls: [call('propose_followup', { customerId: A, content: 'x' }), call('get_top_products', {})] }, { content: '没有权限。' })
  const limited = await chat(auth(viewer, ['customer_ops:read']), { message: '帮我写跟进' })
  assert.equal(limited.statusCode, 200, limited.body)
  assert.deepEqual(requests[0].tools!.map(t => t.function.name).sort(), ['get_business_overview', 'get_customer', 'get_customer_options', 'list_customers'])
  assert.ok(toolResults(requests[1]).every(r => /无权限/.test(r.error)))
  assert.equal(limited.json().data.message.actions.length, 0)
  const overviewOnly = await chat(auth(viewer, ['customer_ops:read']), { message: '概览', conversationId: limited.json().data.conversationId })
  assert.equal(overviewOnly.statusCode, 200)

  // 4. Tenant isolation: another tenant's customer id is not found; the conversation itself is private.
  requests.length = 0
  script({ content: null, tool_calls: [call('get_customer', { customerId: A })] }, { content: '找不到。' })
  assert.equal((await chat(auth(outsider, ['*'], tenantIds[1]), { message: '看看这个客户' })).statusCode, 200)
  assert.match(toolResults(requests[1])[0].error, /客户不存在/)
  assert.equal((await chat(auth(outsider, ['*'], tenantIds[1]), { message: 'x', conversationId: first.json().data.conversationId })).statusCode, 404)

  // 5. Bad arguments come back to the model as an error; a model that keeps calling tools is cut off after five rounds.
  requests.length = 0
  respond = body => body.tools ? { content: null, tool_calls: [call('get_agent_performance', { from: '2026-01-01', to: '2026-12-31' })] } : { content: '工具轮次用尽后的总结' }
  const looping = await chat(auth(admin, ['*']), { message: '分析全年' })
  assert.equal(looping.statusCode, 200, looping.body)
  assert.equal(requests.length, 6); assert.equal(requests[5].tools, undefined)
  assert.match(toolResults(requests[1])[0].error, /92 天/)
  assert.equal(looping.json().data.message.content, '工具轮次用尽后的总结')

  // 6. Rejected proposals cannot be executed later.
  script({ content: null, tool_calls: [call('propose_followup', { customerId: A, content: '再联系' })] }, { content: '已拟好。' })
  const second = (await chat(auth(admin, ['*']), { message: '再拟一条' })).json().data.message.actions[0]
  assert.equal((await app.inject({ method: 'POST', url: `/api/ai/actions/${second.id}/reject`, headers: auth(admin, ['*']) })).json().data.status, 'rejected')
  assert.equal((await app.inject({ method: 'POST', url: `/api/ai/actions/${second.id}/confirm`, headers: auth(admin, ['*']) })).statusCode, 409)

  // 7. Tags: options list names; add (creating a missing tag) and remove on several customers after confirmation.
  const B = (await db.query("SELECT i.buyer_id FROM perf_buyer_identities i WHERE i.connection_id=$1 AND i.open_uid='buyerB'", [c.id])).rows[0].buyer_id
  const oldTag = (await db.query("INSERT INTO cust_tags(tenant_id,name) VALUES($1,'待激活') RETURNING id", [tenantId])).rows[0].id
  await db.query('INSERT INTO cust_buyer_tags(buyer_id,tag_id) VALUES($1,$3),($2,$3)', [A, B, oldTag])
  const confirm = (id: string, sub = admin) => app.inject({ method: 'POST', url: `/api/ai/actions/${id}/confirm`, headers: auth(sub, ['*']) })
  requests.length = 0
  script({ content: null, tool_calls: [call('get_customer_options', {}), call('list_customers', { tag: '待激活' }), call('list_customers', { tag: '不存在' })] },
    { content: null, tool_calls: [call('propose_tags', { customerIds: [A, B], add: ['重点客户'], remove: ['待激活'] }), call('propose_tags', { customerIds: [A], remove: ['不存在'] })] }, { content: '已拟好。' })
  const tagged = (await chat(auth(admin, ['*']), { message: '给这两位打上重点客户，去掉待激活', context: { connectionId: c.id } })).json().data
  const [options, byTag, badTag] = toolResults(requests[1])
  assert.deepEqual(options.tags, [{ name: '待激活', customers: 2 }]); assert.deepEqual(options.agents.map((a: { agent: string }) => a.agent), ['测试旗舰店:小王'])
  assert.equal(byTag.total, 2); assert.deepEqual(byTag.customers[0].tags, ['待激活']); assert.match(badTag.error, /没有名为“不存在”的标签。现有标签：待激活/)
  assert.match(toolResults(requests[2])[4].error, /要移除的标签不存在/)
  const tagAction = tagged.message.actions[0]
  assert.equal(tagged.message.actions.length, 1); assert.deepEqual(tagAction.payload.newTags, ['重点客户']); assert.deepEqual(tagAction.payload.customers.map((x: { name: string }) => x.name).sort(), ['买家尾号 buyerB', '张老板'])
  assert.equal((await db.query("SELECT count(*)::int AS n FROM cust_tags WHERE tenant_id=$1 AND name='重点客户'", [tenantId])).rows[0].n, 0, 'tag not created before confirmation')
  assert.equal((await confirm(tagAction.id)).json().data.status, 'executed')
  const tagsNow = (await db.query('SELECT b.buyer_id,t.name FROM cust_buyer_tags b JOIN cust_tags t ON t.id=b.tag_id WHERE t.tenant_id=$1 ORDER BY 1,2', [tenantId])).rows
  assert.deepEqual(tagsNow.map(r => r.name), ['重点客户', '重点客户'])

  // 8. Owner: matched by sub-account name, pinned as manual; "auto" hands back to automatic assignment.
  script({ content: null, tool_calls: [call('propose_owner', { customerIds: [A], agent: '小王' }), call('propose_owner', { customerIds: [A], agent: '老李' })] }, { content: '已拟好。' })
  requests.length = 0
  const owned = (await chat(auth(admin, ['*']), { message: '张老板归小王', context: { connectionId: c.id } })).json().data
  assert.match(toolResults(requests[1])[1].error, /找不到该客服账号：老李。可选：测试旗舰店:小王/)
  assert.equal(owned.message.actions[0].payload.agentName, '测试旗舰店:小王')
  assert.equal((await confirm(owned.message.actions[0].id)).json().data.status, 'executed')
  assert.deepEqual((await db.query('SELECT owner_agent_id,owner_source FROM cust_profiles WHERE buyer_id=$1', [A])).rows[0], { owner_agent_id: agent, owner_source: 'manual' })
  script({ content: null, tool_calls: [call('get_customer', { customerId: A }), call('propose_owner', { customerIds: [A, B], agent: 'auto' })] }, { content: '已拟好。' })
  requests.length = 0
  const autoAction = (await chat(auth(admin, ['*']), { message: '恢复自动分配', context: { connectionId: c.id } })).json().data.message.actions[0]
  assert.equal(toolResults(requests[1])[0].owner, '测试旗舰店:小王（手动指定）')
  assert.equal((await confirm(autoAction.id)).json().data.status, 'executed')
  assert.notEqual((await db.query('SELECT owner_source FROM cust_profiles WHERE buyer_id=$1', [A])).rows[0].owner_source, 'manual')
  // A viewer without update permission cannot execute even their own proposal.
  const viewerAction = (await db.query(`INSERT INTO ai_action_requests(tenant_id,requested_by,action_type,target_type,target_id,proposed_payload) VALUES($1,$2,'customer.tags','perf_buyer',$3,$4) RETURNING id`,
    [tenantId, viewer, A, JSON.stringify({ customers: [{ id: A, name: 'x' }], add: ['越权'], remove: [] })])).rows[0].id
  assert.equal((await app.inject({ method: 'POST', url: `/api/ai/actions/${viewerAction}/confirm`, headers: auth(viewer, ['customer_ops:read']) })).statusCode, 403)

  // 9. Expiry: a day-old proposal shows as expired and cannot be confirmed.
  script({ content: null, tool_calls: [call('propose_followup', { customerId: A, content: '旧建议' })] }, { content: '好。' })
  const stale = (await chat(auth(admin, ['*']), { message: '拟一条' })).json().data
  await db.query("UPDATE ai_action_requests SET created_at=now()-interval '25 hours' WHERE id=$1", [stale.message.actions[0].id])
  assert.equal((await confirm(stale.message.actions[0].id)).statusCode, 409)
  const staleHistory = (await app.inject({ method: 'GET', url: `/api/ai/conversations/${stale.conversationId}/messages`, headers: auth(admin, ['*']) })).json().data
  assert.equal(staleHistory.messages[1].actions[0].status, 'expired')

  // 10. History list: own conversations newest first with counts, paging, private to the user; delete keeps proposals for audit.
  const list = async (sub: string, query = '') => (await app.inject({ method: 'GET', url: `/api/ai/conversations${query}`, headers: auth(sub, ['*']) })).json()
  const mine = await list(admin)
  assert.equal(mine.data.length, 7); assert.equal(mine.data[0].id, stale.conversationId); assert.equal(mine.data[0].messages, 2)
  assert.equal(mine.data[0].pending_actions, 0, 'expired proposals are not pending')
  const page = await list(admin, '?limit=3'); assert.equal(page.data.length, 3); assert.equal(page.hasMore, true)
  const next = await list(admin, `?limit=3&before=${encodeURIComponent(page.data[2].updated_at)}`); assert.equal(next.data[0].id, mine.data[3].id)
  assert.equal((await list(viewer)).data.length, 1)
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/ai/conversations/${first.json().data.conversationId}`, headers: auth(viewer, ['*']) })).statusCode, 404)
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/ai/conversations/${first.json().data.conversationId}`, headers: auth(admin, ['*']) })).statusCode, 204)
  assert.equal((await list(admin)).data.length, 6)
  assert.equal((await db.query('SELECT conversation_id,status FROM ai_action_requests WHERE id=$1', [actionId])).rows[0].status, 'executed', 'proposal kept after delete')

  // 11. Chat insights: reply quality, keyword hits, and the agent's last words in customer detail (performance managers only).
  const chatSession = (await db.query("SELECT id FROM perf_chat_sessions WHERE connection_id=$1 AND cid='cid1'", [c.id])).rows[0].id
  const m = (uuid: string, dir: 0 | 1, text: string | null, flags: string[], words: object[]) => db.query(`INSERT INTO perf_chat_messages(tenant_id,connection_id,session_id,uuid,direction,sent_at,text_masked,char_count,flags,keywords,message_types)
    VALUES($1,$2,$3,$4,$5,now(),$6,$7,$8,$9,'{正常消息}')`, [tenantId, c.id, chatSession, uuid, dir, text, text ? text.length : null, flags, JSON.stringify(words)])
  await m('q1', 1, null, [], [{ word: '退款', count: 1 }]); await m('q2', 0, '加我微信 ****** 发你实拍', ['wechat'], []); await m('q3', 0, '好的', ['short'], [])
  await db.query("INSERT INTO perf_keywords(tenant_id,connection_id,word,category) VALUES($1,$2,'退款','售后退款')", [tenantId, c.id])
  requests.length = 0
  script({ content: null, tool_calls: [call('get_reply_quality', {}), call('get_keyword_hits', { category: '售后退款' }), call('get_customer', { customerId: A })] }, { content: '分析完毕。' })
  assert.equal((await chat(auth(admin, ['*']), { message: '看看话术和买家在问什么', context: { connectionId: c.id } })).statusCode, 200)
  const [rq, kw, cust] = toolResults(requests[1])
  assert.equal(rq.totals.offsite, 1); assert.equal(rq.offsiteRisks[0].customerId, A); assert.deepEqual(rq.offsiteRisks[0].types, ['微信']); assert.equal(rq.agents[0].shortReplyRate, 0.5)
  assert.deepEqual(kw.words.map((w: { word: string; buyerMentions: number }) => [w.word, w.buyerMentions]), [['退款', 1]]); assert.equal(kw.library[0].category, '售后退款'); assert.equal(kw.recent[0].customerId, A)
  assert.deepEqual(cust.recentAgentReplies.map((r: { text: string }) => r.text), ['加我微信 ****** 发你实拍', '好的']); assert.deepEqual(cust.buyerKeywordHits.map((w: { word: string }) => w.word), ['退款'])
  // A customer-only user gets neither the chat tools nor the agent text inside customer detail.
  requests.length = 0
  script({ content: null, tool_calls: [call('get_customer', { customerId: A }), call('get_reply_quality', {})] }, { content: '好。' })
  await chat(auth(viewer, ['customer_ops:read']), { message: '看看这个客户', context: { connectionId: c.id } })
  assert.ok(!requests[0].tools!.some(t => t.function.name === 'get_reply_quality' || t.function.name === 'get_keyword_hits'))
  const [viewerCust, viewerRq] = toolResults(requests[1])
  assert.equal(viewerCust.recentAgentReplies, undefined); assert.match(viewerRq.error, /无权限/)

  console.log(JSON.stringify({chatInsights:'ok',tags:'ok',owner:'ok',expiry:'ok',history:'ok', toolsOffered: 'ok', contextPointers: 'ok', realData: 'ok', confirmOnce: 'ok', permissions: 'ok', isolation: 'ok', roundLimit: 'ok', reject: 'ok' }))
} finally {
  for (const id of tenantIds) { await db.query('DELETE FROM audit_logs WHERE tenant_id=$1', [id]); await db.query('DELETE FROM ai_action_requests WHERE tenant_id=$1', [id]); await db.query('DELETE FROM tenants WHERE id=$1', [id]) }
  await app.close(); await db.end(); await new Promise<void>(resolve => fake.close(() => resolve()))
}
