import { download, request } from './api'

export type Finding = { readable:boolean; watermark:boolean; rightsRisk:boolean; reason:string }
export type SuiteType = 'suite_white'|'suite_scene'|'suite_detail'|'suite_model'|'suite_selling'|'suite_spec'
export type ImageOperation = 'upload'|'white_bg'|'background'|'resize'|SuiteType
export type ImageAsset = {
  id:string; collected_product_id:string|null; batch_id:string|null; operation:ImageOperation; label:string; provider:'local'|'qwen'|'apimart'; model:string|null
  source_url:string|null; replaces_index:number|null; options:Record<string,unknown>; status:'pending'|'processing'|'completed'|'failed'; width:number|null; height:number|null
  findings:Finding|null; error:string|null; cost:string|null; trigger:'manual'|'agent'; created_at:string; url:string|null; risky:boolean; product_title?:string|null
  photo_status:'uploading'|'uploaded'|'unknown'|null; photo_url:string|null; photo_connection_id:string|null; photo_album_id:string|null
  applied_to:{ collectedProductId:string; index:number; placement:'replace'|'append'; previousUrl:string|null; productId:string|null }|null; applied_at:string|null
}
export type AlbumShop = { id:string; display_name:string; status:string; album_id:string|null }
export type ImageSettings = { auto_replace:boolean; suite_model:'gpt-image-2.5-flare'|'gpt-image-2.5-sunburst'; suite_quality:'low'|'medium'|'high'|'xhigh'; enabled_at:string|null; revision:number }
export type ImageServices = { qwen:boolean; apimart:boolean; oss:boolean }
export type ProductImage = { url:string; finding:Finding|null }
export type ProductImages = { gallery:ProductImage[]; details:ProductImage[]; screenedAt:string|null; assets:ImageAsset[] }
export type ImageSource = { url:string }|{ assetId:string }

export const suiteTypes:[SuiteType,string,string][] = [
  ['suite_white','白底图','纯白背景、居中完整，平台主图首选'],
  ['suite_scene','场景氛围图','放进真实使用环境，突出质感'],
  ['suite_detail','细节图','微距展示做工、材质与结构'],
  ['suite_model','模特场景图','真人使用或展示，直观感受尺寸'],
  ['suite_selling','卖点图','3–4 条卖点文字配图标'],
  ['suite_spec','规格尺寸图','尺寸标注与参数表（只用已知参数）'],
]
export const resizePresets = [['800x800','800×800 · 1688 主图'],['750x1000','750×1000 · 3:4 主图'],['790x1000','790×1000 · 详情页宽度'],['1000x1000','1000×1000'],['1080x1080','1080×1080 · 社媒'],['1200x1200','1200×1200']] as const
export const flagged = (f:Finding|null|undefined) => Boolean(f && (!f.readable || f.watermark || f.rightsRisk))

const base = '/api/image-workshop'
const json = (method:string, body:unknown) => ({ method, body:JSON.stringify(body) })
export const getImageSettings = () => request<{data:ImageSettings;services:ImageServices}>(`${base}/settings`)
export const saveImageSettings = (input:{autoReplace:boolean;suiteModel:string;suiteQuality:string;revision:number;confirmed?:boolean}) => request<{data:ImageSettings}>(`${base}/settings`, json('PUT', input))
export const getProductImages = (id:string) => request<{data:ProductImages}>(`${base}/products/${id}`)
export const screenProductImages = (id:string, details=false) => request<{data:ProductImage[]}>(`${base}/products/${id}/screen`, json('POST', { details }))
export const replaceFlagged = (id:string) => request<{data:{flagged:number;queued:number;clean:number;message:string}}>(`${base}/products/${id}/replace-flagged`, json('POST', {}))
export const uploadImage = (content:string, collectedProductId?:string) => request<{data:ImageAsset}>(`${base}/uploads`, json('POST', { content, collectedProductId }))
export const createEdit = (input:{source:ImageSource;operation:'white_bg'|'background'|'resize';collectedProductId?:string;scene?:string;model?:string;preset?:string;width?:number;height?:number;fit?:'pad'|'crop'}) => request<{data:ImageAsset}>(`${base}/edits`, json('POST', input))
export const createSuite = (input:{collectedProductId?:string;title?:string;points?:string;references:ImageSource[];types:SuiteType[];model?:string;quality?:string;size?:'1:1'|'3:4';resolution?:'1k'|'2k'}) => request<{data:{batchId:string;assets:ImageAsset[]}}>(`${base}/suites`, json('POST', input))
export function getAssets(params:{kind?:'edit'|'suite'|'upload';collectedProductId?:string;batchId?:string;ids?:string[];page?:number;pageSize?:number}) {
  const q = new URLSearchParams()
  Object.entries(params).forEach(([k,v]) => { if (v !== undefined && v !== '') q.set(k, Array.isArray(v) ? v.join(',') : String(v)) })
  return request<{data:ImageAsset[];total:number}>(`${base}/assets?${q}`)
}
export const getAlbums = () => request<{data:AlbumShop[]}>(`${base}/albums`)
export const uploadToAlbum = (id:string, input:{connectionId?:string;albumId?:string}) => request<{data:ImageAsset}>(`${base}/assets/${id}/photo`, json('POST', { ...input, confirmed:true }))
export const applyAsset = (id:string, input:{connectionId?:string;albumId?:string;collectedProductId?:string;placement:'replace'|'append';index?:number}) =>
  request<{data:{asset:ImageAsset;applied:NonNullable<ImageAsset['applied_to']>;queueJob:{id:string;status:string}|null}}>(`${base}/assets/${id}/apply`, json('POST', { ...input, confirmed:true }))
export const revertAsset = (id:string) => request<{data:ImageAsset}>(`${base}/assets/${id}/revert`, json('POST', {}))
export const retryAsset = (id:string) => request<{data:ImageAsset}>(`${base}/assets/${id}/retry`, json('POST', {}))
export const deleteAsset = (id:string) => request<{ok:true}>(`${base}/assets/${id}`, { method:'DELETE' })
export const downloadAsset = (asset:ImageAsset) => download(`${base}/assets/${asset.id}/file`, `${asset.label}-${asset.id.slice(0,8)}.png`)

/** Reads a picked file as base64 (without the data: prefix). */
export const fileToBase64 = (file:File) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader()
  reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
  reader.onerror = () => reject(new Error('文件读取失败。'))
  reader.readAsDataURL(file)
})

/** Opens 图片编辑 / 电商套图 from elsewhere (product detail) with a product or picture preselected. */
export type ImageIntent = { page:'imageEdit'|'imageSuite'; productId?:string; productTitle?:string; sourceUrl?:string; sourceAsset?:{ id:string; url:string; label:string } }
export const OPEN_IMAGE_TOOL = 'crm:image-tool'
export const openImageTool = (intent:ImageIntent) => window.dispatchEvent(new CustomEvent<ImageIntent>(OPEN_IMAGE_TOOL, { detail:intent }))
