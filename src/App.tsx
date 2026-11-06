import { useEffect, useState } from 'react'
import { LogOut, Menu, Sparkles } from 'lucide-react'
import AgentQueueSettings from './AgentQueueSettings'
import LoginPage from './LoginPage'
import CustomersPage from './CustomersPage'
import ProductCatalogPage from './ProductCatalogPage'
import DashboardPage from './DashboardPage'
import ProductCollectionsPage from './ProductCollectionsPage'
import ShopPanel from './1688Page'
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
import { aiPage, has, navigate, parseRoute, tabsFor, visibleSections, type Route } from './navigation'
import { MoreMenu } from './ui'

function Sidebar({ route, open, close, user, onLogout }: { route: Route; open: boolean; close: () => void; user: SessionUser; onLogout: () => void }) {
  const go = (id: string) => { navigate(id); close() }
  const items = visibleSections(user)
  const link = (s: typeof items[number]) => <button key={s.id} className={route.section.id === s.id ? 'active' : ''} aria-current={route.section.id === s.id ? 'page' : undefined} onClick={() => go(s.id)}><s.icon size={18} strokeWidth={1.8} /><span>{s.label}</span></button>
  return <>
    {open && <button className="scrim" onClick={close} aria-label="关闭导航" />}
    <aside className={`sidebar ${open ? 'sidebar-open' : ''}`}>
      <div className="brand"><div className="brand-mark"><span /></div><b>销途</b></div>
      <nav aria-label="主导航">{items.filter(s => !s.bottom).map(link)}</nav>
      <div className="sidebar-foot">
        {items.filter(s => s.bottom).map(link)}
        <div className="profile"><div className="avatar">{user.displayName.slice(0, 1)}</div><b>{user.displayName}</b><button className="logout-button" onClick={onLogout} title="退出登录" aria-label="退出登录"><LogOut size={16} /></button></div>
      </div>
    </aside>
  </>
}

/** One row: where you are, the views of it, and the assistant. */
function Topbar({ route, user, openMenu, openAI }: { route: Route; user: SessionUser; openMenu: () => void; openAI: () => void }) {
  const tabs = tabsFor(route.section, user), front = tabs.filter(t => !t.more), more = tabs.filter(t => t.more)
  const current = more.find(t => t.id === route.tab.id)
  const go = (id: string) => navigate(`${route.section.id}/${id}`)
  return <header className="topbar">
    <button className="mobile-menu" onClick={openMenu} aria-label="打开导航"><Menu size={20} /></button>
    <h1>{route.section.label}</h1>
    {tabs.length > 1 && <nav className="section-tabs" aria-label={route.section.label}>
      {front.map(t => <button key={t.id} className={route.tab.id === t.id ? 'active' : ''} aria-current={route.tab.id === t.id ? 'page' : undefined} onClick={() => go(t.id)}>{t.label}</button>)}
      {more.length > 0 && <MoreMenu label={current?.label ?? '更多'} active={Boolean(current)}>{close => more.map(t => <button key={t.id} role="menuitem" className={route.tab.id === t.id ? 'active' : ''} onClick={() => { go(t.id); close() }}>{t.label}</button>)}</MoreMenu>}
    </nav>}
    <button className="ai-shortcut" onClick={openAI}><Sparkles size={16} /><span>问 AI</span></button>
  </header>
}

function Page({ route: { section, tab }, user, intent, toolKey }: { route: Route; user: SessionUser; intent?: ImageIntent; toolKey: number }) {
  const id = `${section.id}/${tab.id}`
  switch (section.id) {
    case 'home': return <DashboardPage user={user} />
    case 'customers': return tab.id === 'offline' ? <CustomersPage /> : <CustomerOpsPage user={user} view={tab.id === 'segments' ? 'settings' : tab.id as 'list' | 'pool' | 'due'} />
    case 'chats': return <ChatInquiryPage user={user} tab={tab.id === 'inquiry' || tab.id === 'review' ? tab.id : 'chats'} />
    case 'orders': return <OrdersPage user={user} />
    case 'products':
      if (tab.id === 'collect') return <ProductCollectionsPage user={user} />
      if (tab.id === 'queue') return <AgentQueueSettings user={user} />
      return <ShopPanel user={user} view="drafts" />
    case 'catalog': return <ProductCatalogPage user={user} />
    case 'images': return tab.id === 'suite' ? <ImageSuitePage key={`suite-${toolKey}`} user={user} intent={intent} /> : <ImageEditPage key={`edit-${toolKey}`} user={user} intent={intent} />
    case 'performance': return <PerformancePage user={user} view={tab.id as PerfView} />
    default: break
  }
  if (id === 'settings/agents') return <PerformancePage user={user} view="agents" />
  if (id === 'settings/rules') return <PerformancePage user={user} view="settings" />
  if (id === 'settings/automation') return <AgentSettingsPage user={user} />
  if (id === 'settings/users') return <UsersAdminPage user={user} />
  const product = has(user, 'integration:read'), performance = has(user, 'performance:read', 'performance:read_own')
  const operations = id === 'settings/logs'
  return <div className="settings-stack">
    {product && <section><h2>商品应用</h2><ShopPanel user={user} view={operations ? 'operations' : 'connections'} /></section>}
    {performance && <section><h2>绩效应用</h2><PerformancePage user={user} view={operations ? 'operations' : 'connections'} /></section>}
  </div>
}

const imageRoute = (intent: ImageIntent) => intent.page === 'imageSuite' ? 'images/suite' : 'images/edit'

export default function App() {
  const [session, setSession] = useState<SessionUser | null | undefined>(undefined)
  const [hash, setHash] = useState(window.location.hash)
  const [imageIntent, setImageIntent] = useState<ImageIntent | undefined>()
  const [toolKey, setToolKey] = useState(0)
  const [aiOpen, setAiOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [prompt, setPrompt] = useState('')
  const openAI = (text = '') => { setPrompt(text); setAiOpen(true) }
  useEffect(() => {
    // An image handed to a tool stays only while that tool is open.
    const changed = () => { setHash(window.location.hash); setImageIntent(current => current && window.location.hash.endsWith(imageRoute(current)) ? current : undefined) }
    const open = (event: Event) => { setPrompt((event as CustomEvent<string>).detail ?? ''); setAiOpen(true) }
    const tool = (event: Event) => {
      const intent = (event as CustomEvent<ImageIntent>).detail
      setImageIntent(intent); setToolKey(k => k + 1); navigate(imageRoute(intent))
    }
    window.addEventListener('hashchange', changed)
    window.addEventListener(OPEN_AI, open)
    window.addEventListener(OPEN_IMAGE_TOOL, tool)
    return () => { window.removeEventListener('hashchange', changed); window.removeEventListener(OPEN_AI, open); window.removeEventListener(OPEN_IMAGE_TOOL, tool) }
  }, [])
  // Each page opens at its top rather than at the previous page's scroll position.
  useEffect(() => { window.scrollTo(0, 0) }, [hash])
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
  const route = parseRoute(hash, session)
  const title = route.section.tabs.length > 1 ? `${route.section.label} · ${route.tab.label}` : route.section.label
  return <div className="app-shell">
    <Sidebar route={route} open={menuOpen} close={() => setMenuOpen(false)} user={session} onLogout={logout} />
    <main className={aiOpen ? 'main ai-visible' : 'main'}>
      <Topbar route={route} user={session} openMenu={() => setMenuOpen(true)} openAI={() => openAI()} />
      <div className="page-content"><Page route={route} user={session} intent={imageIntent} toolKey={toolKey} /></div>
    </main>
    <AiAssistant open={aiOpen} close={() => setAiOpen(false)} initialPrompt={prompt} userName={session.displayName} page={aiPage(route)} pageTitle={title} />
  </div>
}
