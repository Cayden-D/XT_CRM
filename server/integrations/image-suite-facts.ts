import { sourceNames, withoutNames } from './1688-agent.js'

type ProductFacts = {
  title: string
  category?: string | null
  attributes: Record<string, string>
  skus: string[]
  points?: string
  sellerName?: string | null
}

const productAttribute = /^(?:产品名称|品名|产品类别|类别|类型|种类|款式|颜色(?:分类)?|材质|面料|尺寸|规格(?:尺寸)?|大小|长宽高|长度|宽度|高度|厚度|直径|重量|净重|容量|电池容量|续航(?:时间)?|电池(?:类型)?|电压|电流|功率|充电(?:方式|时间|接口)?|接口|转速|吸力|风量|风速|压力|噪音|工作温度|显示(?:方式|语言)?|语言(?:版本)?|功能(?:特点)?|特色(?:功能)?|用途|适用(?:场景|范围|对象|人群|车型|宠物)?|使用(?:场景|方式)?|结构|工艺|表面处理|配件)\d*$/
const metadata = /货号|商品编号|条形码|库存|现货|价格|阶梯价|报价|起批|起订|销量|销售地区|下游平台|跨境(?:出口)?专供|资质|认证|证书|质检|授权|品牌|商标|产地|发货地|原产国|供应商|店铺|厂家/
const currency = /[¥￥$]\s*\d|\d+(?:\.\d+)?\s*(?:元|块钱|美元|人民币)/
const catalogCode = /^(?:货号|商品编号|商品编码|料号|SKU|产品编号)(?:[（(][^）)]*[）)])?$/i
const identity = /品牌|商标|厂商|厂家|工厂|供应商|店铺|制造商|生产企业|经销商/
const fields = /[\n\r；;|｜]+/

function hiddenTerms(facts: ProductFacts) {
  const codeAndIdentity = Object.entries(facts.attributes).flatMap(([key, value]) => {
    if (typeof value !== 'string') return []
    if (catalogCode.test(key.trim())) return (value.match(/[A-Za-z0-9][A-Za-z0-9._-]{1,39}/g) ?? []).filter(term => /[A-Za-z]/.test(term) || term.length >= 5)
    if (/^(?:产地|发货地|原产国)$/.test(key.trim())) return value.trim().length >= 2 ? [value.trim()] : []
    return identity.test(key) ? value.split(/[\/、,，;；|]/).map(term => term.trim()).filter(term => term.length >= 2 && !/^(无品牌|白牌|无|否|其他|其它|通用|默认|自主品牌)$/i.test(term)) : []
  })
  const sellerNames = sourceNames({ seller_name: facts.sellerName, category_path: facts.category, attributes: facts.attributes }, {})
  return [...new Set([...sellerNames, ...codeAndIdentity])].sort((a, b) => b.length - a.length)
}

function cleanText(value: string, names: string[]) {
  const cleaned = value.replace(/[【（(\[][^】）)\]\n]*[】）)\]]/g, section => metadata.test(section) || currency.test(section) ? ' ' : section)
    .split(fields).map(part => part.trim()).filter(part => part && !metadata.test(part) && !currency.test(part))
  return cleaned.map(part => withoutNames(part, names)).filter(Boolean).join('；')
}

/** Only customer-facing product facts can reach the copy or image model. */
export function imageSuiteFacts(facts: ProductFacts) {
  const names = hiddenTerms(facts)
  const attributes: Record<string, string> = {}
  for (const [key, value] of Object.entries(facts.attributes)) {
    const label = key.replace(/\s/g, '')
    if (!productAttribute.test(label) || typeof value !== 'string' || /^\s*(?:是|否|有|无|其它|其他|默认|不详)\s*$/.test(value)) continue
    const text = cleanText(value, names)
    if (text) attributes[label] = text
  }
  const category = facts.category?.split(/[>＞›]/).map(part => cleanText(part, names)).filter(Boolean).join(' › ')
  const title = cleanText(facts.title, names) || attributes.产品名称 || attributes.品名 || category?.split(' › ').at(-1) || '商品'
  return {
    title, category, attributes, skus: [...new Set(facts.skus.map(sku => cleanText(sku, names)).filter(Boolean))],
    points: facts.points && cleanText(facts.points, names),
    acceptsCopy: (text: string) => cleanText(text, names) === text,
  }
}
