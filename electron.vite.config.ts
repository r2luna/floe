import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  // node-pty is a native module — keep it (and other deps) external so Vite
  // doesn't try to bundle the .node binary into the main/preload output.
  // `ws` is a devDependency, so it is bundled. Its optional native helpers are
  // not installed, and bundled Vite stubs them: in a build with `{}`, which ws
  // takes for the real thing and then calls `mask` on (every client frame of 48
  // bytes or more throws), in dev with a module that throws at load. External,
  // the `require` fails inside ws's own try and it falls back to plain JS.
  main: { plugins: [externalizeDepsPlugin({ include: ['bufferutil', 'utf-8-validate'] })] },
  preload: { plugins: [externalizeDepsPlugin()] },
  renderer: {
    resolve: {
      alias: { '@': resolve('src/renderer/src') }
    },
    // @excalidraw/excalidraw ships one bundle for React and one for Preact and
    // picks between them by reading this at module scope. Vite has no `process`
    // in the browser, so without the define the import throws before the canvas
    // ever mounts.
    define: { 'process.env.IS_PREACT': '"false"' },
    build: { minify: 'esbuild' },
    plugins: [react()]
  }
})
