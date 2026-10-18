import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { hasPermission, requireAuth } from '../auth.js'
import { db } from '../db.js'
import { IntegrationError } from '../integrations/1688.js'
import { agentMetrics } from '../integrations/1688-performance-reports.js'
import { customerSummary } from './customer-ops.js'

const DAY = 86_400_000
/** Beijing calendar date (YYYY-MM-DD) `offset` days from today. */
const beijingDate = (offset = 0) => new Date(Date.now() + 8 * 3_600_000 + offset * DAY).toISOString().slice(0, 10)
const rangeDays = { today: 1, '7d': 7, '30d': 30 } as const

/** Paid sales, refunds, reception and inquiry conversion for one shop over [from, to] (Beijing dates, inclusive). */
async function periodTotals(connectionId: string, from: string, to: string, windowHours: number) {
  const bounds = [connectionId, from, to]
  const sales = (await db.query(`SELECT coalesce(sum(o.total_amount),0)::float AS amount,count(*)::int AS orders,
      count(DISTINCT coalesce(i.buyer_id::text,o.buyer_open_uid))::int AS buyers
    FROM perf_orders o LEFT JOIN perf_buyer_identities i ON i.connection_id=o.connection_id AND i.open_uid=o.buyer_open_uid
    WHERE o.connection_id=$1 AND o.paid_at>=($2::date::timestamp AT TIME ZONE 'Asia/Shanghai') AND o.paid_at<(($3::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai')`, bounds)).rows[0]
  const refunds = (await db.query(`SELECT coalesce(sum(refund_total),0)::float AS amount,count(*)::int AS count FROM perf_refunds
    WHERE connection_id=$1 AND status='refundsuccess' AND completed_at>=($2::date::timestamp AT TIME ZONE 'Asia/Shanghai') AND completed_at<(($3::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai')`, bounds)).rows[0]
  // A buyer converts when an order they later pay for is placed within the attribution window after their first message in the period.
  const chat = (await db.query(`WITH chats AS (
        SELECT s.buyer_id,min(coalesce(t.first_turn,s.chat_date::timestamp AT TIME ZONE 'Asia/Shanghai')) AS first_at,count(DISTINCT s.chat_date)::int AS days
        FROM perf_chat_sessions s LEFT JOIN LATERAL (SELECT min(turn_at) AS first_turn FROM perf_chat_turns WHERE session_id=s.id AND mode='strict') t ON true
        WHERE s.connection_id=$1 AND s.chat_date BETWEEN $2::date AND $3::date AND s.buyer_messages>0 GROUP BY s.buyer_id)
      SELECT coalesce(sum(days),0)::int AS reception,count(*)::int AS inquired,
        count(*) FILTER (WHERE EXISTS(SELECT 1 FROM perf_orders o JOIN perf_buyer_identities i ON i.connection_id=o.connection_id AND i.open_uid=o.buyer_open_uid
          WHERE i.buyer_id=c.buyer_id AND o.connection_id=$1 AND o.paid_at IS NOT NULL AND o.placed_at>=c.first_at AND o.placed_at<c.first_at+make_interval(hours=>$4::int)))::int AS converted
      FROM chats c`, [...bounds, windowHours])).rows[0]
  return { paidAmount: sales.amount, paidOrders: sales.orders, paidBuyers: sales.buyers, refundAmount: refunds.amount, refunds: refunds.count,
    netAmount: Math.round((sales.amount - refunds.amount) * 100) / 100, reception: chat.reception, inquired: chat.inquired, converted: chat.converted,
    conversionRate: chat.inquired ? chat.converted / chat.inquired : null }
}

export type DashboardRange = keyof typeof rangeDays

/** Everything on the home dashboard the user may see; the AI assistant reads the same figures. */
export async function buildDashboard(tenantId: string, permissions: string[], query: { connectionId?: string; range: DashboardRange }) {
  const can = { performance: hasPermission(permissions, 'performance:read'), customers: hasPermission(permissions, 'customer_ops:read'), listings: hasPermission(permissions, 'integration:read') }
  const shops = (can.performance || can.customers) ? (await db.query(`SELECT id,display_name,status FROM integration_1688_perf_connections WHERE tenant_id=$1 ORDER BY status='connected' DESC,created_at`, [tenantId])).rows : []
  if (query.connectionId && !shops.some(s => s.id === query.connectionId)) throw new IntegrationError('NOT_FOUND', '店铺不存在。', 404)
  const shopId = query.connectionId ?? shops[0]?.id ?? null
  const days = rangeDays[query.range]
  const period = { from: beijingDate(1 - days), to: beijingDate(0) }, previous = { from: beijingDate(1 - 2 * days), to: beijingDate(-days) }
  const data: Record<string, unknown> = { range: query.range, period, previous, shops, connectionId: shopId, sections: can }

  if (shopId && can.performance) {
    await db.query('INSERT INTO perf_settings(tenant_id) VALUES($1) ON CONFLICT DO NOTHING', [tenantId])
    const settings = (await db.query('SELECT attribution_window_hours FROM perf_settings WHERE tenant_id=$1', [tenantId])).rows[0]
    data.kpis = { current: await periodTotals(shopId, period.from, period.to, settings.attribution_window_hours), previous: await periodTotals(shopId, previous.from, previous.to, settings.attribution_window_hours) }
    // Daily trend over the selected period (30 days for "today", so the chart still has context).
    const trendFrom = query.range === 'today' ? beijingDate(-29) : period.from
    data.trend = (await db.query(`WITH days AS (SELECT generate_series($2::date,$3::date,interval '1 day')::date AS day)
      SELECT d.day::text AS date,
        coalesce((SELECT sum(total_amount) FROM perf_orders o WHERE o.connection_id=$1 AND (o.paid_at AT TIME ZONE 'Asia/Shanghai')::date=d.day),0)::float AS paid_amount,
        (SELECT count(*) FROM perf_orders o WHERE o.connection_id=$1 AND (o.paid_at AT TIME ZONE 'Asia/Shanghai')::date=d.day)::int AS paid_orders,
        (SELECT count(DISTINCT buyer_id) FROM perf_chat_sessions s WHERE s.connection_id=$1 AND s.chat_date=d.day AND s.buyer_messages>0)::int AS reception
      FROM days d ORDER BY d.day`, [shopId, trendFrom, period.to])).rows
    const metrics = await agentMetrics(tenantId, shopId, period.from, period.to, null)
    const active = metrics.rows.filter(r => r.reception > 0 || r.paid_amount > 0)
    const answered = active.filter(r => r.first_response_seconds != null)
    const weight = answered.reduce((sum, r) => sum + r.effective_reception, 0)
    data.service = {
      scheme: metrics.scheme,
      firstResponseSeconds: weight ? Math.round(answered.reduce((sum, r) => sum + r.first_response_seconds! * r.effective_reception, 0) / weight) : null,
      unanswered: active.reduce((sum, r) => sum + r.unanswered, 0),
      // Agent messages in the period carrying contact details, external links or off-platform payment wording.
      // Sessions where a buyer message hit an after-sales or complaint keyword (buyer text itself is masked by 1688).
      keywordAlerts: (await db.query(`SELECT count(DISTINCT s.id)::int AS n FROM perf_chat_messages m JOIN perf_chat_sessions s ON s.id=m.session_id
          CROSS JOIN LATERAL jsonb_array_elements(m.keywords) k JOIN perf_keywords pk ON pk.connection_id=s.connection_id AND pk.word=k->>'word' AND pk.category IN ('售后退款','投诉差评')
        WHERE s.connection_id=$1 AND s.chat_date BETWEEN $2::date AND $3::date AND m.direction=1 AND m.keywords<>'[]'::jsonb`, [shopId, period.from, period.to])).rows[0].n as number,
      offsiteRisks: (await db.query(`SELECT count(*)::int AS n FROM perf_chat_messages m JOIN perf_chat_sessions s ON s.id=m.session_id
        WHERE s.connection_id=$1 AND s.chat_date BETWEEN $2::date AND $3::date AND m.direction=0 AND m.flags && ARRAY['phone','wechat','qq','offsite','external_link']`, [shopId, period.from, period.to])).rows[0].n as number,
      agents: active.sort((a, b) => b.paid_amount - a.paid_amount || b.reception - a.reception).slice(0, 6).map(r => ({
        agentId: r.agent_id, loginId: r.login_id, isMain: r.is_main, userName: r.user_name, reception: r.reception, inquiry: r.inquiry, paidBuyers: r.paid_buyers,
        paidAmount: r.paid_amount, firstResponseSeconds: r.first_response_seconds, unanswered: r.unanswered })),
    }
    // Paid buyers in the period split by whether this was their first purchase on record.
    data.buyerMix = (await db.query(`WITH paid AS (SELECT DISTINCT i.buyer_id FROM perf_orders o JOIN perf_buyer_identities i ON i.connection_id=o.connection_id AND i.open_uid=o.buyer_open_uid
        WHERE o.connection_id=$1 AND o.paid_at>=($2::date::timestamp AT TIME ZONE 'Asia/Shanghai') AND o.paid_at<(($3::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai'))
      SELECT count(*) FILTER (WHERE st.first_paid_at>=($2::date::timestamp AT TIME ZONE 'Asia/Shanghai'))::int AS first_time,
        count(*) FILTER (WHERE st.first_paid_at<($2::date::timestamp AT TIME ZONE 'Asia/Shanghai'))::int AS returning
      FROM paid p LEFT JOIN cust_stats st ON st.buyer_id=p.buyer_id`, [shopId, period.from, period.to])).rows[0]
    const sync = (await db.query(`SELECT c.backfill_from,c.orders_synced_from,c.refunds_synced_from,c.orders_synced_until,
        (SELECT min(relations_synced_from) FROM perf_agents a WHERE a.connection_id=c.id AND a.present) AS chats_synced_from,
        (SELECT max(finished_at) FROM perf_sync_runs r WHERE r.connection_id=c.id AND r.status='succeeded') AS last_success,
        (SELECT json_build_object('status',status,'errorCode',error_code,'at',coalesce(finished_at,started_at,created_at)) FROM perf_sync_runs r WHERE r.connection_id=c.id ORDER BY created_at DESC LIMIT 1) AS last_run,
        (SELECT count(*) FROM perf_chat_sessions s WHERE s.connection_id=c.id AND s.needs_sync AND s.chat_date>=(now() AT TIME ZONE 'Asia/Shanghai')::date-(c.history_days-1))::int AS pending_sessions,c.history_days
      FROM integration_1688_perf_connections c WHERE c.id=$1`, [shopId])).rows[0]
    data.sync = sync
  }
  if (shopId && can.customers) data.customers = await customerSummary(tenantId, shopId)
  if (can.listings) {
    data.listings = {
      queue: Object.fromEntries((await db.query('SELECT status,count(*)::int AS n FROM integration_1688_collection_queue_jobs WHERE tenant_id=$1 GROUP BY 1', [tenantId])).rows.map(r => [r.status, r.n])),
      blockedReasons: (await db.query(`SELECT coalesce(message,'未说明原因') AS reason,count(*)::int AS n FROM integration_1688_collection_queue_jobs WHERE tenant_id=$1 AND status='blocked' GROUP BY 1 ORDER BY 2 DESC LIMIT 3`, [tenantId])).rows,
      drafts: (await db.query(`SELECT count(*)::int AS n FROM integration_1688_publish_drafts WHERE tenant_id=$1 AND status='draft'`, [tenantId])).rows[0].n,
      listings: Object.fromEntries((await db.query('SELECT status,count(*)::int AS n FROM integration_1688_listings WHERE tenant_id=$1 GROUP BY 1', [tenantId])).rows.map(r => [r.status, r.n])),
      collected: (await db.query('SELECT count(*)::int AS n FROM collected_products WHERE tenant_id=$1', [tenantId])).rows[0].n,
    }
  }
  return data
}

export async function dashboardRoutes(app: FastifyInstance) {
  app.get('/', { preHandler: requireAuth }, async request => {
    const query = z.object({ connectionId: z.string().uuid().optional(), range: z.enum(['today', '7d', '30d']).default('7d') }).parse(request.query)
    return { data: await buildDashboard(request.authUser.tenantId, request.authUser.permissions, query) }
  })
}
