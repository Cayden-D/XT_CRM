import { useEffect, useState } from 'react'
import { BookOpen, ExternalLink } from 'lucide-react'
import supportLogo from './assets/customer-service.svg'
import { MARKETPLACE_URL, MOBILE_MARKETPLACE_URL } from './marketplaceApi'
import './marketplace.css'

/** The marketplace supplies its own header; these links belong to the CRM toolbar. */
export default function ServiceLinks() {
  const [mobile, setMobile] = useState(() => window.matchMedia('(max-width:820px)').matches)
  useEffect(() => {
    const query = window.matchMedia('(max-width:820px)')
    const changed = () => setMobile(query.matches)
    query.addEventListener('change', changed)
    return () => query.removeEventListener('change', changed)
  }, [])
  return <nav className="app-service-links" aria-label="服务与帮助">
    <a href="#/help/guide"><BookOpen size={18} aria-hidden="true" /><span>使用指南</span></a>
    <a href="#/help/support"><img src={supportLogo} alt="" width="22" height="22" /><span>联系客服</span></a>
    <a href={mobile ? MOBILE_MARKETPLACE_URL : MARKETPLACE_URL} target="_blank" rel="noopener noreferrer"><ExternalLink size={18} aria-hidden="true" /><span>应用市场</span></a>
  </nav>
}
