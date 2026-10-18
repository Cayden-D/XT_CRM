import { useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'

/** Page numbers to show: first, last, current ±1, with gaps marked as null. */
export function pageList(page: number, pages: number): (number | null)[] {
  const wanted = new Set([1, pages, page - 1, page, page + 1].filter(n => n >= 1 && n <= pages))
  const sorted = [...wanted].sort((a, b) => a - b), out: (number | null)[] = []
  sorted.forEach((n, i) => { if (i && n - sorted[i - 1] > 1) out.push(n - sorted[i - 1] === 2 ? n - 1 : null); out.push(n) })
  return out
}

/** Value that settles `delay` ms after the last change (for search boxes). */
export function useDebounced<T>(value: T, delay = 300) {
  const [settled, setSettled] = useState(value)
  useEffect(() => { const timer = setTimeout(() => setSettled(value), delay); return () => clearTimeout(timer) }, [value, delay])
  return settled
}

export default function Pagination({ page, pageSize, total, onPage, onPageSize, sizes = [12, 24, 48], unit = '条' }: {
  page: number; pageSize: number; total: number; onPage: (page: number) => void; onPageSize?: (size: number) => void; sizes?: number[]; unit?: string
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize))
  if (total <= Math.min(pageSize, ...sizes)) return null
  const from = (page - 1) * pageSize + 1, to = Math.min(page * pageSize, total)
  return <nav className="pager" aria-label="分页">
    <span className="pager-summary">第 {from}–{to} {unit}，共 {total.toLocaleString('zh-CN')} {unit}</span>
    <div className="pager-pages">
      <button onClick={() => onPage(page - 1)} disabled={page <= 1} aria-label="上一页"><ChevronLeft size={16} /></button>
      {pageList(page, pages).map((n, i) => n == null ? <span key={`gap${i}`} className="pager-gap">…</span>
        : <button key={n} className={n === page ? 'active' : ''} aria-current={n === page ? 'page' : undefined} onClick={() => onPage(n)}>{n}</button>)}
      <button onClick={() => onPage(page + 1)} disabled={page >= pages} aria-label="下一页"><ChevronRight size={16} /></button>
    </div>
    {onPageSize && <label className="pager-size">每页<select value={pageSize} onChange={e => onPageSize(Number(e.target.value))}>{sizes.map(s => <option key={s} value={s}>{s}</option>)}</select>{unit}</label>}
  </nav>
}
