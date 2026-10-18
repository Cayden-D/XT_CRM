import { randomUUID } from 'node:crypto'
import { config } from '../config.js'
import { db } from '../db.js'
import { IntegrationError } from './1688.js'
import { callPerformanceApi } from './1688-performance.js'
import { computeAttributions, syncOrders, syncRefunds, type SyncContext } from './1688-performance-orders.js'
import { assignOwners, ensureOrderBuyers, refreshCustomerStats, resolveBuyer } from './customer-ops.js'
import { analyzeAgentText } from './chat-text.js'

type Json = Record<string, any>
type Run = { id: string; tenant_id: string; connection_id: string; requested_by: string | null; trigger: 'schedule' | 'manual'; scope_days: number | null; worker_id: string; stats: Json }
type Agent = { id: string; login_id: string; relations_synced_until: Date | null; relations_synced_from: Date | null; idle: boolean }
type Session = { id: string; agent_id: string; cid: string; chat_date: string; message_cursor: string | null; login_id: string }
type Message = { direction: number; sent_at: Date; message_types: string[] }

const DAY = 86_400_000, BEIJING = 8 * 3_600_000
const RELATION_PAGE_SIZE = 80, RELATION_MAX_PAGE = 25 // the platform returns at most the first 2000 records per query
const RELATION_OVERLAP = 15 * 60_000
// The platform rejects relation queries starting more than 90 days back; keep a margin for long runs.
export const RELATION_RETENTION = 90 * DAY - 10 * 60_000
const MESSAGE_PAGE_SIZE = 100, MESSAGE_MAX_PAGES = 50, MESSAGE_CONCURRENCY = 4
// Scheduled runs poll accounts without a session in the last 7 days at most this often (manual runs always poll every account).
export const IDLE_POLL_MS = 2 * 3_600_000

// Message types that are not a buyer asking or an agent answering.
const NON_BUYER = ['系统消息', '广播消息']
export const TRANSFER = '客服转交消息'
const NON_REPLY = ['自动回复消息', '系统消息', '广播消息', TRANSFER]
// Agent-side "其他消息" has no content in the API; whether it answers a buyer is a tenant setting.
const OTHER = '其他消息'
export const TURNS_VERSION = 2

/** "2026-10-12 12:59:53" in Beijing time. */
export function parseBeijingTime(value: unknown) {
  const match = typeof value === 'string' && /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value)
  if (!match) throw new IntegrationError('INVALID_MESSAGE_TIME', '平台消息时间格式无法解析。')
  return new Date(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}+08:00`)
}
/** Start of the Beijing calendar day for "20261012" or "2026-10-12". */
export function beijingDayStart(value: string) {
  const match = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(value)
  if (!match) throw new IntegrationError('INVALID_CHAT_DATE', '平台会话日期格式无法解析。')
  return Date.UTC(+match[1], +match[2] - 1, +match[3]) - BEIJING
}
const dayStartOf = (at: number) => Math.floor((at + BEIJING) / DAY) * DAY - BEIJING
const isoDate = (dayStart: number) => new Date(dayStart + BEIJING).toISOString().slice(0, 10)
const types = (value: unknown) => Array.isArray(value) ? value.filter((t): t is string => typeof t === 'string') : []
const data = (response: Json) => (response.data ?? response.result?.data ?? {}) as Json

export function buyerKey(peer: Json) {
  if (typeof peer.adminOpenUid === 'string' && peer.adminOpenUid) return peer.adminOpenUid
  if (typeof peer.openUid === 'string' && peer.openUid) return peer.openUid
  if (typeof peer.taobaoNick === 'string' && peer.taobaoNick) return `tb:${peer.taobaoNick}`
  return null
}

/** Splits a session's messages into buyer turns and the first manual reply to each. */
export function computeTurns(messages: Message[], countOtherAsReply: boolean) {
  const turns: { turn_at: Date; reply_at: Date | null; buyer_messages: number }[] = []
  let buyer = 0, agent = 0, other = 0, auto = 0, transferred = false
  for (const message of messages) {
    if (message.message_types.includes(TRANSFER)) transferred = true
    if (message.direction === 1) {
      if (message.message_types.some(t => NON_BUYER.includes(t))) continue
      buyer++
      const current = turns.at(-1)
      if (!current || current.reply_at) turns.push({ turn_at: message.sent_at, reply_at: null, buyer_messages: 1 })
      else current.buyer_messages++
    } else {
      if (message.message_types.includes('自动回复消息')) auto++
      if (message.message_types.some(t => NON_REPLY.includes(t))) continue
      if (message.message_types.includes(OTHER) && !message.message_types.includes('正常消息')) {
        other++
        if (!countOtherAsReply) continue
      } else agent++
      const current = turns.at(-1)
      if (current && !current.reply_at) current.reply_at = message.sent_at
    }
  }
  return { turns, buyer, agent, other, auto, transferred }
}

class LeaseLost extends Error {}

async function heartbeat(run: Run, phase: string) {
  const result = await db.query("UPDATE perf_sync_runs SET lease_until=now()+interval '5 minutes',phase=$3,stats=$4 WHERE id=$1 AND worker_id=$2 AND status='running'", [run.id, run.worker_id, phase, JSON.stringify(run.stats)])
  if (!result.rowCount) throw new LeaseLost('sync lease lost')
}

const QOS_RETRIES = [2_000, 5_000, 15_000]
const pacing = new Map<string, number>()

/** Platform calls for one run: spaced at most PERF_SYNC_MAX_QPS per shop, and retried with backoff when the gateway throttles the app. */
function caller(run: Run) {
  const gap = 1000 / config.PERF_SYNC_MAX_QPS
  return async (name: string, input: Json = {}) => {
    for (let attempt = 0; ; attempt++) {
      const slot = Math.max(Date.now(), pacing.get(run.connection_id) ?? 0)
      pacing.set(run.connection_id, slot + gap)
      if (slot > Date.now()) await new Promise(resolve => setTimeout(resolve, slot - Date.now()))
      try { return await callPerformanceApi(run.connection_id, run.tenant_id, run.requested_by, name, input, `perf-sync:${run.id}`) as Json } catch (error) {
        if (!(error instanceof IntegrationError && error.code.startsWith('gw.Qos')) || attempt >= QOS_RETRIES.length) throw error
        run.stats.throttled = (run.stats.throttled || 0) + 1
        pacing.set(run.connection_id, Math.max(pacing.get(run.connection_id) ?? 0, Date.now() + QOS_RETRIES[attempt]))
      }
    }
  }
}

async function syncAgents(run: Run) {
  const result = await caller(run)('alibaba.subAccount.list')
  const accounts = (result.result && typeof result.result === 'object' ? result.result : result) as Json
  if (typeof accounts.mainLoginId !== 'string' || !accounts.mainLoginId) throw new IntegrationError('EMPTY_ACCOUNTS', '接口未返回主账号信息。')
  // The main account also receives buyers, so it is tracked like any sub-account.
  const rows = [{ loginId: accounts.mainLoginId, userId: accounts.mainUserId, memberId: accounts.mainMemberId, status: null, main: true },
    ...(Array.isArray(accounts.subAccountList) ? accounts.subAccountList : []).map((s: Json) => ({ loginId: s.loginId, userId: s.userId, memberId: s.memberId, status: s.status, main: false }))]
  const seen: string[] = []
  for (const row of rows) {
    if (typeof row.loginId !== 'string' || !row.loginId) continue
    seen.push(row.loginId)
    await db.query(`INSERT INTO perf_agents(tenant_id,connection_id,login_id,platform_user_id,member_id,is_main,platform_status)VALUES($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT(connection_id,login_id) DO UPDATE SET platform_user_id=excluded.platform_user_id,member_id=excluded.member_id,is_main=excluded.is_main,platform_status=excluded.platform_status,present=true,last_seen_at=now(),updated_at=now()`,
    [run.tenant_id, run.connection_id, row.loginId, row.userId == null ? null : String(row.userId), row.memberId ?? null, row.main, row.status == null ? null : String(row.status)])
  }
  await db.query('UPDATE perf_agents SET present=false,updated_at=now() WHERE connection_id=$1 AND present AND NOT (login_id = ANY($2))', [run.connection_id, seen])
  run.stats.agents = seen.length
}

async function savePeers(run: Run, agent: Agent, peers: Json[]) {
  for (const peer of peers) {
    const key = buyerKey(peer)
    if (!key || typeof peer.cid !== 'string' || !peer.cid || typeof peer.date !== 'string' || !Number.isFinite(Number(peer.time))) { run.stats.skippedPeers = (run.stats.skippedPeers || 0) + 1; continue }
    const at = new Date(Number(peer.time))
    const openUid = typeof peer.openUid === 'string' && peer.openUid ? peer.openUid : null
    // One customer may appear under several encrypted ids; resolve through all ids seen so far.
    const resolved = await resolveBuyer(run.tenant_id, run.connection_id, { key, openUid, adminOpenUid: peer.adminOpenUid || null, taobaoNick: peer.taobaoNick || null, at })
    if (resolved.merged) run.stats.mergedBuyers = (run.stats.mergedBuyers || 0) + resolved.merged
    const buyer = { id: resolved.buyerId }
    await db.query(`INSERT INTO perf_chat_sessions(tenant_id,connection_id,agent_id,buyer_id,cid,chat_date,last_peer_at)VALUES($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT(agent_id,cid,chat_date) DO UPDATE SET last_peer_at=greatest(perf_chat_sessions.last_peer_at,excluded.last_peer_at),
      needs_sync=perf_chat_sessions.needs_sync OR excluded.last_peer_at>perf_chat_sessions.last_peer_at,updated_at=now()`,
    [run.tenant_id, run.connection_id, agent.id, buyer.id, peer.cid, isoDate(beijingDayStart(peer.date)), at])
    run.stats.peers = (run.stats.peers || 0) + 1
  }
}

/**
 * Reads one Beijing calendar day. The platform answers per date (every date from `beg` to `end`, inclusive, whatever the clock time),
 * so a busy day cannot be narrowed further: past the 2000-record cap the remainder is unreachable and the day is reported as truncated.
 */
async function relationDay(run: Run, agent: Agent, beg: number, end: number) {
  const peers: Json[] = []
  for (let page = 1; page <= RELATION_MAX_PAGE; page++) {
    const response = data(await caller(run)('wangwang.chat.relation.query', { loginId: agent.login_id, beg, end, page, size: RELATION_PAGE_SIZE }))
    const batch = Array.isArray(response.peers) ? response.peers : []
    peers.push(...batch)
    if (!response.hasMore || !batch.length) return savePeers(run, agent, peers)
  }
  await savePeers(run, agent, peers)
  run.stats.truncatedDays = (run.stats.truncatedDays || 0) + 1
}

async function syncRelations(run: Run, agent: Agent, now: number, backfillFrom: number | null, scopeFrom: number | null) {
  // New activity first: from the cursor (or the first-sync horizon) up to today. A scoped run whose window starts after the
  // cursor reads only its window and leaves the cursors alone, so the gap before it is still filled by the next full run.
  const cursorStart = dayStartOf(agent.relations_synced_until ? agent.relations_synced_until.getTime() - RELATION_OVERLAP : now - config.PERF_SYNC_INITIAL_DAYS * DAY)
  const contiguous = scopeFrom == null || cursorStart >= scopeFrom
  const start = contiguous ? cursorStart : scopeFrom
  for (let day = start; day < now; day += DAY) {
    await relationStep(run, agent, day)
    if (contiguous) await db.query('UPDATE perf_agents SET relations_synced_until=greatest(coalesce(relations_synced_until,$2),$2),relations_synced_from=least(coalesce(relations_synced_from,$3),$3) WHERE id=$1',
      [agent.id, new Date(Math.min(day + DAY, now)), new Date(start)])
  }
  // Then missing history, newest day first, so an interrupted backfill resumes where it stopped.
  let since = agent.relations_synced_from ? Math.min(agent.relations_synced_from.getTime(), start) : start
  const target = backfillFrom == null ? null : Math.max(backfillFrom, now - RELATION_RETENTION)
  while (target != null && since > target) {
    const day = dayStartOf(since - 1)
    await relationStep(run, agent, day)
    since = day
    await db.query('UPDATE perf_agents SET relations_synced_from=least(coalesce(relations_synced_from,$2),$2) WHERE id=$1', [agent.id, new Date(day)])
  }
}

async function relationStep(run: Run, agent: Agent, day: number) {
  await heartbeat(run, 'relations')
  // Any clock time selects the whole date; stay inside the retention limit on the oldest day.
  await relationDay(run, agent, Math.max(day, Date.now() - RELATION_RETENTION), day + DAY - 1)
  run.stats.windows = (run.stats.windows || 0) + 1
}

export async function rebuildSession(sessionId: string, tenantId: string) {
  const messages = (await db.query<Message>('SELECT direction,sent_at,message_types FROM perf_chat_messages WHERE session_id=$1 ORDER BY sent_at,uuid', [sessionId])).rows
  const strict = computeTurns(messages, false), loose = computeTurns(messages, true)
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    await client.query('DELETE FROM perf_chat_turns WHERE session_id=$1', [sessionId])
    for (const [mode, result] of [['strict', strict], ['loose', loose]] as const) for (const [index, turn] of result.turns.entries()) {
      await client.query('INSERT INTO perf_chat_turns(tenant_id,session_id,mode,turn_index,turn_at,reply_at,buyer_messages)VALUES($1,$2,$3,$4,$5,$6,$7)', [tenantId, sessionId, mode, index, turn.turn_at, turn.reply_at, turn.buyer_messages])
    }
    await client.query('UPDATE perf_chat_sessions SET buyer_messages=$2,agent_messages=$3,other_agent_messages=$4,auto_replies=$5,transferred=$6,turns_version=$7,updated_at=now() WHERE id=$1',
      [sessionId, strict.buyer, strict.agent, strict.other, strict.auto, strict.transferred, TURNS_VERSION])
    await client.query('COMMIT')
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}

async function syncSession(run: Run, session: Session) {
  const dayStart = beijingDayStart(session.chat_date), dayEnd = dayStart + DAY
  let beg = session.message_cursor ? Number(session.message_cursor) : dayStart, latest = beg, saved = 0
  for (let page = 0; page < MESSAGE_MAX_PAGES; page++) {
    const response = data(await caller(run)('chat.msg.query', { loginId: session.login_id, cid: session.cid, beg, count: MESSAGE_PAGE_SIZE, forward: true }))
    const logs = Array.isArray(response.historyChatLogList) ? response.historyChatLogList : []
    let pastDay = false
    for (const log of logs) {
      const sentAt = parseBeijingTime(log.time)
      if (sentAt.getTime() >= dayEnd) { pastDay = true; continue }
      latest = Math.max(latest, sentAt.getTime())
      // A conversation can mix several accounts of the shop; selfLoginId tells whose view a message belongs to.
      if (log.selfLoginId !== session.login_id || typeof log.uuid !== 'string' || !log.uuid || (log.direction !== 0 && log.direction !== 1 && log.direction !== '0' && log.direction !== '1')) continue
      // Agent text is analysed and masked here; buyer text is masked by the platform and not kept.
      const direction = Number(log.direction), msgTypes = types(log.messageTypes)
      const agentText = direction === 0 ? analyzeAgentText(log.content, msgTypes) : null
      const inserted = await db.query(`INSERT INTO perf_chat_messages(tenant_id,connection_id,session_id,uuid,direction,sent_at,length,message_types,keywords,text_masked,char_count,flags)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        ON CONFLICT(connection_id,uuid) DO UPDATE SET text_masked=excluded.text_masked,char_count=excluded.char_count,flags=excluded.flags
          WHERE perf_chat_messages.char_count IS NULL AND excluded.char_count IS NOT NULL RETURNING (xmax=0) AS inserted`,
        [run.tenant_id, run.connection_id, session.id, log.uuid, direction, sentAt, Math.max(0, Number.parseInt(String(log.length ?? 0), 10) || 0), msgTypes,
          JSON.stringify(Array.isArray(log.words) ? log.words.filter((w: Json) => w && typeof w.word === 'string').map((w: Json) => ({ word: w.word, count: Number(w.count) || 0 })) : []),
          agentText?.text ?? null, agentText ? agentText.chars : null, agentText?.flags ?? []])
      const fresh = inserted.rows.filter(r => r.inserted).length
      saved += fresh
      run.stats.messages = (run.stats.messages || 0) + fresh
    }
    const next = Number(response.nextCursor)
    if (!response.hasMore || pastDay || !logs.length) break
    const advanced = Number.isFinite(next) && next > beg ? next : latest > beg ? latest : NaN
    if (!Number.isFinite(advanced)) break
    beg = advanced
  }
  await rebuildSession(session.id, run.tenant_id)
  // Newly stored replies (e.g. backfilled history) can change who gets credit for this buyer's orders.
  if (saved) await db.query(`UPDATE perf_orders o SET attribution_key=NULL FROM perf_chat_sessions s JOIN perf_buyer_identities i ON i.buyer_id=s.buyer_id
    WHERE s.id=$1 AND o.connection_id=i.connection_id AND o.buyer_open_uid=i.open_uid AND o.attribution_key IS NOT NULL`, [session.id])
  await db.query('UPDATE perf_chat_sessions SET message_cursor=$2,needs_sync=false,messages_synced_at=now(),updated_at=now() WHERE id=$1', [session.id, latest])
  run.stats.sessions = (run.stats.sessions || 0) + 1
}

async function rebuildStale(run: Run) {
  const stale = (await db.query<{ id: string }>('SELECT id FROM perf_chat_sessions WHERE connection_id=$1 AND turns_version<$2 AND NOT needs_sync', [run.connection_id, TURNS_VERSION])).rows
  for (const [index, session] of stale.entries()) {
    if (index % 100 === 0) await heartbeat(run, 'rebuild')
    await rebuildSession(session.id, run.tenant_id)
  }
  if (stale.length) run.stats.rebuiltSessions = stale.length
}

async function syncMessages(run: Run, from: number) {
  // Only sessions whose relation entry changed. The relation's session time moves with every new message (checked on
  // 7,393 live sessions: it always equals the last message to the second), so unchanged sessions are not re-read.
  // Only sessions inside the run's range (scope or history days).
  const sessions = (await db.query<Session>(`SELECT s.id,s.agent_id,s.cid,s.chat_date::text AS chat_date,s.message_cursor,a.login_id FROM perf_chat_sessions s JOIN perf_agents a ON a.id=s.agent_id
    WHERE s.connection_id=$1 AND s.chat_date>=$2::date AND s.needs_sync
    ORDER BY s.chat_date DESC,s.last_peer_at`, [run.connection_id, isoDate(from)])).rows
  // Sessions are independent: a few run side by side, and the lease is renewed at most every 15 seconds.
  let consecutiveFailures = 0, next = 0, lastBeat = 0, fatal: unknown = null
  const worker = async () => {
    while (!fatal && next < sessions.length) {
      const session = sessions[next++]
      if (Date.now() - lastBeat > 15_000) { lastBeat = Date.now(); await heartbeat(run, 'messages') }
      try { await syncSession(run, session); consecutiveFailures = 0 } catch (error) {
        if (error instanceof LeaseLost) { fatal = error; break }
        run.stats.failedSessions = (run.stats.failedSessions || 0) + 1
        if (error instanceof IntegrationError && ['REAUTHORIZE', 'CONNECTION_INACTIVE', 'NOT_FOUND', 'APP_MISMATCH'].includes(error.code)) fatal = error
        else if (++consecutiveFailures >= 5) fatal = error
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(MESSAGE_CONCURRENCY, sessions.length) }, worker))
  if (fatal) throw fatal
}

/** Start of the Beijing day `days - 1` days ago, so a range of N days includes today. */
export const rangeStart = (days: number, now = Date.now()) => dayStartOf(now) - (days - 1) * DAY

/** Queues a run. Without `scopeDays` it is a full run: new activity plus history back to the shop's `history_days`. */
export async function enqueuePerformanceSync(tenantId: string, connectionId: string, requestedBy: string | null, trigger: 'schedule' | 'manual', scopeDays?: 1 | 7 | 30) {
  const result = await db.query(`INSERT INTO perf_sync_runs(tenant_id,connection_id,requested_by,trigger,scope_days)
    SELECT $1,$2,$3,$4,$5 WHERE EXISTS(SELECT 1 FROM integration_1688_perf_connections WHERE id=$2 AND tenant_id=$1 AND status='connected')
    ON CONFLICT (connection_id) WHERE status IN ('queued','running') DO NOTHING RETURNING id`, [tenantId, connectionId, requestedBy, trigger, scopeDays ?? null])
  return result.rows[0]?.id as string | undefined
}

/**
 * Scheduled syncs pause for the rest of the Beijing day once the app's daily call quota is used up: the gateway refused a call
 * with gw.Qos* today, or today's calls reached PERF_SYNC_DAILY_CALLS (the app quota is 5,000/day while in development,
 * 100,000/day after going live). Manual syncs are not affected.
 */
async function scheduleDue() {
  const due = (await db.query(`WITH today AS (SELECT (date_trunc('day',now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai') AS start)
    SELECT c.tenant_id,c.id FROM integration_1688_perf_connections c CROSS JOIN today WHERE c.status='connected' AND c.account_role<>'sub'
    AND NOT EXISTS(SELECT 1 FROM perf_sync_runs r WHERE r.connection_id=c.id AND (r.status IN ('queued','running') OR r.created_at>now()-make_interval(secs=>$1::double precision/1000)))
    AND NOT EXISTS(SELECT 1 FROM integration_1688_operations o WHERE o.perf_connection_id=c.id AND o.created_at>=today.start AND o.error_code LIKE 'gw.Qos%')
    AND (SELECT count(*) FROM integration_1688_operations o WHERE o.perf_connection_id=c.id AND o.created_at>=today.start)<$2`, [config.PERF_SYNC_INTERVAL_MS, config.PERF_SYNC_DAILY_CALLS])).rows
  for (const row of due) await enqueuePerformanceSync(row.tenant_id, row.id, null, 'schedule')
}

async function recover() {
  await db.query(`UPDATE perf_sync_runs SET status=CASE WHEN attempts>=3 THEN 'failed' ELSE 'queued' END,worker_id=NULL,lease_until=NULL,
    error_code=CASE WHEN attempts>=3 THEN 'LEASE_EXPIRED' ELSE error_code END,finished_at=CASE WHEN attempts>=3 THEN now() END WHERE status='running' AND lease_until<now()`)
}

export async function runPerformanceSyncOnce(workerId = randomUUID(), connectionId?: string) {
  const claimed = (await db.query(`WITH next AS (SELECT id FROM perf_sync_runs WHERE status='queued' AND ($2::uuid IS NULL OR connection_id=$2) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
    UPDATE perf_sync_runs r SET status='running',worker_id=$1,attempts=attempts+1,lease_until=now()+interval '5 minutes',started_at=coalesce(started_at,now()) FROM next WHERE r.id=next.id RETURNING r.*`, [workerId, connectionId ?? null])).rows[0] as Run | undefined
  if (!claimed) return null
  const run: Run = { ...claimed, stats: claimed.stats || {} }
  try {
    await heartbeat(run, 'agents')
    await syncAgents(run)
    const agents = (await db.query<Agent>(`SELECT a.id,a.login_id,a.relations_synced_until,a.relations_synced_from,
        NOT EXISTS(SELECT 1 FROM perf_chat_sessions s WHERE s.agent_id=a.id AND s.chat_date>=(now() AT TIME ZONE 'Asia/Shanghai')::date-6) AS idle
      FROM perf_agents a WHERE a.connection_id=$1 AND a.present ORDER BY a.is_main DESC,a.login_id`, [run.connection_id])).rows
    const now = Date.now()
    // The history target rolls forward with the shop's range; a scoped run reads only its recent window and fills no history.
    const historyFrom = Math.max(rangeStart((await db.query<{ history_days: number }>('SELECT history_days FROM integration_1688_perf_connections WHERE id=$1', [run.connection_id])).rows[0].history_days, now), now - RELATION_RETENTION)
    await db.query('UPDATE integration_1688_perf_connections SET backfill_from=$2 WHERE id=$1', [run.connection_id, new Date(historyFrom)])
    const scopeFrom = run.scope_days ? rangeStart(run.scope_days, now) : null
    const backfillFrom = scopeFrom == null ? historyFrom : null
    for (const agent of agents) {
      // Idle accounts (no session in 7 days) are polled every two hours by the scheduler; any new session makes them active again.
      if (run.trigger === 'schedule' && agent.idle && agent.relations_synced_until && now - agent.relations_synced_until.getTime() < IDLE_POLL_MS) { run.stats.idleSkipped = (run.stats.idleSkipped || 0) + 1; continue }
      await syncRelations(run, agent, now, backfillFrom, scopeFrom)
    }
    await syncMessages(run, scopeFrom ?? historyFrom)
    // Agent text is kept for 90 days; flags and character counts stay with the message.
    await db.query(`UPDATE perf_chat_messages SET text_masked=NULL WHERE connection_id=$1 AND text_masked IS NOT NULL AND sent_at<now()-interval '90 days'`, [run.connection_id])
    await rebuildStale(run)
    const context: SyncContext = { tenantId: run.tenant_id, connectionId: run.connection_id, backfillFrom, scopeFrom, stats: run.stats, call: caller(run), heartbeat: phase => heartbeat(run, phase) }
    await syncOrders(context, now)
    await syncRefunds(context, now)
    await computeAttributions(context)
    // Owners come from scheme 2 credit; a changed owner re-attributes that customer's orders (schemes 8/9).
    const owners = await assignOwners(run.tenant_id, run.connection_id)
    if (owners) { run.stats.ownersChanged = owners; await computeAttributions(context) }
    await heartbeat(run, 'customers')
    const orderBuyers = await ensureOrderBuyers(run.connection_id)
    if (orderBuyers) run.stats.orderOnlyBuyers = orderBuyers
    run.stats.customers = await refreshCustomerStats(run.connection_id)
    await db.query("UPDATE perf_sync_runs SET status='succeeded',phase=NULL,stats=$3,worker_id=NULL,lease_until=NULL,finished_at=now() WHERE id=$1 AND worker_id=$2", [run.id, workerId, JSON.stringify(run.stats)])
    return { id: run.id, status: 'succeeded', stats: run.stats }
  } catch (error) {
    if (error instanceof LeaseLost) return { id: run.id, status: 'lease_lost', stats: run.stats }
    const code = error instanceof IntegrationError ? error.code : 'INTERNAL_ERROR'
    const message = error instanceof IntegrationError ? error.message : '同步过程中发生错误。'
    await db.query("UPDATE perf_sync_runs SET status='failed',stats=$3,error_code=$4,error_message=$5,worker_id=NULL,lease_until=NULL,finished_at=now() WHERE id=$1 AND worker_id=$2", [run.id, workerId, JSON.stringify(run.stats), code, message])
    return { id: run.id, status: 'failed', stats: run.stats, error: code }
  }
}

export function startPerformanceSync(onError: (error: unknown) => void = () => {}) {
  let stopped = false, active: Promise<unknown> | null = null
  const tick = async () => {
    if (stopped || active) return
    active = (async () => { await recover(); await scheduleDue(); while (!stopped && await runPerformanceSyncOnce()) { /* drain queue */ } })().catch(onError).finally(() => { active = null })
  }
  const timer = setInterval(() => void tick(), config.PERF_SYNC_POLL_MS)
  void tick()
  return async () => {
    stopped = true; clearInterval(timer)
    let timeout: ReturnType<typeof setTimeout> | undefined
    try { if (active) await Promise.race([active, new Promise(resolve => { timeout = setTimeout(resolve, 30_000) })]) } finally { if (timeout) clearTimeout(timeout) }
  }
}
