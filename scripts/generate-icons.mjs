import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = resolve(root, 'public', 'icons')
mkdirSync(output, { recursive: true })

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  return value >>> 0
})

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data = Buffer.alloc(0)) {
  const name = Buffer.from(type)
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])))
  return Buffer.concat([length, name, data, checksum])
}

function insidePolygon(x, y, points) {
  let inside = false
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const [xi, yi] = points[i]
    const [xj, yj] = points[j]
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

function icon(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size)
  const bolt = [[.55, .16], [.28, .56], [.47, .56], [.43, .84], [.72, .42], [.53, .42]]
  for (let y = 0; y < size; y += 1) {
    const row = y * (size * 4 + 1)
    raw[row] = 0
    for (let x = 0; x < size; x += 1) {
      const nx = (x + .5) / size
      const ny = (y + .5) / size
      const offset = row + 1 + x * 4
      const t = (nx + ny) / 2
      let red = Math.round(118 - 70 * t)
      let green = Math.round(87 - 34 * t)
      let blue = Math.round(244 - 69 * t)
      const distance = Math.hypot(nx - .5, ny - .5)
      if (distance < .31) {
        red = 17; green = 26; blue = 58
      }
      if (insidePolygon(nx, ny, bolt)) {
        red = Math.round(222 - 88 * ny)
        green = Math.round(255 - 15 * ny)
        blue = Math.round(104 + 84 * ny)
      }
      if (Math.hypot(nx - .26, ny - .25) < .035) {
        red = 255; green = 190; blue = 92
      }
      if (Math.hypot(nx - .77, ny - .72) < .027) {
        red = 255; green = 126; blue = 157
      }
      raw[offset] = red
      raw[offset + 1] = green
      raw[offset + 2] = blue
      raw[offset + 3] = 255
    }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8
  header[9] = 6
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND'),
  ])
}

for (const [name, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['apple-touch-icon.png', 180]]) {
  writeFileSync(resolve(output, name), icon(size))
}
