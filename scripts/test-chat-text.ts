import assert from 'node:assert/strict'
import { analyzeAgentText, messageImages } from '../server/integrations/chat-text.js'

// Rules checked against real agent replies (2026-10-16 backfill review); flags sorted for comparison.
const f = (text: string, types = ['正常消息']) => analyzeAgentText(text, types).flags.sort()
const cases: [string, string[]][] = [
  ['嗯嗯', ['short']], ['包边有颜色', []], ['好的，亲，这款现货 48 小时内发货，包邮', []],
  // off-platform risks
  ['加我微信 abc_12345 发你实拍', ['wechat']], ['电话 138 1234 5678 随时联系', ['phone']], ['qq: 12345678', ['qq']], ['wei xin 同号', ['wechat']],
  ['可以微信转账给我，便宜点', ['offsite']], ['详情看 https://shop.example.cn/x', ['external_link']],
  // not risks: platform links, CDN paths with digits, the shop's own return address with phone
  ['链接 https://detail.1688.com/offer/1.html', []], ['https://msg2.cloudvideocdn.taobao.com/dHbN8q/13812345678abc', []],
  ['义乌市廿三里街道花仙路565号  进院子左拐1号电梯  13812345678', ['address']], ['陈 13812345678 浙江省义乌市廿三里街道（1号电梯上7楼处）', ['address']],
  ['订单号 260915004635000 已发货', []],
  // curt wording: only clearly dismissive phrases
  ['听不明白', ['curt']], ['你自己看详情', ['curt']], ['这个不清楚呢亲', []], ['我已经和快递说了 明天应该是会派送过去的', []], ['亲上面给您说了 您这个订单 我们发不出去', []], ['您可以自己看下 我们在廿三里', []],
  // images and cards
  ['', ['image']], ['https://img.alicdn.com/imgextra/i4/2218/O1CN01.jpg', ['image']],
]
for (const [text, expected] of cases) assert.deepEqual(f(text, text ? undefined : ['其他消息']), expected, text)
// Masking: contact details never reach storage, and masked text re-classifies the same way.
for (const raw of ['加我微信 abc_12345 发你实拍', '电话 138 1234 5678 随时联系', 'qq: 12345678', '义乌市廿三里街道花仙路565号 13812345678']) {
  const once = analyzeAgentText(raw, ['正常消息'])
  assert.doesNotMatch(once.text!, /abc_12345|1[3-9]\d{9}|138 1234|12345678/)
  // Character count and "short" come from the original text and are kept as stored; the other flags must match.
  const keep = (flags: string[]) => flags.filter(x => x !== 'short').sort()
  assert.deepEqual(keep(analyzeAgentText(once.text, ['正常消息']).flags), keep(once.flags), `re-classify ${raw}`)
}
// Offer ids survive masking; only 1688 offer links count.
const offers = (text: string) => analyzeAgentText(text, ['正常消息']).offerIds
const linked = analyzeAgentText('这款 https://detail.1688.com/offer/712345678901.html?spm=a1 您看下', ['正常消息'])
assert.deepEqual(linked.offerIds, ['712345678901'])
assert.equal(linked.text, '这款 https://detail.1688.com/offer/######.html?spm=a1 您看下', 'the stored text stays masked')
assert.deepEqual(offers('https://m.1688.com/offer/712345678901.html https://detail.1688.com/offer/712345678902.html https://detail.1688.com/offer/712345678901.html'), ['712345678901', '712345678902'])
assert.deepEqual(offers('https://m.1688.com/page/offerlist.html?offerId=712345678903'), ['712345678903'])
for (const text of ['https://detail.1688.com/offer/######.html', 'https://x1688.com/offer/712345678901.html', 'https://1688.com.example.cn/offer/712345678901.html',
  'https://example.cn/detail.1688.com/offer/712345678901.html', 'https://trade.1688.com/order?orderId=712345678901', '订单号 712345678901', 'https://detail.1688.com/offer/123.html']) assert.deepEqual(offers(text), [], text)
assert.deepEqual(analyzeAgentText('', ['其他消息']).offerIds, [])
assert.deepEqual(analyzeAgentText('https://img.alicdn.com/imgextra/i4/2218/O1CN01.jpg', ['正常消息']).offerIds, [])
// Pictures: the buyer's urls list and the agent's own image links, from Alibaba's image hosts only.
const buyerPic = 'https://cbu-im.oss-accelerate.aliyuncs.com/webim/e95f19224d7847b9db15e3af8cbe23b3.png'
const agentPic = 'https://img.alicdn.com/imgextra/i3/2218207153733/O1CN01cCeUfxc0PdJ2b8N1_!!2218207153733-2-ampmedia.png'
assert.deepEqual(messageImages({ direction: 1, content: '---***---', urls: [{ url: buyerPic }, { url: buyerPic }] }), [buyerPic], 'from the list, once')
assert.deepEqual(messageImages({ direction: 0, content: agentPic }), [agentPic], 'digits in the path survive: taken before masking')
assert.equal(analyzeAgentText(agentPic, ['正常消息']).text, '[图片]')
assert.deepEqual(messageImages({ direction: 0, content: `看这个 ${agentPic} 和 https://detail.1688.com/offer/712345678901.html` }), [agentPic], 'only picture links')
for (const bad of ['http://img.alicdn.com/a.png', 'https://img.alicdn.com.evil.cn/a.png', 'https://evil.cn/img.alicdn.com/a.png', 'https://img.alicdn.com/a.html', 'https://user@img.alicdn.com/a.png', 'https://other-bucket.oss-cn-hangzhou.aliyuncs.com/a.png'])
  assert.deepEqual(messageImages({ direction: 1, urls: [{ url: bad }] }), [], bad)
assert.deepEqual(messageImages({ direction: 1, content: agentPic }), [], 'buyer text is masked by the platform and never read')
assert.equal(messageImages({ direction: 1, urls: Array.from({ length: 12 }, (_, i) => ({ url: `https://cbu01.alicdn.com/img/${i}.jpg` })) }).length, 9)
console.log(JSON.stringify({ cases: cases.length, masking: 'ok', reclassifyMasked: 'ok', offerLinks: 'ok', images: 'ok' }))
