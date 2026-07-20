const SCOPE_PATH = new URL(self.registration.scope).pathname
const SCOPE_KEY = encodeURIComponent(SCOPE_PATH) || 'root'
const CACHE_PREFIX = `missions-nikolay-${SCOPE_KEY}-`
const BUILD_ID = 'dev'
const BUILD_ASSETS = []
const CACHE_NAME = `${CACHE_PREFIX}${BUILD_ID}`
const INDEX_URL = new URL('./index.html', self.registration.scope).toString()
const APP_SHELL = [...new Set([
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  ...BUILD_ASSETS,
])].map((path) => new URL(path, self.registration.scope).toString())

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      caches.keys().then((keys) => Promise.all(
        keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME).map((key) => caches.delete(key)),
      )),
      self.clients.claim(),
    ]),
  )
})

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting()
})

async function putSafe(cache, request, response) {
  if (response.ok && response.type !== 'opaque') await cache.put(request, response.clone())
  return response
}

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin || !url.href.startsWith(self.registration.scope)) return

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME)
      try {
        return await fetch(request, { cache: 'no-store' })
      } catch {
        return (await cache.match(INDEX_URL)) || (await cache.match(new URL('./', self.registration.scope).toString())) || Response.error()
      }
    })())
    return
  }

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME)
    const cached = await cache.match(request)
    if (cached) return cached
    try {
      return await putSafe(cache, request, await fetch(request))
    } catch {
      return Response.error()
    }
  })())
})
