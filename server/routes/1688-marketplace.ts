import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { hasPermission, requireAuth } from '../auth.js'
import { config } from '../config.js'
import { IntegrationError, type AppPurpose } from '../integrations/1688.js'
import { marketplaceConnections, syncMarketplace } from '../integrations/1688-marketplace.js'

const purposesFor = (permissions: string[]): AppPurpose[] => [
  ...(hasPermission(permissions, 'integration:read') ? ['product' as const] : []),
  ...(hasPermission(permissions, 'performance:read') || hasPermission(permissions, 'performance:read_own') ? ['performance' as const] : []),
]

export async function marketplaceRoutes(app: FastifyInstance) {
  app.get('/', { preHandler: requireAuth }, async request => ({
    support: { phone: config.MARKETPLACE_SUPPORT_PHONE, wangwang: config.MARKETPLACE_SUPPORT_WANGWANG },
    connections: await marketplaceConnections(request.authUser.tenantId, purposesFor(request.authUser.permissions)),
  }))
  app.post('/:purpose/:id/sync', { preHandler: requireAuth }, async (request, reply) => {
    const { purpose, id } = z.object({ purpose: z.enum(['product', 'performance']), id: z.string().uuid() }).parse(request.params)
    if (!purposesFor(request.authUser.permissions).includes(purpose)) return reply.code(403).send({ message: '当前账号没有查看此应用服务期的权限。' })
    const { refresh } = z.object({ refresh: z.boolean().default(false) }).parse(request.body || {})
    try { return { data: await syncMarketplace(request.authUser.tenantId, request.authUser.sub, purpose, id, request.id, refresh) } }
    catch (error) { if (error instanceof IntegrationError) return reply.code(error.statusCode).send({ error: error.code, message: error.message }); throw error }
  })
}
