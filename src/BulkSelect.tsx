import { useEffect, useMemo, useState } from 'react'
import { LoaderCircle, Trash2, X } from 'lucide-react'

/** Selection of items on the current page; anything no longer listed drops out of it. */
export function useSelection(ids: string[]) {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const key = ids.join(',')
  useEffect(() => { setSelected(current => { const next = new Set([...current].filter(id => ids.includes(id))); return next.size === current.size ? current : next }) }, [key]) // eslint-disable-line react-hooks/exhaustive-deps
  return useMemo(() => ({
    selected,
    has: (id: string) => selected.has(id),
    toggle: (id: string) => setSelected(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next }),
    setAll: (on: boolean) => setSelected(on ? new Set(ids) : new Set()),
    clear: () => setSelected(new Set()),
    all: ids.length > 0 && ids.every(id => selected.has(id)),
  }), [selected, key]) // eslint-disable-line react-hooks/exhaustive-deps
}
export type Selection = ReturnType<typeof useSelection>

/** The tick on a card. */
export function PickBox({ selection, id, label }: { selection: Selection; id: string; label: string }) {
  return <label className={`goods-pick ${selection.has(id) ? 'on' : ''}`} title="选择"><input type="checkbox" aria-label={`选择 ${label}`} checked={selection.has(id)} onChange={() => selection.toggle(id)}/></label>
}

/**
 * Select-all for the page and one delete for the selection. Items are deleted one after another with the same rules as a
 * single delete; whatever the server refuses stays, with its reason.
 */
export function BulkBar<T extends { id: string }>({ selection, items, name, remove, done, noun }: {
  selection: Selection; items: T[]; name: (item: T) => string; remove: (item: T) => Promise<unknown>; done: (message: string) => void | Promise<void>; noun: string
}) {
  const [confirming, setConfirming] = useState(false), [busy, setBusy] = useState(false), [progress, setProgress] = useState(0)
  const chosen = items.filter(item => selection.has(item.id))
  async function run() {
    setBusy(true); setProgress(0)
    const failed: string[] = []
    let deleted = 0
    for (const item of chosen) {
      try { await remove(item); deleted++ } catch (cause) { failed.push(`${name(item)}：${cause instanceof Error ? cause.message : '删除失败'}`) }
      setProgress(n => n + 1)
    }
    setBusy(false); setConfirming(false); selection.clear()
    await done(failed.length ? `已删除 ${deleted} 个${noun}，${failed.length} 个未删除（${failed.slice(0, 3).join('；')}${failed.length > 3 ? ' 等' : ''}）` : `已删除 ${deleted} 个${noun}`)
  }
  if (!items.length) return null
  return <div className="bulk-bar">
    <label><input type="checkbox" aria-label="全选本页" checked={selection.all} onChange={e => selection.setAll(e.target.checked)}/>全选本页</label>
    {chosen.length > 0 && <>
      <span>已选 {chosen.length} 个</span>
      <button className="bulk-danger" onClick={() => setConfirming(true)}><Trash2 size={14}/>批量删除</button>
      <button className="bulk-clear" onClick={selection.clear} aria-label="取消选择"><X size={14}/>取消选择</button>
    </>}
    {confirming && <div className="dialog-layer"><button className="drawer-scrim" aria-label="取消" disabled={busy} onClick={() => setConfirming(false)}/><section className="confirm-dialog" role="alertdialog" aria-label={`批量删除${noun}`}>
      <div className="confirm-icon"><Trash2 size={20}/></div><h2>删除选中的 {chosen.length} 个{noun}？</h2>
      <p>{chosen.slice(0, 3).map(name).join('、')}{chosen.length > 3 ? ` 等 ${chosen.length} 个` : ''}将被删除，不能恢复。</p>
      <div><button disabled={busy} onClick={() => setConfirming(false)}>取消</button><button className="danger" disabled={busy} onClick={() => void run()}>{busy ? <><LoaderCircle size={14} className="spin"/>{progress}/{chosen.length}</> : '删除'}</button></div>
    </section></div>}
  </div>
}
