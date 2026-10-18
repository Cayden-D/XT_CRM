import { randomUUID } from 'node:crypto'
import { config } from '../config.js'
import { IntegrationError } from './1688.js'
import { imagePreviewClient, requireImageStorage } from './oss-images.js'

const prefix = 'customer-attachments/'
const linkSeconds = 600
export const attachmentLimits = { image: { count: 10, bytes: 2 * 1024 * 1024 }, file: { count: 10, bytes: 1024 * 1024 } } as const

const zip = (b: Buffer) => b.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
const text = (b: Buffer) => !b.includes(0)
/** Allowed types with their extension and a content check, so a renamed executable cannot pose as a document. */
export const attachmentTypes: Record<string, { kind: 'image' | 'file'; ext: string; check: (b: Buffer) => boolean }> = {
  'image/jpeg': { kind: 'image', ext: 'jpg', check: b => b[0] === 0xff && b[1] === 0xd8 },
  'image/png': { kind: 'image', ext: 'png', check: b => b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) },
  'image/gif': { kind: 'image', ext: 'gif', check: b => /^GIF8[79]a$/.test(b.subarray(0, 6).toString('latin1')) },
  'image/webp': { kind: 'image', ext: 'webp', check: b => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
  'application/pdf': { kind: 'file', ext: 'pdf', check: b => b.subarray(0, 5).toString('latin1') === '%PDF-' },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': { kind: 'file', ext: 'docx', check: zip },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': { kind: 'file', ext: 'xlsx', check: zip },
  'text/plain': { kind: 'file', ext: 'txt', check: text },
  'text/csv': { kind: 'file', ext: 'csv', check: text },
}

function attachmentKey(key: string, tenantId: string) {
  if (!new RegExp(`^${prefix}${tenantId}/[a-f0-9-]{36}/[a-f0-9-]{36}\\.[a-z]{3,4}$`).test(key)) throw new IntegrationError('OSS_ATTACHMENT_KEY', '附件存储标识无效。', 400)
  return key
}

export async function putAttachment(tenantId: string, buyerId: string, mime: string, bytes: Buffer) {
  const type = attachmentTypes[mime]
  const key = `${prefix}${tenantId}/${buyerId}/${randomUUID()}.${type.ext}`
  try {
    await requireImageStorage().put(key, bytes, { mime, headers: { 'x-oss-object-acl': 'private', 'x-oss-forbid-overwrite': 'true', 'Cache-Control': 'private, max-age=600' } })
  } catch (error) {
    if (error instanceof IntegrationError) throw error
    throw new IntegrationError('OSS_ATTACHMENT_UPLOAD', '附件上传到 OSS 失败，请稍后重试。', 502)
  }
  return key
}

/** Short-lived signed link; files download under their original name, images open inline. */
export async function attachmentUrl(key: string, tenantId: string, name: string, kind: 'image' | 'file') {
  const disposition = `${kind === 'image' ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`
  const url = await imagePreviewClient().signatureUrlV4('GET', linkSeconds, { queries: { 'response-content-disposition': disposition } }, attachmentKey(key, tenantId))
  const parsed = new URL(url)
  if (parsed.protocol !== 'https:' || (config.OSS_CUSTOM_DOMAIN && parsed.hostname !== new URL(config.OSS_CUSTOM_DOMAIN).hostname)) throw new IntegrationError('OSS_ATTACHMENT_URL', 'OSS 链接的协议或域名不符合配置。', 502)
  return url
}

export async function removeAttachment(key: string, tenantId: string) {
  await requireImageStorage().delete(attachmentKey(key, tenantId))
}
