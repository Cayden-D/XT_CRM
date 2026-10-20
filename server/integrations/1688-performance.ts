import { db } from '../db.js'
import { appCredentials, connectionToken, gateway, IntegrationError, recordOperation, signApi } from './1688.js'

// Read-only interfaces from the performance solution document, keyed to their namespace.
// Keyword writes back the 关键词库 feature.
const performanceApis: Record<string, string> = {
  'alibaba.account.basic': 'com.alibaba.account',
  'alibaba.subAccount.list': 'com.alibaba.account',
  'wangwang.chat.relation.query': 'com.alibaba.wangwang',
  'chat.msg.query': 'com.alibaba.wangwang',
  'wangwang.keyword.query.list': 'com.alibaba.wangwang',
  'wangwang.keyword.add': 'com.alibaba.wangwang',
  'wangwang.keyword.delete': 'com.alibaba.wangwang',
  'alibaba.trade.ec.getOrderList.sellerView': 'com.alibaba.trade',
  'alibaba.trade.ec.getOrder.sellerView': 'com.alibaba.trade',
  'alibaba.trade.refund.queryOrderRefundList': 'com.alibaba.trade',
  'alibaba.trade.refund.OpQueryOrderRefund.sellerView': 'com.alibaba.trade',
  'alibaba.trade.refund.OpQueryBatchRefundByOrderIdAndStatus.sellerView': 'com.alibaba.trade',
  'alibaba.product.get': 'com.alibaba.product',
  'alibaba.category.get': 'com.alibaba.product',
  // Risk-controlled, one buyer at a time and only on a person's click: decrypt to open a Wangwang chat (the nickname is
  // never shown or stored), encrypt a loginId the merchant typed to find that buyer.
  'wangwangnick.openuid.decrypt': 'com.alibaba.account',
  'loginid.openuid.encrypt': 'com.alibaba.account',
}

async function invoke(id: string, tenantId: string, actorId: string | null, name: string, input: Record<string, unknown>, requestId?: string) {
  const namespace = performanceApis[name]
  if (!namespace) throw new IntegrationError('API_NOT_SUPPORTED', '该绩效接口尚未接入。', 400)
  const started = Date.now()
  try {
    const { connection, grant } = await connectionToken(id, tenantId, actorId, false, 'performance')
    const credentials = appCredentials('performance')
    const path = `param2/1/${namespace}/${name}/${credentials.appKey}`
    const params: Record<string, string> = { access_token: grant.access_token, _aop_timestamp: String(Date.now()) }
    for (const [key, value] of Object.entries(input)) if (value !== undefined && value !== null) {
      params[key] = typeof value === 'object' ? JSON.stringify(value) : String(value)
    }
    const result = await gateway(path, { ...params, _aop_signature: signApi(path, params, credentials.secret) })
    await recordOperation(tenantId, id, actorId, name, started, undefined, requestId, 'performance')
    return { connection, result }
  } catch (error) {
    await recordOperation(tenantId, id, actorId, name, started, error, requestId, 'performance')
    throw error
  }
}

export async function callPerformanceApi(id: string, tenantId: string, actorId: string | null, name: string, input: Record<string, unknown> = {}, requestId?: string) {
  return (await invoke(id, tenantId, actorId, name, input, requestId)).result
}

const unwrap = (response: Record<string, unknown>) =>
  (response.result && typeof response.result === 'object' && !Array.isArray(response.result) ? response.result : response) as Record<string, unknown>

// Sub-account lists and chat records are only complete for a main-account grant.
export function accountRole(connection: { ali_id: string; login_id?: string | null }, mainUserId: string, mainLoginId: string) {
  if ((mainUserId && mainUserId === connection.ali_id) || (mainLoginId && mainLoginId === connection.login_id)) return 'main'
  if (connection.login_id?.includes(':') || (mainUserId && mainUserId !== connection.ali_id && mainLoginId && connection.login_id && mainLoginId !== connection.login_id)) return 'sub'
  return 'unknown'
}

export async function testPerformanceConnection(id: string, tenantId: string, actorId: string, requestId?: string) {
  try {
    const profile = unwrap((await invoke(id, tenantId, actorId, 'alibaba.account.basic', {}, requestId)).result)
    const name = typeof profile.companyName === 'string' && profile.companyName ? profile.companyName : null
    const { connection, result } = await invoke(id, tenantId, actorId, 'alibaba.subAccount.list', {}, requestId)
    const accounts = unwrap(result)
    const mainUserId = accounts.mainUserId == null ? '' : String(accounts.mainUserId)
    const mainLoginId = typeof accounts.mainLoginId === 'string' ? accounts.mainLoginId : ''
    if (!mainUserId && !mainLoginId) throw new IntegrationError('EMPTY_ACCOUNTS', '接口未返回主账号信息。')
    const role = accountRole(connection as { ali_id: string; login_id?: string | null }, mainUserId, mainLoginId)
    const subAccountCount = Array.isArray(accounts.subAccountList) ? accounts.subAccountList.length : 0
    await db.query(`UPDATE integration_1688_perf_connections SET display_name=coalesce($3,display_name),member_capability='available',account_role=$4,
      main_login_id=nullif($5,''),sub_account_count=$6,last_tested_at=now(),updated_at=now() WHERE id=$1 AND tenant_id=$2`,
    [id, tenantId, name, role, mainLoginId, role === 'main' ? subAccountCount : null])
    if (role === 'sub') throw new IntegrationError('SUB_ACCOUNT_GRANT', '当前授权的是子账号，客服绩效需要使用主账号重新授权。', 409)
    return { verified: true, accountRole: role, subAccountCount: role === 'main' ? subAccountCount : null }
  } catch (error) {
    const permissionDenied = error instanceof IntegrationError && /permission|unauthor|accessdenied|^401$|^403$/i.test(error.code)
    await db.query("UPDATE integration_1688_perf_connections SET member_capability=CASE WHEN $3 THEN 'unavailable' ELSE member_capability END,last_tested_at=now() WHERE id=$1 AND tenant_id=$2", [id, tenantId, permissionDenied])
    throw error
  }
}
