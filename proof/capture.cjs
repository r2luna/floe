// Loads the proof harness in a real Electron window and saves a PNG every frame
// while the scripted ds-implement animation plays out, so ffmpeg can stitch a
// video of the actual UI. Run via: electron proof/capture.cjs
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')

const URL = process.env.PROOF_URL || 'http://localhost:5199'
const OUT = path.join(__dirname, 'frames')
const FPS = 12
const DURATION_MS = 11000

app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  fs.rmSync(OUT, { recursive: true, force: true })
  fs.mkdirSync(OUT, { recursive: true })

  const win = new BrowserWindow({
    width: 360,
    height: 560,
    show: true,
    x: 40,
    y: 40,
    frame: false,
    webPreferences: { offscreen: false }
  })
  await win.loadURL(URL)
  await new Promise((r) => setTimeout(r, 400)) // let React mount + first paint

  const frames = Math.round((DURATION_MS / 1000) * FPS)
  const interval = 1000 / FPS
  for (let i = 0; i < frames; i++) {
    const t0 = Date.now()
    const img = await win.webContents.capturePage()
    fs.writeFileSync(path.join(OUT, `f${String(i).padStart(4, '0')}.png`), img.toPNG())
    const elapsed = Date.now() - t0
    if (elapsed < interval) await new Promise((r) => setTimeout(r, interval - elapsed))
  }
  console.log(`captured ${frames} frames -> ${OUT}`)
  app.quit()
})
