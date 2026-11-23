import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'

if (!process.env.PLAYWRIGHT_MODULE) throw new Error('PLAYWRIGHT_MODULE is required')
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE)
const browser = await chromium.launch({ headless: true, channel: 'chrome' })
const output = '/tmp/crm-marketplace-ui'
await mkdir(output, { recursive: true })
const base = process.env.CRM_UI_URL || 'http://127.0.0.1:5173'
const user = { id: 'ab611d8a-f66f-4ef0-87c2-4d1765b2afc0', email: 'review@example.test', displayName: '审核测试', roles: [], permissions: ['*'] }
let connections = [
  { id: '82ec14d5-76b1-4a3e-9be3-8d155b3e5515', purpose: 'product', name: '审核测试店铺', status: 'connected', service: { state: 'urgent', end: '2026-11-29T00:00:00.000Z', days: 6, name: '商品应用' }, checkedAt: new Date().toISOString(), syncing: false, needsSync: false, error: null, renewalUrl: 'https://app.1688.com/' },
  { id: '91f7da59-1eab-4d33-9409-69fb0effe313', purpose: 'performance', name: '审核测试店铺', status: 'connected', service: { state: 'active', end: '2026-12-13T00:00:00.000Z', days: 20, name: '绩效应用' }, checkedAt: new Date().toISOString(), syncing: false, needsSync: false, error: null, renewalUrl: 'https://app.1688.com/' },
]
const support = { phone: '18879905890', wangwang: 't_1516142198847_0435' }
let syncCalls = 0
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const errors = [], requests = []
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(() => sessionStorage.setItem('ai_crm_access_token', 'ui-only-token'))
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname
    requests.push(path)
    let body = { data: [], total: 0 }
    if (path === '/api/auth/me') body = { user }
    if (path === '/api/integrations/1688/marketplace/') body = { support, connections }
    if (path.endsWith('/sync')) {
      const c = connections.find(c => path.includes(c.id))
      syncCalls++
      c.needsSync = syncCalls < 3; c.syncing = syncCalls < 3; c.checkedAt = syncCalls < 3 ? null : new Date().toISOString()
      body = { data: c }
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })
  })
  await page.goto(base + '/#/help/guide')
  const header = page.getByRole('region', { name: '1688 服务市场' })
  await header.getByText('服务即将到期，剩余 6 天').waitFor()
  assert.ok(await header.getByRole('link', { name: '订购 / 续费' }).evaluate(el => el.classList.contains('marketplace-renew-urgent')))
  assert.equal(await header.getByRole('link', { name: '返回应用市场' }).getAttribute('href'), 'https://app.1688.com/')
  await page.getByRole('heading', { name: '首次使用与店铺授权' }).waitFor()
  assert.equal(await page.locator('a[href="tel:18879905890"]').count(), 1)
  const ww = await page.getByRole('link', { name: '旺旺：t_1516142198847_0435' }).getAttribute('href')
  assert.ok(ww.includes('touid=cnalichnt_1516142198847_0435'))
  for (const width of [320, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 })
    await page.waitForFunction(width => { const r = document.querySelector('.sidebar').getBoundingClientRect(); return width <= 820 ? r.right <= 0.5 : r.x >= 0 }, width)
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `overflow at ${width}`)
    for (const link of await header.getByRole('link').all()) {
      const box = await link.boundingBox()
      assert.ok(box && box.x >= 0 && box.x + box.width <= width + 1, `header link clipped at ${width}`)
    }
    await page.screenshot({ path: `${output}/guide-${width}.png`, fullPage: true })
  }
  await page.evaluate(() => window.scrollTo(0, 600))
  assert.equal(Math.round((await header.boundingBox()).y), 0, 'header stays visible while scrolling')
  await header.getByRole('link', { name: '联系客服' }).click()
  await page.getByRole('heading', { name: '联系客服', exact: true }).waitFor()
  await page.getByRole('link', { name: '电话：18879905890' }).waitFor()
  await header.getByLabel('查看应用与店铺服务期').selectOption(`performance/${connections[1].id}`)
  await header.getByText('剩余服务时间 20 天').waitFor()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await header.getByLabel('查看应用与店铺服务期').selectOption(`product/${connections[0].id}`)
  assert.equal(await header.getByRole('link', { name: '订购 / 续费' }).evaluate(el => getComputedStyle(el).animationName), 'none')
  await header.getByRole('link', { name: '使用指南' }).focus()
  await page.keyboard.press('Enter')
  await page.getByRole('heading', { name: '首次使用与店铺授权' }).waitFor()
  assert.ok(await header.getByRole('link', { name: '返回应用市场' }).isVisible())
  await page.evaluate(() => { window.location.hash = '#/performance/comparison' })
  await page.getByRole('button', { name: '更多', exact: true }).click()
  const menu = await page.getByRole('menu').boundingBox(), bar = await page.locator('.topbar').boundingBox()
  assert.ok(menu.y >= bar.y + bar.height - 1, 'tab popup must appear below the new service header')
  await page.keyboard.press('Escape')
  assert.equal(await page.getByRole('menu').count(), 0)
  await header.getByRole('link', { name: '使用指南' }).click()
  // Missing order and error states preserve all required service/help links.
  connections = connections.map(c => ({ ...c, error: '平台暂不可用', service: { state: 'unknown', days: null, end: null, name: null } }))
  await page.reload()
  await header.getByText('服务期暂无法核实').waitFor()
  await header.getByRole('link', { name: '联系客服' }).waitFor()
  connections = []
  await page.reload()
  await header.getByText('授权店铺后查询服务期').waitFor()
  await header.getByRole('link', { name: '返回应用市场' }).waitFor()
  // Historical pagination automatically continues after each response.
  connections = [{ id: '82ec14d5-76b1-4a3e-9be3-8d155b3e5515', purpose: 'product', name: '历史扫描店铺', status: 'connected', service: { state: 'unknown', days: null, end: null, name: null }, checkedAt: null, syncing: true, needsSync: true, error: null, renewalUrl: 'https://app.1688.com/' }]
  await page.reload()
  await header.getByText('服务期待核实').waitFor()
  assert.equal(syncCalls, 3, 'three history pages must continue without a reload')
  assert.deepEqual(errors, [])
  console.log(`1688 marketplace UI passed: 320/768/1024/1440, permanent links, help/contact navigation, phone/Wangwang URLs, app switch, keyboard, reduced motion, empty/error states and history continuation. Screenshots: ${output}`)
} finally { await browser.close() }
