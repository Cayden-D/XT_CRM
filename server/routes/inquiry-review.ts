import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { hasPermission, requireAuth, requirePermission } from '../auth.js'
import { db } from '../db.js'
import { IntegrationError } from '../integrations/1688.js'
import { ensureSettings } from '../integrations/1688-performance-reports.js'
import { agentDayStats, analyzeSession, enqueueReviewRun, FINDING_TYPES, finalLossSql, LOSS_CODES, LOSS_NAMES, PROMPT_VERSION, productFacts, refreshSessionProducts, reviewFactsCte, reviewSettings } from '../integrations/chat-review.js'
import { LlmConfigurationError, LlmRequestError, QWEN_MODELS } from '../llm/qwen.js'
import { ensureConnection, ownOnly, readScope, reportQuery } from './1688-performance.js'

const tenant = (request: FastifyRequest) => request.authUser.tenantId
const scope = (request: FastifyRequest) => ownOnly(request) ? request.authUser.sub : null
const canReview = (request: FastifyRequest) => hasPermission(request.authUser.permissions, 'performance:review')
const canReadReviews = (request: FastifyRequest) => canReview(request) || hasPermission(request.authUser.permissions, 'performance:review_read')
const idParams = z.object({ id: z.string().uuid() })
const beijingToday = () => new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10)

async function requireReviewRead(request: FastifyRequest, reply: import('fastify').FastifyReply) {
  await requireAuth(request, reply)
  if (reply.sent) return
  if (!canReadReviews(request)) return reply.code(403).send({ error: 'FORBIDDEN', message: '当前账号没有查看询盘复盘的权限。' })
}
const audit = (request: FastifyRequest, action: string, entityType: string, entityId: string, data: object) => db.query(
  'INSERT INTO audit_logs(tenant_id,actor_id,action,entity_type,entity_id,after_data,request_id)VALUES($1,$2,$3,$4,$5,$6,$7)',
  [tenant(request), request.authUser.sub, action, entityType, entityId, JSON.stringify(data), request.id])

async function sessionFor(request: FastifyRequest, id: string) {
  const session = (await db.query(`SELECT s.id,s.connection_id,s.agent_id,s.buyer_id,s.chat_date::text AS chat_date,a.login_id,a.is_main,a.user_id,u.display_name AS user_name,right(b.buyer_key,6) AS buyer_tail
    FROM perf_chat_sessions s JOIN perf_agents a ON a.id=s.agent_id JOIN perf_buyers b ON b.id=s.buyer_id LEFT JOIN users u ON u.id=a.user_id WHERE s.id=$1 AND s.tenant_id=$2`, [id, tenant(request)])).rows[0]
  if (!session) throw new IntegrationError('NOT_FOUND', '会话不存在。', 404)
  return session
}
const isOwnAgent = (request: FastifyRequest, agent: { user_id: string | null }) => agent.user_id != null && agent.user_id === request.authUser.sub

const findingSchema = z.object({ type: z.enum(FINDING_TYPES), summary: z.string().trim().min(1).max(200), message_uuid: z.string().max(200).nullable().optional(), excerpt: z.string().max(200).nullable().optional(), fact_ref: z.string().max(60).optional() }).strict()
const decisionSchema = z.object({
  revision: z.number().int().min(0),
  action: z.enum(['confirm', 'correct', 'dismiss']),
  lossCode: z.enum(LOSS_CODES).nullable().optional(),
  findings: z.array(findingSchema).max(30).optional(),
  note: z.string().trim().max(1000).nullable().optional(),
  publish: z.boolean().default(false),
}).strict()
const coachingSchema = z.object({ agentId: z.string().uuid(), reviewId: z.string().uuid().nullable().optional(), title: z.string().trim().min(1, '请填写改进事项。').max(200), detail: z.string().trim().max(2000).nullable().optional(), dueDate: z.string().date().nullable().optional() }).strict()

export async function inquiryReviewRoutes(app: FastifyInstance) {
  // 今日待复盘: highest risk first and a cap per agent, so a supervisor can get through it in a day.
  app.get('/inquiry-review/worklist', { preHandler: requireReviewRead }, async request => {
    const q = reportQuery.and(z.object({ status: z.enum(['pending', 'reviewed', 'all']).default('pending'), agentId: z.string().uuid().optional(), perAgent: z.coerce.number().int().min(1).max(200).default(10) })).parse(request.query)
    await ensureConnection(tenant(request), q.connectionId)
    await ensureSettings(tenant(request))
    // Chats sync every 15 minutes; the links should not wait for the hourly refresh.
    await refreshSessionProducts(tenant(request), q.connectionId, q.from, q.to)
    const rows = (await db.query(`WITH ${reviewFactsCte},
      listed AS (SELECT f.*,r.id AS review_id,coalesce(r.status,'pending') AS review_status,coalesce(r.revision,0) AS review_revision,r.ai_loss_code,r.ai_loss_confidence,r.ai_findings,r.ai_coaching,r.final_loss_code,r.published_at,
          coalesce(jsonb_array_length(r.ai_findings),0) AS finding_count,
          CASE WHEN f.rule_loss_code='no_reply' THEN 100 WHEN r.ai_findings @> '[{"type":"wrong_fact"}]' THEN 90 WHEN f.offsite>0 THEN 80 WHEN f.rule_loss_code='slow_reply' THEN 70
            WHEN coalesce(jsonb_array_length(r.ai_findings),0)>0 THEN 60 WHEN f.buyer_messages>=5 THEN 50 WHEN f.evidence_level='sufficient' THEN 30 ELSE 10 END AS priority
        FROM review_rules f LEFT JOIN chat_reviews r ON r.session_id=f.id
        WHERE f.category IN ('no_order','ordered_unpaid') AND ($6::uuid IS NULL OR f.agent_id=$6)
          AND ($7='all' OR ($7='pending' AND coalesce(r.status,'pending')='pending') OR ($7='reviewed' AND r.status IN ('confirmed','corrected','dismissed')))),
      ranked AS (SELECT l.*,row_number() OVER (PARTITION BY l.agent_id ORDER BY l.priority DESC,l.started_at DESC) AS position FROM listed l)
      SELECT x.id,x.agent_id,x.buyer_id,x.chat_date::text AS chat_date,x.started_at,x.category,x.new_customer,x.buyer_messages,x.agent_messages,x.other_agent_messages,x.real_chars,x.text_messages,x.template_messages,x.offsite,x.keywords,x.first_response_seconds,x.matured,x.evidence_level,x.rule_loss_code,
        x.review_id,x.review_status,x.review_revision,x.ai_loss_code,x.ai_loss_confidence,x.finding_count,x.final_loss_code,x.published_at,x.priority,
        a.login_id,a.is_main,u.display_name AS user_name,right(b.buyer_key,6) AS buyer_tail,
        coalesce((SELECT jsonb_agg(jsonb_build_object('offer_id',p.offer_id,'name',p.product_name,'confidence',p.confidence)) FROM (SELECT DISTINCT ON (offer_id) offer_id,product_name,confidence FROM chat_session_products sp WHERE sp.session_id=x.id AND sp.source<>'recent_order' ORDER BY offer_id,CASE sp.confidence WHEN 'certain' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END) p),'[]'::jsonb) AS products
      FROM ranked x JOIN perf_agents a ON a.id=x.agent_id LEFT JOIN users u ON u.id=a.user_id JOIN perf_buyers b ON b.id=x.buyer_id
      WHERE x.position<=$8 ORDER BY x.priority DESC,x.started_at DESC LIMIT 300`,
    [tenant(request), q.connectionId, q.from, q.to, null, q.agentId ?? null, q.status, q.perAgent])).rows
    const totals = (await db.query(`WITH ${reviewFactsCte}
      SELECT count(*) FILTER (WHERE NOT f.after_sales)::int AS inquiries,
        count(*) FILTER (WHERE f.category='no_order' AND f.matured)::int AS lost,
        count(*) FILTER (WHERE f.category='no_order' AND NOT f.matured)::int AS watching,
        count(*) FILTER (WHERE f.category IN ('no_order','ordered_unpaid') AND coalesce(r.status,'pending')='pending')::int AS pending,
        count(*) FILTER (WHERE f.category IN ('no_order','ordered_unpaid') AND f.evidence_level<>'sufficient')::int AS thin_evidence
      FROM review_rules f LEFT JOIN chat_reviews r ON r.session_id=f.id`, [tenant(request), q.connectionId, q.from, q.to, null])).rows[0]
    return { data: rows, totals, lossNames: LOSS_NAMES }
  })

  // One session: facts and timeline for reviewers; an agent sees their own session's review only once it is published.
  app.get('/inquiry-review/sessions/:id', { preHandler: readScope }, async request => {
    const { id } = idParams.parse(request.params)
    const session = await sessionFor(request, id)
    const reviewer = canReadReviews(request), own = isOwnAgent(request, session)
    if (!reviewer && !own) throw new IntegrationError('NOT_FOUND', '会话不存在。', 404)
    await ensureSettings(tenant(request))
    await refreshSessionProducts(tenant(request), session.connection_id, session.chat_date, session.chat_date)
    const [facts] = (await db.query(`WITH ${reviewFactsCte} SELECT f.id,f.category,f.after_sales,f.new_customer,f.buyer_messages,f.agent_messages,f.other_agent_messages,f.real_chars,f.text_messages,f.template_messages,f.offsite,f.keywords,f.first_response_seconds,f.matured,f.evidence_level,f.rule_loss_code FROM review_rules f WHERE f.id=$6`,
      [tenant(request), session.connection_id, session.chat_date, session.chat_date, null, id])).rows
    const messages = (await db.query('SELECT uuid,direction,sent_at,length,message_types,keywords,text_masked,flags,linked_offer_ids FROM perf_chat_messages WHERE session_id=$1 ORDER BY sent_at,uuid', [id])).rows
    const products = (await db.query("SELECT offer_id,product_name,source,confidence,evidence_message_uuid FROM chat_session_products WHERE session_id=$1 ORDER BY CASE confidence WHEN 'certain' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,source", [id])).rows
    const row = (await db.query('SELECT * FROM chat_reviews WHERE session_id=$1', [id])).rows[0] ?? null
    // Before publication an agent gets the conversation and nothing the AI or supervisor concluded.
    const review = reviewer || row?.published_at ? row : null
    const visible = review && !reviewer ? { id: review.id, status: review.status, final_loss_code: review.final_loss_code, final_findings: review.final_findings ?? (review.status === 'confirmed' ? review.ai_findings : []), reviewer_note: review.reviewer_note, ai_coaching: review.status === 'confirmed' ? review.ai_coaching : null, published_at: review.published_at, agent_response: review.agent_response, revision: review.revision } : review
    const facts_by_offer = reviewer ? await Promise.all(products.filter(p => p.source !== 'recent_order').slice(0, 3).map(async p => ({ offer_id: p.offer_id, ...(await productFacts(tenant(request), p.offer_id)) }))) : []
    return { data: { session: { id: session.id, chat_date: session.chat_date, agent_id: session.agent_id, login_id: session.login_id, is_main: session.is_main, user_name: session.user_name, buyer_id: session.buyer_id, buyer_tail: session.buyer_tail }, facts, messages, turns: [], products, review: visible, productFacts: facts_by_offer, own, canReview: canReview(request) }, lossNames: LOSS_NAMES }
  })

  app.post('/inquiry-review/sessions/:id/analyze', { preHandler: requirePermission('performance:review') }, async (request, reply) => {
    const { id } = idParams.parse(request.params)
    await sessionFor(request, id)
    const settings = await reviewSettings(tenant(request))
    try {
      const result = await analyzeSession(tenant(request), id, null, settings)
      if (!result.review) throw new IntegrationError('REVIEW_DECIDED', '这个会话已经由主管确认过，不会重新分析。', 409)
      await audit(request, 'performance.review.analyze', 'chat_review', result.review.id, { model: result.review.model, promptVersion: PROMPT_VERSION, inputTokens: result.inputTokens, outputTokens: result.outputTokens })
      return { data: result.review }
    } catch (error) {
      // Sent directly: the app-wide handler replaces every 5xx message, and these tell the supervisor what to do.
      if (error instanceof LlmConfigurationError) return reply.code(503).send({ error: 'AI_NOT_CONFIGURED', message: '尚未配置模型服务，无法分析。' })
      if (error instanceof LlmRequestError) return reply.code(502).send({ error: 'AI_FAILED', message: `模型暂时不可用：${error.message}` })
      if (error instanceof SyntaxError || error instanceof z.ZodError) return reply.code(502).send({ error: 'AI_INVALID_OUTPUT', message: '模型返回的内容格式不正确，请重试。' })
      throw error
    }
  })

  // A supervisor's decision. It also works with no AI result: most sessions are judged from rules and what they read themselves.
  app.put('/inquiry-review/sessions/:id/review', { preHandler: requirePermission('performance:review') }, async request => {
    const { id } = idParams.parse(request.params), d = decisionSchema.parse(request.body)
    const session = await sessionFor(request, id)
    if (d.action === 'correct' && !d.lossCode && !d.findings) throw new IntegrationError('VALIDATION_ERROR', '纠正时请选择原因或修改问题。', 400)
    const status = { confirm: 'confirmed', correct: 'corrected', dismiss: 'dismissed' }[d.action]
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      await client.query(`INSERT INTO chat_reviews(tenant_id,session_id,agent_id,chat_date,evidence_level,revision) VALUES($1,$2,$3,$4,'rules_only',0) ON CONFLICT(session_id) DO NOTHING`, [tenant(request), id, session.agent_id, session.chat_date])
      const row = (await client.query(`UPDATE chat_reviews SET status=$3,final_loss_code=$4,final_findings=$5,reviewer_note=$6,reviewed_by=$7,reviewed_at=now(),
          published_at=CASE WHEN $8::boolean THEN coalesce(published_at,now()) ELSE NULL END,revision=revision+1,updated_at=now()
        WHERE session_id=$1 AND tenant_id=$2 AND revision=$9 RETURNING *`,
      [id, tenant(request), status, d.action === 'dismiss' ? null : d.lossCode ?? null, d.action === 'dismiss' ? '[]' : d.findings ? JSON.stringify(d.findings) : null, d.note || null, request.authUser.sub, d.action !== 'dismiss' && d.publish, d.revision])).rows[0]
      if (!row) throw new IntegrationError('CONFLICT', '这条复盘已被他人修改，请刷新后重试。', 409)
      await client.query('INSERT INTO audit_logs(tenant_id,actor_id,action,entity_type,entity_id,after_data,request_id)VALUES($1,$2,$3,$4,$5,$6,$7)', [tenant(request), request.authUser.sub, `performance.review.${d.action}`, 'chat_review', row.id, JSON.stringify({ sessionId: id, aiLossCode: row.ai_loss_code, finalLossCode: row.final_loss_code, publish: d.publish }), request.id])
      await client.query('COMMIT')
      return { data: row }
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  })

  // An agent's explanation or objection on a published review of their own.
  app.post('/inquiry-review/reviews/:id/response', { preHandler: readScope }, async request => {
    const { id } = idParams.parse(request.params), { text } = z.object({ text: z.string().trim().min(1, '请填写说明。').max(1000) }).strict().parse(request.body)
    const row = (await db.query(`UPDATE chat_reviews r SET agent_response=$3,agent_responded_at=now(),updated_at=now() FROM perf_agents a
      WHERE r.id=$1 AND r.tenant_id=$2 AND a.id=r.agent_id AND a.user_id=$4 AND r.published_at IS NOT NULL RETURNING r.id,r.agent_response,r.agent_responded_at`, [id, tenant(request), text, request.authUser.sub])).rows[0]
    if (!row) throw new IntegrationError('NOT_FOUND', '复盘不存在或尚未发布。', 404)
    await audit(request, 'performance.review.response', 'chat_review', id, {})
    return { data: row }
  })

  app.put('/inquiry-review/sessions/:id/products', { preHandler: requirePermission('performance:review') }, async request => {
    const { id } = idParams.parse(request.params), { offerId, name } = z.object({ offerId: z.string().regex(/^\d{1,30}$/, '商品 ID 应为数字。'), name: z.string().trim().max(200).nullable().optional() }).strict().parse(request.body)
    await sessionFor(request, id)
    await db.query(`INSERT INTO chat_session_products(tenant_id,session_id,offer_id,product_name,source,confidence,created_by)
      VALUES($1,$2,$3,coalesce($4,(SELECT title FROM integration_1688_listings WHERE tenant_id=$1 AND offer_id=$3 ORDER BY synced_at DESC LIMIT 1)),'manual','certain',$5)
      ON CONFLICT(session_id,offer_id,source) DO UPDATE SET product_name=excluded.product_name,created_by=excluded.created_by`, [tenant(request), id, offerId, name || null, request.authUser.sub])
    await audit(request, 'performance.review.product', 'perf_chat_session', id, { offerId })
    return { data: (await db.query('SELECT offer_id,product_name,source,confidence,evidence_message_uuid FROM chat_session_products WHERE session_id=$1', [id])).rows }
  })
  app.delete('/inquiry-review/sessions/:id/products/:offerId', { preHandler: requirePermission('performance:review') }, async (request, reply) => {
    const { id, offerId } = z.object({ id: z.string().uuid(), offerId: z.string().regex(/^\d{1,30}$/) }).parse(request.params)
    await sessionFor(request, id)
    await db.query("DELETE FROM chat_session_products WHERE session_id=$1 AND offer_id=$2 AND source='manual' AND tenant_id=$3", [id, offerId, tenant(request)])
    return reply.code(204).send()
  })

  // 流失原因: confirmed conclusions and what rules prove. AI guesses join only when asked for, and are labelled.
  app.get('/inquiry/loss-analysis', { preHandler: requireReviewRead }, async request => {
    const q = reportQuery.and(z.object({ includeAi: z.enum(['true', 'false']).default('false') })).parse(request.query)
    await ensureConnection(tenant(request), q.connectionId)
    await ensureSettings(tenant(request))
    const params = [tenant(request), q.connectionId, q.from, q.to, null, q.includeAi === 'true']
    const reason = `coalesce(${finalLossSql('r', 'f')},CASE WHEN $6::boolean AND r.status='pending' THEN r.ai_loss_code END,'unknown')`
    const base = `FROM review_rules f LEFT JOIN chat_reviews r ON r.session_id=f.id WHERE f.category='no_order' AND f.matured AND coalesce(r.status,'')<>'dismissed'`
    const reasons = (await db.query(`WITH ${reviewFactsCte} SELECT ${reason} AS code,count(*)::int AS sessions,count(*) FILTER (WHERE r.status IN ('confirmed','corrected'))::int AS confirmed,count(*) FILTER (WHERE f.rule_loss_code IS NOT NULL AND coalesce(r.status,'pending')='pending')::int AS by_rule ${base} GROUP BY 1 ORDER BY 2 DESC`, params)).rows
    const agents = (await db.query(`WITH ${reviewFactsCte} SELECT f.agent_id,a.login_id,a.is_main,u.display_name AS user_name,${reason} AS code,count(*)::int AS sessions ${base.replace('FROM review_rules f LEFT JOIN chat_reviews r ON r.session_id=f.id', 'FROM review_rules f LEFT JOIN chat_reviews r ON r.session_id=f.id JOIN perf_agents a ON a.id=f.agent_id LEFT JOIN users u ON u.id=a.user_id')} GROUP BY 1,2,3,4,5 ORDER BY 6 DESC LIMIT 200`, params)).rows
    const coverage = (await db.query(`WITH ${reviewFactsCte} SELECT count(*)::int AS lost,count(*) FILTER (WHERE r.status IN ('confirmed','corrected'))::int AS confirmed,count(*) FILTER (WHERE f.evidence_level='sufficient')::int AS sufficient,
        count(*) FILTER (WHERE EXISTS(SELECT 1 FROM chat_session_products p WHERE p.session_id=f.id AND p.source<>'recent_order'))::int AS with_product ${base}`, params.slice(0, 5))).rows[0]
    const refunds = (await db.query(`SELECT coalesce(nullif(r.apply_reason,''),'未填写') AS reason,count(*)::int AS refunds FROM perf_refunds r WHERE r.tenant_id=$1 AND r.connection_id=$2 AND r.applied_at>=($3::date::timestamp AT TIME ZONE 'Asia/Shanghai') AND r.applied_at<(($4::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai') GROUP BY 1 ORDER BY 2 DESC LIMIT 12`, [tenant(request), q.connectionId, q.from, q.to])).rows
    return { data: { reasons, agents, coverage, refunds, includeAi: q.includeAi === 'true' }, lossNames: LOSS_NAMES }
  })

  // 商品询盘: only sessions tied to an offer by evidence; the coverage says how much of the picture this is.
  app.get('/inquiry/products', { preHandler: readScope }, async request => {
    const q = reportQuery.parse(request.query)
    await ensureConnection(tenant(request), q.connectionId)
    await ensureSettings(tenant(request))
    await refreshSessionProducts(tenant(request), q.connectionId, q.from, q.to)
    const params = [tenant(request), q.connectionId, q.from, q.to, scope(request)]
    const products = (await db.query(`WITH ${reviewFactsCte},
      linked AS (SELECT DISTINCT ON (p.session_id,p.offer_id) p.session_id,p.offer_id,p.product_name,p.source FROM chat_session_products p WHERE p.tenant_id=$1 AND p.source NOT IN ('recent_order','ai_text') ORDER BY p.session_id,p.offer_id,p.source)
      SELECT l.offer_id,max(l.product_name) AS name,count(*)::int AS sessions,
        count(*) FILTER (WHERE l.source<>'order_after')::int AS before_order,
        count(*) FILTER (WHERE f.category IN ('paid','ordered_unpaid'))::int AS ordered,count(*) FILTER (WHERE f.category='paid')::int AS paid,count(*) FILTER (WHERE f.category='no_order' AND f.matured)::int AS lost
      FROM review_rules f JOIN linked l ON l.session_id=f.id WHERE NOT f.after_sales GROUP BY l.offer_id ORDER BY 3 DESC LIMIT 100`, params)).rows
    const coverage = (await db.query(`WITH ${reviewFactsCte} SELECT count(*) FILTER (WHERE f.category='no_order')::int AS no_order,
        count(*) FILTER (WHERE f.category='no_order' AND EXISTS(SELECT 1 FROM chat_session_products p WHERE p.session_id=f.id AND p.source NOT IN ('recent_order','ai_text')))::int AS no_order_linked,
        count(*)::int AS inquiries,count(*) FILTER (WHERE EXISTS(SELECT 1 FROM chat_session_products p WHERE p.session_id=f.id AND p.source NOT IN ('recent_order','ai_text')))::int AS linked FROM review_rules f WHERE NOT f.after_sales`, params)).rows[0]
    const orders = (await db.query(`SELECT i->>'productId' AS offer_id,count(DISTINCT o.id) FILTER (WHERE o.status='cancel')::int AS cancelled,
        count(DISTINCT rf.refund_id)::int AS refunds,coalesce(jsonb_agg(DISTINCT rf.apply_reason) FILTER (WHERE rf.apply_reason IS NOT NULL AND rf.apply_reason<>''),'[]'::jsonb) AS refund_reasons
      FROM perf_orders o CROSS JOIN LATERAL jsonb_array_elements(o.items) i LEFT JOIN perf_refunds rf ON rf.connection_id=o.connection_id AND rf.order_id=o.order_id
      WHERE o.tenant_id=$1 AND o.connection_id=$2 AND o.placed_at>=($3::date::timestamp AT TIME ZONE 'Asia/Shanghai') AND o.placed_at<(($4::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai') AND i->>'productId'=ANY($5::text[]) GROUP BY 1`,
    [tenant(request), q.connectionId, q.from, q.to, products.map(p => p.offer_id)])).rows
    const byOffer = new Map(orders.map(o => [o.offer_id, o]))
    return { data: { products: products.map(p => ({ ...p, cancelled: byOffer.get(p.offer_id)?.cancelled ?? 0, refunds: byOffer.get(p.offer_id)?.refunds ?? 0, refund_reasons: byOffer.get(p.offer_id)?.refund_reasons ?? [] })), coverage } }
  })

  // Daily brief: figures come from SQL. An agent sees their own figures, published reviews and the supervisor's note, not the AI's summary.
  app.get('/agents/:id/brief', { preHandler: readScope }, async request => {
    const { id } = idParams.parse(request.params), { date } = z.object({ date: z.string().date().default(beijingToday()) }).parse(request.query)
    const agent = (await db.query('SELECT a.id,a.connection_id,a.login_id,a.is_main,a.user_id,u.display_name AS user_name FROM perf_agents a LEFT JOIN users u ON u.id=a.user_id WHERE a.id=$1 AND a.tenant_id=$2', [id, tenant(request)])).rows[0]
    if (!agent) throw new IntegrationError('NOT_FOUND', '客服不存在。', 404)
    const reviewer = canReadReviews(request), own = isOwnAgent(request, agent)
    if (!reviewer && !own) throw new IntegrationError('NOT_FOUND', '客服不存在。', 404)
    await ensureSettings(tenant(request))
    const stats = await agentDayStats(tenant(request), agent.connection_id, id, date)
    const brief = (await db.query('SELECT brief_date::text AS brief_date,summary,supervisor_note,model,prompt_version FROM chat_agent_daily_briefs WHERE agent_id=$1 AND brief_date=$2', [id, date])).rows[0] ?? null
    const reviews = (await db.query(`SELECT r.id,r.session_id,r.chat_date::text AS chat_date,r.status,r.ai_loss_code,r.final_loss_code,r.ai_findings,r.final_findings,r.ai_coaching,r.reviewer_note,r.published_at,r.agent_response,r.revision
      FROM chat_reviews r WHERE r.agent_id=$1 AND r.chat_date BETWEEN ($2::date-6) AND $2::date AND r.status IN ('confirmed','corrected') AND ($3::boolean OR r.published_at IS NOT NULL) ORDER BY r.chat_date DESC,r.reviewed_at DESC LIMIT 50`, [id, date, reviewer])).rows
    const trend = (await db.query(`SELECT brief_date::text AS date,stats->'today' AS today FROM chat_agent_daily_briefs WHERE agent_id=$1 AND brief_date BETWEEN ($2::date-27) AND $2::date ORDER BY brief_date`, [id, date])).rows
    const items = (await db.query(`SELECT c.id,c.title,c.detail,c.status,c.due_date::text AS due_date,c.review_id,c.created_at,u.display_name AS created_by_name FROM chat_coaching_items c LEFT JOIN users u ON u.id=c.created_by WHERE c.agent_id=$1 AND c.tenant_id=$2 ORDER BY CASE c.status WHEN 'open' THEN 0 WHEN 'acknowledged' THEN 1 ELSE 2 END,c.created_at DESC LIMIT 50`, [id, tenant(request)])).rows
    return { data: { agent: { id: agent.id, login_id: agent.login_id, is_main: agent.is_main, user_name: agent.user_name }, stats, summary: reviewer ? brief?.summary ?? null : null, supervisorNote: brief?.supervisor_note ?? null, reviews: reviewer ? reviews : reviews.map(r => ({ ...r, ai_loss_code: null, ai_findings: r.status === 'confirmed' ? r.ai_findings : [], ai_coaching: r.status === 'confirmed' ? r.ai_coaching : null })), trend, items, canReview: canReview(request), own }, lossNames: LOSS_NAMES }
  })
  app.put('/agents/:id/brief', { preHandler: requirePermission('performance:review') }, async request => {
    const { id } = idParams.parse(request.params), { date, note } = z.object({ date: z.string().date(), note: z.string().trim().max(2000).nullable() }).strict().parse(request.body)
    const agent = (await db.query('SELECT id,connection_id FROM perf_agents WHERE id=$1 AND tenant_id=$2', [id, tenant(request)])).rows[0]
    if (!agent) throw new IntegrationError('NOT_FOUND', '客服不存在。', 404)
    await ensureSettings(tenant(request))
    const stats = await agentDayStats(tenant(request), agent.connection_id, id, date)
    await db.query(`INSERT INTO chat_agent_daily_briefs(tenant_id,agent_id,brief_date,stats,supervisor_note)VALUES($1,$2,$3,$4,$5) ON CONFLICT(agent_id,brief_date) DO UPDATE SET supervisor_note=excluded.supervisor_note`, [tenant(request), id, date, JSON.stringify(stats), note || null])
    await audit(request, 'performance.brief.note', 'perf_agent', id, { date })
    return { data: { supervisorNote: note || null } }
  })

  app.post('/coaching-items', { preHandler: requirePermission('performance:review') }, async (request, reply) => {
    const d = coachingSchema.parse(request.body)
    const agent = (await db.query('SELECT id FROM perf_agents WHERE id=$1 AND tenant_id=$2', [d.agentId, tenant(request)])).rows[0]
    if (!agent) throw new IntegrationError('NOT_FOUND', '客服不存在。', 404)
    const row = (await db.query(`INSERT INTO chat_coaching_items(tenant_id,agent_id,review_id,title,detail,due_date,created_by)
      VALUES($1,$2,(SELECT id FROM chat_reviews WHERE id=$3 AND tenant_id=$1 AND agent_id=$2),$4,$5,$6,$7) RETURNING *`, [tenant(request), d.agentId, d.reviewId ?? null, d.title, d.detail || null, d.dueDate ?? null, request.authUser.sub])).rows[0]
    await audit(request, 'performance.coaching.create', 'chat_coaching_item', row.id, { agentId: d.agentId })
    return reply.code(201).send({ data: row })
  })
  // The agent acknowledges and finishes; dropping one, or reopening it, is the supervisor's.
  app.patch('/coaching-items/:id', { preHandler: readScope }, async request => {
    const { id } = idParams.parse(request.params), { status } = z.object({ status: z.enum(['open', 'acknowledged', 'done', 'dropped']) }).strict().parse(request.body)
    const item = (await db.query('SELECT c.id,c.status,a.user_id FROM chat_coaching_items c JOIN perf_agents a ON a.id=c.agent_id WHERE c.id=$1 AND c.tenant_id=$2', [id, tenant(request)])).rows[0]
    if (!item || (!canReview(request) && !isOwnAgent(request, item))) throw new IntegrationError('NOT_FOUND', '改进事项不存在。', 404)
    if (!canReview(request) && !['acknowledged', 'done'].includes(status)) throw new IntegrationError('FORBIDDEN', '只能标记为已知悉或已完成。', 403)
    const row = (await db.query('UPDATE chat_coaching_items SET status=$2,updated_at=now() WHERE id=$1 RETURNING *', [id, status])).rows[0]
    await audit(request, 'performance.coaching.update', 'chat_coaching_item', id, { status })
    return { data: row }
  })

  app.get('/inquiry-review/settings', { preHandler: requireReviewRead }, async request => {
    const { connectionId } = z.object({ connectionId: z.string().uuid().optional() }).parse(request.query)
    const runs = connectionId ? (await db.query('SELECT id,review_date::text AS review_date,status,stats,error_message,created_at,finished_at FROM chat_review_runs WHERE tenant_id=$1 AND connection_id=$2 ORDER BY review_date DESC LIMIT 14', [tenant(request), connectionId])).rows : []
    return { data: { ...(await reviewSettings(tenant(request))), models: QWEN_MODELS, runs } }
  })
  app.put('/inquiry-review/settings', { preHandler: requirePermission('performance:manage') }, async request => {
    const d = z.object({ enabled: z.boolean(), dailySessionLimit: z.number().int().min(0).max(2000), minRealChars: z.number().int().min(1).max(1000), model: z.enum(QWEN_MODELS) }).strict().parse(request.body)
    await reviewSettings(tenant(request))
    await db.query('UPDATE chat_review_settings SET enabled=$2,daily_session_limit=$3,min_real_chars=$4,model=$5,updated_at=now() WHERE tenant_id=$1', [tenant(request), d.enabled, d.dailySessionLimit, d.minRealChars, d.model])
    await audit(request, 'performance.review.settings', 'chat_review_settings', tenant(request), d)
    return { data: await reviewSettings(tenant(request)) }
  })
  app.post('/inquiry-review/runs', { preHandler: requirePermission('performance:manage') }, async (request, reply) => {
    const d = z.object({ connectionId: z.string().uuid(), date: z.string().date() }).strict().parse(request.body)
    await ensureConnection(tenant(request), d.connectionId)
    if (d.date > beijingToday()) throw new IntegrationError('VALIDATION_ERROR', '不能分析未来的日期。', 400)
    const run = await enqueueReviewRun(tenant(request), d.connectionId, d.date)
    if (!run) throw new IntegrationError('RUN_ACTIVE', '这一天的复盘正在进行。', 409)
    await audit(request, 'performance.review.run', 'chat_review_run', run.id, { date: d.date })
    return reply.code(202).send({ data: run })
  })
}
