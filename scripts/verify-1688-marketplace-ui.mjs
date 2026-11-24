import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'

if (!process.env.PLAYWRIGHT_MODULE) throw new Error('PLAYWRIGHT_MODULE is required')
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE)
const browser = await chromium.launch({ headless: true, channel: 'chrome' })
const output = '/tmp/crm-marketplace-ui'
await mkdir(output, { recursive: true })
const base = process.env.CRM_UI_URL || 'http://127.0.0.1:5173'
const user = { id: 'ab611d8a-f66f-4ef0-87c2-4d1765b2afc0', email: 'review@example.test', displayName: '审核测试', roles: [], permissions: ['*'] }
const support = { phone: '18879905890', wangwang: 't_1516142198847_0435' }
let supportError = false
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
    if (path === '/api/integrations/1688/marketplace/support') {
      if (supportError) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: '暂不可用' }) })
      body = { support }
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })
  })
  await page.goto(base + '/#/help/guide')
  const links = page.getByRole('navigation', { name: '服务与帮助' })
  await page.getByRole('heading', { name: '首次使用与店铺授权' }).waitFor()
  await page.getByRole('link', { name: '电话客服', exact: true }).waitFor()
  assert.equal(await page.locator('.marketplace-header,.marketplace-brand,.marketplace-service').count(), 0, 'no duplicate marketplace header')
  assert.equal(await page.locator('header.topbar').count(), 1)
  const logo = links.getByRole('link', { name: '联系客服' }).locator('img')
  await logo.evaluate(img => img.decode())
  assert.ok(await logo.evaluate(img => img.complete && img.naturalWidth > 0), 'provided support SVG must render')
  const ww = await page.getByRole('link', { name: '旺旺客服', exact: true }).getAttribute('href')
  assert.ok(ww.includes('touid=cnalichnt_1516142198847_0435'))
  assert.equal(await page.getByRole('link', { name: '电话客服', exact: true }).getAttribute('href'), 'tel:18879905890')
  assert.ok(!(await page.locator('body').innerText()).includes(support.phone), 'phone number must not be visible')
  assert.ok(!(await page.locator('body').innerText()).includes(support.wangwang), 'Wangwang account must not be visible')
  const floating = page.getByRole('link', { name: '联系旺旺客服', exact: true })
  assert.equal(await floating.getAttribute('href'), ww)
  assert.equal(await floating.getAttribute('target'), '_blank')
  await page.context().route('https://air.1688.com/**', route => route.fulfill({ contentType: 'text/html', body: '<title>Mock customer chat</title>' }))
  const opened = page.waitForEvent('popup')
  await floating.click()
  const popup = await opened
  await popup.waitForLoadState()
  assert.equal(popup.url(), ww, 'edge icon opens the configured Wangwang chat')
  await popup.close()
  assert.equal(await page.getByRole('link', { name: '千牛 PC 服务市场' }).getAttribute('href'), 'https://fuwu.1688.com/qn/index.html')
  assert.equal(await page.getByRole('link', { name: '千牛手机服务市场' }).getAttribute('href'), 'https://m-fuwu.1688.com/page/pluginlist.htm')
  for (const width of [320, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 })
    await page.waitForFunction(width => { const r = document.querySelector('.sidebar').getBoundingClientRect(); return width <= 820 ? r.right <= 0.5 : r.x >= 0 }, width)
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `overflow at ${width}`)
    const market = links.getByRole('link', { name: '应用市场', exact: true })
    await page.waitForFunction(href => document.querySelector('.app-service-links a:last-child').href === href, width <= 820 ? 'https://m-fuwu.1688.com/page/pluginlist.htm' : 'https://app.1688.com/')
    assert.equal(await market.getAttribute('target'), '_blank')
    for (const link of await links.getByRole('link').all()) {
      const box = await link.boundingBox()
      assert.ok(box && box.x >= 0 && box.x + box.width <= width + 1, `service link clipped at ${width}`)
      const clickable = await link.evaluate(el => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)) })
      assert.ok(clickable, `service link obscured at ${width}`)
    }
    const box = await links.boundingBox(), bar = await page.locator('.topbar').boundingBox()
    assert.ok(width <= 820 ? box.y + box.height >= 999 : box.y >= bar.y && box.y + box.height <= bar.y + bar.height, `wrong service link placement at ${width}`)
    const floatingBox = await floating.boundingBox()
    assert.ok(Math.abs(floatingBox.x + floatingBox.width - width) <= 1, `floating support must snap to right edge at ${width}`)
    assert.ok(floatingBox.y > 56 && floatingBox.y + floatingBox.height < (width <= 820 ? box.y : 1000), `floating support overlaps toolbar or bottom nav at ${width}`)
    assert.ok(await floating.evaluate(el => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)) }), `floating support obscured at ${width}`)
    await page.screenshot({ path: `${output}/guide-${width}.png`, fullPage: false })
  }
  await page.evaluate(() => window.scrollTo(0, 600))
  assert.equal(Math.round((await page.locator('.topbar').boundingBox()).y), 0, 'toolbar stays visible while scrolling')
  assert.equal(Math.round((await floating.boundingBox()).y), 470, 'floating support stays fixed during scrolling')
  const contactReads = requests.filter(path => path.endsWith('/marketplace/support')).length
  await links.getByRole('link', { name: '联系客服' }).click()
  await page.getByRole('heading', { name: '联系客服', exact: true }).waitFor()
  await page.getByRole('link', { name: '电话客服', exact: true }).waitFor()
  await page.waitForFunction(() => window.scrollY === 0)
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await page.screenshot({ path: `${output}/support-desktop.png`, fullPage: false })
  await links.getByRole('link', { name: '使用指南' }).focus()
  await page.keyboard.press('Enter')
  await page.getByRole('heading', { name: '首次使用与店铺授权' }).waitFor()
  await page.evaluate(() => { window.location.hash = '#/performance/comparison' })
  await page.getByRole('button', { name: '更多', exact: true }).click()
  const menu = await page.getByRole('menu').boundingBox(), bar = await page.locator('.topbar').boundingBox()
  assert.ok(menu.y >= bar.y + bar.height - 1, 'tab popup appears below the toolbar')
  await page.keyboard.press('Escape')
  assert.equal(await page.getByRole('menu').count(), 0)
  assert.ok(await links.isVisible())
  assert.ok(await floating.isVisible(), 'floating support is available beyond the help page')
  assert.equal(requests.filter(path => path.endsWith('/marketplace/support')).length, contactReads, 'navigation reuses loaded support configuration')
  await page.setViewportSize({ width: 320, height: 740 })
  await page.waitForFunction(() => document.querySelector('.sidebar').getBoundingClientRect().right <= 0.5)
  await links.getByRole('link', { name: '联系客服' }).click()
  await page.getByRole('link', { name: '电话客服', exact: true }).waitFor()
  await page.screenshot({ path: `${output}/support-mobile.png`, fullPage: false })
  supportError = true
  await page.reload()
  await page.getByRole('button', { name: '重新加载客服信息' }).waitFor()
  assert.equal(await floating.getAttribute('href'), '#/help/support', 'failed contact load falls back to help')
  assert.ok(await links.getByRole('link', { name: '应用市场', exact: true }).isVisible())
  supportError = false
  await page.getByRole('button', { name: '重新加载客服信息' }).click()
  await page.getByRole('link', { name: '电话客服', exact: true }).waitFor()
  await page.waitForTimeout(1200)
  assert.deepEqual(requests.filter(path => path.includes('/marketplace') && !path.endsWith('/support')), [], 'no subscription lookup or automatic sync')
  assert.deepEqual(errors, [])
  console.log(`1688 service links UI passed: no duplicate header or subscription queries; desktop toolbar/mobile bottom links at 320/768/1024/1440; supplied SVG, help/contact navigation, all market URLs, icon-only phone/Wangwang buttons, fixed edge chat, keyboard, popup placement and contact error recovery. Screenshots: ${output}`)
} finally { await browser.close() }
