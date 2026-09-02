// Copy Excalidraw's fonts into the renderer's public/ so the canvas never
// reaches for a CDN.
//
// By default @excalidraw/excalidraw loads its woff2 files from unpkg at
// runtime. Floe is a desktop app that has to draw correctly offline (and on
// Linux, where nobody has warmed that cache), so the fonts ship with the build:
// this puts them where Vite serves them from, and index.html points
// EXCALIDRAW_ASSET_PATH at that directory.
//
// Runs on postinstall, so a fresh clone is ready without a separate step, and it
// is a no-op once the copy is current — reinstalling should not rewrite 13MB.

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const from = join(root, 'node_modules/@excalidraw/excalidraw/dist/prod/fonts')
const to = join(root, 'src/renderer/public/excalidraw/fonts')

if (!existsSync(from)) {
  // The dependency is not installed (or moved in a version bump). Not fatal:
  // `pnpm install` runs this before anyone can have built anything.
  console.warn('[excalidraw-assets] no fonts at', from, '— skipping')
  process.exit(0)
}

const count = (dir) =>
  readdirSync(dir, { withFileTypes: true }).reduce(
    (n, e) => n + (e.isDirectory() ? count(join(dir, e.name)) : 1),
    0
  )

const want = count(from)
if (existsSync(to) && statSync(to).isDirectory() && count(to) === want) process.exit(0)

rmSync(to, { recursive: true, force: true })
mkdirSync(dirname(to), { recursive: true })
cpSync(from, to, { recursive: true })
console.log(`[excalidraw-assets] copied ${want} font files → src/renderer/public/excalidraw/fonts`)
