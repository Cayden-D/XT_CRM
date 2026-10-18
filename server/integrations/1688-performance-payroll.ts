import type { PoolClient } from 'pg'
import { db } from '../db.js'
import { IntegrationError } from './1688.js'
import { availableSchemes } from './1688-performance-orders.js'
import { agentMetrics, type AgentMetricRow } from './1688-performance-reports.js'

// KPI metrics a manager can weigh. Rates are per reception so small and large accounts compare fairly.
export const kpiMetrics = {
  reception: { label: '总接待人数', higherIsBetter: true, value: (r: AgentMetricRow) => r.reception },
  effective_rate: { label: '有效接待率', higherIsBetter: true, value: (r: AgentMetricRow) => r.reception ? r.effective_reception / r.reception : null },
  inquiry: { label: '询单人数', higherIsBetter: true, value: (r: AgentMetricRow) => r.inquiry },
  conversion: { label: '询单→付款转化率', higherIsBetter: true, value: (r: AgentMetricRow) => r.inquiry ? r.paid_buyers / r.inquiry : null },
  paid_amount: { label: '绩效销售额', higherIsBetter: true, value: (r: AgentMetricRow) => r.paid_amount },
  first_response_seconds: { label: '平均首次响应', higherIsBetter: false, value: (r: AgentMetricRow) => r.first_response_seconds },
  avg_response_seconds: { label: '平均响应时间', higherIsBetter: false, value: (r: AgentMetricRow) => r.avg_response_seconds },
  unanswered_rate: { label: '未回复率', higherIsBetter: false, value: (r: AgentMetricRow) => r.reception ? r.unanswered / r.reception : null },
} as const
export type KpiMetric = keyof typeof kpiMetrics
export type KpiItem = { metric: KpiMetric; weight: number }
export const defaultKpiItems: KpiItem[] = [
  { metric: 'reception', weight: 20 }, { metric: 'effective_rate', weight: 15 }, { metric: 'conversion', weight: 25 },
  { metric: 'paid_amount', weight: 20 }, { metric: 'first_response_seconds', weight: 10 }, { metric: 'unanswered_rate', weight: 10 },
]

export async function kpiScheme(tenantId: string) {
  const row = (await db.query('SELECT items,revision,updated_at FROM perf_kpi_schemes WHERE tenant_id=$1', [tenantId])).rows[0]
  return row ? { items: row.items as KpiItem[], revision: row.revision as number, updatedAt: row.updated_at as Date } : { items: defaultKpiItems, revision: 0, updatedAt: null }
}

/**
 * Scores each active agent 0-100 per metric relative to the best value in the period
 * (value/max when higher is better, min/value when lower is better), then a weighted average.
 * Ties share a rank (1, 1, 3).
 */
export function scoreKpi(rows: AgentMetricRow[], items: KpiItem[]) {
  const active = rows.filter(r => r.reception > 0 || r.orders > 0)
  const totalWeight = items.reduce((sum, item) => sum + item.weight, 0) || 1
  const parts = new Map<string, Record<string, number>>()
  for (const item of items) {
    const def = kpiMetrics[item.metric]
    const values = active.map(r => def.value(r)).filter((v): v is number => v != null)
    const max = Math.max(0, ...values), min = values.length ? Math.min(...values) : 0
    for (const row of active) {
      const value = def.value(row)
      let score = 0
      if (value != null) score = def.higherIsBetter ? (max > 0 ? value / max * 100 : 0) : (value <= 0 ? 100 : min / value * 100)
      parts.set(row.agent_id, { ...(parts.get(row.agent_id) ?? {}), [item.metric]: Math.round(score * 10) / 10 })
    }
  }
  const scored = active.map(row => {
    const p = parts.get(row.agent_id) ?? {}
    const score = Math.round(items.reduce((sum, item) => sum + (p[item.metric] ?? 0) * item.weight, 0) / totalWeight * 100) / 100
    return { agent_id: row.agent_id, score, parts: p }
  }).sort((a, b) => b.score - a.score)
  return scored.map((row, index) => ({ ...row, rank: index && row.score === scored[index - 1].score ? scored.findIndex(r => r.score === row.score) + 1 : index + 1 }))
}

const cents = (value: number) => Math.round(value * 100) / 100
export const monthRange = (month: string) => {
  const [y, m] = month.split('-').map(Number)
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`
  const last = new Date(Date.parse(`${next}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10)
  return { start: `${month}-01`, next, last }
}

/** Recalculates every line of a draft period inside the caller's transaction. */
export type CommissionTier = { from: number; rate: number }
export type CommissionPlan = { mode: 'flat' | 'tiered'; style: 'progressive' | 'whole'; tiers: CommissionTier[]; floorZero: boolean }
type Band = { from: number; to: number | null; amount: number; rate: number }

/**
 * Commission on a month's net credited sales (paid minus refunded).
 * flat: the agent's own rate. tiered/progressive: each slice of the amount at its band's rate (超额累进).
 * tiered/whole: the whole amount at the rate of the highest band reached (全额累进). A negative net (more refunds
 * than sales) uses the first band's rate; with floorZero the result never goes below zero.
 */
export function commissionFor(net: number, flatRate: number, plan: CommissionPlan) {
  const tiers = [...plan.tiers].sort((a, b) => a.from - b.from)
  const bands: Band[] = []
  if (plan.mode !== 'tiered' || !tiers.length) bands.push({ from: 0, to: null, amount: net, rate: flatRate })
  else if (net <= 0) bands.push({ from: 0, to: tiers[1]?.from ?? null, amount: net, rate: tiers[0].rate })
  else if (plan.style === 'whole') {
    const reached = tiers.filter(t => t.from <= net).at(-1) ?? tiers[0]
    const next = tiers[tiers.indexOf(reached) + 1]
    bands.push({ from: reached.from, to: next?.from ?? null, amount: net, rate: reached.rate })
  } else tiers.forEach((tier, i) => {
    const to = tiers[i + 1]?.from ?? null
    const amount = Math.max(0, Math.min(net, to ?? Infinity) - tier.from)
    if (amount > 0) bands.push({ from: tier.from, to, amount: cents(amount), rate: tier.rate })
  })
  let commission = cents(bands.reduce((sum, b) => sum + b.amount * b.rate, 0))
  const floored = plan.floorZero && commission < 0
  if (floored) commission = 0
  const rate = net > 0 ? Math.round(commission / net * 10000) / 10000 : bands[0].rate
  return { commission, rate, detail: { mode: plan.mode === 'tiered' && tiers.length ? plan.mode : 'flat', style: plan.mode === 'tiered' ? plan.style : null, net: cents(net), bands, floored } }
}

export async function calculatePayroll(client: PoolClient, periodId: string, tenantId: string) {
  const period = (await client.query('SELECT *,month::text AS month_text FROM perf_payroll_periods WHERE id=$1 AND tenant_id=$2 FOR UPDATE', [periodId, tenantId])).rows[0]
  if (!period) throw new IntegrationError('NOT_FOUND', '工资单不存在。', 404)
  if (period.status !== 'draft') throw new IntegrationError('PAYROLL_LOCKED', '工资单已锁定，不能重新计算。', 409)
  const range = monthRange(String(period.month_text).slice(0, 7))
  await client.query('INSERT INTO perf_settings(tenant_id) VALUES($1) ON CONFLICT DO NOTHING', [tenantId])
  const settings = (await client.query('SELECT default_scheme FROM perf_settings WHERE tenant_id=$1', [tenantId])).rows[0]
  const scheme = (availableSchemes as readonly string[]).includes(settings.default_scheme) ? settings.default_scheme : 'order_first'
  // Cash basis: commission on credited orders paid this month, minus refunds that completed this month.
  const paid = new Map((await client.query(`SELECT a.agent_id,sum(a.share)::float AS orders,sum(o.total_amount*a.share)::float AS amount FROM perf_order_attributions a JOIN perf_orders o ON o.id=a.order_id
    WHERE o.connection_id=$1 AND a.scheme=$2 AND o.paid_at>=($3::date::timestamp AT TIME ZONE 'Asia/Shanghai') AND o.paid_at<($4::date::timestamp AT TIME ZONE 'Asia/Shanghai') GROUP BY a.agent_id`,
  [period.connection_id, scheme, range.start, range.next])).rows.map(r => [r.agent_id, r]))
  const refunded = new Map((await client.query(`SELECT a.agent_id,sum(r.refund_total*a.share)::float AS amount FROM perf_refunds r
    JOIN perf_orders o ON o.connection_id=r.connection_id AND o.order_id=r.order_id JOIN perf_order_attributions a ON a.order_id=o.id AND a.scheme=$2
    WHERE r.connection_id=$1 AND r.status='refundsuccess' AND r.completed_at>=($3::date::timestamp AT TIME ZONE 'Asia/Shanghai') AND r.completed_at<($4::date::timestamp AT TIME ZONE 'Asia/Shanghai') GROUP BY a.agent_id`,
  [period.connection_id, scheme, range.start, range.next])).rows.map(r => [r.agent_id, r.amount as number]))
  const rules = (await client.query('SELECT agent_id,base_salary::float AS base,commission_rate::float AS rate FROM perf_pay_rules WHERE connection_id=$1', [period.connection_id])).rows
  const fallback = rules.find(r => r.agent_id === null) ?? { base: 0, rate: 0 }
  const ruleOf = (agentId: string) => rules.find(r => r.agent_id === agentId) ?? fallback
  const pay = (await client.query(`SELECT rank_bonuses::float[] AS bonuses,revision,commission_mode,tier_style,commission_tiers,commission_floor_zero FROM perf_pay_settings WHERE connection_id=$1`, [period.connection_id])).rows[0]
    ?? { bonuses: [], revision: 0, commission_mode: 'flat', tier_style: 'progressive', commission_tiers: [], commission_floor_zero: false }
  const plan: CommissionPlan = { mode: pay.commission_mode, style: pay.tier_style, tiers: pay.commission_tiers, floorZero: pay.commission_floor_zero }
  const adjustments = new Map((await client.query('SELECT agent_id,sum(amount)::float AS amount FROM perf_payroll_adjustments WHERE period_id=$1 GROUP BY agent_id', [periodId])).rows.map(r => [r.agent_id, r.amount as number]))
  const kpi = await kpiScheme(tenantId)
  const metrics = await agentMetrics(tenantId, period.connection_id, range.start, range.last, null)
  const ranking = new Map(scoreKpi(metrics.rows, kpi.items).map(r => [r.agent_id, r]))
  // Everyone with a rule, activity, credit, refund or adjustment this month gets a line.
  const agentIds = (await client.query(`SELECT id FROM perf_agents WHERE connection_id=$1 AND (present OR id=ANY($2))`, [period.connection_id, [...new Set([...paid.keys(), ...refunded.keys(), ...adjustments.keys(), ...ranking.keys()])]])).rows.map(r => r.id as string)
  await client.query('DELETE FROM perf_payroll_lines WHERE period_id=$1', [periodId])
  for (const agentId of agentIds) {
    const rule = ruleOf(agentId), sale = paid.get(agentId), refund = refunded.get(agentId) ?? 0, rank = ranking.get(agentId)
    const paidAmount = cents(sale?.amount ?? 0), refundAmount = cents(refund)
    const { commission, rate, detail } = commissionFor(paidAmount - refundAmount, rule.rate, plan)
    const bonus = rank ? cents(pay.bonuses[rank.rank - 1] ?? 0) : 0
    const adjustment = cents(adjustments.get(agentId) ?? 0)
    await client.query(`INSERT INTO perf_payroll_lines(period_id,agent_id,base_salary,credited_orders,paid_amount,refund_amount,commission_rate,commission,kpi_score,kpi_rank,kpi_bonus,adjustments,total,commission_detail)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [periodId, agentId, cents(rule.base), sale?.orders ?? 0, paidAmount, refundAmount, rate, commission, rank?.score ?? null, rank?.rank ?? null, bonus, adjustment, cents(rule.base + commission + bonus + adjustment), JSON.stringify(detail)])
  }
  const basis = { scheme, kpi: kpi.items, kpiRevision: kpi.revision, rankBonuses: pay.bonuses, paySettingsRevision: pay.revision, rules, commission: plan, range }
  await client.query('UPDATE perf_payroll_periods SET scheme=$2,basis=$3,revision=revision+1,calculated_at=now() WHERE id=$1', [periodId, scheme, JSON.stringify(basis)])
}
