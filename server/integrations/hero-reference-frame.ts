import sharp from 'sharp'
import { fileURLToPath } from 'node:url'

export const HERO_REFERENCE_FRAME = 'tuoyang-v1'
export const CUSTOM_HERO_FRAME = 'custom-v1'
export const HERO_REFERENCE_MARKS = ['义乌拓洋', '超级工厂']
export const HERO_TOP_PERCENT = 12, HERO_BOTTOM_PERCENT = 20
export type HeroInsets = { top: number; bottom: number; left: number; right: number }

const bands = (height: number) => ({
  top: Math.max(1, Math.floor(height * HERO_TOP_PERCENT / 100)),
  bottom: Math.max(1, Math.floor(height * HERO_BOTTOM_PERCENT / 100)),
})

type Span = { start: number; end: number }
const sampleSize = 512
const middle = sampleSize / 2

function spans(matches: (index: number) => boolean) {
  const runs: Span[] = []
  let start = -1
  for (let i = 0; i <= sampleSize; i++) {
    if (i < sampleSize && matches(i)) {
      if (start < 0) start = i
    } else if (start >= 0) {
      runs.push({ start, end: i })
      start = -1
    }
  }
  return runs
}

const central = (runs: Span[]) => runs.find(run => run.start <= middle && run.end > middle)

async function detectOpening(png: Buffer) {
  const rgba = await sharp(png).resize(sampleSize, sampleSize, { fit: 'fill' }).toColourspace('srgb').ensureAlpha().raw().toBuffer()
  const offset = (x: number, y: number) => (y * sampleSize + x) * 4
  const transparent = (i: number) => rgba[i + 3] < 16
  const white = (i: number) => Math.min(rgba[i], rgba[i + 1], rgba[i + 2]) >= 235
    && Math.max(rgba[i], rgba[i + 1], rgba[i + 2]) - Math.min(rgba[i], rgba[i + 1], rgba[i + 2]) <= 18
  const center = offset(middle, middle)
  const flat = (i: number) => Math.max(
    Math.abs(rgba[i] - rgba[center]), Math.abs(rgba[i + 1] - rgba[center + 1]), Math.abs(rgba[i + 2] - rgba[center + 2]),
  ) <= 12
  const centerStart = sampleSize * 3 / 8, centerEnd = sampleSize * 5 / 8
  let clearPixels = 0, flatPixels = 0
  for (let y = centerStart; y < centerEnd; y++) {
    for (let x = centerStart; x < centerEnd; x++) {
      const i = offset(x, y)
      if (transparent(i)) clearPixels++
      if (flat(i)) flatPixels++
    }
  }
  const centerArea = (centerEnd - centerStart) ** 2
  const hasOpeningAlpha = clearPixels > centerArea * 0.95
  const blank = hasOpeningAlpha ? transparent : flatPixels > centerArea * 0.98 && !white(center) ? flat : white
  const mostlyBlank = (from: number, to: number, pixel: (i: number) => number, isBlank = blank) => {
    const tolerance = Math.floor((to - from) * 0.01)
    let nonblank = 0
    for (let i = from; i < to; i++) if (!isBlank(pixel(i)) && ++nonblank > tolerance) return false
    return true
  }
  const rowSpans = (left: number, right: number, isBlank = blank) => spans(y => mostlyBlank(left, right, x => offset(x, y), isBlank))

  const inner = central(rowSpans(centerStart, centerEnd))
  const centralOpening = inner && inner.end - inner.start >= sampleSize * 0.4 ? inner : null

  // A completed example can still expose two blank gutters between its sample
  // product and the artwork. The sample itself may also have a flat background.
  if (!hasOpeningAlpha) {
    const edge = Math.round(sampleSize * 0.02)
    const runs = rowSpans(edge, sampleSize - edge, white).filter(run => run.end - run.start >= sampleSize * 0.015)
    const upper = runs.filter(run => run.start > 0 && run.end <= sampleSize * 0.4).at(-1)
    const lower = runs.find(run => run.start >= sampleSize * 0.6 && run.end < sampleSize)
    if (upper && lower && (!centralOpening || (blank === flat
      && Math.abs(upper.end - centralOpening.start) <= edge && Math.abs(lower.start - centralOpening.end) <= edge))) {
      return { hasOpeningAlpha, across: { start: 0, end: sampleSize }, vertical: { start: upper.start, end: lower.end } }
    }
  }

  // A blank template has a large central opening. Measure its side rails across
  // the middle of that opening, then use the full interior width to find the bands.
  if (centralOpening) {
    const { start, end } = centralOpening
    const inset = Math.floor((end - start) / 4)
    const across = central(spans(x => mostlyBlank(start + inset, end - inset, y => offset(x, y))))
    const vertical = across && central(rowSpans(across.start, across.end))
    if (across && vertical && across.end - across.start >= sampleSize * 0.45 && vertical.end - vertical.start >= sampleSize * 0.35) {
      return { hasOpeningAlpha, across, vertical }
    }
  }

  return null
}

/** Store the compositing layer and its measured insets together with the template revision. */
export async function prepareCustomHeroFrame(png: Buffer, width: number, height: number): Promise<{ frame: Buffer; insets: HeroInsets | null }> {
  const opening = await detectOpening(png)
  if (opening) {
    const { across, vertical, hasOpeningAlpha } = opening
    const insets = { top: vertical.start / sampleSize, bottom: 1 - vertical.end / sampleSize, left: across.start / sampleSize, right: 1 - across.end / sampleSize }
    if (hasOpeningAlpha) return { frame: png, insets }
    if (Object.values(insets).some(value => value > 0)) {
      const area = frameOpening(insets, width, height)
      const frame = await sharp(png).ensureAlpha().composite([{
        input: { create: { width: area.width, height: area.height, channels: 4, background: '#ffffffff' } },
        left: area.left, top: area.top, blend: 'dest-out',
      }]).png().toBuffer()
      return { frame, insets }
    }
  }

  // Ambiguous opaque pictures keep the same behavior as templates saved before detection.
  const { top, bottom } = bands(height)
  const [header, footer] = await Promise.all([
    sharp(png).extract({ left: 0, top: 0, width, height: top }).png().toBuffer(),
    sharp(png).extract({ left: 0, top: height - bottom, width, height: bottom }).png().toBuffer(),
  ])
  const frame = await sharp({ create: { width, height, channels: 4, background: '#00000000' } })
    .composite([{ input: header, left: 0, top: 0 }, { input: footer, left: 0, top: height - bottom }]).png().toBuffer()
  return { frame, insets: null }
}

function frameOpening(insets: HeroInsets, width: number, height: number) {
  const left = Math.round(insets.left * width), right = Math.round(insets.right * width)
  const top = Math.round(insets.top * height), bottom = Math.round(insets.bottom * height)
  return { left, top, width: width - left - right, height: height - top - bottom }
}

export async function applyCustomHeroFrame(png: Buffer, width: number, height: number, frame: Buffer, insets?: HeroInsets | null) {
  if (insets) {
    const overlay = await sharp(frame).resize({ width, height, fit: 'fill' }).png().toBuffer()
    return sharp(png).composite([{ input: overlay, left: 0, top: 0 }]).png().toBuffer()
  }
  const meta = await sharp(frame).metadata()
  const source = bands(meta.height), target = bands(height)
  const fit = { width, fit: 'contain', background: '#00000000' } as const
  const [header, footer] = await Promise.all([
    sharp(frame).extract({ left: 0, top: 0, width: meta.width, height: source.top })
      .resize({ ...fit, height: target.top, position: 'north' }).png().toBuffer(),
    sharp(frame).extract({ left: 0, top: meta.height - source.bottom, width: meta.width, height: source.bottom })
      .resize({ ...fit, height: target.bottom, position: 'south' }).png().toBuffer(),
  ])
  return sharp(png).composite([{ input: header, left: 0, top: 0 }, { input: footer, left: 0, top: height - target.bottom }]).png().toBuffer()
}

const referenceWidth = 2048
const header = fileURLToPath(new URL('../assets/tuoyang-hero-header.png', import.meta.url))
const footer = fileURLToPath(new URL('../assets/tuoyang-hero-footer.png', import.meta.url))

/** The PNGs contain only the original frame. Scale by width so the lettering keeps its proportions on portrait images. */
export async function applyHeroReferenceFrame(png: Buffer, width: number, height: number) {
  const frameWidth = Math.min(width, Math.floor(height * referenceWidth / 556))
  const scale = (value: number) => Math.round(value * frameWidth / referenceWidth)
  const left = Math.floor((width - frameWidth) / 2)
  const insetLeft = scale(24), insetRight = scale(20)
  const [top, bottom, body] = await Promise.all([
    sharp(header).resize({ width: frameWidth }).png().toBuffer(),
    sharp(footer).resize({ width: frameWidth }).png().toBuffer({ resolveWithObject: true }),
    sharp(png).extract({ left: left + insetLeft, top: 0, width: frameWidth - insetLeft - insetRight, height })
      .flatten({ background: '#20212a' })
      .extend({ left: left + insetLeft, right: width - left - frameWidth + insetRight, top: 0, bottom: 0, background: '#000000' })
      .png().toBuffer(),
  ])
  return sharp(body).composite([{ input: top, top: 0, left }, { input: bottom.data, top: height - bottom.info.height, left }]).png().toBuffer()
}
