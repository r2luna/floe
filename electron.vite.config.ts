import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  // node-pty is a native module — keep it (and other deps) external so Vite
  // doesn't try to bundle the .node binary into the main/preload output.
  main: { plugins: [externalizeDepsPlugin()] },
  preload: { plugins: [externalizeDepsPlugin()] },
  renderer: {
    resolve: {
      alias: { '@': resolve('src/renderer/src') }
    },
    build: { minify: 'esbuild' },
    plugins: [react()]
  }
})
