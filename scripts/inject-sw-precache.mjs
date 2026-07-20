import { createHash } from 'node:crypto'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const distDir = path.join(projectRoot, 'dist')
const swPath = path.join(distDir, 'sw.js')

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(entries.map(async (entry) => {
    const absolute = path.join(directory, entry.name)
    return entry.isDirectory() ? walk(absolute) : [absolute]
  }))
  return nested.flat()
}

const files = (await walk(distDir)).filter((file) => {
  if (file === swPath) return false
  const relative = path.relative(distDir, file).split(path.sep).join('/')
  return relative === 'index.html'
    || relative === 'manifest.webmanifest'
    || relative.startsWith('assets/')
    || relative.startsWith('icons/')
}).sort()
const assets = files.map((file) => `./${path.relative(distDir, file).split(path.sep).join('/')}`)
const original = await readFile(swPath, 'utf8')
const hash = createHash('sha256')
hash.update('sw.js')
hash.update(original)
for (const file of files) {
  hash.update(path.relative(distDir, file))
  hash.update(await readFile(file))
}
const buildId = hash.digest('hex').slice(0, 12)

const buildIdMarker = "const BUILD_ID = 'dev'"
const assetsMarker = 'const BUILD_ASSETS = []'
if (!original.includes(buildIdMarker) || !original.includes(assetsMarker)) {
  throw new Error('Service worker precache markers were not found')
}

const injected = original
  .replace(buildIdMarker, `const BUILD_ID = '${buildId}'`)
  .replace(assetsMarker, `const BUILD_ASSETS = ${JSON.stringify(assets)}`)

await writeFile(swPath, injected)
