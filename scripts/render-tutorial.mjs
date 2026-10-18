// Renders docs/tutorial/index.html frame by frame in headless Chrome and encodes an H.264 MP4 with ffmpeg.
//   PLAYWRIGHT_MODULE=/path/to/playwright-core FFMPEG=/path/to/ffmpeg node scripts/render-tutorial.mjs [--fps 30] [--stills 1000,20000] [--out file.mp4] [--burn-subs]
//   --srt file.srt writes the narration cues as SubRip subtitles (no ffmpeg needed).
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > -1 ? process.argv[i + 1] : fallback }
if (!process.env.PLAYWRIGHT_MODULE) throw new Error('PLAYWRIGHT_MODULE is required (path to playwright-core)')
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE)
const fps = Number(arg('fps', 30)), stills = arg('stills', ''), out = resolve(arg('out', 'docs/tutorial/销途CRM使用教程.mp4'))
const burn = process.argv.includes('--burn-subs')
const page_url = `${pathToFileURL(resolve('docs/tutorial/index.html')).href}?render=1${burn ? '&subs=1' : ''}`
const browser = await chromium.launch({ headless: true, channel: 'chrome' })
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 })
const errors = []; page.on('pageerror', e => errors.push(e.message))
await page.goto(page_url); await page.waitForFunction(() => window.__tutorial)
const duration = await page.evaluate(() => window.__tutorial.duration)
const shot = t => page.evaluate(ms => window.__tutorial.seek(ms), t).then(() => page.screenshot({ type: 'jpeg', quality: 92 }))
// The first full-page capture after load can composite stale tiles; take throwaway captures before the real ones.
await page.evaluate(() => document.fonts.ready); for (const t of [0, 1000, 0]) await shot(t)
const srtTime = ms => { const h = Math.floor(ms / 3_600_000), m = Math.floor(ms / 60_000) % 60, s = Math.floor(ms / 1000) % 60; return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}` }
try {
  if (arg('srt')) {
    const cues = await page.evaluate(() => window.__tutorial.subtitles)
    const body = cues.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`).join('\n')
    await writeFile(resolve(arg('srt')), body, 'utf8')
    console.log(JSON.stringify({ srt: resolve(arg('srt')), cues: cues.length, errors }))
  } else if (stills) {
    const dir = resolve(arg('dir', 'docs/tutorial/stills')); await mkdir(dir, { recursive: true })
    for (const t of stills.split(',').map(Number)) await writeFile(`${dir}/t${String(t).padStart(6, '0')}.jpg`, await shot(t))
    console.log(JSON.stringify({ stills: stills.split(',').length, dir, errors }))
  } else {
    if (!process.env.FFMPEG) throw new Error('FFMPEG is required (path to an ffmpeg binary with libx264)')
    await mkdir(dirname(out), { recursive: true })
    const ff = spawn(process.env.FFMPEG, ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', '-',
      '-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out], { stdio: ['pipe', 'inherit', 'inherit'] })
    const done = new Promise((ok, fail) => ff.on('close', code => code === 0 ? ok() : fail(new Error(`ffmpeg exited ${code}`))))
    const frames = Math.ceil(duration / 1000 * fps), started = Date.now()
    for (let i = 0; i < frames; i++) {
      const jpg = await shot(i * 1000 / fps)
      if (!ff.stdin.write(jpg)) await new Promise(r => ff.stdin.once('drain', r))
      if (i % (fps * 10) === 0) console.log(`frame ${i}/${frames} (${Math.round((Date.now() - started) / 1000)}s)`)
    }
    ff.stdin.end(); await done
    console.log(JSON.stringify({ out, frames, fps, seconds: duration / 1000, errors }))
  }
} finally { await browser.close() }
