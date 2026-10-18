import { buildApp } from './app.js'
import { config } from './config.js'
import { db } from './db.js'
import { startCollectionQueue } from './integrations/1688-collection-queue.js'
import { startPerformanceSync } from './integrations/1688-performance-sync.js'
import { startImageWorker } from './integrations/image-workshop.js'

const app = await buildApp()
let stopCollectionQueue:()=>Promise<void>=async()=>{}
let stopPerformanceSync:()=>Promise<void>=async()=>{}
let stopImageWorker:()=>Promise<void>=async()=>{}

async function shutdown(signal: string) {
  app.log.info({ signal }, 'Shutting down')
  await stopCollectionQueue()
  await stopPerformanceSync()
  await stopImageWorker()
  await app.close()
  await db.end()
  process.exit(0)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))

try {
  await app.listen({ host: config.API_HOST, port: config.API_PORT })
  stopCollectionQueue=startCollectionQueue(error=>app.log.error({err:error},'1688 collection queue tick failed'))
  stopPerformanceSync=startPerformanceSync(error=>app.log.error({err:error},'1688 performance sync tick failed'))
  stopImageWorker=startImageWorker(error=>app.log.error({err:error},'image worker tick failed'))
} catch (error) {
  app.log.error(error)
  await db.end()
  process.exit(1)
}
