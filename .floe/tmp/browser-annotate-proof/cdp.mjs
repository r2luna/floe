// CDP helpers for driving the dev Floe on its own port.
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

export const PORT = 9471
export const FIXTURE = 'http://127.0.0.1:5199/checkout'
export const wait = (ms) => new Promise((r) => setTimeout(r, ms))

export async function targets() {
  const r = await fetch(`http://127.0.0.1:${PORT}/json`)
  return r.json()
}

export function connect(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
    }
  }
  const opened = new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = reject
  })
  const send = async (method, params = {}) => {
    await opened
    return new Promise((resolve, reject) => {
      const n = ++id
      pending.set(n, { resolve, reject })
      ws.send(JSON.stringify({ id: n, method, params }))
    })
  }
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
    return r.result.value
  }
  const key = async (k, code, opts = {}) => {
    const { text, modifiers = 0, vk } = opts
    const base = { key: k, code, modifiers, windowsVirtualKeyCode: vk ?? k.toUpperCase().charCodeAt(0) }
    await send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...base, ...(text ? { text } : {}) })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
  }
  const type = async (s) => {
    for (const ch of s) {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch })
    }
  }
  const shot = async (file) => {
    const r = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(file, Buffer.from(r.data, 'base64'))
  }
  return { send, evaluate, key, type, shot, close: () => ws.close() }
}

export async function app() {
  const list = await targets()
  const t = list.find((x) => x.type === 'page' && !x.url.includes(':5199') && !x.url.startsWith('about:') && !x.url.startsWith('devtools:'))
  if (!t) throw new Error('no renderer target: ' + JSON.stringify(list.map((x) => x.url)))
  return connect(t)
}

export async function page() {
  const t = (await targets()).find((x) => x.url.includes(':5199'))
  if (!t) throw new Error('no page target')
  return connect(t)
}

export function mcpPorts() {
  const pid = execFileSync('lsof', ['-nP', `-iTCP:${PORT}`, '-sTCP:LISTEN', '-t']).toString().trim().split('\n')[0]
  const out = execFileSync('lsof', ['-aPn', '-p', pid, '-iTCP', '-sTCP:LISTEN']).toString()
  return [...out.matchAll(/:(\d+) \(LISTEN\)/g)].map((m) => Number(m[1])).filter((p) => p !== PORT && p !== 9472)
}

/** JSON-RPC over the dev instance's own MCP server. The reply may be SSE. */
export async function mcp(port, name, args = {}) {
  const r = await fetch(`http://127.0.0.1:${port}/mcp/global`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
  })
  const raw = await r.text()
  const line = raw.split('\n').find((l) => l.startsWith('data:'))
  return JSON.parse(line ? line.slice(5) : raw).result
}
