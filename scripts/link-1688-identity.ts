import { z } from 'zod'
import { db } from '../server/db.js'
import { appCredentials } from '../server/integrations/1688.js'
import { lock1688Identity } from '../server/integrations/1688-sign-in.js'

// Deployment operator only: the platform ID and the existing workspace membership must have been verified.
try {
  const { appKey } = appCredentials('performance')
  const [userId, aliId] = z.tuple([z.uuid(), z.string().trim().min(1).max(255)]).parse(process.argv.slice(2))
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    await lock1688Identity(client, appKey, aliId)
    const user = (await client.query('SELECT tenant_id FROM users WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [userId])).rows[0]
    if (!user) throw new Error('找不到指定的历史成员。')
    const shop = (await client.query('SELECT tenant_id FROM integration_1688_perf_connections WHERE app_key=$1 AND ali_id=$2 FOR UPDATE', [appKey, aliId])).rows[0]
    if (shop && shop.tenant_id !== user.tenant_id) throw new Error('该 1688 账号的店铺连接属于另一个工作区。')
    await client.query('INSERT INTO auth_1688_identities(app_key,ali_id,user_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [appKey, aliId, userId])
    const { rowCount } = await client.query('SELECT 1 FROM auth_1688_identities WHERE app_key=$1 AND ali_id=$2 AND user_id=$3', [appKey, aliId, userId])
    if (!rowCount) throw new Error('该平台身份或历史成员已有其他绑定，未修改数据。')
    await client.query('COMMIT')
    console.log('已绑定 1688 登录身份，保留历史成员和权限。')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally { client.release() }
} catch (error) {
  console.error(error instanceof z.ZodError ? '用法：npm run 1688:link-identity -- <历史用户 UUID> <已核实的 1688 aliId>' : error instanceof Error ? error.message : '绑定失败。')
  process.exitCode = 1
} finally { await db.end() }
