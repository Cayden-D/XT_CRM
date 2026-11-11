import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { db } from '../db.js'
import { IntegrationError } from '../integrations/1688.js'
import { availableSchemes } from '../integrations/1688-performance-orders.js'
import { attributionKey, chatCategories, ensureSettings, factsSql, replyAtSql, schemeOf } from '../integrations/1688-performance-reports.js'
import { ensureConnection, ownOnly, readScope, reportQuery } from './1688-performance.js'
import { replyQuality } from '../integrations/chat-insights.js'

const scope = (request: FastifyRequest) => ownOnly(request) ? request.authUser.sub : null

export async function performanceAnalysisRoutes(app: FastifyInstance) {
  app.get('/chats', { preHandler: readScope }, async request => {
    const query = z.object({ connectionId: z.string().uuid(), from: z.string(), to: z.string(), category: z.enum(chatCategories).optional(), agentId: z.string().uuid().optional(), page: z.coerce.number().int().min(1).max(1000).default(1) })
      .and(reportQuery).parse(request.query)
    await ensureConnection(request.authUser.tenantId, query.connectionId)
    await ensureSettings(request.authUser.tenantId)
    const params = [request.authUser.tenantId, query.connectionId, query.from, query.to, scope(request), query.category ?? null, query.agentId ?? null, (query.page - 1) * 50]
    const rows = (await db.query(`WITH ${factsSql}
      SELECT c.id,c.agent_id,c.buyer_id,ag.login_id,ag.is_main,u.display_name AS user_name,right(b.buyer_key,6) AS buyer_tail,coalesce(b.taobao_nick,b.login_id) AS buyer_nick,c.chat_date::text AS chat_date,c.started_at,c.last_peer_at,
        c.buyer_messages,c.agent_messages,c.other_agent_messages,c.auto_replies,c.transferred,c.category,c.orders_after,c.paid_after,c.new_customer,
        (SELECT round(perf_response_seconds(t.turn_at,r.reply_at,perf_response_clock(t.turn_at,settings.work_hours_enabled,settings.work_start,settings.work_end)))::int
          FROM perf_chat_turns t CROSS JOIN settings CROSS JOIN LATERAL (SELECT ${replyAtSql('t', 'c', 'settings')} AS reply_at) r
          WHERE t.session_id=c.id AND t.mode=settings.mode AND t.turn_index=0) AS first_response_seconds,
        (SELECT count(*)::int FROM perf_chat_turns t CROSS JOIN settings CROSS JOIN LATERAL (SELECT ${replyAtSql('t', 'c', 'settings')} AS reply_at) r
          CROSS JOIN LATERAL (SELECT perf_response_clock(t.turn_at,settings.work_hours_enabled,settings.work_start,settings.work_end) AS clock) k
          WHERE t.session_id=c.id AND t.mode=settings.mode AND ((r.reply_at IS NULL AND k.clock<now()-make_interval(secs=>settings.unanswered_threshold_seconds))
            OR perf_response_seconds(t.turn_at,r.reply_at,k.clock)>settings.unanswered_threshold_seconds)) AS unanswered
      FROM categorized c JOIN perf_agents ag ON ag.id=c.agent_id LEFT JOIN users u ON u.id=ag.user_id JOIN perf_buyers b ON b.id=c.buyer_id
      WHERE ($6::text IS NULL OR c.category=$6) AND ($7::uuid IS NULL OR c.agent_id=$7)
      ORDER BY c.started_at DESC LIMIT 50 OFFSET $8`, params)).rows
    const counts = (await db.query(`WITH ${factsSql} SELECT category,count(*)::int AS n FROM categorized WHERE ($6::uuid IS NULL OR agent_id=$6) GROUP BY category`,
      [request.authUser.tenantId, query.connectionId, query.from, query.to, scope(request), query.agentId ?? null])).rows
    return { data: rows, counts: Object.fromEntries(counts.map(c => [c.category, c.n])) }
  })

  app.get('/chats/:id/messages', { preHandler: readScope }, async request => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const session = (await db.query(`SELECT s.id,s.chat_date::text AS chat_date,s.cid,ag.login_id,ag.is_main,ag.user_id FROM perf_chat_sessions s JOIN perf_agents ag ON ag.id=s.agent_id
      WHERE s.id=$1 AND s.tenant_id=$2`, [id, request.authUser.tenantId])).rows[0]
    if (!session || (ownOnly(request) && session.user_id !== request.authUser.sub)) throw new IntegrationError('NOT_FOUND', '会话不存在。', 404)
    const messages = (await db.query('SELECT uuid,direction,sent_at,length,message_types,keywords,text_masked,flags,image_urls FROM perf_chat_messages WHERE session_id=$1 ORDER BY sent_at,uuid', [id])).rows
    const turns = (await db.query("SELECT t.mode,t.turn_index,t.turn_at,t.reply_at,t.buyer_messages FROM perf_chat_turns t WHERE t.session_id=$1 ORDER BY t.mode,t.turn_index", [id])).rows
    return { data: { session: { id: session.id, chat_date: session.chat_date, login_id: session.login_id, is_main: session.is_main }, messages, turns } }
  })

  /**
   * Reply quality per agent from agent-side text, and the off-platform trading alerts. Text is only available for
   * messages synced since text capture started (coverage tells how much of the period is covered).
   */
  app.get('/quality', { preHandler: readScope }, async request => {
    const q = reportQuery.parse(request.query)
    await ensureConnection(request.authUser.tenantId, q.connectionId)
    return { data: await replyQuality(request.authUser.tenantId, q.connectionId, q.from, q.to, scope(request)) }
  })

  app.get('/orders', { preHandler: readScope }, async request => {
    const query = z.object({ connectionId: z.string().uuid(), from: z.string(), to: z.string(), scheme: z.enum(availableSchemes).optional(), agentId: z.string().uuid().optional(),
      orderId: z.string().regex(/^\d{1,30}$/).optional(), attributed: z.enum(['yes','no']).optional(), page: z.coerce.number().int().min(1).max(1000).default(1) }).and(reportQuery).parse(request.query)
    await ensureConnection(request.authUser.tenantId, query.connectionId)
    await ensureSettings(request.authUser.tenantId)
    const scheme = query.scheme ?? schemeOf((await db.query('SELECT default_scheme FROM perf_settings WHERE tenant_id=$1', [request.authUser.tenantId])).rows[0].default_scheme)
    const rows = (await db.query(`SELECT o.id,o.order_id,o.status,o.total_amount::float AS total_amount,o.placed_at,o.paid_at,o.items,
        (SELECT coalesce(sum(r.refund_total),0)::float FROM perf_refunds r WHERE r.connection_id=o.connection_id AND r.order_id=o.order_id AND r.status='refundsuccess') AS refunded,
        coalesce((SELECT json_agg(json_build_object('agent_id',a.agent_id,'login_id',ag.login_id,'is_main',ag.is_main,'user_name',u.display_name,'share',a.share::float,'basis',a.basis,'basis_at',a.basis_at) ORDER BY a.share DESC)
          FROM perf_order_attributions a JOIN perf_agents ag ON ag.id=a.agent_id LEFT JOIN users u ON u.id=ag.user_id WHERE a.order_id=o.id AND a.scheme=$6),'[]') AS credits
      FROM perf_orders o
      WHERE o.tenant_id=$1 AND o.connection_id=$2 AND o.placed_at>=($3::date::timestamp AT TIME ZONE 'Asia/Shanghai') AND o.placed_at<(($4::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai')
        AND ($7::text IS NULL OR o.order_id=$7)
        AND ($8::uuid IS NULL OR EXISTS(SELECT 1 FROM perf_order_attributions a WHERE a.order_id=o.id AND a.scheme=$6 AND a.agent_id=$8))
        AND ($5::uuid IS NULL OR EXISTS(SELECT 1 FROM perf_order_attributions a JOIN perf_agents ag ON ag.id=a.agent_id WHERE a.order_id=o.id AND a.scheme=$6 AND ag.user_id=$5))
        AND ($9::text IS NULL OR ($9='yes')=EXISTS(SELECT 1 FROM perf_order_attributions a WHERE a.order_id=o.id AND a.scheme=$6))
      ORDER BY o.placed_at DESC LIMIT 50 OFFSET $10`,
    [request.authUser.tenantId, query.connectionId, query.from, query.to, scope(request), scheme, query.orderId ?? null, query.agentId ?? null, query.attributed ?? null, (query.page - 1) * 50])).rows
    const pending = (await db.query('SELECT count(*)::int AS n FROM perf_orders WHERE connection_id=$1 AND attribution_key IS DISTINCT FROM $2', [query.connectionId, await attributionKey(request.authUser.tenantId)])).rows[0].n
    return { data: rows, scheme, pendingAttribution: pending }
  })
}
