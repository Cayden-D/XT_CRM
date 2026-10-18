import { db } from '../db.js'

/**
 * Chat insights shared by the 客服绩效 pages and the AI assistant, so both report the same figures. Both read local data only.
 * `ownUser` limits to the agent accounts bound to that user (performance:read_own).
 */

/** 回复质量: per-agent reply metrics from agent-side text, off-platform trading alerts and curt wording. */
export async function replyQuality(tenantId: string, connectionId: string, from: string, to: string, ownUser: string | null) {
  const params = [tenantId, connectionId, from, to, ownUser]
  const base = `FROM perf_chat_messages m JOIN perf_chat_sessions s ON s.id=m.session_id JOIN perf_agents ag ON ag.id=s.agent_id LEFT JOIN users u ON u.id=ag.user_id
      JOIN perf_buyers b ON b.id=s.buyer_id LEFT JOIN cust_profiles p ON p.buyer_id=b.id
    WHERE s.tenant_id=$1 AND s.connection_id=$2 AND s.chat_date BETWEEN $3::date AND $4::date AND ($5::uuid IS NULL OR ag.user_id=$5) AND m.direction=0
      AND NOT (m.message_types && ARRAY['自动回复消息','系统消息','广播消息','客服转交消息'])`
  const agents = (await db.query(`SELECT ag.id AS agent_id,ag.login_id,ag.is_main,u.display_name AS user_name,
      count(*)::int AS messages,count(m.char_count)::int AS captured,
      round(avg(m.char_count) FILTER (WHERE m.char_count>0),1)::float AS avg_chars,
      count(*) FILTER (WHERE 'short'=ANY(m.flags))::int AS short_replies,count(*) FILTER (WHERE m.char_count>0)::int AS text_replies,
      count(*) FILTER (WHERE 'image'=ANY(m.flags))::int AS images,count(*) FILTER (WHERE 'curt'=ANY(m.flags))::int AS curt,
      count(*) FILTER (WHERE m.flags && ARRAY['phone','wechat','qq','offsite','external_link'])::int AS offsite
    ${base} GROUP BY ag.id,ag.login_id,ag.is_main,u.display_name ORDER BY count(*) DESC`, params)).rows
  const risks = (await db.query(`SELECT m.uuid,m.sent_at,m.flags,m.text_masked,s.id AS session_id,s.buyer_id,s.chat_date::text AS chat_date,ag.login_id,right(b.buyer_key,6) AS buyer_tail,p.name AS buyer_name
    ${base}
      AND m.flags && ARRAY['phone','wechat','qq','offsite','external_link'] ORDER BY m.sent_at DESC LIMIT 200`, params)).rows
  const curt = (await db.query(`SELECT m.uuid,m.sent_at,m.text_masked,s.id AS session_id,ag.login_id ${base} AND 'curt'=ANY(m.flags) AND m.text_masked IS NOT NULL ORDER BY m.sent_at DESC LIMIT 50`, params)).rows
  const totals = agents.reduce((t, a) => ({ messages: t.messages + a.messages, captured: t.captured + a.captured, offsite: t.offsite + a.offsite }), { messages: 0, captured: 0, offsite: 0 })
  return { agents, risks, curt, coverage: totals.messages ? totals.captured / totals.messages : null, totals }
}

/** 关键词命中: hits per keyword (buyer vs agent) and the latest hits. */
export async function keywordHits(tenantId: string, connectionId: string, from: string, to: string, ownUser: string | null) {
  const params = [tenantId, connectionId, from, to, ownUser]
  const base = `FROM perf_chat_messages m JOIN perf_chat_sessions s ON s.id=m.session_id JOIN perf_agents ag ON ag.id=s.agent_id
      JOIN perf_buyers b ON b.id=s.buyer_id LEFT JOIN cust_profiles p ON p.buyer_id=b.id
      CROSS JOIN LATERAL jsonb_array_elements(m.keywords) k LEFT JOIN perf_keywords pk ON pk.connection_id=s.connection_id AND pk.word=k->>'word'
    WHERE s.tenant_id=$1 AND s.connection_id=$2 AND s.chat_date BETWEEN $3::date AND $4::date AND m.keywords<>'[]'::jsonb AND ($5::uuid IS NULL OR ag.user_id=$5)`
  const words = (await db.query(`SELECT k->>'word' AS word,coalesce(pk.category,'其他') AS category,
      coalesce(sum(coalesce((k->>'count')::int,1)) FILTER (WHERE m.direction=1),0)::int AS buyer_hits,coalesce(sum(coalesce((k->>'count')::int,1)) FILTER (WHERE m.direction=0),0)::int AS agent_hits,
      count(DISTINCT s.id)::int AS sessions,count(DISTINCT s.buyer_id) FILTER (WHERE m.direction=1)::int AS buyers,max(m.sent_at) AS last_hit
    ${base}
    GROUP BY 1,2 ORDER BY 3 DESC,4 DESC`, params)).rows
  const recent = (await db.query(`SELECT m.uuid,m.sent_at,m.direction,k->>'word' AS word,coalesce(pk.category,'其他') AS category,s.id AS session_id,s.buyer_id,s.chat_date::text AS chat_date,ag.login_id,right(b.buyer_key,6) AS buyer_tail,p.name AS buyer_name
    ${base}
    ORDER BY m.sent_at DESC LIMIT 100`, params)).rows
  return { words, recent }
}
