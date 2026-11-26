import { z } from 'zod'
import { db } from '../server/db.js'
import { authorizeWorkspaceShops } from '../server/integrations/1688-workspace-shops.js'

try {
  const args = process.argv.slice(2)
  const apply = args.includes('--apply')
  const [workspace, ...aliIds] = args.filter(arg => arg !== '--apply')
  const input = z.object({
    workspace: z.string().min(1).max(80),
    aliIds: z.array(z.string().regex(/^[0-9]{1,30}$/)).min(1),
  }).parse({ workspace, aliIds })
  const result = await authorizeWorkspaceShops(input.workspace, input.aliIds, apply)
  console.table(result.shops)
  console.log('工作区：' + result.workspace + '，超级管理员 1688 ID：' + result.adminAliId)
  console.log(apply ? '授权已保存，请用上述超级管理员的 1688 账号重新登录。' : '仅预览。核对后在同一命令后添加 --apply 保存。')
} catch (error) {
  console.error(error instanceof z.ZodError
    ? '用法：npm run 1688:allow-shops -- <工作区slug> <aliId...> [--apply]'
    : error instanceof Error ? error.message : '店铺授权失败。')
  process.exitCode = 1
} finally { await db.end() }
