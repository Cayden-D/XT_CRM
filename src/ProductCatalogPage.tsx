import { useState } from 'react'
import { Layers3, Store } from 'lucide-react'
import type { SessionUser } from './api'
import PlatformCatalog from './PlatformCatalog'
import ProductLibrary from './ProductsPage'

type View = 'platform' | 'unlisted'
const can = (user: SessionUser, name: string) => (user.permissions || []).some(v => v === '*' || v === name || v === `${name.split(':')[0]}:*`)

/** 产品目录: the shop's 1688 products are the catalogue; products added by hand or not yet listed sit next to them. */
export default function ProductCatalogPage({ user }: { user: SessionUser }) {
  const [view, setView] = useState<View>('platform'), [creating, setCreating] = useState(false)
  const canCreate = can(user, 'product:create')
  return <div className="commerce-page">
    <div className="catalog-views" role="tablist" aria-label="产品目录视图">
      <button role="tab" aria-selected={view === 'platform'} className={view === 'platform' ? 'active' : ''} onClick={() => setView('platform')}><Store size={15} />平台商品</button>
      <button role="tab" aria-selected={view === 'unlisted'} className={view === 'unlisted' ? 'active' : ''} onClick={() => setView('unlisted')}><Layers3 size={15} />未上架<small>手动添加或采集后还没发布的产品</small></button>
    </div>
    {view === 'platform'
      ? <PlatformCatalog user={user} onAdd={canCreate ? () => { setCreating(true); setView('unlisted') } : undefined} />
      : <ProductLibrary unlisted canEdit={canCreate} canDelete={can(user, 'product:delete')} startCreating={creating} onStarted={() => setCreating(false)} />}
  </div>
}
