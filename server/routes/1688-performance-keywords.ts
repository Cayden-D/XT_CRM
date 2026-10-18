import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { requirePermission } from '../auth.js'
import { db } from '../db.js'
import { IntegrationError } from '../integrations/1688.js'
import { callPerformanceApi } from '../integrations/1688-performance.js'
import { ensureConnection, ownOnly, readScope, reportQuery } from './1688-performance.js'
import { keywordHits } from '../integrations/chat-insights.js'

/**
 * 关键词库. The list lives on 1688: it marks a message with the keywords it contains when the message is sent (not
 * retroactively — checked live on 2026-10-16), and chat.msg.query returns those marks, which the sync stores in
 * perf_chat_messages.keywords. Buyer text is masked, so these marks are the only window on what buyers ask about.
 * Platform writes for one shop are serialised: the keyword API is not safe under concurrent edits.
 */
export const keywordPresets: { category: string; hint: string; words: string[] }[] = [
  { category: '售后退款', hint: '质量、破损、少发错发等售后苗头', words: ['退款', '退货', '换货', '质量问题', '坏了', '破损', '少发', '漏发', '错发'] },
  { category: '投诉差评', hint: '需要尽快安抚的高风险会话', words: ['差评', '投诉', '举报', '假货', '骗'] },
  { category: '物流催单', hint: '催发货、问物流', words: ['发货', '快递', '物流', '到哪了', '什么时候到', '催'] },
  { category: '发票', hint: '开票需求', words: ['发票', '开票', '专票'] },
  { category: '议价', hint: '价格敏感，适合推阶梯价或活动', words: ['便宜', '优惠', '最低', '降价', '批发价', '包邮'] },
  { category: '定制大单', hint: '定制、贴牌、打样等高价值线索', words: ['定制', '贴牌', 'logo', '大货', '打样', '样品', '代发'] },
]
const wordSchema = z.string().trim().min(1, '关键词不能为空').max(20, '关键词最多 20 个字').refine(w => !/[\s,，]/.test(w), '关键词不能包含空格或逗号')
const categorySchema = z.string().trim().min(1).max(20)
const tenant = (request: FastifyRequest) => request.authUser.tenantId
const scope = (request: FastifyRequest) => ownOnly(request) ? request.authUser.sub : null
const audit = (request: FastifyRequest, entityId: string, action: string, data: object) => db.query(
  'INSERT INTO audit_logs(tenant_id,actor_id,action,entity_type,entity_id,after_data,request_id)VALUES($1,$2,$3,$4,$5,$6,$7)',
  [tenant(request), request.authUser.sub, action, '1688_perf_connection', entityId, JSON.stringify(data), request.id])

/** Runs platform keyword edits for one shop one at a time (transaction-scoped advisory lock). */
async function serialised<T>(connectionId: string, work: () => Promise<T>) {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`perf-keywords:${connectionId}`])
    const result = await work()
    await client.query('COMMIT')
    return result
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}
const platformWords = async (connectionId: string, tenantId: string, actor: string, requestId: string) => {
  const r = await callPerformanceApi(connectionId, tenantId, actor, 'wangwang.keyword.query.list', {}, requestId) as { result?: { data?: { words?: unknown } }; data?: { words?: unknown } }
  const words = r.result?.data?.words ?? r.data?.words ?? []
  return Array.isArray(words) ? words.filter((w): w is string => typeof w === 'string') : []
}
const listKeywords = (connectionId: string) => db.query(`SELECT k.id,k.word,k.category,k.on_platform,k.created_at,k.checked_at,u.display_name AS created_by_name
  FROM perf_keywords k LEFT JOIN users u ON u.id=k.created_by WHERE k.connection_id=$1 ORDER BY k.category,k.created_at`, [connectionId]).then(r => r.rows)

export async function performanceKeywordRoutes(app: FastifyInstance) {
  app.get('/keywords', { preHandler: readScope }, async request => {
    const { connectionId } = z.object({ connectionId: z.string().uuid() }).parse(request.query)
    await ensureConnection(tenant(request), connectionId)
    return { data: await listKeywords(connectionId), presets: keywordPresets }
  })

  // Adds words on 1688 one by one; each success is recorded locally, failures are reported per word.
  app.post('/keywords', { preHandler: requirePermission('performance:manage') }, async request => {
    const input = z.object({ connectionId: z.string().uuid(), words: z.array(z.object({ word: wordSchema, category: categorySchema })).min(1).max(30) }).strict().parse(request.body)
    await ensureConnection(tenant(request), input.connectionId)
    const wanted = [...new Map(input.words.map(w => [w.word.toLowerCase(), w])).values()]
    const existing = new Set((await db.query<{ word: string }>('SELECT lower(word) AS word FROM perf_keywords WHERE connection_id=$1 AND on_platform', [input.connectionId])).rows.map(r => r.word))
    const added: string[] = [], skipped: string[] = [], failed: { word: string; message: string }[] = []
    await serialised(input.connectionId, async () => {
      for (const { word, category } of wanted) {
        if (existing.has(word.toLowerCase())) { skipped.push(word); continue }
        try {
          await callPerformanceApi(input.connectionId, tenant(request), request.authUser.sub, 'wangwang.keyword.add', { word }, request.id)
          await db.query(`INSERT INTO perf_keywords(tenant_id,connection_id,word,category,created_by) VALUES($1,$2,$3,$4,$5)
            ON CONFLICT(connection_id,word) DO UPDATE SET category=excluded.category,on_platform=true,created_by=excluded.created_by,created_at=now(),checked_at=now()`,
          [tenant(request), input.connectionId, word, category, request.authUser.sub])
          added.push(word)
        } catch (error) {
          failed.push({ word, message: error instanceof Error ? error.message : '添加失败' })
          // A shop-level failure (quota, authorization) will fail the rest the same way.
          if (error instanceof IntegrationError && (error.code.startsWith('gw.Qos') || ['REAUTHORIZE', 'CONNECTION_INACTIVE'].includes(error.code))) break
        }
      }
    })
    if (added.length) await audit(request, input.connectionId, 'performance.keywords.add', { added })
    return { data: { added, skipped, failed, keywords: await listKeywords(input.connectionId) } }
  })

  app.delete('/keywords/:id', { preHandler: requirePermission('performance:manage') }, async request => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const row = (await db.query('SELECT id,connection_id,word,on_platform FROM perf_keywords WHERE id=$1 AND tenant_id=$2', [id, tenant(request)])).rows[0]
    if (!row) throw new IntegrationError('NOT_FOUND', '关键词不存在。', 404)
    await serialised(row.connection_id, async () => {
      // A word already gone from 1688 only needs the local record removed.
      if (row.on_platform) await callPerformanceApi(row.connection_id, tenant(request), request.authUser.sub, 'wangwang.keyword.delete', { word: row.word }, request.id)
      await db.query('DELETE FROM perf_keywords WHERE id=$1', [id])
    })
    await audit(request, row.connection_id, 'performance.keywords.delete', { word: row.word })
    return { data: await listKeywords(row.connection_id) }
  })

  app.patch('/keywords/:id', { preHandler: requirePermission('performance:manage') }, async request => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const { category } = z.object({ category: categorySchema }).strict().parse(request.body)
    const row = (await db.query('UPDATE perf_keywords SET category=$3 WHERE id=$1 AND tenant_id=$2 RETURNING connection_id', [id, tenant(request), category])).rows[0]
    if (!row) throw new IntegrationError('NOT_FOUND', '关键词不存在。', 404)
    return { data: await listKeywords(row.connection_id) }
  })

  // Compares with the list on 1688: words added elsewhere are imported as "其他", words removed elsewhere are marked.
  app.post('/keywords/reconcile', { preHandler: requirePermission('performance:manage') }, async request => {
    const { connectionId } = z.object({ connectionId: z.string().uuid() }).strict().parse(request.body)
    await ensureConnection(tenant(request), connectionId)
    const result = await serialised(connectionId, async () => {
      const remote = await platformWords(connectionId, tenant(request), request.authUser.sub, request.id)
      const imported = (await db.query(`INSERT INTO perf_keywords(tenant_id,connection_id,word,category) SELECT $1,$2,w,'其他' FROM unnest($3::text[]) w
        ON CONFLICT(connection_id,word) DO UPDATE SET on_platform=true,checked_at=now() WHERE NOT perf_keywords.on_platform RETURNING word`, [tenant(request), connectionId, remote])).rows.length
      const missing = (await db.query(`UPDATE perf_keywords SET on_platform=false,checked_at=now() WHERE connection_id=$1 AND on_platform AND NOT (word=ANY($2::text[])) RETURNING word`, [connectionId, remote])).rows.map(r => r.word)
      await db.query('UPDATE perf_keywords SET checked_at=now() WHERE connection_id=$1', [connectionId])
      return { platform: remote.length, imported, missing }
    })
    return { data: { ...result, keywords: await listKeywords(connectionId) } }
  })

  // Hits per word for the period (buyer vs agent messages), and the latest hits to open.
  app.get('/keywords/hits', { preHandler: readScope }, async request => {
    const q = reportQuery.parse(request.query)
    await ensureConnection(tenant(request), q.connectionId)
    return { data: await keywordHits(tenant(request), q.connectionId, q.from, q.to, scope(request)) }
  })
}
