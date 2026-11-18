import { useEffect, useRef, useState } from 'react'
import { ArrowRight, Globe2, Radio, ShieldCheck } from 'lucide-react'
import { finish1688SignIn, start1688SignIn } from './signIn1688'

export default function LoginPage({ returning = false }: { returning?: boolean }) {
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(returning)
  const started = useRef(false)

  function failed(cause: unknown) {
    setError(cause instanceof Error && !(cause instanceof TypeError) ? cause.message : '暂时无法连接登录服务，请稍后重试。')
    setLoading(false)
  }

  useEffect(() => {
    if (!returning || started.current) return
    started.current = true
    void finish1688SignIn().catch(failed)
  }, [returning])

  function authorize() {
    setError('')
    setLoading(true)
    void start1688SignIn().catch(failed)
  }

  return <main className="login-page">
    <section className="login-signal">
      <div className="login-brand"><div className="brand-mark"><span /></div><div><b>销途</b><small>AI CRM</small></div></div>
      <div className="signal-copy"><p className="signal-code"><Radio size={14} /> 实时 · 1688 店铺工作台</p><h1>每一次跟进，<br />都更接近成交。</h1><p>连接 1688 商品上架、客服绩效与客户经营，让每一次接待和复购都有据可依。</p></div>
      <div className="login-route" aria-label="1688 店铺经营全链路">
        {['采集', '上架', '接待', '成交', '跟进', '复购'].map((item, i) => <div key={item}><span>{i + 1}</span><b>{item}</b></div>)}
      </div>
      <div className="signal-foot"><span><Globe2 size={15} /> 上海 · 北京时间</span><span><ShieldCheck size={15} /> 租户数据隔离已启用</span></div>
    </section>
    <section className="login-form-side">
      <div className="login-card">
        <p className="kicker">销途绩效</p>
        <h2>进入工作台</h2>
        <p className="login-intro">使用 1688 账号授权，完成后即可进入工作台。</p>
        {error && <div className="form-error" role="alert">{error}</div>}
        <button type="button" className="login-submit" disabled={loading} onClick={authorize}>
          {loading ? <span role="status">{returning ? '正在完成 1688 登录…' : '正在打开 1688 授权…'}</span> : <>使用 1688 账号授权登录 <ArrowRight size={17} aria-hidden="true" /></>}
        </button>
      </div>
    </section>
  </main>
}
