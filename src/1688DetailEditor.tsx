import { useEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, Code2, ImagePlus, Link2, LoaderCircle, Trash2, Type } from 'lucide-react'

/**
 * 详情描述 as pictures: the platform's description is HTML (paragraphs of text and <img>). It is shown as a list of
 * picture / text blocks that can be reordered, removed, added (upload to the shop album, or an Alibaba picture URL),
 * and written back as plain HTML. Anything else in the HTML (tables, styled markup) is kept untouched as a raw block;
 * the HTML source stays editable for those cases.
 */
type Block = { kind: 'image'; url: string } | { kind: 'text'; text: string } | { kind: 'raw'; html: string }
const escape = (text: string) => text.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))
const imageSrc = (url: string) => url.startsWith('img/') ? `https://cbu01.alicdn.com/${url}` : url.startsWith('//') ? `https:${url}` : url
const SIMPLE = new Set(['P', 'DIV', 'SPAN', 'BR', 'IMG', 'STRONG', 'B', 'EM', 'I', 'CENTER', 'FONT'])
const ALIBABA_IMAGE = /^https:\/\/(cbu\d+\.alicdn\.com|img\.alicdn\.com|gw\.alicdn\.com)\//i

export function parseDetail(html: string): Block[] {
  if (!html.trim()) return []
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')
  const blocks: Block[] = []
  const simple = (el: Element): boolean => SIMPLE.has(el.tagName) && !el.getAttribute('style') && [...el.children].every(simple)
  for (const node of [...doc.body.childNodes]) {
    if (node.nodeType === Node.TEXT_NODE) { const text = node.textContent?.trim(); if (text) blocks.push({ kind: 'text', text }); continue }
    if (node.nodeType !== Node.ELEMENT_NODE) continue
    const el = node as Element
    if (!simple(el)) { blocks.push({ kind: 'raw', html: el.outerHTML }); continue }
    // Split a simple paragraph into its text and pictures, in order.
    let text = ''
    const flush = () => { const t = text.replace(/\s+/g, ' ').trim(); if (t) blocks.push({ kind: 'text', text: t }); text = '' }
    const walk = (n: Node) => {
      if (n.nodeType === Node.TEXT_NODE) { text += n.textContent ?? ''; return }
      if (n.nodeType !== Node.ELEMENT_NODE) return
      const e = n as Element
      if (e.tagName === 'IMG') { flush(); const src = e.getAttribute('src'); if (src) blocks.push({ kind: 'image', url: src }); return }
      if (e.tagName === 'BR') { text += '\n'; return }
      e.childNodes.forEach(walk)
    }
    walk(el); flush()
  }
  return blocks
}
export const serializeDetail = (blocks: Block[]) => blocks.map(b => b.kind === 'image' ? `<p><img src="${escape(b.url)}" alt="商品详情"></p>` : b.kind === 'text' ? `<p>${escape(b.text)}</p>` : b.html).join('')

export default function DetailEditor({ html, editable, busy, onChange, upload }: { html: string; editable: boolean; busy: boolean; onChange: (html: string) => void; upload?: (file: File) => Promise<string> }) {
  // Blocks are the working copy; the HTML is re-read only when it changes from outside (source edits, a reloaded draft).
  const [blocks, setBlocks] = useState<Block[]>(() => parseDetail(html)), emitted = useRef(html)
  useEffect(() => { if (html !== emitted.current) { emitted.current = html; setBlocks(parseDetail(html)) } }, [html])
  const [source, setSource] = useState(false), [url, setUrl] = useState(''), [uploading, setUploading] = useState(false), [error, setError] = useState('')
  const set = (next: Block[]) => { setBlocks(next); emitted.current = serializeDetail(next); onChange(emitted.current) }
  const move = (i: number, d: -1 | 1) => { const next = [...blocks]; [next[i], next[i + d]] = [next[i + d], next[i]]; set(next) }
  const images = blocks.filter(b => b.kind === 'image').length
  async function add(files: FileList | null) {
    if (!files?.length || !upload) return
    setUploading(true); setError('')
    try { const urls: string[] = []; for (const f of [...files]) urls.push(await upload(f)); set([...blocks, ...urls.map(u => ({ kind: 'image' as const, url: u }))]) }
    catch (cause) { setError(cause instanceof Error ? cause.message : '上传失败。') } finally { setUploading(false) }
  }
  function addUrl() {
    const value = url.trim()
    if (!ALIBABA_IMAGE.test(imageSrc(value))) { setError('只能添加阿里图片地址（cbu01.alicdn.com 等），其他图片请先上传到店铺相册。'); return }
    setError(''); setUrl(''); set([...blocks, { kind: 'image', url: imageSrc(value) }])
  }
  return <div className="detail-editor">
    <div className="detail-editor-head"><span className="shop-field-label">详情描述</span><small>{images} 张详情图{blocks.some(b => b.kind === 'text') ? ` · ${blocks.filter(b => b.kind === 'text').length} 段文字` : ''}</small>
      <button type="button" className="shop-button" onClick={() => setSource(!source)}><Code2 size={15} />{source ? '图文模式' : 'HTML 源码'}</button></div>
    {source ? <textarea className="detail-source" rows={10} disabled={!editable || busy} value={html} onChange={e => onChange(e.target.value)} aria-label="详情 HTML 源码" />
      : <ol className="detail-blocks">{blocks.map((b, i) => <li key={i} className={`detail-block ${b.kind}`}>
        {b.kind === 'image' ? <img src={imageSrc(b.url)} alt={`详情图 ${i + 1}`} loading="lazy" referrerPolicy="no-referrer" />
          : b.kind === 'text' ? <textarea rows={2} value={b.text} disabled={!editable || busy} aria-label={`详情文字 ${i + 1}`} onChange={e => set(blocks.map((x, j) => j === i ? { kind: 'text', text: e.target.value } : x))} />
          : <div className="detail-raw" title="复杂格式，请在 HTML 源码中修改"><Code2 size={14} />复杂格式内容（{b.html.length} 字符），保持原样</div>}
        {editable && <div className="detail-block-tools">
          <button type="button" title="上移" aria-label="上移" disabled={busy || i === 0} onClick={() => move(i, -1)}><ArrowUp size={14} /></button>
          <button type="button" title="下移" aria-label="下移" disabled={busy || i === blocks.length - 1} onClick={() => move(i, 1)}><ArrowDown size={14} /></button>
          <button type="button" title="删除" aria-label="删除" disabled={busy} onClick={() => set(blocks.filter((_, j) => j !== i))}><Trash2 size={14} /></button></div>}
      </li>)}{!blocks.length && <li className="detail-empty">还没有详情内容</li>}</ol>}
    {editable && !source && <div className="detail-add">
      {upload && <label className={`shop-button ${uploading || busy ? 'disabled' : ''}`}>{uploading ? <LoaderCircle size={15} className="spin" /> : <ImagePlus size={15} />}上传详情图
        <input type="file" hidden multiple accept="image/jpeg,image/png,image/gif,image/bmp" disabled={uploading || busy} onChange={e => { void add(e.target.files); e.target.value = '' }} /></label>}
      <button type="button" className="shop-button" disabled={busy} onClick={() => set([...blocks, { kind: 'text', text: '' }])}><Type size={15} />添加文字</button>
      <div className="detail-url"><input value={url} placeholder="粘贴阿里图片地址" aria-label="图片地址" onChange={e => setUrl(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addUrl() } }} />
        <button type="button" className="shop-button" disabled={busy || !url.trim()} onClick={addUrl}><Link2 size={15} />添加</button></div>
    </div>}
    {error && <p className="shop-local-error" role="alert">{error}</p>}
  </div>
}
