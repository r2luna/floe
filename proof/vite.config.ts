import { resolve } from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Standalone Vite app for the proof harness: serves proof/index.html and bundles
// the REAL renderer component + CSS so the recorded video is the actual UI.
export default defineConfig({
  root: resolve(__dirname),
  resolve: { alias: { '@': resolve(__dirname, '../src/renderer/src') } },
  plugins: [react()],
  server: { port: 5199, strictPort: true }
})
