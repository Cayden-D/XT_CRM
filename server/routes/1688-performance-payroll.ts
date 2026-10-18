import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requirePermission } from '../auth.js'
import { sendCsv } from '../csv.js'
import { db } from '../db.js'
import { IntegrationError } from '../integrations/1688.js'
import { calculatePayroll, kpiMetrics, kpiScheme, monthRange, scoreKpi, type KpiMetric } from '../integrations/1688-performance-payroll.js'
import { agentMetrics, type AgentMetricRow } from '../integrations/1688-performance-reports.js'
import { ensureConnection, ownOnly, readScope, reportQuery } from './1688-performance.js'

const idSchema = z.object({ id: z.string().uuid() })
const money = z.number().finite().min(0).max(10_000_000).transform(v => Math.round(v * 100) / 100)
const kpiMetricKeys = Object.keys(kpiMetrics) as [KpiMetric, ...KpiMetric[]]

// Columns available to "我关注的" and CSV export, in display order.
export const reportColumns: Record<string, { label: string; value: (r: AgentMetricRow) => string | number | null }> = {
  reception: { label: '总接待人数', value: r => r.reception },
  effective_reception: { label: '有效接待人数', value: r => r.effective_reception },
  inquiry: { label: '询单人数', value: r => r.inquiry },
  new_customer_inquiry: { label: '新客询盘', value: r => r.new_customer_inquiry },
  after_sales: { label: '售后咨询', value: r => r.after_sales },
  ordered_buyers: { label: '下单人数', value: r => r.ordered_buyers },
  paid_buyers: { label: '付款人数', value: r => r.paid_buyers },
  conversion: { label: '询单→付款转化率', value: r => r.inquiry ? `${Math.round(r.paid_buyers / r.inquiry * 1000) / 10}%` : null },
  orders: { label: '绩效订单', value: r => Math.round(r.orders * 100) / 100 },
  paid_amount: { label: '绩效销售额（元）', value: r => r.paid_amount.toFixed(2) },
  refund_amount: { label: '退款（元）', value: r => r.refund_amount.toFixed(2) },
  first_response_seconds: { label: '平均首次响应（秒）', value: r => r.first_response_seconds },
  avg_response_seconds: { label: '平均响应（秒）', value: r => r.avg_response_seconds },
  unanswered: { label: '未回复人次', value: r => r.unanswered },
  transfers: { label: '转接人数', value: r => r.transfers },
  buyer_messages: { label: '买家消息', value: r => r.buyer_messages },
  agent_messages: { label: '客服消息', value: r => r.agent_messages },
}
const columnKeys = Object.keys(reportColumns)

export const agentName = (row: { login_id: string; is_main: boolean; user_name?: string | null }) => {
  const account = row.is_main ? '主账号' : row.login_id.includes(':') ? row.login_id.slice(row.login_id.indexOf(':') + 1) : row.login_id
  return row.user_name ? `${row.user_name}（${account}）` : account
}
async function audit(tenantId: string, actorId: string, entityType: string, id: string, action: string, requestId: string, after?: object) {
  await db.query('INSERT INTO audit_logs(tenant_id,actor_id,action,entity_type,entity_id,after_data,request_id)VALUES($1,$2,$3,$4,$5,$6,$7)', [tenantId, actorId, action, entityType, id, after ? JSON.stringify(after) : null, requestId])
}
async function inTransaction<T>(run: (client: import('pg').PoolClient) => Promise<T>) {
  const client = await db.connect()
  try { await client.query('BEGIN'); const result = await run(client); await client.query('COMMIT'); return result } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}

export async function performancePayrollRoutes(app: FastifyInstance) {
  // ---------- P4: KPI ranking ----------
  app.get('/kpi', { preHandler: readScope }, async request => {
    const scheme = await kpiScheme(request.authUser.tenantId)
    return { data: { ...scheme, metrics: Object.entries(kpiMetrics).map(([key, def]) => ({ key, label: def.label, higherIsBetter: def.higherIsBetter })) } }
  })
  app.put('/kpi', { preHandler: requirePermission('performance:manage') }, async request => {
    const input = z.object({ revision: z.number().int().min(0), items: z.array(z.object({ metric: z.enum(kpiMetricKeys), weight: z.number().int().min(1).max(100) }).strict()).min(1).max(kpiMetricKeys.length) }).strict().parse(request.body)
    if (new Set(input.items.map(i => i.metric)).size !== input.items.length) throw new IntegrationError('DUPLICATE_METRIC', '同一指标只能出现一次。', 400)
    const saved = input.revision === 0
      ? await db.query('INSERT INTO perf_kpi_schemes(tenant_id,items,updated_by) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING items,revision,updated_at', [request.authUser.tenantId, JSON.stringify(input.items), request.authUser.sub])
      : await db.query('UPDATE perf_kpi_schemes SET items=$2,revision=revision+1,updated_by=$4,updated_at=now() WHERE tenant_id=$1 AND revision=$3 RETURNING items,revision,updated_at', [request.authUser.tenantId, JSON.stringify(input.items), input.revision, request.authUser.sub])
    if (!saved.rows.length) throw new IntegrationError('REVISION_CONFLICT', 'KPI 方案已被他人修改，请刷新后重试。', 409)
    await audit(request.authUser.tenantId, request.authUser.sub, 'perf_kpi_scheme', request.authUser.tenantId, 'performance.kpi.update', request.id, { items: input.items })
    return { data: { items: saved.rows[0].items, revision: saved.rows[0].revision, updatedAt: saved.rows[0].updated_at } }
  })
  app.get('/kpi/ranking', { preHandler: readScope }, async request => {
    const query = reportQuery.parse(request.query)
    await ensureConnection(request.authUser.tenantId, query.connectionId)
    const scheme = await kpiScheme(request.authUser.tenantId)
    // Scores are always relative to every agent of the shop; own-scope users then see only their rows.
    const metrics = await agentMetrics(request.authUser.tenantId, query.connectionId, query.from, query.to, null)
    const ranking = scoreKpi(metrics.rows, scheme.items)
    const visible = ownOnly(request) ? new Set(metrics.rows.filter(r => r.user_id === request.authUser.sub).map(r => r.agent_id)) : null
    const byId = new Map(metrics.rows.map(r => [r.agent_id, r]))
    return { data: ranking.filter(r => !visible || visible.has(r.agent_id)).map(r => {
      const row = byId.get(r.agent_id)!
      return { ...r, login_id: row.login_id, is_main: row.is_main, user_name: row.user_name, values: Object.fromEntries(scheme.items.map(i => [i.metric, kpiMetrics[i.metric].value(row)])) }
    }), items: scheme.items }
  })

  // ---------- P4: "我关注的" report and export ----------
  app.get('/favorites', { preHandler: readScope }, async request => {
    const row = (await db.query('SELECT metrics FROM perf_report_favorites WHERE user_id=$1 AND tenant_id=$2', [request.authUser.sub, request.authUser.tenantId])).rows[0]
    return { data: { metrics: row?.metrics ?? [], columns: columnKeys.map(key => ({ key, label: reportColumns[key].label })) } }
  })
  app.put('/favorites', { preHandler: readScope }, async request => {
    const { metrics } = z.object({ metrics: z.array(z.string()).max(columnKeys.length) }).strict().parse(request.body)
    if (metrics.some(m => !columnKeys.includes(m)) || new Set(metrics).size !== metrics.length) throw new IntegrationError('INVALID_COLUMNS', '包含未知或重复的指标。', 400)
    await db.query(`INSERT INTO perf_report_favorites(user_id,tenant_id,metrics) VALUES($1,$2,$3) ON CONFLICT(user_id) DO UPDATE SET metrics=excluded.metrics,updated_at=now()`, [request.authUser.sub, request.authUser.tenantId, metrics])
    return { data: { metrics } }
  })
  app.get('/metrics/export', { preHandler: readScope }, async (request, reply) => {
    const query = z.object({ connectionId: z.string().uuid(), from: z.string(), to: z.string(), columns: z.string().optional() }).and(reportQuery).parse(request.query)
    await ensureConnection(request.authUser.tenantId, query.connectionId)
    const columns = query.columns ? query.columns.split(',').filter(c => columnKeys.includes(c)) : columnKeys
    if (!columns.length) throw new IntegrationError('INVALID_COLUMNS', '请至少选择一个指标。', 400)
    const metrics = await agentMetrics(request.authUser.tenantId, query.connectionId, query.from, query.to, ownOnly(request) ? request.authUser.sub : null)
    const rows = metrics.rows.filter(r => r.reception > 0 || r.orders > 0 || r.agent_messages > 0)
    return sendCsv(reply, `客服绩效_${query.from}_${query.to}.csv`, [['客服', '平台账号', ...columns.map(c => reportColumns[c].label)], ...rows.map(r => [agentName(r), r.login_id, ...columns.map(c => reportColumns[c].value(r))])])
  })

  // ---------- P5: pay rules (finance) ----------
  app.get('/pay-settings', { preHandler: requirePermission('payroll:read') }, async request => {
    const { connectionId } = z.object({ connectionId: z.string().uuid() }).parse(request.query)
    await ensureConnection(request.authUser.tenantId, connectionId)
    const settings = (await db.query('SELECT rank_bonuses::float[] AS rank_bonuses,revision,updated_at,commission_mode,tier_style,commission_tiers,commission_floor_zero FROM perf_pay_settings WHERE connection_id=$1', [connectionId])).rows[0]
    const rules = (await db.query('SELECT agent_id,base_salary::float AS base_salary,commission_rate::float AS commission_rate FROM perf_pay_rules WHERE connection_id=$1', [connectionId])).rows
    return { data: { rankBonuses: settings?.rank_bonuses ?? [], revision: settings?.revision ?? 0, updatedAt: settings?.updated_at ?? null,
      commissionMode: settings?.commission_mode ?? 'flat', tierStyle: settings?.tier_style ?? 'progressive', tiers: settings?.commission_tiers ?? [], floorZero: settings?.commission_floor_zero ?? false,
      defaultRule: rules.find(r => r.agent_id === null) ?? { agent_id: null, base_salary: 0, commission_rate: 0 }, rules: rules.filter(r => r.agent_id !== null) } }
  })
  app.put('/pay-settings', { preHandler: requirePermission('payroll:manage') }, async request => {
    const rule = z.object({ baseSalary: money, commissionRate: z.number().min(0).max(1).transform(v => Math.round(v * 10000) / 10000) }).strict()
    const tier = z.object({ from: money, rate: z.number().min(0).max(1).transform(v => Math.round(v * 10000) / 10000) }).strict()
    const input = z.object({ connectionId: z.string().uuid(), revision: z.number().int().min(0), rankBonuses: z.array(money).max(10), defaultRule: rule,
      rules: z.array(rule.extend({ agentId: z.string().uuid() })).max(200),
      commissionMode: z.enum(['flat','tiered']).default('flat'), tierStyle: z.enum(['progressive','whole']).default('progressive'),
      tiers: z.array(tier).max(10).default([]), floorZero: z.boolean().default(false) }).strict()
      .refine(v => !v.tiers.length || (v.tiers[0].from === 0 && v.tiers.every((t, i) => i === 0 || t.from > v.tiers[i - 1].from)), '阶梯需从 0 元开始且起点逐档递增')
      .refine(v => v.commissionMode === 'flat' || v.tiers.length > 0, '阶梯提成至少需要一档').parse(request.body)
    await ensureConnection(request.authUser.tenantId, input.connectionId)
    if (new Set(input.rules.map(r => r.agentId)).size !== input.rules.length) throw new IntegrationError('DUPLICATE_AGENT', '同一客服只能设置一条规则。', 400)
    const known = (await db.query('SELECT id FROM perf_agents WHERE connection_id=$1 AND id=ANY($2)', [input.connectionId, input.rules.map(r => r.agentId)])).rows.length
    if (known !== input.rules.length) throw new IntegrationError('AGENT_NOT_FOUND', '规则中包含不属于该店铺的客服账号。', 400)
    const revision = await inTransaction(async client => {
      const saved = input.revision === 0
        ? await client.query(`INSERT INTO perf_pay_settings(connection_id,tenant_id,rank_bonuses,updated_by,commission_mode,tier_style,commission_tiers,commission_floor_zero) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
            ON CONFLICT DO NOTHING RETURNING revision`, [input.connectionId, request.authUser.tenantId, input.rankBonuses, request.authUser.sub, input.commissionMode, input.tierStyle, JSON.stringify(input.tiers), input.floorZero])
        : await client.query(`UPDATE perf_pay_settings SET rank_bonuses=$2,commission_mode=$5,tier_style=$6,commission_tiers=$7,commission_floor_zero=$8,revision=revision+1,updated_by=$4,updated_at=now()
            WHERE connection_id=$1 AND revision=$3 RETURNING revision`, [input.connectionId, input.rankBonuses, input.revision, request.authUser.sub, input.commissionMode, input.tierStyle, JSON.stringify(input.tiers), input.floorZero])
      if (!saved.rows.length) throw new IntegrationError('REVISION_CONFLICT', '工资规则已被他人修改，请刷新后重试。', 409)
      await client.query('DELETE FROM perf_pay_rules WHERE connection_id=$1', [input.connectionId])
      await client.query('INSERT INTO perf_pay_rules(tenant_id,connection_id,agent_id,base_salary,commission_rate) VALUES($1,$2,NULL,$3,$4)', [request.authUser.tenantId, input.connectionId, input.defaultRule.baseSalary, input.defaultRule.commissionRate])
      for (const r of input.rules) await client.query('INSERT INTO perf_pay_rules(tenant_id,connection_id,agent_id,base_salary,commission_rate) VALUES($1,$2,$3,$4,$5)', [request.authUser.tenantId, input.connectionId, r.agentId, r.baseSalary, r.commissionRate])
      return saved.rows[0].revision as number
    })
    await audit(request.authUser.tenantId, request.authUser.sub, 'perf_pay_settings', input.connectionId, 'payroll.rules.update', request.id, { rankBonuses: input.rankBonuses, defaultRule: input.defaultRule, rules: input.rules, commissionMode: input.commissionMode, tierStyle: input.tierStyle, tiers: input.tiers, floorZero: input.floorZero })
    return { data: { revision } }
  })

  // ---------- P5: payroll periods ----------
  const periodRow = async (id: string, tenantId: string) => {
    const period = (await db.query(`SELECT p.id,p.connection_id,p.month::text AS month,p.status,p.scheme,p.basis,p.revision,p.calculated_at,p.locked_at,lu.display_name AS locked_by_name
      FROM perf_payroll_periods p LEFT JOIN users lu ON lu.id=p.locked_by WHERE p.id=$1 AND p.tenant_id=$2`, [id, tenantId])).rows[0]
    if (!period) throw new IntegrationError('NOT_FOUND', '工资单不存在。', 404)
    return period
  }
  const lines = async (periodId: string) => (await db.query(`SELECT l.agent_id,a.login_id,a.is_main,u.display_name AS user_name,l.base_salary::float,l.credited_orders::float,l.paid_amount::float,l.refund_amount::float,
      l.commission_rate::float,l.commission::float,l.commission_detail,l.kpi_score::float,l.kpi_rank,l.kpi_bonus::float,l.adjustments::float,l.total::float
    FROM perf_payroll_lines l JOIN perf_agents a ON a.id=l.agent_id LEFT JOIN users u ON u.id=a.user_id WHERE l.period_id=$1 ORDER BY l.total DESC,a.is_main DESC,a.login_id`, [periodId])).rows

  app.get('/payroll', { preHandler: requirePermission('payroll:read') }, async request => {
    const { connectionId } = z.object({ connectionId: z.string().uuid() }).parse(request.query)
    await ensureConnection(request.authUser.tenantId, connectionId)
    return { data: (await db.query(`SELECT p.id,p.month::text AS month,p.status,p.scheme,p.revision,p.calculated_at,p.locked_at,coalesce(sum(l.total),0)::float AS total,count(l.agent_id)::int AS agents
      FROM perf_payroll_periods p LEFT JOIN perf_payroll_lines l ON l.period_id=p.id WHERE p.tenant_id=$1 AND p.connection_id=$2 GROUP BY p.id ORDER BY p.month DESC`, [request.authUser.tenantId, connectionId])).rows }
  })
  app.post('/payroll', { preHandler: requirePermission('payroll:manage') }, async (request, reply) => {
    const input = z.object({ connectionId: z.string().uuid(), month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) }).strict().parse(request.body)
    await ensureConnection(request.authUser.tenantId, input.connectionId)
    const current = new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 7)
    if (input.month > current) throw new IntegrationError('FUTURE_MONTH', '不能生成未来月份的工资单。', 400)
    const id = await inTransaction(async client => {
      const existing = (await client.query('SELECT id,status FROM perf_payroll_periods WHERE connection_id=$1 AND month=$2::date', [input.connectionId, `${input.month}-01`])).rows[0]
      if (existing?.status === 'locked') throw new IntegrationError('PAYROLL_LOCKED', '该月工资单已锁定。', 409)
      const periodId = existing?.id ?? (await client.query("INSERT INTO perf_payroll_periods(tenant_id,connection_id,month,scheme,created_by) VALUES($1,$2,$3::date,'order_first',$4) RETURNING id", [request.authUser.tenantId, input.connectionId, `${input.month}-01`, request.authUser.sub])).rows[0].id
      await calculatePayroll(client, periodId, request.authUser.tenantId)
      return periodId as string
    })
    await audit(request.authUser.tenantId, request.authUser.sub, 'perf_payroll', id, 'payroll.calculate', request.id, { month: input.month })
    return reply.code(201).send({ data: { ...(await periodRow(id, request.authUser.tenantId)), lines: await lines(id) } })
  })
  app.get('/payroll/:id', { preHandler: requirePermission('payroll:read') }, async request => {
    const { id } = idSchema.parse(request.params)
    const period = await periodRow(id, request.authUser.tenantId)
    const adjustments = (await db.query(`SELECT j.id,j.agent_id,a.login_id,a.is_main,j.amount::float,j.reason,j.created_at,u.display_name AS created_by_name FROM perf_payroll_adjustments j JOIN perf_agents a ON a.id=j.agent_id LEFT JOIN users u ON u.id=j.created_by
      WHERE j.period_id=$1 ORDER BY j.created_at`, [id])).rows
    return { data: { ...period, lines: await lines(id), adjustments } }
  })
  const draftAction = async (id: string, tenantId: string, revision: number, run: (client: import('pg').PoolClient) => Promise<void>) => inTransaction(async client => {
    const period = (await client.query('SELECT status,revision FROM perf_payroll_periods WHERE id=$1 AND tenant_id=$2 FOR UPDATE', [id, tenantId])).rows[0]
    if (!period) throw new IntegrationError('NOT_FOUND', '工资单不存在。', 404)
    if (period.status !== 'draft') throw new IntegrationError('PAYROLL_LOCKED', '工资单已锁定，不能修改。', 409)
    if (period.revision !== revision) throw new IntegrationError('REVISION_CONFLICT', '工资单已被他人更新，请刷新后重试。', 409)
    await run(client)
  })
  app.post('/payroll/:id/recalculate', { preHandler: requirePermission('payroll:manage') }, async request => {
    const { id } = idSchema.parse(request.params)
    const { revision } = z.object({ revision: z.number().int().positive() }).strict().parse(request.body)
    await draftAction(id, request.authUser.tenantId, revision, client => calculatePayroll(client, id, request.authUser.tenantId))
    await audit(request.authUser.tenantId, request.authUser.sub, 'perf_payroll', id, 'payroll.calculate', request.id)
    return { data: { ...(await periodRow(id, request.authUser.tenantId)), lines: await lines(id) } }
  })
  app.post('/payroll/:id/adjustments', { preHandler: requirePermission('payroll:manage') }, async (request, reply) => {
    const { id } = idSchema.parse(request.params)
    const input = z.object({ revision: z.number().int().positive(), agentId: z.string().uuid(), amount: z.number().finite().min(-1_000_000).max(1_000_000).refine(v => Math.round(v * 100) !== 0, '金额不能为 0').transform(v => Math.round(v * 100) / 100),
      reason: z.string().trim().min(1).max(200) }).strict().parse(request.body)
    await draftAction(id, request.authUser.tenantId, input.revision, async client => {
      const agent = (await client.query('SELECT 1 FROM perf_agents a JOIN perf_payroll_periods p ON p.connection_id=a.connection_id WHERE a.id=$1 AND p.id=$2', [input.agentId, id])).rows[0]
      if (!agent) throw new IntegrationError('AGENT_NOT_FOUND', '客服账号不属于该店铺。', 400)
      await client.query('INSERT INTO perf_payroll_adjustments(period_id,agent_id,amount,reason,created_by) VALUES($1,$2,$3,$4,$5)', [id, input.agentId, input.amount, input.reason, request.authUser.sub])
      await calculatePayroll(client, id, request.authUser.tenantId)
    })
    await audit(request.authUser.tenantId, request.authUser.sub, 'perf_payroll', id, 'payroll.adjust', request.id, { agentId: input.agentId, amount: input.amount, reason: input.reason })
    return reply.code(201).send({ data: { ...(await periodRow(id, request.authUser.tenantId)), lines: await lines(id) } })
  })
  app.delete('/payroll/:id/adjustments/:adjustmentId', { preHandler: requirePermission('payroll:manage') }, async request => {
    const { id, adjustmentId } = z.object({ id: z.string().uuid(), adjustmentId: z.string().uuid() }).parse(request.params)
    const { revision } = z.object({ revision: z.coerce.number().int().positive() }).parse(request.query)
    await draftAction(id, request.authUser.tenantId, revision, async client => {
      const removed = await client.query('DELETE FROM perf_payroll_adjustments WHERE id=$1 AND period_id=$2 RETURNING amount', [adjustmentId, id])
      if (!removed.rowCount) throw new IntegrationError('NOT_FOUND', '调整记录不存在。', 404)
      await calculatePayroll(client, id, request.authUser.tenantId)
    })
    await audit(request.authUser.tenantId, request.authUser.sub, 'perf_payroll', id, 'payroll.adjust.remove', request.id, { adjustmentId })
    return { data: { ...(await periodRow(id, request.authUser.tenantId)), lines: await lines(id) } }
  })
  app.post('/payroll/:id/lock', { preHandler: requirePermission('payroll:manage') }, async request => {
    const { id } = idSchema.parse(request.params)
    const { revision } = z.object({ revision: z.number().int().positive(), confirmed: z.literal(true) }).strict().parse(request.body)
    await draftAction(id, request.authUser.tenantId, revision, async client => {
      await client.query("UPDATE perf_payroll_periods SET status='locked',locked_by=$2,locked_at=now(),revision=revision+1 WHERE id=$1 AND calculated_at IS NOT NULL", [id, request.authUser.sub])
    })
    await audit(request.authUser.tenantId, request.authUser.sub, 'perf_payroll', id, 'payroll.lock', request.id)
    return { data: await periodRow(id, request.authUser.tenantId) }
  })
  // Orders and refunds behind one agent's line ("明细详情").
  app.get('/payroll/:id/lines/:agentId', { preHandler: requirePermission('payroll:read') }, async request => {
    const { id, agentId } = z.object({ id: z.string().uuid(), agentId: z.string().uuid() }).parse(request.params)
    const period = await periodRow(id, request.authUser.tenantId)
    const range = monthRange(period.month.slice(0, 7))
    const params = [period.connection_id, period.scheme, agentId, range.start, range.next]
    const orders = (await db.query(`SELECT o.order_id,o.paid_at,o.total_amount::float AS total_amount,a.share::float AS share,round(o.total_amount*a.share,2)::float AS credited,a.basis,a.basis_at
      FROM perf_order_attributions a JOIN perf_orders o ON o.id=a.order_id WHERE o.connection_id=$1 AND a.scheme=$2 AND a.agent_id=$3
        AND o.paid_at>=($4::date::timestamp AT TIME ZONE 'Asia/Shanghai') AND o.paid_at<($5::date::timestamp AT TIME ZONE 'Asia/Shanghai') ORDER BY o.paid_at`, params)).rows
    const refunds = (await db.query(`SELECT r.refund_id,r.order_id,r.completed_at,r.refund_total::float AS refund_amount,a.share::float AS share,round(r.refund_total*a.share,2)::float AS credited,r.apply_reason
      FROM perf_refunds r JOIN perf_orders o ON o.connection_id=r.connection_id AND o.order_id=r.order_id JOIN perf_order_attributions a ON a.order_id=o.id AND a.scheme=$2 AND a.agent_id=$3
      WHERE r.connection_id=$1 AND r.status='refundsuccess' AND r.completed_at>=($4::date::timestamp AT TIME ZONE 'Asia/Shanghai') AND r.completed_at<($5::date::timestamp AT TIME ZONE 'Asia/Shanghai') ORDER BY r.completed_at`, params)).rows
    return { data: { orders, refunds } }
  })
  app.get('/payroll/:id/export', { preHandler: requirePermission('payroll:read') }, async (request, reply) => {
    const { id } = idSchema.parse(request.params)
    const period = await periodRow(id, request.authUser.tenantId)
    const rows = await lines(id)
    return sendCsv(reply, `客服工资_${period.month.slice(0, 7)}${period.status === 'locked' ? '' : '_草稿'}.csv`, [
      ['客服', '平台账号', '基本工资', '绩效订单', '绩效销售额', '退款', '实际提成比例', '提成', 'KPI 得分', 'KPI 名次', 'KPI 奖金', '奖惩', '合计'],
      ...rows.map(r => [agentName(r), r.login_id, r.base_salary.toFixed(2), r.credited_orders, r.paid_amount.toFixed(2), r.refund_amount.toFixed(2), `${Math.round(r.commission_rate * 10000) / 100}%`, r.commission.toFixed(2),
        r.kpi_score ?? '', r.kpi_rank ?? '', r.kpi_bonus.toFixed(2), r.adjustments.toFixed(2), r.total.toFixed(2)]),
    ])
  })
}
