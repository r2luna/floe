// Dev-only CDP driver for GUI verification: eval JS in the running dev window,
// send keys, or grab a screenshot. Launch the app with ROOKERY_CDP_PORT=9401.
//   node scripts/cdp-drive.mjs eval "document.title"
//   node scripts/cdp-drive.mjs key p 4        (4 = Meta)
//   node scripts/cdp-drive.mjs shot /tmp/x.png
import WebSocket from 'ws'
import { writeFileSync } from 'node:fs'

const PORT = process.env.ROOKERY_CDP_PORT || 9401
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const page = list.find((t) => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
ws.on('message', (d) => {
  const m = JSON.parse(d.toString())
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m)
    pending.delete(m.id)
  }
})
await new Promise((r) => ws.on('open', r))
const send = (method, params = {}) =>
  new Promise((res) => {
    const i = ++id
    pending.set(i, res)
    ws.send(JSON.stringify({ id: i, method, params }))
  })

const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  return r.result?.result?.value ?? r.result?.exceptionDetails?.exception?.description ?? null
}

const key = async (k, mod = 0, text) => {
  const base = { key: k, modifiers: Number(mod), text }
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base })
  if (text) await send('Input.dispatchKeyEvent', { type: 'char', ...base })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
}

// A real pointer drag: press, a few moves (one event is not a drag), release.
// Synthetic PointerEvents from page JS can't be captured with setPointerCapture,
// so anything using pointer capture — the panel splitters — can only be driven
// from here.
const drag = async (from, to, steps = 8) => {
  const [x1, y1] = from.split(',').map(Number)
  const [x2, y2] = to.split(',').map(Number)
  const base = { button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' }
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x1, y: y1, ...base })
  for (let i = 1; i <= steps; i++) {
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Math.round(x1 + ((x2 - x1) * i) / steps),
      y: Math.round(y1 + ((y2 - y1) * i) / steps),
      ...base
    })
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x2, y: y2, ...base, buttons: 0 })
}

const [cmd, a, b] = process.argv.slice(2)
if (cmd === 'eval') console.log(JSON.stringify(await evalJs(a), null, 2))
// insertText, not per-key events: typing into a field that lost focus would
// otherwise fire the app's global shortcuts one letter at a time.
else if (cmd === 'type') await send('Input.insertText', { text: a })
else if (cmd === 'key') await key(a, b)
else if (cmd === 'drag') await drag(a, b)
else if (cmd === 'shot') {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(a, Buffer.from(r.result.data, 'base64'))
  console.log('saved', a)
}
ws.close()
