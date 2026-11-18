import { db } from '../db.js'
import { IMAGE_OUTPUT_DEFAULTS, type ImageModelId, type ImageOutputSettings } from '../llm/apimart-image.js'

export const imagePlans = {
  'image-a': { model: 'gpt-image-2.5-flare', label: '图像方案 A' },
  'image-b': { model: 'gpt-image-2.5-sunburst', label: '图像方案 B' },
  'image-c': { model: 'gpt-image-2', label: '图像方案 C（自动质量）' },
} as const satisfies Record<string, { model: ImageModelId; label: string }>
export type ImagePlan = keyof typeof imagePlans
export const imagePlanOf = (model: ImageModelId): ImagePlan =>
  (Object.keys(imagePlans) as ImagePlan[]).find(id => imagePlans[id].model === model) ?? 'image-a'
export const imagePlanOptions = Object.entries(imagePlans).map(([id, { label }]) => ({ id, label }))

type Settings = ImageOutputSettings & { model: ImageModelId; revision: number }

export async function imageGenerationSettings(tenantId: string): Promise<Settings> {
  return (await db.query<Settings>(`
    SELECT suite_model AS model, suite_quality AS quality, suite_resolution AS resolution, revision
    FROM image_workshop_settings WHERE tenant_id=$1`, [tenantId])).rows[0]
    ?? { model: imagePlans['image-a'].model, ...IMAGE_OUTPUT_DEFAULTS, revision: 0 }
}
