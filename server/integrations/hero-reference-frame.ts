import sharp from 'sharp'
import { fileURLToPath } from 'node:url'

export const HERO_REFERENCE_FRAME = 'tuoyang-v1'
export const CUSTOM_HERO_FRAME = 'custom-v1'
export const HERO_REFERENCE_MARKS = ['义乌拓洋', '超级工厂']
export const HERO_TOP_PERCENT = 12, HERO_BOTTOM_PERCENT = 20

const bands = (height: number) => ({
  top: Math.max(1, Math.floor(height * HERO_TOP_PERCENT / 100)),
  bottom: Math.max(1, Math.floor(height * HERO_BOTTOM_PERCENT / 100)),
})

/** Store only the fixed bands. The source's sample product and copy are outside the compositing layers. */
export async function prepareCustomHeroFrame(png: Buffer, width: number, height: number) {
  const { top, bottom } = bands(height)
  const [header, footer] = await Promise.all([
    sharp(png).extract({ left: 0, top: 0, width, height: top }).png().toBuffer(),
    sharp(png).extract({ left: 0, top: height - bottom, width, height: bottom }).png().toBuffer(),
  ])
  return sharp({ create: { width, height, channels: 4, background: '#00000000' } })
    .composite([{ input: header, left: 0, top: 0 }, { input: footer, left: 0, top: height - bottom }]).png().toBuffer()
}

export async function applyCustomHeroFrame(png: Buffer, width: number, height: number, frame: Buffer) {
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
