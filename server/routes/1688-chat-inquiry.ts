import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { db } from '../db.js'
import { IntegrationError } from '../integrations/1688.js'
import { callPerformanceApi } from '../integrations/1688-performance.js'
import { ensureSettings, factsSql } from '../integrations/1688-performance-reports.js'
import { ensureConnection, ownOnly, readScope, reportQuery } from './1688-performance.js'

/**
 * 聊天与询盘: inquiry analysis over the synced sessions, finding a buyer by the Wangwang login name the merchant types,
 * and opening a Wangwang chat with a buyer.
 *
 * The two account interfaces are risk-controlled by 1688: loginid.openuid.encrypt only on a merchant's own action,
 * wangwangnick.openuid.decrypt only to open a Wangwang chat. So each call is one buyer, on a click, rate-limited per
 * user, and neither the typed login name nor the decrypted nickname is stored, logged or shown (the nickname only
 * travels inside the chat link the browser opens).
 */
const tenant = (request: FastifyRequest) => request.authUser.tenantId
const scope = (request: FastifyRequest) => ownOnly(request) ? request.authUser.sub : null
const LIMIT = 30, WINDOW_MS = 10 * 60_000
const uses = new Map<string, number[]>()
function throttle(request: FastifyRequest, kind: string) {
  const key = `${kind}:${request.authUser.sub}`, now = Date.now()
  const recent = (uses.get(key) ?? []).filter(t => now - t < WINDOW_MS)
  if (recent.length >= LIMIT) throw new IntegrationError('TOO_FREQUENT', '操作过于频繁：平台只允许人工逐个查询，请稍后再试。', 429)
  uses.set(key, [...recent, now])
}
const audit = (request: FastifyRequest, action: string, entityId: string, data: object) => db.query(
  "INSERT INTO audit_logs(tenant_id,actor_id,action,entity_type,entity_id,after_data,request_id)VALUES($1,$2,$3,'perf_buyer',$4,$5,$6)",
  [tenant(request), request.authUser.sub, action, entityId, JSON.stringify(data), request.id])
/** A buyer of this tenant; with own-only access, only buyers the user's bound agents have talked to. */
async function buyerFor(request: FastifyRequest, id: string) {
  const buyer = (await db.query(`SELECT b.id,b.connection_id,b.buyer_key,b.open_uid,b.first_chat_at,b.last_chat_at FROM perf_buyers b WHERE b.id=$1 AND b.tenant_id=$2
    AND ($3::uuid IS NULL OR EXISTS(SELECT 1 FROM perf_chat_sessions s JOIN perf_agents a ON a.id=s.agent_id WHERE s.buyer_id=b.id AND a.user_id=$3))`, [id, tenant(request), scope(request)])).rows[0]
  if (!buyer) throw new IntegrationError('NOT_FOUND', '买家不存在。', 404)
  return buyer
}
/** Links that open a Wangwang chat with the buyer: 1688 web chat, and the desktop client. */
export function wangwangLinks(nick: string) {
  const to = encodeURIComponent(`cnalichn${nick}`)
  return {
    web: `https://air.1688.com/app/ocms-fusion-components-1688/def_cbu_web_im/index.html?touid=${to}&siteid=cnalichn&status=1#/`,
    client: `aliim:sendmsg?uid=cnalichn&touid=${to}&siteid=cnalichn&status=1`,
  }
}

export async function chatInquiryRoutes(app: FastifyInstance) {
  // 询盘分析: pre-sales inquiries (buyer·day, excluding after-sales chats) and what became of them.
  app.get('/inquiry', { preHandler: readScope }, async request => {
    const q = reportQuery.parse(request.query)
    await ensureConnection(tenant(request), q.connectionId)
    await ensureSettings(tenant(request))
    const params = [tenant(request), q.connectionId, q.from, q.to, scope(request)]
    // One statement so the session categorization (the expensive part) is computed once for all the figures.
    const [data] = (await db.query(`WITH ${factsSql},
      cats AS MATERIALIZED (SELECT id,buyer_id,agent_id,chat_date,started_at,after_sales,new_customer,orders_after IS NOT NULL AS ordered,paid_after IS NOT NULL AS paid FROM categorized),
      inquiries AS MATERIALIZED (SELECT DISTINCT ON (buyer_id,chat_date) * FROM cats WHERE NOT after_sales ORDER BY buyer_id,chat_date,started_at)
      SELECT
        (SELECT json_build_object('sessions',(SELECT count(*) FROM cats),'buyers',(SELECT count(DISTINCT buyer_id) FROM cats),'after_sales',(SELECT count(*) FROM cats WHERE after_sales),
          'inquiries',count(*),'new_buyers',count(*) FILTER (WHERE new_customer),'ordered',count(*) FILTER (WHERE ordered),'paid',count(*) FILTER (WHERE paid)) FROM inquiries) AS totals,
        (SELECT coalesce(json_agg(d ORDER BY d.date),'[]') FROM (SELECT chat_date::text AS date,count(*)::int AS inquiries,count(*) FILTER (WHERE new_customer)::int AS new_buyers,
          count(*) FILTER (WHERE paid)::int AS paid FROM inquiries GROUP BY chat_date) d) AS daily,
        (SELECT coalesce(json_agg(h ORDER BY h.hour),'[]') FROM (SELECT extract(hour FROM started_at AT TIME ZONE 'Asia/Shanghai')::int AS hour,count(*)::int AS inquiries FROM inquiries GROUP BY 1) h) AS hourly,
        (SELECT coalesce(json_agg(g ORDER BY g.inquiries DESC),'[]') FROM (SELECT i.agent_id,a.login_id,a.is_main,u.display_name AS user_name,count(*)::int AS inquiries,
          count(*) FILTER (WHERE i.new_customer)::int AS new_buyers,count(*) FILTER (WHERE i.ordered)::int AS ordered,count(*) FILTER (WHERE i.paid)::int AS paid
          FROM inquiries i JOIN perf_agents a ON a.id=i.agent_id LEFT JOIN users u ON u.id=a.user_id GROUP BY 1,2,3,4 ORDER BY inquiries DESC LIMIT 30) g) AS agents,
        (SELECT coalesce(json_agg(k ORDER BY k.hits DESC),'[]') FROM (SELECT w->>'word' AS word,sum(coalesce((w->>'count')::int,1))::int AS hits,count(DISTINCT m.session_id)::int AS sessions
          FROM perf_chat_messages m CROSS JOIN LATERAL jsonb_array_elements(m.keywords) w WHERE m.direction=1 AND m.keywords<>'[]' AND m.session_id IN (SELECT id FROM cats)
          GROUP BY 1 ORDER BY hits DESC LIMIT 12) k) AS keywords`, [tenant(request), q.connectionId, q.from, q.to, scope(request)])).rows
    const { totals, daily, hourly, agents, keywords } = data
    return { data: { totals, daily, hourly, agents, keywords } }
  })

  // 买家在问什么 → the conversations behind one keyword: sessions in the period where a buyer message carried it.
  app.get('/inquiry/keyword-sessions', { preHandler: readScope }, async request => {
    const q = reportQuery.extend({ word: z.string().trim().min(1).max(50) }).parse(request.query)
    await ensureConnection(tenant(request), q.connectionId)
    const rows = (await db.query(`SELECT s.id,s.chat_date::text AS chat_date,s.buyer_id,right(b.buyer_key,6) AS buyer_tail,p.name AS buyer_name,
        ag.login_id,ag.is_main,u.display_name AS user_name,s.buyer_messages,s.agent_messages,
        sum(coalesce((k->>'count')::int,1))::int AS hits,min(m.sent_at) AS first_hit_at,(array_agg(m.uuid ORDER BY m.sent_at))[1] AS first_hit_uuid
      FROM perf_chat_messages m JOIN perf_chat_sessions s ON s.id=m.session_id JOIN perf_agents ag ON ag.id=s.agent_id JOIN perf_buyers b ON b.id=s.buyer_id
        LEFT JOIN cust_profiles p ON p.buyer_id=b.id LEFT JOIN users u ON u.id=ag.user_id CROSS JOIN LATERAL jsonb_array_elements(m.keywords) k
      WHERE s.tenant_id=$1 AND s.connection_id=$2 AND s.chat_date BETWEEN $3::date AND $4::date AND m.direction=1 AND m.keywords<>'[]'::jsonb AND k->>'word'=$5
        AND ($6::uuid IS NULL OR ag.user_id=$6)
      GROUP BY s.id,b.buyer_key,p.name,ag.login_id,ag.is_main,u.display_name ORDER BY min(m.sent_at) DESC LIMIT 51`,
    [tenant(request), q.connectionId, q.from, q.to, q.word, scope(request)])).rows
    return { data: rows.slice(0, 50), hasMore: rows.length > 50 }
  })

  // Find a buyer by the Wangwang login name the merchant typed (encrypted by 1688 to the openUid our records use).
  app.post('/buyers/lookup', { preHandler: readScope }, async request => {
    const input = z.object({ connectionId: z.string().uuid(), loginId: z.string().trim().min(2, '请输入买家的旺旺名（登录名）。').max(64) }).strict().parse(request.body)
    await ensureConnection(tenant(request), input.connectionId)
    throttle(request, 'encrypt')
    const response = await callPerformanceApi(input.connectionId, tenant(request), request.authUser.sub, 'loginid.openuid.encrypt', { loginId: input.loginId }, request.id) as { openUid?: unknown; result?: { openUid?: unknown } }
    const openUid = response.openUid ?? response.result?.openUid
    if (typeof openUid !== 'string' || !openUid) throw new IntegrationError('NOT_FOUND', '平台没有找到这个旺旺名。', 404)
    const found = (await db.query(`SELECT b.id FROM perf_buyers b WHERE b.connection_id=$1 AND (b.buyer_key=$2 OR b.open_uid=$2 OR b.admin_open_uid=$2
        OR b.id IN (SELECT buyer_id FROM perf_buyer_identities WHERE connection_id=$1 AND open_uid=$2))
      AND ($3::uuid IS NULL OR EXISTS(SELECT 1 FROM perf_chat_sessions s JOIN perf_agents a ON a.id=s.agent_id WHERE s.buyer_id=b.id AND a.user_id=$3)) LIMIT 1`,
    [input.connectionId, openUid, scope(request)])).rows[0]
    await audit(request, 'performance.buyer.lookup', found?.id ?? input.connectionId, { found: Boolean(found) })
    if (!found) return { data: null }
    const buyer = await buyerFor(request, found.id)
    const sessions = (await db.query(`SELECT s.id,s.chat_date::text AS chat_date,s.buyer_messages,s.agent_messages,a.login_id,a.is_main,u.display_name AS user_name
      FROM perf_chat_sessions s JOIN perf_agents a ON a.id=s.agent_id LEFT JOIN users u ON u.id=a.user_id
      WHERE s.buyer_id=$1 AND ($2::uuid IS NULL OR a.user_id=$2) ORDER BY s.chat_date DESC LIMIT 30`, [buyer.id, scope(request)])).rows
    const orders = (await db.query(`SELECT count(*)::int AS orders,count(*) FILTER (WHERE o.paid_at IS NOT NULL)::int AS paid,coalesce(sum(o.total_amount) FILTER (WHERE o.paid_at IS NOT NULL),0)::float AS paid_amount,max(o.placed_at) AS last_order_at
      FROM perf_orders o WHERE o.connection_id=$1 AND o.buyer_open_uid IN (SELECT open_uid FROM perf_buyer_identities WHERE buyer_id=$2 UNION SELECT $3)`, [buyer.connection_id, buyer.id, buyer.open_uid ?? buyer.buyer_key])).rows[0]
    return { data: { id: buyer.id, buyer_tail: String(buyer.buyer_key).slice(-6), first_chat_at: buyer.first_chat_at, last_chat_at: buyer.last_chat_at, sessions, orders } }
  })

  // Opens a Wangwang chat with the buyer: decrypts on this click only and returns the chat links (nothing stored).
  app.post('/buyers/:id/wangwang', { preHandler: readScope }, async request => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const buyer = await buyerFor(request, id)
    const openUid = buyer.open_uid ?? buyer.buyer_key
    throttle(request, 'decrypt')
    const response = await callPerformanceApi(buyer.connection_id, tenant(request), request.authUser.sub, 'wangwangnick.openuid.decrypt', { openUid }, request.id) as { wangwangNick?: unknown; result?: { wangwangNick?: unknown } }
    const nick = response.wangwangNick ?? response.result?.wangwangNick
    if (typeof nick !== 'string' || !nick.trim()) throw new IntegrationError('WANGWANG_UNAVAILABLE', '平台没有返回可用的旺旺联系方式（买家可能已注销或限制联系）。', 404)
    await audit(request, 'performance.buyer.wangwang', buyer.id, {})
    return { data: wangwangLinks(nick.trim()) }
  })
}
