import { useEffect, useState } from 'react'
import { AlertCircle, LoaderCircle, Trash2, X } from 'lucide-react'

export type DeleteImpact = { removes: string[]; blocked: string | null }
const message = (cause: unknown) => cause instanceof Error ? cause.message : '操作未完成，请稍后重试。'

/**
 * Confirms deleting a disabled shop connection: lists what goes with it (re-syncable data) or why it cannot go
 * (work that must be kept), as the server will decide the same way.
 */
export default function ConnectionDelete({ name, account, impact, remove, close, done }: {
  name: string; account: string | null; impact: () => Promise<DeleteImpact>; remove: () => Promise<unknown>; close: () => void; done: () => void
}) {
  const [data, setData] = useState<DeleteImpact | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('')
  useEffect(() => { let live = true; impact().then(r => live && setData(r)).catch(cause => live && setError(message(cause))); return () => { live = false } }, [impact])
  useEffect(() => { const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }; window.addEventListener('keydown', escape); return () => window.removeEventListener('keydown', escape) }, [close])
  async function confirm() { setBusy(true); setError(''); try { await remove(); done() } catch (cause) { setError(message(cause)) } finally { setBusy(false) } }
  return <div className="dialog-layer shop-dialog"><button className="drawer-scrim" onClick={close} aria-label="关闭对话框" />
    <section role="dialog" aria-modal="true" aria-label="删除店铺连接" className="shop-modal"><header><h2>删除店铺连接</h2><button title="关闭" onClick={close}><X size={18} /></button></header>
      <div className="shop-modal-body">
        <p><strong>{name}</strong>{account && <small className="connection-delete-account">{account}</small>}</p>
        {!data && !error && <p className="shop-note"><LoaderCircle size={14} className="spin" /> 正在检查这个连接的数据…</p>}
        {data?.blocked && <p className="shop-local-error"><AlertCircle size={15} />{data.blocked}</p>}
        {data && !data.blocked && <>
          <p>删除后无法恢复。{data.removes.length ? '以下数据会一起删除（重新授权后可再次同步）：' : '这个连接没有关联数据。'}</p>
          {data.removes.length > 0 && <ul className="connection-delete-list">{data.removes.map(line => <li key={line}>{line}</li>)}</ul>}
          <p className="shop-note">调用记录会保留；店铺在 1688 上的商品和订单不受影响。</p>
        </>}
        {error && <p className="shop-local-error" role="alert"><AlertCircle size={15} />{error}</p>}
      </div>
      <footer><button className="shop-button" onClick={close}>{data?.blocked ? '知道了' : '取消'}</button>
        {!data?.blocked && <button className="shop-button danger" disabled={!data || busy} onClick={() => void confirm()}>{busy ? <LoaderCircle size={15} className="spin" /> : <Trash2 size={15} />}删除连接</button>}</footer>
    </section></div>
}
