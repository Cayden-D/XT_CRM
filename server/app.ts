import { ZodError } from 'zod'
import Fastify from 'fastify'
import type { FastifyError } from 'fastify'
import { randomUUID } from 'node:crypto'
import cors from '@fastify/cors'
import jwt from '@fastify/jwt'
import { config } from './config.js'
import { checkDatabase } from './db.js'
import { authRoutes } from './routes/auth.js'
import { userRoutes } from './routes/users.js'
import { accountRoutes } from './routes/accounts.js'
import { productRoutes } from './routes/products.js'
import { productAttributeRoutes } from './routes/product-attributes.js'
import { productCatalogRoutes } from './routes/product-catalog.js'
import { productCollectionRoutes } from './routes/product-collections.js'
import { aiRoutes } from './routes/ai.js'
import { integration1688Routes } from './routes/1688.js'
import { performanceRoutes } from './routes/1688-performance.js'
import { performanceAnalysisRoutes } from './routes/1688-performance-analysis.js'
import { performanceKeywordRoutes } from './routes/1688-performance-keywords.js'
import { performancePayrollRoutes } from './routes/1688-performance-payroll.js'
import { customerOpsRoutes } from './routes/customer-ops.js'
import { dashboardRoutes } from './routes/dashboard.js'
import { imageWorkshopRoutes } from './routes/image-workshop.js'
import { chatInquiryRoutes } from './routes/1688-chat-inquiry.js'
import { inquiryReviewRoutes } from './routes/inquiry-review.js'
import { orderListRoutes } from './routes/1688-order-list.js'

export async function buildApp() {
  const app = Fastify({
    logger: { level: config.NODE_ENV === 'production' ? 'info' : 'warn' },
    requestIdHeader: 'x-request-id',
    genReqId: () => randomUUID(),
  })
  await app.register(cors, {
    origin: config.CORS_ORIGIN,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id', 'X-Collector-Key'],
    // Lets the browser read the server-chosen file name of CSV exports.
    exposedHeaders: ['Content-Disposition'],
  })
  await app.register(jwt, { secret: config.JWT_SECRET })

  app.setErrorHandler((error, request, reply) => {
    const apiError = error as FastifyError
    request.log.error(apiError)
    if (reply.sent) return
    // Request validation (zod) is the caller's mistake, not a server failure.
    if (error instanceof ZodError) {
      const issue = error.issues[0]
      return reply.code(400).send({ error: 'VALIDATION_ERROR', message: issue?.code === 'custom' ? issue.message : `请求参数不正确${issue?.path.length ? `（${issue.path.join('.')}）` : ''}。` })
    }
    const clientError = Boolean(apiError.statusCode && apiError.statusCode < 500)
    reply.code(clientError ? apiError.statusCode! : 500).send({
      error: clientError ? 'REQUEST_ERROR' : 'INTERNAL_SERVER_ERROR',
      message: clientError ? apiError.message : '服务器处理请求时发生错误。',
    })
  })

  app.get('/api/health', async () => {
    const database = await checkDatabase()
    return { status: 'ok', service: 'ai-crm-api', database: database.database, time: database.now }
  })
  await app.register(authRoutes, { prefix: '/api/auth' })
  await app.register(userRoutes, { prefix: '/api/users' })
  await app.register(accountRoutes, { prefix: '/api/accounts' })
  await app.register(productRoutes, { prefix: '/api/products' })
  await app.register(productAttributeRoutes, { prefix: '/api/products' })
  await app.register(productCatalogRoutes, { prefix: '/api/products' })
  await app.register(productCollectionRoutes, { prefix: '/api/product-collections' })
  await app.register(aiRoutes, { prefix: '/api/ai' })
  await app.register(integration1688Routes, { prefix: '/api/integrations/1688' })
  await app.register(performanceRoutes, { prefix: '/api/integrations/1688/performance' })
  await app.register(performanceAnalysisRoutes, { prefix: '/api/integrations/1688/performance' })
  await app.register(performanceKeywordRoutes, { prefix: '/api/integrations/1688/performance' })
  await app.register(chatInquiryRoutes, { prefix: '/api/integrations/1688/performance' })
  await app.register(inquiryReviewRoutes, { prefix: '/api/integrations/1688/performance' })
  await app.register(orderListRoutes, { prefix: '/api/integrations/1688/performance' })
  await app.register(performancePayrollRoutes, { prefix: '/api/integrations/1688/performance' })
  await app.register(customerOpsRoutes, { prefix: '/api/customer-ops' })
  await app.register(dashboardRoutes, { prefix: '/api/dashboard' })
  await app.register(imageWorkshopRoutes, { prefix: '/api/image-workshop' })

  return app
}
