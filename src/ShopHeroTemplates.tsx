import { useEffect, useRef, useState } from 'react'
import { ImageUp, Pencil, Trash2 } from 'lucide-react'
import {
  addHeroTemplate, deleteHeroTemplate, editHeroTemplate, fileToBase64, getHeroTemplateShops, saveHeroTemplate, saveShopHeroCopy,
  type CustomHeroTemplate, type HeroTemplateMode, type HeroTemplateShop,
} from './imageApi'

const modes: Record<HeroTemplateMode, string> = { none: '普通首图', 'tuoyang-v1': '拓洋黑金模板', 'custom-v1': '自定义模板' }
const errorMessage = (error:unknown) => error instanceof Error ? error.message : '首图模板操作失败，请重试。'

function useHeroTemplateShops() {
  const [shops, setShops] = useState<HeroTemplateShop[]|null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let current = true
    getHeroTemplateShops().then(({ data }) => { if (current) setShops(data) })
      .catch(cause => { if (current) setError(errorMessage(cause)) })
    return () => { current = false }
  }, [])
  return { shops, setShops, error }
}

export function HeroShopPicker({ shopId, change, followProduct, disabled, label = '首图店铺' }:{
  shopId?:string|null; change:(id:string|null|undefined)=>void; followProduct:boolean; disabled?:boolean; label?:string
}) {
  const { shops, error } = useHeroTemplateShops()
  const value = shopId === undefined && followProduct ? 'product' : shopId ?? ''
  return <label className="iw-field iw-hero-shop-picker">{label}
    <select value={value} disabled={disabled || !shops} onChange={e => change(e.target.value === 'product' ? undefined : e.target.value || null)}>
      {followProduct && <option value="product">跟随商品的目标店铺</option>}
      <option value="">企业通用</option>
      {shops?.map(shop => <option value={shop.id} key={shop.id}>
        {shop.display_name} · {shop.templates.find(template => template.id === shop.activeTemplateId)?.name ?? modes[shop.mode]}
      </option>)}
    </select>
    {error && <small className="iw-error" role="status">{error}</small>}
  </label>
}

type Editor = { kind:'add' } | { kind:'edit'; template:CustomHeroTemplate } | { kind:'copy' }

function TemplateEditor({ editor, busy, submit, cancel }:{
  editor:Exclude<Editor,{kind:'copy'}>; busy:boolean; submit:(name:string,file?:File)=>void; cancel:()=>void
}) {
  const nameInput = useRef<HTMLInputElement>(null)
  const [name, setName] = useState(editor.kind === 'edit' ? editor.template.name : '')
  const [file, setFile] = useState<File>()
  useEffect(() => { nameInput.current?.focus() }, [])
  return <form className="iw-shop-template-edit" onSubmit={e => { e.preventDefault(); submit(name.trim(), file) }}>
    <label className="iw-field">模板名称
      <input ref={nameInput} required maxLength={80} disabled={busy} value={name} onChange={e => setName(e.target.value)}/>
    </label>
    <label className="iw-field">{editor.kind === 'add' ? '参考图片' : '更换参考图片（可选）'}
      <input type="file" accept="image/png,image/jpeg,image/webp" required={editor.kind === 'add'} disabled={busy} onChange={e => setFile(e.target.files?.[0])}/>
    </label>
    <div className="iw-shop-template-actions">
      <button className="shop-button primary" type="submit" disabled={busy || !name.trim() || (editor.kind === 'add' && !file)}>{busy ? '正在保存…' : '保存'}</button>
      <button className="shop-button" type="button" disabled={busy} onClick={cancel}>取消</button>
    </div>
  </form>
}

function ShopCopyEditor({ shop, busy, save, cancel }:{
  shop:HeroTemplateShop; busy:boolean; save:(origin:string|null,notes:string[])=>void; cancel:()=>void
}) {
  const originField = useRef<HTMLInputElement>(null)
  const [origin, setOrigin] = useState(shop.heroOrigin ?? '')
  const [notes, setNotes] = useState([shop.heroNotes?.[0] ?? '', shop.heroNotes?.[1] ?? ''])
  useEffect(() => { originField.current?.focus() }, [])
  return <form className="iw-shop-template-edit" onSubmit={event => {
    event.preventDefault()
    save(origin.trim() || null, [...new Set(notes.map(note => note.trim()).filter(Boolean))])
  }}>
    <label className="iw-field">产地（选填）
      <input ref={originField} value={origin} maxLength={24} disabled={busy} onChange={e => setOrigin(e.target.value)} placeholder="例如 浙江义乌"/>
    </label>
    {notes.map((note,index) => <label key={index} className="iw-field">固定短语 {index + 1}（选填）
      <input value={note} maxLength={16} disabled={busy} onChange={e => setNotes(current => current.map((value,i) => i === index ? e.target.value : value))}/>
    </label>)}
    <div className="iw-shop-template-actions">
      <button className="shop-button primary" type="submit" disabled={busy}>{busy ? '正在保存…' : '保存文案'}</button>
      <button className="shop-button" type="button" disabled={busy} onClick={cancel}>取消</button>
    </div>
  </form>
}

function ShopTemplateRow({ shop, editable, changed }:{shop:HeroTemplateShop;editable:boolean;changed:(next:HeroTemplateShop)=>void}) {
  const addButton = useRef<HTMLButtonElement>(null)
  const editorTrigger = useRef<HTMLButtonElement | null>(null)
  const [editor, setEditor] = useState<Editor | null>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const revision = shop.revision
  const fixedCopy = [...(shop.heroOrigin ? [`产地 ${shop.heroOrigin}`] : []), ...(shop.heroNotes ?? [])]

  async function run(action:()=>Promise<{data:HeroTemplateShop}>, message:string, done?:()=>void) {
    setBusy(true); setError(''); setNotice('')
    try {
      changed((await action()).data)
      setNotice(message)
      done?.()
    } catch (cause) { setError(errorMessage(cause)) } finally { setBusy(false) }
  }
  function startEditing(next:Editor, trigger:HTMLButtonElement) {
    editorTrigger.current = trigger
    setEditor(next); setError(''); setNotice('')
  }
  function closeEditor() {
    setEditor(null)
    requestAnimationFrame(() => editorTrigger.current?.focus())
  }
  function save(name:string, file?:File) {
    async function encode(image:File) {
      if (image.size > 8 * 1024 * 1024) throw new Error('模板图片需在 8 MB 以内。')
      return fileToBase64(image)
    }
    if (editor?.kind === 'edit') {
      void run(async () => editHeroTemplate(shop.id, editor.template.id, { name, revision, content:file && await encode(file) }), '已保存模板', closeEditor)
    } else if (file) {
      void run(async () => addHeroTemplate(shop.id, { name, revision, content:await encode(file) }), '已添加模板，可在「使用模板」中选择。', closeEditor)
    }
  }
  function select(value:string) {
    if (value === 'none' || value === 'tuoyang-v1') {
      void run(() => saveHeroTemplate(shop.id, { mode:value, revision }), '已切换模板')
    } else {
      void run(() => saveHeroTemplate(shop.id, { mode:'custom-v1', templateId:value, revision }), '已切换模板')
    }
  }
  function remove(template:CustomHeroTemplate) {
    const active = shop.activeTemplateId === template.id
    const message = active ? '删除后，该店铺新生成的首图会切回普通首图。' : ''
    if (window.confirm(`删除模板「${template.name}」？${message}`)) {
      void run(() => deleteHeroTemplate(shop.id, template.id, revision), active ? '已删除模板，已切回普通首图。' : '已删除模板', () => {
        requestAnimationFrame(() => addButton.current?.focus())
      })
    }
  }

  return <li className="iw-shop-template" aria-busy={busy}>
    <div className="iw-shop-template-header">
      <strong>{shop.display_name}</strong>
      <label className="iw-field">使用模板
        <select aria-label={`${shop.display_name} 使用模板`} value={shop.activeTemplateId ?? shop.mode}
          disabled={!editable || busy || Boolean(editor)} onChange={e => select(e.target.value)}>
          <option value="none">{modes.none}</option>
          <option value="tuoyang-v1">{modes['tuoyang-v1']}</option>
          {shop.templates.map(template => <option key={template.id} value={template.id}>{template.name}</option>)}
        </select>
      </label>
    </div>
    <div className="iw-shop-template-fixed">
      <span>{fixedCopy.length ? fixedCopy.join(' · ') : '未设置首图固定文案'}</span>
      {editable && <button className="shop-button" type="button" disabled={busy || Boolean(editor)} aria-label={`${shop.display_name} 编辑固定文案`}
        onClick={e => startEditing({ kind:'copy' }, e.currentTarget)}>编辑固定文案</button>}
    </div>
    {shop.templates.length > 0 && <ul className="iw-shop-template-list" aria-label={`${shop.display_name} 自定义模板`}>
      {shop.templates.map(template => <li key={template.id}>
        {template.previewUrl && <img src={template.previewUrl} loading="lazy" alt="" referrerPolicy="no-referrer"/>}
        <span className="iw-shop-template-name">{template.name}{shop.activeTemplateId === template.id && <small>使用中</small>}
          {template.adaptive === false && <small>固定边框</small>}
        </span>
        {editable && <div className="iw-shop-template-actions">
          <button className="shop-button" type="button" disabled={busy || Boolean(editor)} aria-label={`编辑 ${template.name}`}
            onClick={e => startEditing({ kind:'edit', template }, e.currentTarget)}><Pencil size={14} aria-hidden="true"/>编辑</button>
          <button className="shop-button" type="button" disabled={busy || Boolean(editor)} aria-label={`删除 ${template.name}`}
            onClick={() => remove(template)}><Trash2 size={14} aria-hidden="true"/>删除</button>
        </div>}
      </li>)}
    </ul>}
    {editor?.kind === 'copy' ? <ShopCopyEditor shop={shop} busy={busy} cancel={closeEditor}
      save={(origin,notes) => void run(() => saveShopHeroCopy(shop.id, { origin, notes, revision }), '已保存首图固定文案', closeEditor)}/> :
      editor && <TemplateEditor editor={editor} busy={busy} submit={save} cancel={closeEditor}/>}
    {editable && <button ref={addButton} className="shop-button iw-shop-template-add" type="button" disabled={busy || Boolean(editor)}
      onClick={e => startEditing({ kind:'add' }, e.currentTarget)} aria-label={`${shop.display_name} 添加模板`}>
      <ImageUp size={15} aria-hidden="true"/>添加模板
    </button>}
    {error && <small className="iw-error iw-shop-template-message" role="alert">{error}</small>}
    {notice && <small className="iw-shop-template-message" role="status">{notice}</small>}
  </li>
}

export default function ShopHeroTemplates({ editable }:{ editable:boolean }) {
  const { shops, setShops, error } = useHeroTemplateShops()
  return <section className="iw-shop-templates" aria-labelledby="iw-shop-templates-title">
    <h4 id="iw-shop-templates-title">1688 首图参考模板</h4>
    <p>自定义模板支持 PNG、JPG、WebP，自动识别边框并为商品留出空间。显示「固定边框」的模板可编辑并重新上传，优先使用中间透明或留空的模板原图。</p>
    {error ? <p className="iw-error" role="alert">{error}</p> : shops === null ? <p role="status">正在读取店铺…</p> : shops.length === 0 ? <p>还没有授权商品应用的店铺。</p> :
      <ul className="iw-shop-template-shops">{shops.map(shop => <ShopTemplateRow key={shop.id} shop={shop} editable={editable}
        changed={next => setShops(list => list?.map(row => row.id === next.id ? next : row) ?? null)}/>)}</ul>}
  </section>
}
