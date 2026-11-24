import { request } from './api'

export const MARKETPLACE_URL = 'https://app.1688.com/'
export const MOBILE_MARKETPLACE_URL = 'https://m-fuwu.1688.com/page/pluginlist.htm'
export type SupportContact = { phone: string; wangwang: string }
export const getSupportContact = () => request<{ support: SupportContact }>('/api/integrations/1688/marketplace/support').then(result => result.support)
export const supportWangwangUrl = (id: string) => `https://air.1688.com/app/ocms-fusion-components-1688/def_cbu_web_im/index.html?touid=${encodeURIComponent(`cnalichn${id}`)}&siteid=cnalichn&status=1#/`
