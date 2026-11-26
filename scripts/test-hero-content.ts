import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import sharp from 'sharp'
import { applyCustomHeroFrame, composeHeroContent, CUSTOM_HERO_FRAME, heroCanvas, heroContentFrame, heroContentSize, HERO_REFERENCE_FRAME, prepareCustomHeroFrame } from '../server/integrations/hero-reference-frame.js'

const block = (width: number, height: number, background: string) => ({ create: { width, height, channels: 4 as const, background } })
const pixel = async (png: Buffer, x: number, y: number) => [...await sharp(png).extract({ left: x, top: y, width: 1, height: 1 }).removeAlpha().raw().toBuffer()]
const bounds = async (png: Buffer, color: number[]) => {
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  let left = info.width, right = -1, top = info.height, bottom = -1
  for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
    const i = (y * info.width + x) * 3
    if (color.every((c, n) => Math.abs(data[i + n] - c) <= 2)) { left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y) }
  }
  assert.ok(right >= left && bottom >= top, `missing color ${color}`)
  return { left, top, width: right - left + 1, height: bottom - top + 1 }
}

// Reproduce an opaque sample with white background around a central header badge and above/below the product.
const original = await sharp(block(400, 400, '#ffffff')).composite([
  { input: block(120, 40, '#5030c0'), left: 140, top: 0 },
  { input: block(12, 12, '#ffffff'), left: 194, top: 14 }, // enclosed white lettering must survive
  { input: block(400, 60, '#c03050'), left: 0, top: 340 },
]).png().toBuffer()
const { frame, insets } = await prepareCustomHeroFrame(original, 400, 400)
assert.ok(insets)
const content = await sharp(block(400, 300, '#ffffff')).composite([
  { input: block(400, 260, '#315575'), left: 0, top: 20 },
  { input: block(80, 160, '#eb3c24'), left: 260, top: 60 }, // product, with measurable proportions
  { input: block(120, 24, '#28c878'), left: 24, top: 44 }, // headline
  { input: block(100, 8, '#f0d020'), left: 24, top: 260 }, // a low text line must not be cropped
]).png().toBuffer()
const before = await applyCustomHeroFrame(content, 400, 300, frame, insets)
const after = await composeHeroContent(content, 400, 400, CUSTOM_HERO_FRAME, frame, insets)
const { area } = await heroContentFrame(400, 400, CUSTOM_HERO_FRAME, frame, insets)
assert.equal(heroContentSize(area), '4:3')
assert.deepEqual(await pixel(before, 10, 5), [255, 255, 255], 'old compositor retains the white header background')
assert.deepEqual(await pixel(after, 10, 5), [49, 85, 117], 'the body background now continues behind the badge')
assert.deepEqual(await pixel(after, 200, 20), [255, 255, 255], 'white badge lettering is retained')
const jpeg = await prepareCustomHeroFrame(await sharp(original).jpeg({ quality: 92 }).toBuffer(), 400, 400)
const jpegOutput = await composeHeroContent(content, 400, 400, CUSTOM_HERO_FRAME, jpeg.frame, jpeg.insets)
assert.deepEqual(await pixel(jpegOutput, 10, 5), [49, 85, 117], 'JPEG white background also becomes transparent')
assert.ok((await pixel(jpegOutput, 200, 20)).every(c => c >= 240), 'JPEG white lettering is still present')
for (const y of [area.top + 2, area.top + area.height - 3]) assert.deepEqual(await pixel(after, 10, y), [49, 85, 117], 'no white band at the opening edges')
const product = await bounds(after, [235, 60, 36])
assert.ok(Math.abs(product.width / product.height - 0.5) < 0.02, 'the product is not stretched to match the opening')
await bounds(after, [40, 200, 120]); await bounds(after, [240, 208, 32])

// Portrait output must preserve badge/lettering proportions and the exact final canvas size.
const portrait = await composeHeroContent(content, 600, 800, CUSTOM_HERO_FRAME, frame, insets)
assert.deepEqual((({ width, height }) => ({ width, height }))(await sharp(portrait).metadata()), { width: 600, height: 800 })
const badge = await bounds(portrait, [80, 48, 192])
assert.ok(Math.abs(badge.width / badge.height - 3) < 0.1, 'the square template badge is not stretched on a portrait')
assert.deepEqual(await pixel(portrait, 10, 65), [49, 85, 117])
assert.deepEqual(await pixel(portrait, 10, 705), [49, 85, 117])

// Intentional rails and genuinely transparent templates remain intact.
const transparent = await sharp(block(400, 400, '#00000000')).composite([
  { input: block(120, 40, '#5030c0'), left: 140, top: 0 },
  { input: block(400, 60, '#c03050'), left: 0, top: 340 },
  { input: block(8, 400, '#179f47'), left: 0, top: 0 },
]).png().toBuffer()
const railOutput = await composeHeroContent(content, 400, 400, CUSTOM_HERO_FRAME, transparent, { top: 0.1, bottom: 0.15, left: 0.02, right: 0 })
assert.deepEqual(await pixel(railOutput, 2, 200), [23, 159, 71])
assert.deepEqual(await pixel(railOutput, 395, 200), [49, 85, 117])
const fallback = await composeHeroContent(content, 400, 400, CUSTOM_HERO_FRAME, transparent, null)
await bounds(fallback, [235, 60, 36])

// A small meaningful mark at the edge prevents whitespace trimming; a fully white source does not trigger invalid crops.
const edgeContent = await sharp(block(400, 300, '#ffffff')).composite([
  { input: block(400, 260, '#315575'), left: 0, top: 20 },
  { input: block(8, 6, '#a020b0'), left: 20, top: 2 },
]).png().toBuffer()
await bounds(await composeHeroContent(edgeContent, 400, 400, CUSTOM_HERO_FRAME, frame, insets), [160, 32, 176])
const faintContent = await sharp(block(400, 300, '#ffffff')).composite([
  { input: block(400, 260, '#315575'), left: 0, top: 20 },
  { input: block(12, 8, '#fcfcfc'), left: 20, top: 2 },
]).png().toBuffer()
await bounds(await composeHeroContent(faintContent, 400, 400, CUSTOM_HERO_FRAME, frame, insets), [252, 252, 252])
await composeHeroContent(await sharp(block(400, 300, '#ffffff')).png().toBuffer(), 400, 400, CUSTOM_HERO_FRAME, frame, insets)

assert.deepEqual(heroCanvas('1:1', '2k'), { width: 2048, height: 2048 })
assert.deepEqual(heroCanvas('3:4', '1k'), { width: 768, height: 1024 })
const builtin = await composeHeroContent(content, 1024, 1024, HERO_REFERENCE_FRAME)
assert.deepEqual(await pixel(builtin, 4, 500), [0, 0, 0])
await bounds(builtin, [235, 60, 36])

if (process.env.HERO_QA_DIR) {
  const dir = process.env.HERO_QA_DIR
  await mkdir(dir, { recursive: true })
  await Promise.all([['template', original], ['source-content', content], ['before', before], ['after', after], ['portrait', portrait], ['builtin', builtin]].map(([name, png]) => writeFile(`${dir}/${name}.png`, png)))
}
console.log(JSON.stringify({ whiteBackgroundRemoved: 'ok', whiteLetteringPreserved: 'ok', contentBandsRemoved: 'ok', productProportions: 'ok', allTextRetained: 'ok', portraitBadgeProportions: 'ok', rails: 'ok', legacyFallback: 'ok', builtin: 'ok', outputDimensions: 'ok' }))
