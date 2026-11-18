import { config } from '../config.js'
import { IntegrationError } from '../integrations/1688.js'

/**
 * APIMart GPT-Image-2.5 and GPT-Image-2 (docs: /v1/images/generations + /v1/tasks/:id). Generation is asynchronous:
 * submit returns a task id, the task is polled every few seconds, and the result URL is temporary, so callers download
 * and store it. GPT-Image-2 takes no quality or output format, at most 15 reference pictures, and resolution 1k/2k/4k.
 */
export const IMAGE_MODELS = ['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst', 'gpt-image-2'] as const
export type ImageModelId = typeof IMAGE_MODELS[number]
export type ImageOutputSettings = { quality: 'low' | 'medium' | 'high' | 'xhigh'; resolution: '1k' | '2k' }
export const IMAGE_OUTPUT_DEFAULTS = { resolution: '1k', quality: 'medium' } as const
export type ImageTask = { status: 'submitted' | 'processing' | 'completed' | 'failed'; url?: string; cost?: number; error?: string }

export const apimartConfigured = () => Boolean(config.APIMART_API_KEY)

async function call(path: string, init: RequestInit = {}) {
  if (!config.APIMART_API_KEY) throw new IntegrationError('APIMART_NOT_CONFIGURED', '图片生成服务暂不可用，请联系管理员。', 503)
  let response: Response
  try {
    response = await fetch(`${config.APIMART_BASE_URL.replace(/\/$/, '')}${path}`, { ...init, headers: { Authorization: `Bearer ${config.APIMART_API_KEY}`, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(60_000) })
  } catch { throw new IntegrationError('APIMART_NETWORK', '图片生成服务暂时无法连接，请稍后重试。', 502) }
  const body = await response.json().catch(() => null) as { code?: number; data?: unknown } | null
  if (!response.ok || (body?.code != null && body.code !== 200)) {
    const status = response.ok ? Number(body?.code) || 502 : response.status
    if (status === 401) throw new IntegrationError('APIMART_AUTH', '图片生成服务暂不可用，请联系管理员。', 502)
    if (status === 402) throw new IntegrationError('APIMART_BALANCE', '图片生成服务额度不足，请联系管理员。', 402)
    if (status === 429) throw new IntegrationError('APIMART_RATE_LIMIT', '图片生成服务繁忙，请稍后重试。', 429)
    if (status === 400) throw new IntegrationError('APIMART_INVALID', '图片生成请求未通过，请检查参考图及内容后重试。', 400)
    throw new IntegrationError('APIMART_FAILED', '图片生成服务暂时异常，请稍后重试。', 502)
  }
  return body?.data
}

export async function submitImageTask(input: { model: ImageModelId; prompt: string; imageUrls: string[]; size: string } & ImageOutputSettings) {
  const v2 = input.model === 'gpt-image-2'
  const data = await call('/images/generations', { method: 'POST', body: JSON.stringify({
    model: input.model, prompt: input.prompt, size: input.size, resolution: input.resolution, n: 1,
    ...(v2 ? {} : { quality: input.quality, output_format: 'png' }),
    ...(input.imageUrls.length ? { image_urls: input.imageUrls.slice(0, v2 ? 15 : 16) } : {}),
  }) }) as Array<{ task_id?: unknown }> | undefined
  const taskId = Array.isArray(data) ? data[0]?.task_id : undefined
  if (typeof taskId !== 'string' || !/^[\w-]{4,120}$/.test(taskId)) throw new IntegrationError('APIMART_RESPONSE', '图片生成服务未确认接收任务，请稍后重试。', 502)
  return taskId
}

export async function getImageTask(taskId: string): Promise<ImageTask> {
  const data = await call(`/tasks/${encodeURIComponent(taskId)}`) as { status?: string; cost?: number; result?: { images?: Array<{ url?: string[] | string }> } } | undefined
  const status = data?.status
  if (status === 'completed') {
    const raw = data?.result?.images?.[0]?.url
    const url = Array.isArray(raw) ? raw[0] : raw
    if (typeof url !== 'string') throw new IntegrationError('APIMART_RESPONSE', '图片生成任务未返回图片，请重试。', 502)
    return { status, url, cost: typeof data?.cost === 'number' ? data.cost : undefined }
  }
  if (status === 'failed') return { status, error: '图片生成未完成，请检查参考图及内容后重试。' }
  return { status: status === 'processing' ? 'processing' : 'submitted' }
}

/** Result links are third-party and temporary: only plain HTTPS hosts, never local or private addresses. */
export function resultUrl(raw: string) {
  const url = new URL(raw)
  if (url.protocol !== 'https:' || url.username || url.password || url.port || raw.length > 4096
    || /^(localhost|\d+\.\d+\.\d+\.\d+|\[.*\])$/i.test(url.hostname) || !url.hostname.includes('.')) throw new IntegrationError('INVALID_IMAGE_URL', '生成图片的链接无效，请重新生成。', 502)
  return url.href
}

/**
 * Submits one picture and waits for it (polling every few seconds), for screens where a person waits for the result.
 * Returns the temporary result URL.
 */
export async function generateAndWait(input: { model: ImageModelId; prompt: string; imageUrls: string[]; size?: string; output?: ImageOutputSettings }, timeoutMs = 5 * 60_000, pollMs = Number(process.env.APIMART_POLL_MS ?? 4000)) {
  const taskId = await submitImageTask({ model: input.model, prompt: input.prompt, imageUrls: input.imageUrls, size: input.size ?? '1:1', ...(input.output ?? IMAGE_OUTPUT_DEFAULTS) })
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    await new Promise(resolve => setTimeout(resolve, pollMs))
    const task = await getImageTask(taskId)
    if (task.status === 'completed') return resultUrl(task.url!)
    if (task.status === 'failed') throw new IntegrationError('APIMART_FAILED', task.error ?? '图片生成失败，请重试。', 502)
  }
  throw new IntegrationError('IMAGE_MODEL_TIMEOUT', '图片生成超过 5 分钟仍未完成，请稍后重试。', 504)
}
