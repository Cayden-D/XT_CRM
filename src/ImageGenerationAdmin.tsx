import { useEffect, useState } from 'react'
import { request } from './api'

type Settings = { replacementPlan: string; quality: string; resolution: string; revision: number }
type Plan = { id: string; label: string }
const path = '/api/image-workshop/generation-settings'
const message = (cause: unknown) => cause instanceof Error ? cause.message : '无法保存设置，请稍后重试。'

export default function ImageGenerationAdmin() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [plans, setPlans] = useState<Plan[]>([])
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')

  async function load() {
    setBusy(true); setError(''); setNotice('')
    try {
      const result = await request<{ data: Settings; plans: Plan[] }>(path)
      setSettings(result.data)
      setPlans(result.plans)
    } catch (cause) { setError(message(cause)) }
    finally { setBusy(false) }
  }
  useEffect(() => { void load() }, [])

  async function save() {
    if (!settings) return
    setBusy(true); setError(''); setNotice('')
    try {
      const { data } = await request<{ data: Settings }>(path, { method: 'PUT', body: JSON.stringify(settings) })
      setSettings(data)
      setNotice('已保存，新生成的图片将使用此设置。')
    } catch (cause) { setError(message(cause)) }
    finally { setBusy(false) }
  }

  return <section className="teams-admin" aria-labelledby="generation-settings-title">
    <div className="shop-page-heading">
      <div><h3 id="generation-settings-title">图片生成设置</h3>
        <p>质量和分辨率用于本工作区的新任务。团队图像方案 C 的质量由服务自动决定。</p></div>
      <button className="shop-button" type="button" onClick={() => void load()} disabled={busy}>刷新设置</button>
    </div>
    {error && <p className="shop-alert error" role="alert">{error}</p>}
    {notice && <p className="shop-alert" role="status">{notice}</p>}
    {settings && <form className="users-form" onSubmit={event => { event.preventDefault(); void save() }}>
      <div className="shop-form-columns">
        <label>替代主图方案
          <select value={settings.replacementPlan} disabled={busy} onChange={event => setSettings({ ...settings, replacementPlan: event.target.value })}>
            {plans.map(plan => <option key={plan.id} value={plan.id}>{plan.label}</option>)}
          </select>
        </label>
        <label>默认生图质量
          <select value={settings.quality} disabled={busy} onChange={event => setSettings({ ...settings, quality: event.target.value })}>
            <option value="low">基础</option><option value="medium">标准</option>
            <option value="high">高</option><option value="xhigh">最高</option>
          </select>
        </label>
        <label>默认分辨率
          <select value={settings.resolution} disabled={busy} onChange={event => setSettings({ ...settings, resolution: event.target.value })}>
            <option value="1k">1K</option><option value="2k">2K</option>
          </select>
        </label>
      </div>
      <div><button className="shop-button primary" type="submit" disabled={busy}>保存图片生成设置</button></div>
    </form>}
  </section>
}
