import { defineConfig, Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Offline start: the service worker (public/sw.js) precaches every file of this
 * build, named after a hash of the file list, so an old build's cache is dropped
 * instead of lingering. After Vite writes the bundle this plugin injects the
 * list and the id — index.html itself is never blocked on the network.
 */
function offlinePrecache(): Plugin {
  let files: string[] = []
  return {
    name: 'pixel-mirroring-precache',
    apply: 'build',
    generateBundle(_options, bundle) {
      files = Object.keys(bundle)
        .filter((f) => f !== 'index.html' && !f.endsWith('.map'))
        .map((f) => '/' + f)
        .sort()
    },
    closeBundle() {
      const swPath = resolve(process.cwd(), 'dist/sw.js')
      if (!existsSync(swPath)) return
      const id = createHash('sha256').update(files.join('|')).digest('hex').slice(0, 8)
      const precache = JSON.stringify(['/', '/index.html', '/manifest.webmanifest', ...files])
      const sw = readFileSync(swPath, 'utf8')
        .replace("const BUILD_ID = 'dev'", `const BUILD_ID = '${id}'`)
        .replace('const BUILD_ASSETS = []', `const BUILD_ASSETS = ${precache}`)
      writeFileSync(swPath, sw)
    },
  }
}

export default defineConfig({ plugins: [react(), offlinePrecache()] })
