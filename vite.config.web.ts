// The browser build of the Floe UI, served by the daemon (src/main/webServer.ts).
//
// Separate from electron.vite.config.ts on purpose: that file's `renderer`
// block builds the same React tree for a BrowserWindow, where the preload has
// already put `window.floe` there. Here the entry does that itself (src/web),
// and everything downstream of it is byte-identical to the desktop renderer.
import { resolve } from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: resolve('src/web'),
  // Rooted, not relative: the daemon answers any unknown path with index.html so
  // a deep link survives a reload, and relative asset urls would then resolve
  // against the route.
  base: '/',
  // The desktop page's static files (icons, manifest, the excalidraw fonts that
  // scripts/copy-excalidraw-assets.mjs writes) — shared, not copied.
  publicDir: resolve('src/renderer/public'),
  resolve: {
    alias: { '@': resolve('src/renderer/src') }
  },
  // @excalidraw/excalidraw reads this at module scope to pick its React or
  // Preact bundle, and a browser has no `process` — without the define the
  // import throws before the canvas mounts. Same reason as the electron config.
  define: { 'process.env.IS_PREACT': '"false"' },
  build: {
    outDir: resolve('out/web'),
    emptyOutDir: true,
    // Both entries await at the top level — the renderer reads floe.toml before
    // its first render, and src/web/main.ts installs the bridge before importing
    // it. Vite's default target predates top-level await and refuses to emit it.
    target: 'es2022',
    minify: 'esbuild'
  },
  plugins: [react()]
})
