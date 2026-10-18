/**
 * Agent-side chat text (the platform masks buyer text). Only what this module returns is stored: contact details are
 * replaced before saving, and the flags drive the off-platform trading alerts and reply-quality metrics.
 *
 * Off-platform trading flags (1688 penalises moving buyers to other channels):
 *   phone          a mainland mobile number
 *   wechat         a WeChat id next to 微信/VX/V信…, or an invitation to add WeChat
 *   qq             a QQ number next to QQ/扣扣/企鹅
 *   offsite        wording about paying or trading outside the platform
 *   external_link  a link outside 1688/Taobao/Tmall/Alibaba CDN
 * Quality flags: curt (clearly dismissive wording), short (≤ 3 characters of real text), image (a picture or card was sent).
 * Info flag: address — a phone number sent together with an address (return / pickup address); not an off-platform risk.
 * The analysis also works on already-masked text, so stored messages can be re-classified after a rule change.
 */
export const OFFSITE_FLAGS = ['phone', 'wechat', 'qq', 'offsite', 'external_link'] as const
export type ChatFlag = typeof OFFSITE_FLAGS[number] | 'curt' | 'short' | 'image' | 'address'

const PHONE = /(?<![0-9])1[3-9][0-9](?:[\s-]?[0-9]){8}(?![0-9])/g
const MASKED_PHONE = /1\*{10}/
// Return / pickup addresses: a phone number next to these is address information, not an invitation to trade elsewhere.
const ADDRESS = /[省市区县镇]|街道|[路街巷]\d|\d+号|号楼|大厦|园区|仓库|电梯|收件人|收货人|退货|寄回|寄到|地址/
const WECHAT_ID = /(?:微\s*信|威\s*信|薇\s*信|徽\s*信|weixin|wei\s*xin|v\s*x|v\s*信|wx|vx号|微信号|v号)\s*[:：号是为]?\s*([a-zA-Z][-_a-zA-Z0-9]{5,19})/gi
const MASKED_ID = /(微\s*信|威\s*信|薇\s*信|weixin|v\s*x|v\s*信|wx|qq|扣扣|企鹅)\s*[:：号是为]?\s*\*{6}/i
const WECHAT_INVITE = /(加|添加|加个|加下|加一下|扫码加?|私信|发你|给你)[^，。！？,.!?]{0,4}(微信|威信|薇信|vx|v信|wx|v\b)|微信(联系|沟通|聊|发你|发图|号)|(微信|威信|薇信|vx|v信|wx|wei\s*xin)\s*同(号|手机)/i
const QQ = /(?:qq|扣扣|企鹅)\s*[:：号是为]?\s*([1-9][0-9]{4,10})/gi
const OFFSITE = /私下(交易|付|转)|线下(交易|付款|转账)|(微信|支付宝|银行卡|对公)\s*(转账|付款|打款|收款)|直接转(账|给我)|不走平台|别(在|走)平台|绕过平台|平台外/
const LINK = /https?:\/\/[^\s，。]+/gi
const PLATFORM_HOST = /(^|\.)(1688\.com|alicdn\.com|taobao\.com|tmall\.com|alibaba\.com|aliyuncs\.com|tbcdn\.cn|alipay\.com)$/i
const IMAGE_URL = /^\s*https?:\/\/[^\s]+\.(jpe?g|png|gif|webp)(\?[^\s]*)?\s*$/i
// Only clearly dismissive wording: "不清楚 / 说了" are mostly polite in real chats ("这个不清楚呢亲", "已经和快递说了").
const CURT = /听不(明白|懂)|看不懂吗|你自己(看|找|选)|说了多少遍|都说了|不是说了吗|没有就是没有|爱买不买|随便你|别问了|问那么多|烦不烦/

const mask = (text: string) => text
  .replace(PHONE, '1**********')
  .replace(WECHAT_ID, (m, id: string) => m.replace(id, '******'))
  .replace(QQ, (m, id: string) => m.replace(id, '******'))
  .replace(/[0-9]{6,}/g, '######')

export function analyzeAgentText(content: unknown, messageTypes: string[]) {
  const raw = typeof content === 'string' ? content.trim() : ''
  const flags = new Set<ChatFlag>()
  // "其他消息" carries no text (pictures, product cards, bots); a bare picture link is an image as well.
  if (!raw) { if (messageTypes.includes('其他消息')) flags.add('image'); return { text: null, chars: 0, flags: [...flags] } }
  if (IMAGE_URL.test(raw)) { flags.add('image'); return { text: '[图片]', chars: 0, flags: [...flags] } }
  // Numbers inside links (CDN paths, video ids) are not contact details.
  const plain = raw.replace(LINK, ' ')
  if (plain.match(PHONE) || MASKED_PHONE.test(plain)) flags.add(ADDRESS.test(plain) ? 'address' : 'phone')
  if ([...plain.matchAll(WECHAT_ID)].length || WECHAT_INVITE.test(plain) || /^(微|威|薇|we|v|wx)/i.test(plain.match(MASKED_ID)?.[1] ?? '')) flags.add('wechat')
  if ([...plain.matchAll(QQ)].length || /^(qq|扣扣|企鹅)/i.test(plain.match(MASKED_ID)?.[1] ?? '')) flags.add('qq')
  if (OFFSITE.test(raw)) flags.add('offsite')
  for (const url of raw.match(LINK) ?? []) { try { if (!PLATFORM_HOST.test(new URL(url).hostname)) flags.add('external_link') } catch { flags.add('external_link') } }
  if (CURT.test(raw)) flags.add('curt')
  // Real characters: links and punctuation do not count towards reply length.
  const chars = [...raw.replace(LINK, '').replace(/[\s\p{P}\p{S}]/gu, '')].length
  if (chars > 0 && chars <= 3 && !/https?:\/\//i.test(raw)) flags.add('short')
  return { text: mask(raw).slice(0, 500), chars, flags: [...flags] }
}
