import { useState } from 'react'
import { applyDraftProductData, type PublishDraft } from './1688Api'
import { previewDraftProductData, type DraftChange } from './productAttributesApi'
import './productAttributes.css'

const message = (cause: unknown) => cause instanceof Error ? cause.message : '操作未完成，请稍后重试。'

/** Brings confirmed product data into an existing draft: shows each difference first, and only what is ticked changes. */
export default function DraftProductData({ draftId, revision, disabled, setError, applied }: { draftId: string; revision: number; disabled: boolean; setError: (text: string) => void; applied: (result: { data: PublishDraft; missing: string[] }) => void }) {
  const [changes, setChanges] = useState<DraftChange[] | null>(null), [picked, setPicked] = useState<string[]>([]), [busy, setBusy] = useState(false)
  async function open() {
    setBusy(true); setError('')
    try {
      const result = (await previewDraftProductData(draftId)).data
      setChanges(result.changes)
      // A value someone already filled in stays unless they choose to replace it.
      setPicked(result.changes.filter(c => c.current === '（空）').map(c => c.field))
    } catch (cause) { setError(message(cause)) } finally { setBusy(false) }
  }
  async function apply() {
    setBusy(true); setError('')
    try { applied(await applyDraftProductData(draftId, revision, picked)); setChanges(null) } catch (cause) { setError(message(cause)) } finally { setBusy(false) }
  }
  if (!changes) return <button className="shop-button" disabled={disabled || busy} onClick={() => void open()}>从产品资料带入</button>
  return <div className="attr-check" role="region" aria-label="从产品资料带入">
    {!changes.length ? <p>产品资料与草稿一致，没有可带入的内容。</p> : <>
      <p>勾选要带入的字段（箱规不提交平台，不在此列）：</p>
      {changes.map(c => <label key={c.field} className="attr-change"><input type="checkbox" checked={picked.includes(c.field)} onChange={e => setPicked(current => e.target.checked ? [...current, c.field] : current.filter(f => f !== c.field))} /><span><b>{c.label}</b>：{c.current} → {c.next}</span></label>)}
      <button className="primary" disabled={busy || !picked.length} onClick={() => void apply()}>带入所选</button>{' '}</>}
    <button disabled={busy} onClick={() => setChanges(null)}>关闭</button>
  </div>
}
