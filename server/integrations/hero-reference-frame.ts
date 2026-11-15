import sharp from 'sharp'
import { fileURLToPath } from 'node:url'

export const HERO_REFERENCE_FRAME = 'tuoyang-v1'
export const HERO_REFERENCE_MARKS = ['义乌拓洋', '超级工厂']

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
