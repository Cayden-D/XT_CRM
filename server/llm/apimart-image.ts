import { config } from '../config.js'
import { IntegrationError } from '../integrations/1688.js'

/**
 * APIMart GPT-Image-2.5 and GPT-Image-2 (docs: /v1/images/generations + /v1/tasks/:id). Generation is asynchronous:
 * submit returns a task id, the task is polled every few seconds, and the result URL is temporary, so callers download
 * and store it. GPT-Image-2 takes no quality or output format, at most 15 reference pictures, and resolution 1k/2k/4k.
 */
export const IMAGE_MODELS = ['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst', 'gpt-image-2'] as const
export type ImageModelId = typeof IMAGE_MODELS[number]
export const IMAGE_MODEL_NAMES: Record<ImageModelId, string> = { 'gpt-image-2.5-flare': 'GPT-Image-2.5 Flare', 'gpt-image-2.5-sunburst': 'GPT-Image-2.5 Sunburst', 'gpt-image-2': 'GPT-Image-2' }
/** Kept for stored settings and older callers: every image model can make suites. */
export const SUITE_MODELS = IMAGE_MODELS
export const SUITE_QUALITIES = ['low', 'medium', 'high', 'xhigh'] as const
export type SuiteModel = ImageModelId
export type SuiteQuality = typeof SUITE_QUALITIES[number]
export type ImageTask = { status: 'submitted' | 'processing' | 'completed' | 'failed'; url?: string; cost?: number; error?: string }

export const apimartConfigured = () => Boolean(config.APIMART_API_KEY)

async function call(path: string, init: RequestInit = {}) {
  if (!config.APIMART_API_KEY) throw new IntegrationError('APIMART_NOT_CONFIGURED', '请先在服务器配置 APIMART_API_KEY（图片生成与编辑使用 GPT-Image）。', 503)
  let response: Response
  try {
    response = await fetch(`${config.APIMART_BASE_URL.replace(/\/$/, '')}${path}`, { ...init, headers: { Authorization: `Bearer ${config.APIMART_API_KEY}`, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(60_000) })
  } catch { throw new IntegrationError('APIMART_NETWORK', 'APIMart 图像服务暂时无法连接。', 502) }
  const body = await response.json().catch(() => null) as { code?: number; data?: unknown; error?: { message?: string; type?: string } } | null
  if (!response.ok || (body?.code != null && body.code !== 200)) {
    const status = response.ok ? Number(body?.code) || 502 : response.status
    const detail = typeof body?.error?.message === 'string' ? body.error.message.slice(0, 200) : ''
    if (status === 401) throw new IntegrationError('APIMART_AUTH', 'APIMart 密钥无效，请检查 APIMART_API_KEY。', 502)
    if (status === 402) throw new IntegrationError('APIMART_BALANCE', 'APIMart 账户余额不足，请充值后重试。', 402)
    if (status === 429) throw new IntegrationError('APIMART_RATE_LIMIT', 'APIMart 请求过于频繁，稍后自动重试。', 429)
    if (status === 400) throw new IntegrationError('APIMART_INVALID', `APIMart 拒绝了请求${detail ? `：${detail}` : ''}。`, 400)
    throw new IntegrationError('APIMART_FAILED', `APIMart 返回 HTTP ${status}${detail ? `：${detail}` : ''}。`, 502)
  }
  return body?.data
}

export async function submitImageTask(input: { model: SuiteModel; prompt: string; imageUrls: string[]; size: string; resolution: '1k' | '2k'; quality: SuiteQuality }) {
  const v2 = input.model === 'gpt-image-2'
  const data = await call('/images/generations', { method: 'POST', body: JSON.stringify({
    model: input.model, prompt: input.prompt, size: input.size, resolution: input.resolution, n: 1,
    ...(v2 ? {} : { quality: input.quality, output_format: 'png' }),
    ...(input.imageUrls.length ? { image_urls: input.imageUrls.slice(0, v2 ? 15 : 16) } : {}),
  }) }) as Array<{ task_id?: unknown }> | undefined
  const taskId = Array.isArray(data) ? data[0]?.task_id : undefined
  if (typeof taskId !== 'string' || !/^[\w-]{4,120}$/.test(taskId)) throw new IntegrationError('APIMART_RESPONSE', 'APIMart 没有返回任务编号。', 502)
  return taskId
}

export async function getImageTask(taskId: string): Promise<ImageTask> {
  const data = await call(`/tasks/${encodeURIComponent(taskId)}`) as { status?: string; cost?: number; error?: { message?: string } | string; result?: { images?: Array<{ url?: string[] | string }> } } | undefined
  const status = data?.status
  if (status === 'completed') {
    const raw = data?.result?.images?.[0]?.url
    const url = Array.isArray(raw) ? raw[0] : raw
    if (typeof url !== 'string') throw new IntegrationError('APIMART_RESPONSE', 'APIMart 任务完成但没有返回图片。', 502)
    return { status, url, cost: typeof data?.cost === 'number' ? data.cost : undefined }
  }
  if (status === 'failed') return { status, error: (typeof data?.error === 'string' ? data.error : data?.error?.message)?.slice(0, 300) || '生成失败（费用已由平台退回）。' }
  return { status: status === 'processing' ? 'processing' : 'submitted' }
}

/** Result links are third-party and temporary: only plain HTTPS hosts, never local or private addresses. */
export function resultUrl(raw: string) {
  const url = new URL(raw)
  if (url.protocol !== 'https:' || url.username || url.password || url.port || raw.length > 4096
    || /^(localhost|\d+\.\d+\.\d+\.\d+|\[.*\])$/i.test(url.hostname) || !url.hostname.includes('.')) throw new IntegrationError('INVALID_IMAGE_URL', 'APIMart 返回的图片地址不安全。', 502)
  return url.href
}

/**
 * Submits one picture and waits for it (polling every few seconds), for screens where a person waits for the result.
 * Returns the temporary result URL.
 */
export async function generateAndWait(input: { model: ImageModelId; prompt: string; imageUrls: string[]; size?: string }, timeoutMs = 5 * 60_000, pollMs = Number(process.env.APIMART_POLL_MS ?? 4000)) {
  const taskId = await submitImageTask({ model: input.model, prompt: input.prompt, imageUrls: input.imageUrls, size: input.size ?? '1:1', resolution: '1k', quality: 'medium' })
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    await new Promise(resolve => setTimeout(resolve, pollMs))
    const task = await getImageTask(taskId)
    if (task.status === 'completed') return resultUrl(task.url!)
    if (task.status === 'failed') throw new IntegrationError('APIMART_FAILED', `生成失败：${task.error}`, 502)
  }
  throw new IntegrationError('IMAGE_MODEL_TIMEOUT', '图片生成超过 5 分钟仍未完成，请稍后重试。', 504)
}
