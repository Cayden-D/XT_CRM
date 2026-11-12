import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

// The browser extension: its own manifest, bridge and background, plus the userscript itself behind a small shim, so
// both forms collect exactly the same way. Zipped on request (store only, no compression library needed).
const DIR = resolve(process.cwd(), 'collector-extension')
const FILES = ['manifest.json', 'background.js', 'bridge.js']

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
const crc32 = (bytes: Buffer) => { let c = 0xffffffff; for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }

export function zipStore(entries: { name: string; data: Buffer }[]) {
  const locals: Buffer[] = [], centrals: Buffer[] = []
  let offset = 0
  for (const { name, data } of entries) {
    const file = Buffer.from(name, 'utf8'), crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(0, 8)
    local.writeUInt32LE(0, 10); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(file.length, 26); local.writeUInt16LE(0, 28)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(0, 10)
    central.writeUInt32LE(0, 12); central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(file.length, 28); central.writeUInt32LE(offset, 42)
    locals.push(local, file, data); centrals.push(central, file)
    offset += local.length + file.length + data.length
  }
  const directory = Buffer.concat(centrals), end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

export async function collectorExtensionFiles() {
  const [shim, script] = await Promise.all([readFile(resolve(DIR, 'shim.js'), 'utf8'), readFile(resolve(process.cwd(), 'scripts', '1688-product-collector.user.js'), 'utf8')])
  const files = await Promise.all(FILES.map(async name => ({ name, data: await readFile(resolve(DIR, name)) })))
  return [...files, { name: 'collector.js', data: Buffer.from(`${shim}\n${script}`, 'utf8') }]
}
export const collectorExtensionZip = async () => zipStore(await collectorExtensionFiles())
