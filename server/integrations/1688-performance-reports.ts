import { db } from '../db.js'
import { attributionKeySql, availableSchemes, manualReplySql } from './1688-performance-orders.js'

export const chatCategories = ['no_order','ordered_unpaid','paid','after_sales'] as const

/**
 * Per session-day facts used by reports and chat analysis ($1 tenant, $2 shop, $3..$4 dates, $5 own-user filter).
 * - after_sales: the buyer paid an order in the 90 days before that day
 * - new_customer: no paid order before that day in the synced order history
 * - orders_after / paid_after: orders placed (paid) within the attribution window after the first buyer turn
 */
export const factsSql = `settings AS (SELECT attribution_window_hours,count_other_as_reply,CASE WHEN count_other_as_reply THEN 'loose' ELSE 'strict' END AS mode,
    unanswered_threshold_seconds,default_scheme,work_hours_enabled,work_start,work_end FROM perf_settings WHERE tenant_id=$1),
  sessions AS (SELECT s.*,(s.chat_date::timestamp AT TIME ZONE 'Asia/Shanghai') AS day_start,
      coalesce((SELECT min(t.turn_at) FROM perf_chat_turns t WHERE t.session_id=s.id AND t.mode='strict'),(s.chat_date::timestamp AT TIME ZONE 'Asia/Shanghai')) AS started_at
    FROM perf_chat_sessions s JOIN perf_agents a ON a.id=s.agent_id
    WHERE s.tenant_id=$1 AND s.connection_id=$2 AND s.chat_date BETWEEN $3::date AND $4::date AND ($5::uuid IS NULL OR a.user_id=$5) AND s.buyer_messages>0),
  buyer_orders AS (SELECT DISTINCT i.buyer_id,o.id,o.order_id,o.placed_at,o.paid_at,o.total_amount
    FROM perf_orders o JOIN perf_buyer_identities i ON i.connection_id=o.connection_id AND i.open_uid=o.buyer_open_uid
    WHERE o.connection_id=$2 AND i.buyer_id IN (SELECT buyer_id FROM sessions)),
  facts AS (SELECT s.*,
    EXISTS(SELECT 1 FROM buyer_orders b WHERE b.buyer_id=s.buyer_id AND b.paid_at<s.day_start AND b.paid_at>=s.day_start-interval '90 days') AS after_sales,
    NOT EXISTS(SELECT 1 FROM buyer_orders b WHERE b.buyer_id=s.buyer_id AND b.paid_at<s.day_start) AS new_customer,
    (SELECT array_agg(b.order_id ORDER BY b.placed_at) FROM buyer_orders b CROSS JOIN settings WHERE b.buyer_id=s.buyer_id AND b.placed_at>=s.started_at AND b.placed_at<=s.started_at+make_interval(hours=>settings.attribution_window_hours)) AS orders_after,
    (SELECT array_agg(b.order_id ORDER BY b.placed_at) FROM buyer_orders b CROSS JOIN settings WHERE b.buyer_id=s.buyer_id AND b.paid_at IS NOT NULL AND b.placed_at>=s.started_at AND b.placed_at<=s.started_at+make_interval(hours=>settings.attribution_window_hours)) AS paid_after
    FROM sessions s),
  categorized AS (SELECT f.*,CASE WHEN f.after_sales THEN 'after_sales' WHEN f.paid_after IS NOT NULL THEN 'paid' WHEN f.orders_after IS NOT NULL THEN 'ordered_unpaid' ELSE 'no_order' END AS category FROM facts f)`

export const ensureSettings = (tenantId: string) => db.query('INSERT INTO perf_settings(tenant_id) VALUES($1) ON CONFLICT DO NOTHING', [tenantId])
export const schemeOf = (value: string) => (availableSchemes as readonly string[]).includes(value) ? value : 'order_first'

export async function conversionByAgent(tenantId: string, connectionId: string, from: string, to: string, ownUser: string | null) {
  await ensureSettings(tenantId)
  const scheme = schemeOf((await db.query('SELECT default_scheme FROM perf_settings WHERE tenant_id=$1', [tenantId])).rows[0].default_scheme)
  const conversion = (await db.query(`WITH ${factsSql}
    SELECT agent_id,
      count(DISTINCT (buyer_id,chat_date)) FILTER (WHERE NOT after_sales)::int AS inquiry,
      count(DISTINCT (buyer_id,chat_date)) FILTER (WHERE NOT after_sales AND new_customer)::int AS new_customer_inquiry,
      count(DISTINCT (buyer_id,chat_date)) FILTER (WHERE after_sales)::int AS after_sales,
      count(DISTINCT (buyer_id,chat_date)) FILTER (WHERE NOT after_sales AND orders_after IS NOT NULL)::int AS ordered_buyers,
      count(DISTINCT (buyer_id,chat_date)) FILTER (WHERE NOT after_sales AND paid_after IS NOT NULL)::int AS paid_buyers
    FROM categorized GROUP BY agent_id`, [tenantId, connectionId, from, to, ownUser])).rows
  // Credited sales by order date under the default scheme; refunds are those that completed successfully.
  const sales = (await db.query(`SELECT a.agent_id,round(sum(a.share),2)::float AS orders,
      round(sum(o.total_amount*a.share),2)::float AS order_amount,
      round(coalesce(sum(o.total_amount*a.share) FILTER (WHERE o.paid_at IS NOT NULL),0),2)::float AS paid_amount,
      round(coalesce(sum(r.refunded*a.share),0),2)::float AS refund_amount
    FROM perf_order_attributions a JOIN perf_orders o ON o.id=a.order_id JOIN perf_agents ag ON ag.id=a.agent_id
    LEFT JOIN LATERAL (SELECT sum(refund_total) AS refunded FROM perf_refunds r WHERE r.connection_id=o.connection_id AND r.order_id=o.order_id AND r.status='refundsuccess') r ON true
    WHERE o.tenant_id=$1 AND o.connection_id=$2 AND a.scheme=$6 AND ($5::uuid IS NULL OR ag.user_id=$5)
      AND o.placed_at>=($3::date::timestamp AT TIME ZONE 'Asia/Shanghai') AND o.placed_at<(($4::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai')
    GROUP BY a.agent_id`, [tenantId, connectionId, from, to, ownUser, scheme])).rows
  return { scheme, conversion, sales }
}


/** Inputs that change order credit; orders whose stored key differs are recomputed by the sync worker. */
export async function attributionKey(tenantId: string) {
  await ensureSettings(tenantId)
  return (await db.query(`SELECT ${attributionKeySql} AS key FROM perf_settings WHERE tenant_id=$1`, [tenantId])).rows[0].key as string
}

export type AgentMetricRow = {
  agent_id: string; login_id: string; is_main: boolean; present: boolean; user_id: string | null; user_name: string | null
  reception: number; effective_reception: number; unanswered: number; transfers: number; buyer_messages: number; agent_messages: number; other_agent_messages: number; auto_replies: number
  first_response_seconds: number | null; avg_response_seconds: number | null
  inquiry: number; new_customer_inquiry: number; after_sales: number; ordered_buyers: number; paid_buyers: number
  orders: number; order_amount: number; paid_amount: number; refund_amount: number
}

/**
 * Reply time of a turn. Turns are stored per Beijing date, so a buyer turn still open at the end of the day is answered by the
 * agent's first manual reply in the same conversation on the next day (typical for late-night inquiries).
 */
export const replyAtSql = (turn: string, session: string, settings: string) => `coalesce(${turn}.reply_at,(SELECT min(m.sent_at) FROM perf_chat_sessions n JOIN perf_chat_messages m ON m.session_id=n.id
  WHERE ${turn}.reply_at IS NULL AND n.agent_id=${session}.agent_id AND n.cid=${session}.cid AND n.chat_date=${session}.chat_date+1 AND m.sent_at>${turn}.turn_at
    AND ${manualReplySql.replace('$COUNT_OTHER', `${settings}.count_other_as_reply`)}))`

/** Reception, conversion and credited sales per agent ($5 limits to agents bound to that user). */
export async function agentMetrics(tenantId: string, connectionId: string, from: string, to: string, ownUser: string | null) {
  await ensureSettings(tenantId)
  const rows = await db.query(`WITH settings AS (SELECT make_interval(secs=>unanswered_threshold_seconds) AS threshold,CASE WHEN count_other_as_reply THEN 'loose' ELSE 'strict' END AS mode,count_other_as_reply,
        work_hours_enabled,work_start,work_end FROM perf_settings WHERE tenant_id=$1),
      agents AS (SELECT a.id,a.login_id,a.is_main,a.present,a.user_id,u.display_name AS user_name FROM perf_agents a LEFT JOIN users u ON u.id=a.user_id
        WHERE a.tenant_id=$1 AND a.connection_id=$2 AND ($5::uuid IS NULL OR a.user_id=$5)),
      sessions AS (SELECT s.* FROM perf_chat_sessions s JOIN agents a ON a.id=s.agent_id WHERE s.chat_date BETWEEN $3::date AND $4::date),
      session_stats AS (SELECT agent_id,
        count(DISTINCT (buyer_id,chat_date)) FILTER (WHERE buyer_messages>0) AS reception,
        count(DISTINCT (buyer_id,chat_date)) FILTER (WHERE buyer_messages>0 AND (agent_messages>0 OR (settings.count_other_as_reply AND other_agent_messages>0))) AS effective_reception,
        count(*) FILTER (WHERE transferred) AS transfers, sum(buyer_messages) AS buyer_messages, sum(agent_messages) AS agent_messages, sum(other_agent_messages) AS other_agent_messages, sum(auto_replies) AS auto_replies
        FROM sessions CROSS JOIN settings GROUP BY agent_id),
      -- Response clocks start at the next opening for inquiries outside working hours (see migration 031).
      turns AS (SELECT s.agent_id,t.turn_index,r.reply_at,c.clock,perf_response_seconds(t.turn_at,r.reply_at,c.clock) AS seconds,settings.threshold
        FROM perf_chat_turns t JOIN sessions s ON s.id=t.session_id CROSS JOIN settings
        CROSS JOIN LATERAL (SELECT ${replyAtSql('t', 's', 'settings')} AS reply_at) r
        CROSS JOIN LATERAL (SELECT perf_response_clock(t.turn_at,settings.work_hours_enabled,settings.work_start,settings.work_end) AS clock) c WHERE t.mode=settings.mode),
      turn_stats AS (SELECT agent_id,
        avg(seconds) FILTER (WHERE turn_index=0) AS first_response_seconds,
        avg(seconds) AS avg_response_seconds,
        count(*) FILTER (WHERE (reply_at IS NULL AND clock<now()-threshold) OR seconds>extract(epoch FROM threshold)) AS unanswered
        FROM turns GROUP BY agent_id)
      SELECT a.id AS agent_id,a.login_id,a.is_main,a.present,a.user_id,a.user_name,
        coalesce(ss.reception,0)::int AS reception,coalesce(ss.effective_reception,0)::int AS effective_reception,coalesce(ts.unanswered,0)::int AS unanswered,
        coalesce(ss.transfers,0)::int AS transfers,coalesce(ss.buyer_messages,0)::int AS buyer_messages,coalesce(ss.agent_messages,0)::int AS agent_messages,coalesce(ss.other_agent_messages,0)::int AS other_agent_messages,coalesce(ss.auto_replies,0)::int AS auto_replies,
        round(ts.first_response_seconds)::int AS first_response_seconds,round(ts.avg_response_seconds)::int AS avg_response_seconds
      FROM agents a LEFT JOIN session_stats ss ON ss.agent_id=a.id LEFT JOIN turn_stats ts ON ts.agent_id=a.id
      ORDER BY coalesce(ss.reception,0) DESC,a.is_main DESC,a.login_id`,
    [tenantId, connectionId, from, to, ownUser])
  const { scheme, conversion, sales } = await conversionByAgent(tenantId, connectionId, from, to, ownUser)
  const byAgent = (list: { agent_id: string }[]) => new Map(list.map(row => [row.agent_id, row]))
  const conversions = byAgent(conversion), credited = byAgent(sales)
  const empty = { inquiry: 0, new_customer_inquiry: 0, after_sales: 0, ordered_buyers: 0, paid_buyers: 0, orders: 0, order_amount: 0, paid_amount: 0, refund_amount: 0 }
  return { scheme, rows: rows.rows.map(row => ({ ...row, ...empty, ...(conversions.get(row.agent_id) ?? {}), ...(credited.get(row.agent_id) ?? {}), agent_id: row.agent_id })) as AgentMetricRow[] }
}
