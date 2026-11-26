import sharp, { type OverlayOptions } from 'sharp'
import { fileURLToPath } from 'node:url'

export const HERO_REFERENCE_FRAME = 'tuoyang-v1'
export const CUSTOM_HERO_FRAME = 'custom-v1'
export const HERO_REFERENCE_MARKS = ['义乌拓洋', '超级工厂']
export const HERO_TOP_PERCENT = 12, HERO_BOTTOM_PERCENT = 20
export type HeroInsets = { top: number; bottom: number; left: number; right: number }
export const HERO_CONTENT_LAYOUT = 'content-window-v1'
type ImageArea = { left: number; top: number; width: number; height: number }

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

/** Remove only near-white template background connected to the opening, never enclosed white lettering. */
async function clearOpeningWhite(frame: Buffer, area: ImageArea) {
  const { data, info } = await sharp(frame).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const { width, height } = info
  const seed = (area.top + Math.floor(area.height / 2)) * width + area.left + Math.floor(area.width / 2)
  if (data[seed * 4 + 3] > 8) return frame
  const seen = new Uint8Array(width * height), queue = new Uint32Array(width * height)
  let head = 0, tail = 0, changed = false
  const visit = (pixel: number) => {
    if (seen[pixel]) return
    seen[pixel] = 1
    const i = pixel * 4
    const white = Math.min(data[i], data[i + 1], data[i + 2]) >= 245
      && Math.max(data[i], data[i + 1], data[i + 2]) - Math.min(data[i], data[i + 1], data[i + 2]) <= 8
    if (data[i + 3] > 8 && !white) return
    if (white && data[i + 3] > 0) { data[i + 3] = 0; changed = true }
    queue[tail++] = pixel
  }
  visit(seed)
  while (head < tail) {
    const pixel = queue[head++], x = pixel % width
    if (x > 0) visit(pixel - 1)
    if (x + 1 < width) visit(pixel + 1)
    if (pixel >= width) visit(pixel - width)
    if (pixel + width < width * height) visit(pixel + width)
  }
  return changed ? sharp(data, { raw: info }).png().toBuffer() : frame
}

/** A deterministic final canvas: the provider's content image may have a different aspect ratio or pixel size. */
export function heroCanvas(size: string, resolution: string) {
  const edge = resolution === '2k' ? 2048 : 1024
  return size === '3:4' ? { width: edge * 3 / 4, height: edge } : { width: edge, height: edge }
}

/** APIMart's documented aspect ratios, shared by the configured image models. */
export function heroContentSize(area: Pick<ImageArea, 'width' | 'height'>) {
  const sizes = ['1:1', '3:2', '2:3', '4:3', '3:4', '5:4', '4:5', '16:9', '9:16', '2:1', '1:2', '3:1', '1:3', '21:9', '9:21']
  const error = (size: string) => { const [w, h] = size.split(':').map(Number); return Math.abs(Math.log(w / h / (area.width / area.height))) }
  return sizes.reduce((best, size) => error(size) < error(best) ? size : best)
}

/** Build the frame and the exact opening together so submission and composition use the same geometry. */
export async function heroContentFrame(width: number, height: number, mode: string, frame?: Buffer, insets?: HeroInsets | null) {
  if (mode === HERO_REFERENCE_FRAME) {
    const scale = width / referenceWidth
    const top = Math.round(200 * scale), bottom = Math.round(356 * scale)
    const left = Math.round(24 * scale), right = Math.round(20 * scale)
    const area = { left, top, width: width - left - right, height: height - top - bottom }
    const overlay = await sharp({ create: { width, height, channels: 4, background: '#00000000' } }).composite([
      { input: await sharp(header).resize({ width }).png().toBuffer(), left: 0, top: 0 },
      { input: await sharp(footer).resize({ width }).png().toBuffer(), left: 0, top: height - bottom },
      { input: { create: { width: left, height: area.height, channels: 4, background: '#000000ff' } }, left: 0, top },
      { input: { create: { width: right, height: area.height, channels: 4, background: '#000000ff' } }, left: width - right, top },
    ]).png().toBuffer()
    return { area, overlay }
  }
  if (!frame) throw new Error('Custom hero frame is missing')
  const meta = await sharp(frame).metadata()
  const sourceWidth = meta.width!, sourceHeight = meta.height!
  const source = frameOpening(insets ?? { top: HERO_TOP_PERCENT / 100, bottom: HERO_BOTTOM_PERCENT / 100, left: 0, right: 0 }, sourceWidth, sourceHeight)
  // Nine-slice layout: header/footer scale uniformly by width; side rails span the opening. Logo/text keep their shape.
  const scale = width / sourceWidth
  const top = Math.round(source.top * scale), bottom = Math.round((sourceHeight - source.top - source.height) * scale)
  const left = Math.round(source.left * scale), right = Math.round((sourceWidth - source.left - source.width) * scale)
  const area = { left, top, width: width - left - right, height: height - top - bottom }
  if (source.width <= 0 || source.height <= 0 || area.width <= 0 || area.height <= 0) throw new Error('Hero template opening is too small')
  const pieces: OverlayOptions[] = []
  const piece = async (rect: ImageArea, target: ImageArea) => {
    if (rect.width > 0 && rect.height > 0 && target.width > 0 && target.height > 0) pieces.push({
      input: await sharp(frame).extract(rect).resize({ width: target.width, height: target.height, fit: 'fill' }).png().toBuffer(), left: target.left, top: target.top,
    })
  }
  await piece({ left: 0, top: 0, width: sourceWidth, height: source.top }, { left: 0, top: 0, width, height: top })
  await piece({ left: 0, top: source.top + source.height, width: sourceWidth, height: sourceHeight - source.top - source.height }, { left: 0, top: height - bottom, width, height: bottom })
  await piece({ left: 0, top: source.top, width: source.left, height: source.height }, { left: 0, top, width: left, height: area.height })
  await piece({ left: source.left + source.width, top: source.top, width: sourceWidth - source.left - source.width, height: source.height }, { left: width - right, top, width: right, height: area.height })
  const overlay = await sharp({ create: { width, height, channels: 4, background: '#00000000' } }).composite(pieces).png().toBuffer()
  return { area, overlay: await clearOpeningWhite(overlay, area) }
}

/** Trim only completely blank edge strips (at most 15% per edge), preserving faint product edges and small lettering. */
async function trimContentBands(png: Buffer) {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const { width, height } = info
  const blank = (x: number, y: number) => {
    const i = (y * width + x) * 4
    return data[i + 3] <= 8 || Math.min(data[i], data[i + 1], data[i + 2]) >= 254
  }
  const row = (y: number) => { for (let x = 0; x < width; x++) if (!blank(x, y)) return false; return true }
  const col = (x: number) => { for (let y = 0; y < height; y++) if (!blank(x, y)) return false; return true }
  const edge = (length: number, test: (i: number) => boolean) => {
    const max = Math.floor(length * 0.15)
    let n = 0
    while (n <= max && test(n)) n++
    return n > max ? 0 : n
  }
  const top = edge(height, row), bottom = edge(height, n => row(height - n - 1))
  const left = edge(width, col), right = edge(width, n => col(width - n - 1))
  return sharp(png).extract({ left, top, width: width - left - right, height: height - top - bottom }).png().toBuffer()
}

/** Fit the whole content into the opening without cropping or stretching; extend edge backgrounds to close ratio gaps. */
export async function composeHeroContent(png: Buffer, width: number, height: number, mode: string, frame?: Buffer, insets?: HeroInsets | null) {
  const { area, overlay } = await heroContentFrame(width, height, mode, frame, insets)
  const fitted = await sharp(await trimContentBands(png)).flatten({ background: '#ffffff' })
    .resize({ width: area.width, height: area.height, fit: 'inside' }).png().toBuffer({ resolveWithObject: true })
  const left = area.left + Math.floor((area.width - fitted.info.width) / 2)
  const top = area.top + Math.floor((area.height - fitted.info.height) / 2)
  const background = await sharp(fitted.data).extend({ left, top, right: width - left - fitted.info.width, bottom: height - top - fitted.info.height, extendWith: 'copy' }).png().toBuffer()
  return sharp(background).composite([{ input: overlay, left: 0, top: 0 }]).png().toBuffer()
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
