import AgentQueueSettings from './AgentQueueSettings'
import { useEffect, useState } from 'react'
import {
  Building2, Database, Headset, Images, LayoutDashboard, LogOut, Menu, MessagesSquare, Package, ReceiptText, PackageCheck, Settings, ShieldCheck, Sparkles, Store, Users, Wand2,
} from 'lucide-react'
import LoginPage from './LoginPage'
import CustomersPage from './CustomersPage'
import ProductsPage from './ProductsPage'
import DashboardPage, { type DashboardTarget } from './DashboardPage'
import ProductCollectionsPage from './ProductCollectionsPage'
import Integration1688Page from './1688Page'
import AgentSettingsPage from './AgentSettingsPage'
import PerformancePage, { type View as PerfView } from './PerformancePage'
import CustomerOpsPage from './CustomerOpsPage'
import UsersAdminPage from './UsersAdminPage'
import ChatInquiryPage from './ChatInquiryPage'
import OrdersPage from './OrdersPage'
import { ImageEditPage, ImageSuitePage } from './ImageWorkshop'
import { OPEN_IMAGE_TOOL, type ImageIntent } from './imageApi'
import AiAssistant from './AiAssistant'
import { OPEN_AI, resetAiFocus } from './aiFocus'
import { clearToken,getCurrentUser,getToken,type SessionUser } from './api'

type Page = 'dashboard' | 'customers' | 'products' | 'collections' | 'imageEdit' | 'imageSuite' | 'shop' | 'settings' | 'queue' | 'performance' | 'chats' | 'orders' | 'customerOps' | 'users'

const pageMeta: Record<Page, { title: string; eyebrow: string }> = {
  dashboard: { title: '经营看板', eyebrow: '成交、接待、客户与上架的实时概况' },
  customers: { title: '客户资产', eyebrow: '沉淀客户关系与全生命周期价值' },
  products: { title: '产品目录', eyebrow: '店铺在 1688 上架的商品、价格库存与近 30 天销量' },
  collections: { title: '1688 商品采集', eyebrow: '独立采集、查看并清洗源商品资料' },
  imageEdit: { title: '图片编辑', eyebrow: '白底图、换背景、改尺寸，处理商品图片' },
  imageSuite: { title: '电商套图', eyebrow: 'AI 根据商品生成白底、场景、细节、模特、卖点、规格 6 张主图' },
  shop: { title: '1688 店铺', eyebrow: '平台商品、发布工作台与连接设置' },
  queue: {title:'上架队列',eyebrow:'跟踪采集商品的检测、资料准备与发布进度'},
  customerOps: { title: '客户经营', eyebrow: '1688 客户档案、精细化分层、跟进与复购' },
  orders: { title: '订单', eyebrow: '店铺订单列表与 1688 实时订单详情' },
  chats: { title: '聊天与询盘', eyebrow: '旺旺聊天记录、询盘转化与买家查找' },
  performance: { title: '客服绩效', eyebrow: '1688 绩效应用授权、指标口径与绩效方案' },
  users: { title: '账户管理', eyebrow: '开设账号、分配角色、停用与重置密码' },
  settings: { title: '系统设置', eyebrow: '店铺 Agent 与自动发布授权' },
}

const nav: Array<{ id: Page; label: string; icon: typeof LayoutDashboard; count?: number }> = [
  { id: 'dashboard', label: '经营看板', icon: LayoutDashboard },
  { id: 'customerOps', label: '客户经营', icon: Users },
  { id: 'customers', label: '客户', icon: Building2 },
  { id: 'products', label: '产品目录', icon: Package },
  { id: 'collections', label: '1688 商品采集', icon: Database },
  { id: 'imageEdit', label: '图片编辑', icon: Wand2 },
  { id: 'imageSuite', label: '电商套图', icon: Images },
  { id: 'shop', label: '1688 店铺', icon: Store },
  { id: 'queue', label: '上架队列', icon: PackageCheck },
  { id: 'orders', label: '订单', icon: ReceiptText },
  { id: 'chats', label: '聊天与询盘', icon: MessagesSquare },
  { id: 'performance', label: '客服绩效', icon: Headset },
]

const canManageUsers = (user: SessionUser) => (user.permissions || []).some(p => p === '*' || p === 'user:*' || p === 'user:manage')

function Sidebar({ page, setPage, open, close, user, onLogout }: { page: Page; setPage: (page: Page) => void; open: boolean; close: () => void; user: SessionUser; onLogout: () => void }) {
  return <>
    {open && <button className="scrim" onClick={close} aria-label="关闭导航" />}
    <aside className={`sidebar ${open ? 'sidebar-open' : ''}`}>
      <div className="brand"><div className="brand-mark"><span /></div><div><b>销途</b><small>AI CRM</small></div></div>
      <nav aria-label="主导航">
        <p className="nav-label">工作空间</p>
        {nav.map(item => <button key={item.id} className={page === item.id ? 'active' : ''} onClick={() => { setPage(item.id); close() }}>
          <item.icon size={18} strokeWidth={1.8} /><span>{item.label}</span>{item.count && <em>{item.count}</em>}
        </button>)}
      </nav>
      <div className="sidebar-foot">
        {canManageUsers(user) && <button className={page==='users'?'active':''} onClick={()=>{setPage('users');close()}}><ShieldCheck size={18} /><span>账户管理</span></button>}
        <button className={page==='settings'?'active':''} onClick={()=>{setPage('settings');close()}}><Settings size={18} /><span>系统设置</span></button>
        <div className="profile"><div className="avatar">{user.displayName.slice(0, 1)}</div><div><b>{user.displayName}</b><small>{user.roles.includes('super_admin') ? '超级管理员' : user.roles.includes('admin') ? '管理员' : '业务成员'}</small></div><button className="logout-button" onClick={onLogout} aria-label="退出登录"><LogOut size={16} /></button></div>
      </div>
    </aside>
  </>
}

function Topbar({ page, openMenu, openAI }: { page: Page; openMenu: () => void; openAI: () => void }) {
  return <header className="topbar">
    <button className="mobile-menu" onClick={openMenu}><Menu size={20} /></button>
    <div className="page-title"><p>{pageMeta[page].eyebrow}</p><h1>{pageMeta[page].title}</h1></div>
    <div className="top-actions">
      <button className="ai-shortcut" onClick={openAI}><Sparkles size={17} /><span>问 AI</span></button>
    </div>
  </header>
}

export default function App() {
  const [session, setSession] = useState<SessionUser | null | undefined>(undefined)
  const [page, setPage] = useState<Page>('dashboard')
  const [subView, setSubView] = useState<string | undefined>()
  const [imageIntent, setImageIntent] = useState<ImageIntent | undefined>()
  const go = (target: DashboardTarget) => { setSubView('view' in target ? target.view : undefined); setPage(target.page) }
  const [aiOpen, setAiOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [prompt, setPrompt] = useState('')
  const openAI = (text = '') => { setPrompt(text); setAiOpen(true) }
  useEffect(() => {
    const open = (event: Event) => { setPrompt((event as CustomEvent<string>).detail ?? ''); setAiOpen(true) }
    const tool = (event: Event) => { const intent = (event as CustomEvent<ImageIntent>).detail; setImageIntent(intent); setSubView(String(Date.now())); setPage(intent.page) }
    window.addEventListener(OPEN_AI, open)
    window.addEventListener(OPEN_IMAGE_TOOL, tool)
    return () => { window.removeEventListener(OPEN_AI, open); window.removeEventListener(OPEN_IMAGE_TOOL, tool) }
  }, [])
  // Each page opens at its top rather than at the previous page's scroll position.
  useEffect(() => { window.scrollTo(0, 0) }, [page, subView])
  // Dialogs make room for the open sidebar instead of hiding under it.
  useEffect(() => { document.body.classList.toggle('ai-open', aiOpen) }, [aiOpen])
  useEffect(() => {
    const expired = () => setSession(null)
    window.addEventListener('crm:unauthorized', expired)
    if (!getToken()) setSession(null)
    else getCurrentUser().then(setSession).catch(() => { clearToken(); setSession(null) })
    return () => window.removeEventListener('crm:unauthorized', expired)
  }, [])
  if (session === undefined) return <div className="app-loading"><div className="brand-mark"><span /></div><p>正在恢复工作空间…</p></div>
  if (session === null) return <LoginPage onLogin={setSession} />
  const logout = () => { clearToken(); setSession(null); setAiOpen(false); resetAiFocus() }
  return <div className="app-shell">
    <Sidebar page={page} setPage={next => { setSubView(undefined); setImageIntent(undefined); setPage(next) }} open={menuOpen} close={() => setMenuOpen(false)} user={session} onLogout={logout} />
    <main className={aiOpen ? 'main ai-visible' : 'main'}>
      <Topbar page={page} openMenu={() => setMenuOpen(true)} openAI={() => openAI()} />
      <div className="page-content">{page === 'dashboard' ? <DashboardPage user={session} go={go} /> : page === 'customers' ? <CustomersPage /> : page === 'products' ? <ProductsPage user={session} openShop={() => setPage('shop')} /> : page === 'collections' ? <ProductCollectionsPage user={session} /> : page === 'imageEdit' ? <ImageEditPage key={subView ?? 'imageEdit'} user={session} intent={imageIntent} /> : page === 'imageSuite' ? <ImageSuitePage key={subView ?? 'imageSuite'} user={session} intent={imageIntent} /> : page === 'shop' ? <Integration1688Page user={session} onCollections={()=>setPage('collections')}/> : page === 'queue' ? <AgentQueueSettings user={session}/> : page === 'performance' ? <PerformancePage key={subView ?? 'performance'} user={session} initialView={subView as PerfView | undefined}/> : page === 'chats' ? <ChatInquiryPage user={session} /> : page === 'orders' ? <OrdersPage user={session} /> : page === 'users' && canManageUsers(session) ? <UsersAdminPage user={session} /> : page === 'customerOps' ? <CustomerOpsPage key={subView ?? 'customerOps'} user={session} initialView={subView as 'list' | 'pool' | 'due' | undefined} openOffline={()=>setPage('customers')}/> : <AgentSettingsPage user={session}/>}</div>
    </main>
    <button className={`ai-fab ${aiOpen ? 'hidden' : ''}`} onClick={() => openAI()}><Sparkles size={20} /><span>问销途 AI</span></button>
    <AiAssistant open={aiOpen} close={() => setAiOpen(false)} initialPrompt={prompt} userName={session.displayName} page={page} pageTitle={pageMeta[page].title} />
  </div>
}
