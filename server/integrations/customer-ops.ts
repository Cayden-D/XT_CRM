import type { PoolClient } from 'pg'
import { db } from '../db.js'

type Peer = { key: string; openUid: string | null; adminOpenUid: string | null; taobaoNick: string | null; at: Date }

/**
 * Moves everything attached to `dropId` onto `keepId` and deletes the duplicate buyer.
 * Happens when a chat reveals that two encrypted ids (e.g. an order-only sub-buyer and a chat main buyer) are one customer.
 */
export async function mergeBuyers(client: PoolClient, keepId: string, dropId: string) {
  await client.query('UPDATE perf_chat_sessions SET buyer_id=$1 WHERE buyer_id=$2', [keepId, dropId])
  await client.query('UPDATE perf_buyer_identities SET buyer_id=$1 WHERE buyer_id=$2', [keepId, dropId])
  await client.query('UPDATE cust_followups SET buyer_id=$1 WHERE buyer_id=$2', [keepId, dropId])
  await client.query('UPDATE cust_attachments SET buyer_id=$1 WHERE buyer_id=$2', [keepId, dropId])
  await client.query('INSERT INTO cust_buyer_tags(buyer_id,tag_id) SELECT $1,tag_id FROM cust_buyer_tags WHERE buyer_id=$2 ON CONFLICT DO NOTHING', [keepId, dropId])
  // Profile: keep the surviving buyer's values, fill gaps from the duplicate.
  await client.query(`INSERT INTO cust_profiles(buyer_id,tenant_id,name,wangwang_id,phone,wechat,email,qq,address,member_identity,purchase_type,sales_channels,cycle_mode,cycle_days,note,account_id,owner_agent_id,owner_source,owner_assigned_at)
    SELECT $1,tenant_id,name,wangwang_id,phone,wechat,email,qq,address,member_identity,purchase_type,sales_channels,cycle_mode,cycle_days,note,account_id,owner_agent_id,owner_source,owner_assigned_at FROM cust_profiles WHERE buyer_id=$2
    ON CONFLICT(buyer_id) DO UPDATE SET name=coalesce(cust_profiles.name,excluded.name),wangwang_id=coalesce(cust_profiles.wangwang_id,excluded.wangwang_id),phone=coalesce(cust_profiles.phone,excluded.phone),
      wechat=coalesce(cust_profiles.wechat,excluded.wechat),email=coalesce(cust_profiles.email,excluded.email),qq=coalesce(cust_profiles.qq,excluded.qq),address=coalesce(cust_profiles.address,excluded.address),
      member_identity=coalesce(cust_profiles.member_identity,excluded.member_identity),purchase_type=coalesce(cust_profiles.purchase_type,excluded.purchase_type),
      sales_channels=CASE WHEN cardinality(cust_profiles.sales_channels)>0 THEN cust_profiles.sales_channels ELSE excluded.sales_channels END,
      note=coalesce(cust_profiles.note,excluded.note),account_id=coalesce(cust_profiles.account_id,excluded.account_id),owner_agent_id=coalesce(cust_profiles.owner_agent_id,excluded.owner_agent_id),
      owner_source=CASE WHEN cust_profiles.owner_agent_id IS NULL AND cust_profiles.owner_source IS DISTINCT FROM 'manual' THEN excluded.owner_source ELSE cust_profiles.owner_source END,
      owner_assigned_at=CASE WHEN cust_profiles.owner_agent_id IS NULL AND cust_profiles.owner_source IS DISTINCT FROM 'manual' THEN excluded.owner_assigned_at ELSE cust_profiles.owner_assigned_at END,
      revision=cust_profiles.revision+1,updated_at=now()`, [keepId, dropId])
  await client.query(`UPDATE perf_buyers k SET open_uid=coalesce(k.open_uid,d.open_uid),admin_open_uid=coalesce(k.admin_open_uid,d.admin_open_uid),
    first_chat_at=least(k.first_chat_at,d.first_chat_at),last_chat_at=greatest(k.last_chat_at,d.last_chat_at) FROM perf_buyers d WHERE k.id=$1 AND d.id=$2`, [keepId, dropId])
  await client.query('DELETE FROM perf_buyers WHERE id=$1', [dropId])
}

/** Finds (or creates) the buyer for a chat peer through every encrypted id already seen, merging duplicates. */
export async function resolveBuyer(tenantId: string, connectionId: string, peer: Peer) {
  const uids = [...new Set([peer.openUid, peer.adminOpenUid].filter((v): v is string => Boolean(v)))]
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    // Serialise per shop so two peers of one buyer cannot create duplicates concurrently.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`perf-buyers:${connectionId}`])
    const found = uids.length ? (await client.query<{ buyer_id: string; buyer_key: string }>(`SELECT DISTINCT i.buyer_id,b.buyer_key FROM perf_buyer_identities i JOIN perf_buyers b ON b.id=i.buyer_id
      WHERE i.connection_id=$1 AND i.open_uid=ANY($2)`, [connectionId, uids])).rows : []
    let buyerId: string
    if (!found.length) {
      buyerId = (await client.query(`INSERT INTO perf_buyers(tenant_id,connection_id,buyer_key,open_uid,admin_open_uid,taobao_nick,first_chat_at,last_chat_at)VALUES($1,$2,$3,$4,$5,$6,$7,$7)
        ON CONFLICT(connection_id,buyer_key) DO UPDATE SET open_uid=coalesce(excluded.open_uid,perf_buyers.open_uid),admin_open_uid=coalesce(excluded.admin_open_uid,perf_buyers.admin_open_uid),
        first_chat_at=least(perf_buyers.first_chat_at,excluded.first_chat_at),last_chat_at=greatest(perf_buyers.last_chat_at,excluded.last_chat_at) RETURNING id`,
      [tenantId, connectionId, peer.key, peer.openUid, peer.adminOpenUid, peer.openUid ? null : peer.taobaoNick, peer.at])).rows[0].id
    } else {
      // Prefer the buyer keyed by the main-account id; fold the others into it.
      const keep = found.find(f => f.buyer_key === peer.adminOpenUid) ?? found[0]
      for (const other of found) if (other.buyer_id !== keep.buyer_id) await mergeBuyers(client, keep.buyer_id, other.buyer_id)
      buyerId = keep.buyer_id
      await client.query(`UPDATE perf_buyers SET open_uid=coalesce($2,open_uid),admin_open_uid=coalesce($3,admin_open_uid),
        first_chat_at=least(coalesce(first_chat_at,$4),$4),last_chat_at=greatest(coalesce(last_chat_at,$4),$4) WHERE id=$1`, [buyerId, peer.openUid, peer.adminOpenUid, peer.at])
    }
    for (const uid of uids) await client.query('INSERT INTO perf_buyer_identities(connection_id,open_uid,buyer_id)VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [connectionId, uid, buyerId])
    await client.query('COMMIT')
    return { buyerId, merged: found.length > 1 ? found.length - 1 : 0 }
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}

/** Buyers who ordered without chatting still become customers. */
export async function ensureOrderBuyers(connectionId: string) {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`perf-buyers:${connectionId}`])
    const created = await client.query(`INSERT INTO perf_buyers(tenant_id,connection_id,buyer_key,open_uid)
      SELECT DISTINCT o.tenant_id,o.connection_id,o.buyer_open_uid,o.buyer_open_uid FROM perf_orders o
      WHERE o.connection_id=$1 AND o.buyer_open_uid IS NOT NULL AND NOT EXISTS (SELECT 1 FROM perf_buyer_identities i WHERE i.connection_id=o.connection_id AND i.open_uid=o.buyer_open_uid)
      ON CONFLICT (connection_id,buyer_key) DO NOTHING RETURNING id,buyer_key`, [connectionId])
    for (const row of created.rows) await client.query('INSERT INTO perf_buyer_identities(connection_id,open_uid,buyer_id)VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [connectionId, row.buyer_key, row.id])
    await client.query('COMMIT')
    return created.rowCount ?? 0
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}

/** Recomputes purchase statistics for every customer of a shop in one statement. */
export async function refreshCustomerStats(connectionId: string) {
  const result = await db.query(`WITH ob AS (SELECT i.buyer_id,o.* FROM perf_orders o JOIN perf_buyer_identities i ON i.connection_id=o.connection_id AND i.open_uid=o.buyer_open_uid WHERE o.connection_id=$1),
    -- Several orders on one Beijing day are one purchase for the cycle (avoids 0-day cycles that look overdue within hours).
    paid AS (SELECT buyer_id,count(*) AS n,sum(total_amount) AS amount,min(paid_at) AS first_at,max(paid_at) AS last_at,
        count(DISTINCT (paid_at AT TIME ZONE 'Asia/Shanghai')::date) AS days FROM ob WHERE paid_at IS NOT NULL GROUP BY buyer_id),
    unpaid AS (SELECT DISTINCT ON (buyer_id) buyer_id,order_id,total_amount,placed_at FROM ob WHERE paid_at IS NULL AND status='waitbuyerpay' ORDER BY buyer_id,placed_at DESC),
    chats AS (SELECT buyer_id,count(DISTINCT chat_date) FILTER (WHERE buyer_messages>0) AS days,max(last_peer_at) AS last_at FROM perf_chat_sessions WHERE connection_id=$1 GROUP BY buyer_id)
    INSERT INTO cust_stats(buyer_id,connection_id,paid_orders,paid_amount,avg_order_amount,first_paid_at,last_paid_at,avg_interval_days,inquiry_days,last_chat_at,unpaid_order_id,unpaid_amount,unpaid_placed_at,refreshed_at)
    SELECT b.id,b.connection_id,coalesce(p.n,0),coalesce(p.amount,0),round(p.amount/nullif(p.n,0),2),p.first_at,p.last_at,
      CASE WHEN p.days>1 THEN round((extract(epoch FROM p.last_at-p.first_at)/86400/(p.days-1))::numeric,2) END,
      coalesce(c.days,0),c.last_at,u.order_id,u.total_amount,u.placed_at,now()
    FROM perf_buyers b LEFT JOIN paid p ON p.buyer_id=b.id LEFT JOIN unpaid u ON u.buyer_id=b.id LEFT JOIN chats c ON c.buyer_id=b.id WHERE b.connection_id=$1
    ON CONFLICT (buyer_id) DO UPDATE SET paid_orders=excluded.paid_orders,paid_amount=excluded.paid_amount,avg_order_amount=excluded.avg_order_amount,first_paid_at=excluded.first_paid_at,
      last_paid_at=excluded.last_paid_at,avg_interval_days=excluded.avg_interval_days,inquiry_days=excluded.inquiry_days,last_chat_at=excluded.last_chat_at,unpaid_order_id=excluded.unpaid_order_id,
      unpaid_amount=excluded.unpaid_amount,unpaid_placed_at=excluded.unpaid_placed_at,refreshed_at=now()`, [connectionId])
  return result.rowCount ?? 0
}

/**
 * Customers without a hand-set owner are owned by the agent credited for their earliest paid order (scheme 2, "优先促成付款").
 * Automatic owners follow the data as history fills in; a manual choice (including "no owner") is never overwritten.
 * Returns the buyers whose owner changed so their orders can be re-attributed.
 */
export async function assignOwners(tenantId: string, connectionId: string) {
  const enabled = (await db.query('SELECT auto_assign_owner FROM perf_settings WHERE tenant_id=$1', [tenantId])).rows[0]?.auto_assign_owner ?? true
  const firsts = `SELECT DISTINCT ON (i.buyer_id) i.buyer_id,a.agent_id
    FROM perf_orders o JOIN perf_buyer_identities i ON i.connection_id=o.connection_id AND i.open_uid=o.buyer_open_uid
    JOIN perf_order_attributions a ON a.order_id=o.id AND a.scheme='payment_first'
    WHERE o.connection_id=$1 AND o.paid_at IS NOT NULL ORDER BY i.buyer_id,o.paid_at,a.share DESC,a.agent_id`
  const changed = enabled
    ? (await db.query<{ buyer_id: string }>(`WITH firsts AS (${firsts}),
        target AS (SELECT b.id AS buyer_id,f.agent_id FROM perf_buyers b LEFT JOIN firsts f ON f.buyer_id=b.id WHERE b.connection_id=$1),
        upserted AS (INSERT INTO cust_profiles(buyer_id,tenant_id,owner_agent_id,owner_source,owner_assigned_at)
          SELECT t.buyer_id,$2,t.agent_id,'auto',now() FROM target t LEFT JOIN cust_profiles p ON p.buyer_id=t.buyer_id
          WHERE t.agent_id IS NOT NULL AND p.buyer_id IS NULL
          ON CONFLICT (buyer_id) DO NOTHING RETURNING buyer_id),
        updated AS (UPDATE cust_profiles p SET owner_agent_id=t.agent_id,owner_source=CASE WHEN t.agent_id IS NULL THEN NULL ELSE 'auto' END,
            owner_assigned_at=now(),revision=p.revision+1,updated_at=now()
          FROM target t WHERE p.buyer_id=t.buyer_id AND p.owner_source IS DISTINCT FROM 'manual' AND p.owner_agent_id IS DISTINCT FROM t.agent_id RETURNING p.buyer_id)
        SELECT buyer_id FROM upserted UNION SELECT buyer_id FROM updated`, [connectionId, tenantId])).rows
    : (await db.query<{ buyer_id: string }>(`UPDATE cust_profiles p SET owner_agent_id=NULL,owner_source=NULL,owner_assigned_at=NULL,revision=p.revision+1,updated_at=now()
        FROM perf_buyers b WHERE b.id=p.buyer_id AND b.connection_id=$1 AND p.owner_source='auto' RETURNING p.buyer_id`, [connectionId])).rows
  if (changed.length) await invalidateBuyerOrders(connectionId, changed.map(r => r.buyer_id))
  return changed.length
}

/** Marks the orders of these buyers for re-attribution. */
export async function invalidateBuyerOrders(connectionId: string, buyerIds: string[]) {
  const result = await db.query(`UPDATE perf_orders o SET attribution_key=NULL FROM perf_buyer_identities i
    WHERE i.buyer_id=ANY($2) AND i.connection_id=o.connection_id AND o.buyer_open_uid=i.open_uid AND o.connection_id=$1 RETURNING o.id`, [connectionId, buyerIds])
  return result.rows.map(r => r.id as string)
}
