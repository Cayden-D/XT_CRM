import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { Phone } from 'lucide-react'
import supportLogo from './assets/customer-service.svg'
import { getSupportContact, supportWangwangUrl, type SupportContact } from './marketplaceApi'

type SupportState = { contact: SupportContact | null; error: boolean; retry: () => void }
const SupportContext = createContext<SupportState | null>(null)

/** Fetch once per signed-in workspace, shared by the help page and floating link. */
export function SupportProvider({ children }: { children: ReactNode }) {
  const [contact, setContact] = useState<SupportContact | null>(null)
  const [error, setError] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let active = true
    setError(false)
    getSupportContact().then(value => { if (active) setContact(value) }).catch(() => { if (active) setError(true) })
    return () => { active = false }
  }, [attempt])
  return <SupportContext.Provider value={{ contact, error, retry: () => setAttempt(value => value + 1) }}>{children}</SupportContext.Provider>
}

function useSupport() {
  const state = useContext(SupportContext)
  if (!state) throw new Error('SupportProvider is required')
  return state
}

export function ContactButtons() {
  const { contact, error, retry } = useSupport()
  if (!contact) return <div role="status"><p>{error ? '客服信息读取失败，请重试。' : '正在读取客服联系方式…'}</p>{error && <button className="shop-button" onClick={retry}>重新加载客服信息</button>}</div>
  return <div className="support-contact-actions" role="group" aria-label="客服联系方式">
    <a className="support-contact-button" href={`tel:${contact.phone.replace(/[ -]/g, '')}`} aria-label="电话客服" title="电话客服"><Phone size={24} aria-hidden="true" /></a>
    <a className="support-contact-button" href={supportWangwangUrl(contact.wangwang)} target="_blank" rel="noopener noreferrer" aria-label="旺旺客服" title="旺旺客服"><img src={supportLogo} alt="" width="28" height="28" /></a>
  </div>
}

export function FloatingSupport() {
  const { contact } = useSupport()
  return <a className="floating-wangwang" href={contact ? supportWangwangUrl(contact.wangwang) : '#/help/support'} target={contact ? '_blank' : undefined} rel={contact ? 'noopener noreferrer' : undefined} aria-label="联系旺旺客服" title="联系旺旺客服">
    <img src={supportLogo} alt="" width="32" height="32" />
  </a>
}
