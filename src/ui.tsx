import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Info, Store } from 'lucide-react'
import { navigate } from './navigation'

/** Definitions and fine print stay one click away instead of sitting on the page. */
export function Note({ label = '说明', children }: { label?: string; children: ReactNode }) {
  return <details className="ui-note"><summary><Info size={13} />{label}</summary><div>{children}</div></details>
}

/** Nothing to choose with one shop, so the control only appears when there is more than one. */
export function ShopPicker<T extends { id: string; display_name: string | null }>({ shops, value, onChange }: { shops: T[]; value: string; onChange: (id: string) => void }) {
  if (shops.length < 2) return null
  return <div className="shop-select"><Store size={16} /><select aria-label="店铺" value={value} onChange={e => onChange(e.target.value)}>{shops.map(s => <option key={s.id} value={s.id}>{s.display_name || '未命名店铺'}</option>)}</select></div>
}

export type DateValue = { from: string; to: string }
const today = () => new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10)

/** Preset ranges, with the two date inputs only after choosing 自定义. */
export function DateRange<P extends string>({ presets, preset, range, onPreset, onCustom }: { presets: [P, string][]; preset: P | 'custom'; range: DateValue; onPreset: (id: P) => void; onCustom: (range: DateValue) => void }) {
  const [custom, setCustom] = useState(preset === 'custom')
  return <div className="perf-range">
    <nav className="perf-metric-tabs" aria-label="日期范围">
      {presets.map(([id, label]) => <button key={id} aria-pressed={!custom && preset === id} className={!custom && preset === id ? 'active' : ''} onClick={() => { setCustom(false); onPreset(id) }}>{label}</button>)}
      <button aria-pressed={custom} className={custom ? 'active' : ''} onClick={() => setCustom(true)}>自定义</button>
    </nav>
    {custom && <><input type="date" aria-label="开始日期" value={range.from} max={range.to} onChange={e => { if (e.target.value) onCustom({ ...range, from: e.target.value }) }} /><span>至</span>
      <input type="date" aria-label="结束日期" value={range.to} min={range.from} max={today()} onChange={e => { if (e.target.value) onCustom({ ...range, to: e.target.value }) }} /></>}
  </div>
}

/** Shown wherever a page needs an authorized shop: says what is missing and goes straight there. */
export function NeedShop({ text }: { text: string }) {
  return <section className="state-card"><Store size={28} /><h2>{text}</h2><button onClick={() => navigate('settings/shops')}>去授权</button></section>
}

/** A small popup menu for tabs that are used less often. */
export function MoreMenu({ label, active, children }: { label: string; active: boolean; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false), ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const outside = (event: MouseEvent) => { if (!ref.current?.contains(event.target as Node)) setOpen(false) }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', outside); document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('mousedown', outside); document.removeEventListener('keydown', escape) }
  }, [open])
  return <div className="tab-more" ref={ref}>
    <button className={active ? 'active' : ''} aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen(v => !v)}>{label}<i aria-hidden="true" /></button>
    {open && <div className="tab-more-menu" role="menu">{children(() => setOpen(false))}</div>}
  </div>
}
