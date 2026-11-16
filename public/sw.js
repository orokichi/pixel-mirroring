/* Pixelミラーリング service worker.
 *
 * Two jobs, both about the shell (never about the phone's picture):
 *  1. Installability as a PWA and an instant start: this build's hashed files are
 *     injected by vite.config.ts and precached on install; same-origin requests
 *     are answered cache-first and revalidated in the background, so the window
 *     paints without waiting for the network. A new deploy still wins, because
 *     the new worker installs, drops the old cache and claims the pages at once.
 *  2. The Google Fonts stylesheets (Material Symbols among them) are cached too,
 *     so the icons draw even when the font CDN is slow or unreachable.
 *
 * Nothing the app shows is cached or stored: a mirrored frame only ever exists
 * between the phone and the canvas.
 */
// Replaced at build time (see offlinePrecache in vite.config.ts).
const BUILD_ID = 'dev'
const BUILD_ASSETS = []
const CACHE = 'pixel-mirroring-shell-' + BUILD_ID
const FONT_CACHE = 'pixel-mirroring-fonts'
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com']
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icon.svg',
  '/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-maskable-512.png',
  ...BUILD_ASSETS]
const FONT_CSS = [
  'https://fonts.googleapis.com/css2?family=Google+Sans+Flex:opsz,wght,ROND@6..144,1..1000,100&family=Noto+Sans+JP:wght@400;500;700&display=swap',
  'https://fonts.googleapis.com/css2?family=Material+Symbols+Rounded:opsz,wght,FILL,GRAD@20..48,300..700,0..1,-50..200&display=block',
]

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE)
    await Promise.allSettled(SHELL.map((u) => cache.add(new Request(u, { cache: 'reload' }))))
    const fonts = await caches.open(FONT_CACHE)
    await Promise.allSettled(FONT_CSS.map((u) => fonts.add(u)))
    await self.skipWaiting()
  })())
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys()
    await Promise.all(keys.filter((k) => k !== CACHE && k !== FONT_CACHE).map((k) => caches.delete(k)))
    await self.clients.claim()
  })())
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)

  // Fonts: cache-first, kept across builds.
  if (FONT_HOSTS.includes(url.hostname)) {
    event.respondWith((async () => {
      const cache = await caches.open(FONT_CACHE)
      const hit = await cache.match(req)
      if (hit) return hit
      try {
        const res = await fetch(req)
        if (res.ok) cache.put(req, res.clone())
        return res
      } catch {
        return hit || Response.error()
      }
    })())
    return
  }

  if (url.origin !== location.origin) return

  // The shell: cache-first, refreshed in the background (stale-while-revalidate).
  event.respondWith((async () => {
    const cache = await caches.open(CACHE)
    const hit = await cache.match(req, { ignoreSearch: true })
    const net = fetch(req).then((res) => {
      if (res.ok) cache.put(req, res.clone())
      return res
    }).catch(() => undefined)
    if (hit) { void net; return hit }
    const res = await net
    if (res) return res
    if (req.mode === 'navigate') {
      const shell = await cache.match('/index.html')
      if (shell) return shell
    }
    return new Response('オフラインです', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
  })())
})
