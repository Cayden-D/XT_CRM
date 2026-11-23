import { useEffect, useState } from 'react'
import { getMarketplace, MARKETPLACE_URL, supportWangwangUrl } from './MarketplaceHeader'
import type { MarketplaceData } from '../shared/1688-marketplace'
import type { SessionUser } from './api'
import { has } from './navigation'

const guides = [
  { title: '首次使用与店铺授权', path: 'settings/shops', permission: ['integration:read', 'performance:read', 'performance:read_own'], steps: ['进入「设置 → 店铺授权」，选择商品应用或绩效应用。两套应用需要分别授权。', '点击授权入口，在 1688 官方页面使用店铺主账号登录并同意授权，完成后返回本系统。', '检查连接状态；提示重新授权时，再次完成授权。顶部服务期来自应用订购订单，和店铺授权有效期分别计算。'] },
  { title: '采集商品与自动上架', path: 'products/collect', permission: ['collection:read'], steps: ['进入「上架 → 采集箱」，打开采集器配置，下载浏览器插件或安装油猴脚本，并按页面提示连接本系统。', '打开 1688 商品详情页，点击采集按钮，选择目标店铺。采集完成后回到采集箱检查商品图片、属性、规格、价格和库存。', '有管理权限的账号可在「设置 → 自动上架」按店铺配置发布规则、调价和图片处理，再开启自动上架。开启后，新采集商品可能直接提交平台。', '在「上架队列」查看进度和失败原因。资料不足时补齐发布草稿后重试；结果待核对时先确认平台商品，避免重复发布。最终商品审核与展示状态以 1688 为准。'] },
  { title: '图片与产品目录', path: 'images/edit', permission: [], steps: ['进入「图片 → 图片编辑」，选择商品图片或上传图片，再选择白底图、换背景或尺寸调整。需要整套商品图片时使用「电商套图」。', '检查生成结果与商品事实是否一致，确认后下载或继续编辑。', '在「产品目录」筛选店铺和商品，查看平台商品、正式产品及规格；需要发布时进入「上架 → 发布草稿」检查资料并提交。'] },
  { title: '订单、客户与聊天', path: 'orders/all', permission: ['performance:read', 'performance:read_own'], steps: ['先完成绩效应用授权与数据同步，再进入「订单」按状态、日期或关键词查看订单，打开详情核对商品、金额和物流。', '在「客户」查看线上客户、待跟进和未成交客户，按权限维护标签、跟进记录和所属客服。', '进入「聊天」查看消息记录与询盘分析，联系买家时点击旺旺入口。数据范围由账号权限决定。'] },
  { title: '客服绩效与工资', path: 'performance/comparison', permission: ['performance:read', 'performance:read_own'], steps: ['管理员在「设置 → 客服账号」完成客服与系统用户的绑定，并在「绩效规则」核对归属方案、工作时段和响应指标。', '进入「绩效」选择店铺和日期，查看客服对比、综合排行与分时接待；数据尚未同步完成时，请等待后再核对。', '有工资权限的账号可查看工资单。财务按实际工资规则生成、复核和锁定工资单。'] },
]

export default function HelpPage({ support, user }: { support: boolean; user: SessionUser }) {
  const [data, setData] = useState<MarketplaceData | null>(null)
  const [error, setError] = useState(false)
  useEffect(() => { let active = true; getMarketplace().then(value => { if (active) setData(value) }).catch(() => { if (active) setError(true) }); return () => { active = false } }, [])
  return <div className="help-page">
    {!support && <>
      <p className="help-intro">从店铺授权开始，按下面的步骤完成日常操作。页面入口会根据当前账号权限显示。</p>
      {guides.map(guide => <section className="help-section" key={guide.title}>
        <h2>{guide.title}</h2><ol>{guide.steps.map(step => <li key={step}>{step}</li>)}</ol>
        {(!guide.permission.length || has(user, ...guide.permission)) && <a href={`#/${guide.path}`}>前往操作 →</a>}
      </section>)}
      <section className="help-section"><h2>服务期与续费</h2><p>顶部常驻服务市场栏可切换应用和店铺，查看订购服务期。剩余 14 天内显示续费提醒，7 天内加强提醒。点击「订购 / 续费」进入 1688 应用市场，登录订购账号，找到对应应用完成续费。</p><p>首次查询会分段核对历史订单，可能需要几分钟；服务期查询失败时请联系客服核实。店铺授权到期与应用服务到期是两回事，重新授权不会延长订购服务期。</p></section>
    </>}
    <section className="help-section" id="support">
      <h2>联系客服</h2><p>授权、采集、发布、服务期或使用问题，请联系销途客服。请提供店铺名称、所在页面、操作时间和错误提示，便于定位问题。</p>
      {data ? <div className="help-contacts"><a href={`tel:${data.support.phone.replace(/[ -]/g, '')}`}>电话：{data.support.phone}</a><a href={supportWangwangUrl(data.support.wangwang)} target="_blank" rel="noopener noreferrer">旺旺：{data.support.wangwang}</a></div> : <p role="status">{error ? '客服信息读取失败，请刷新页面重试。' : '正在读取客服联系方式…'}</p>}
      <p>请勿向客服提供登录密码、验证码或授权令牌。</p>
    </section>
    <section className="help-section"><h2>返回市场</h2><p>通过 1688 官方市场查看应用和管理订购。</p><div className="help-contacts"><a href={MARKETPLACE_URL} target="_blank" rel="noopener noreferrer">PC 应用市场</a><a href="https://fuwu.1688.com/qn/index.html" target="_blank" rel="noopener noreferrer">千牛 PC 服务市场</a><a href="https://m-fuwu.1688.com/page/pluginlist.htm" target="_blank" rel="noopener noreferrer">千牛手机服务市场</a></div></section>
  </div>
}
