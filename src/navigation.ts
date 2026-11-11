import { Headset, Images, LayoutDashboard, MessagesSquare, Package, PackageCheck, ReceiptText, Settings, Users, type LucideIcon } from 'lucide-react'
import type { SessionUser } from './api'

export const has = (user: SessionUser, ...names: string[]) => (user.permissions || []).some(p => p === '*' || names.some(name => p === name || p === `${name.split(':')[0]}:*`))
const perf = (user: SessionUser) => has(user, 'performance:read', 'performance:read_own')

export type Tab = { id: string; label: string; more?: boolean; can?: (user: SessionUser) => boolean }
export type Section = { id: string; label: string; icon: LucideIcon; tabs: Tab[]; bottom?: boolean }

/** The whole product in one table: left nav = what the user works on, tabs = the views of it; `more` tucks low-frequency views away. */
export const sections: Section[] = [
  { id: 'home', label: '首页', icon: LayoutDashboard, tabs: [{ id: 'overview', label: '首页' }] },
  { id: 'customers', label: '客户', icon: Users, tabs: [
    { id: 'list', label: '全部客户', can: u => has(u, 'customer_ops:read') },
    { id: 'due', label: '待跟进', can: u => has(u, 'customer_ops:read') },
    { id: 'pool', label: '未成交', can: u => has(u, 'customer_ops:read') },
    { id: 'offline', label: '线下客户', can: u => has(u, 'account:read', 'account:own') },
    { id: 'segments', label: '分层与标签', more: true, can: u => has(u, 'customer_ops:read') },
  ] },
  { id: 'chats', label: '聊天', icon: MessagesSquare, tabs: [
    { id: 'records', label: '聊天记录', can: perf },
    { id: 'inquiry', label: '询盘分析', can: perf },
    { id: 'review', label: '询盘复盘', can: u => has(u, 'performance:review', 'performance:review_read') },
  ] },
  { id: 'orders', label: '订单', icon: ReceiptText, tabs: [{ id: 'all', label: '订单', can: perf }] },
  { id: 'catalog', label: '产品目录', icon: Package, tabs: [{ id: 'all', label: '产品目录', can: u => has(u, 'product:read', 'integration:read') }] },
  { id: 'products', label: '上架', icon: PackageCheck, tabs: [
    { id: 'collect', label: '采集箱', can: u => has(u, 'collection:read') },
    { id: 'queue', label: '上架队列', can: u => has(u, 'integration:read') },
    { id: 'drafts', label: '发布草稿', can: u => has(u, 'integration:read') },
  ] },
  { id: 'images', label: '图片', icon: Images, tabs: [
    { id: 'edit', label: '图片编辑' },
    { id: 'suite', label: '电商套图' },
    { id: 'brands', label: '品牌', can: u => has(u, 'integration:manage') },
  ] },
  { id: 'performance', label: '绩效', icon: Headset, tabs: [
    { id: 'comparison', label: '客服对比', can: perf },
    { id: 'coaching', label: '业务员复盘', can: perf },
    { id: 'kpi', label: '综合排行', can: perf },
    { id: 'quality', label: '回复质量', can: perf },
    { id: 'payroll', label: '工资', can: u => has(u, 'payroll:read') },
    { id: 'hourly', label: '分时接待', more: true, can: perf },
    { id: 'keywords', label: '关键词', more: true, can: perf },
    { id: 'orders', label: '订单归属', more: true, can: perf },
    { id: 'favorites', label: '我关注的', more: true, can: perf },
  ] },
  { id: 'settings', label: '设置', icon: Settings, bottom: true, tabs: [
    { id: 'shops', label: '店铺授权', can: u => has(u, 'integration:read') || perf(u) },
    { id: 'agents', label: '客服账号', can: perf },
    { id: 'rules', label: '绩效规则', can: u => has(u, 'performance:read') },
    { id: 'automation', label: '自动上架', can: u => has(u, 'integration:read') },
    { id: 'users', label: '账号权限', can: u => has(u, 'user:manage', 'user:manage_team') },
    { id: 'logs', label: '调用记录', can: u => has(u, 'integration:read', 'performance:read') },
  ] },
]

export const tabsFor = (section: Section, user: SessionUser) => section.tabs.filter(tab => !tab.can || tab.can(user))
export const visibleSections = (user: SessionUser) => sections.filter(section => tabsFor(section, user).length > 0)

export type Route = { section: Section; tab: Tab }
export function parseRoute(hash: string, user: SessionUser): Route {
  // Old links to the two views that became 产品目录.
  const path = hash.replace(/^#\/?/, '')
  const [sectionId, tabId] = (path === 'products/listed' || path === 'products/library' ? 'catalog/all' : path).split('/')
  const section = visibleSections(user).find(s => s.id === sectionId) ?? sections[0]
  const tabs = tabsFor(section, user)
  return { section, tab: tabs.find(t => t.id === tabId) ?? tabs[0] }
}

/** Any page can send the user somewhere: `navigate('settings/shops')`. */
export const navigate = (path: string) => { window.location.hash = `#/${path}` }

/** Keys the AI assistant's suggestions and context use. */
export function aiPage({ section, tab }: Route) {
  if (section.id === 'home') return 'dashboard'
  if (section.id === 'customers') return tab.id === 'offline' ? 'customers' : 'customerOps'
  return section.id
}
