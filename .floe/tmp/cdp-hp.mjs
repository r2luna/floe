// usage: node cdp-hp.mjs <out.png> "<js expression to eval first>"
const [out, expr] = process.argv.slice(2)
let targets = []
for (let i = 0; i < 90; i++) {
  try {
    targets = (await (await fetch('http://127.0.0.1:9466/json')).json()).filter((t) => t.type === 'page')
    if (targets.length) break
  } catch {}
  await new Promise((r) => setTimeout(r, 1000))
}
const ws = new WebSocket(targets[0].webSocketDebuggerUrl)
let id = 0
const pending = new Map()
ws.onmessage = (m) => {
  const d = JSON.parse(m.data)
  if (pending.has(d.id)) pending.get(d.id)(d)
}
ws.onerror = (e) => {
  console.error('ws error', e.message)
  process.exit(1)
}
await new Promise((r) => (ws.onopen = r))
const send = (method, params = {}) =>
  new Promise((r) => {
    const i = ++id
    pending.set(i, r)
    ws.send(JSON.stringify({ id: i, method, params }))
  })
await send('Page.bringToFront')
if (expr) {
  const res = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
  console.log(JSON.stringify(res.result?.result?.value ?? res.result))
}
await new Promise((r) => setTimeout(r, 1200))
const shot = await send('Page.captureScreenshot', { format: 'png' })
const fs = await import('node:fs')
fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'))
ws.close()
