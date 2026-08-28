// WebSocket-backed IpcLike for attached mode: the preload dials the remote
// backend's /ws and speaks the same wire the server's web (PWA) client uses:
//   -> {t:'invoke', id, channel, args}
//   <- {t:'reply'|'error', id, …} | {t:'event', channel, args} | {t:'superseded'}
// Ported from the server branch's webBridge: reconnect with a send queue, and
// in-flight invokes rejected on disconnect (the server keeps no memory of an
// invoke once its socket drops, so a reply can never come). DOM-free on
// purpose — status is surfaced through the callback, the caller owns the UX.
import type { IpcLike } from './api'

export interface SocketStatus {
  connected: boolean
  // Another client (browser tab or window) took over the single-active-client
  // backend. We park: no reconnect, every invoke rejects.
  superseded: boolean
}

// Distinct name (not just message) so callers can tell transport failures apart
// from real app errors that happen to share the text.
const transportError = (reason: string): Error =>
  Object.assign(new Error(reason), { name: 'RookeryTransport' })

// A dropped VPN/tailnet leaves the socket wedged OPEN with dead TCP under it:
// no close event ever fires, so in-flight invokes sit in `pending` forever and
// the UI goes quiet — a click or ⏎ that produces nothing, no error, no clue
// (this is exactly how a hung Tailscale made "new worktree" do nothing). The
// browser WebSocket API exposes no protocol-level ping, so we heartbeat at the
// app level and treat a missed pong as a dead link.
const PING_MS = 5000
const DEAD_MS = 12000

export function createSocketIpc(wsUrl: string, onStatus?: (s: SocketStatus) => void): IpcLike {
  let ws: WebSocket | null = null
  let nextId = 1
  let superseded = false
  let opened = false // has ever connected — used to fire a reconnect (not first-open) signal
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  const listeners = new Map<string, Array<(...a: unknown[]) => void>>()
  const outbox: string[] = []

  const status = (): void => onStatus?.({ connected: !!ws && ws.readyState === WebSocket.OPEN, superseded })

  function flush(): void {
    if (ws && ws.readyState === WebSocket.OPEN) {
      for (const m of outbox.splice(0)) ws.send(m)
    }
  }

  function failPending(reason: string): void {
    for (const { reject } of pending.values()) reject(transportError(reason))
    pending.clear()
    outbox.length = 0
  }

  function connect(): void {
    const sock = (ws = new WebSocket(wsUrl))
    let lastPong = Date.now()
    // Servers older than this client never answer a ping — only hold them to the
    // deadline once one has proven it speaks pong, or a version skew would put
    // the window in a permanent reconnect loop.
    let sawPong = false

    // Tear down a socket we believe is dead. close() alone isn't enough: on a
    // wedged connection the close handshake has nobody to answer it, so onclose
    // may never fire — unhook it and drive the reconnect ourselves.
    const drop = (): void => {
      if (ws !== sock) return
      ws = null
      clearInterval(beat)
      sock.onclose = null
      sock.onmessage = null
      sock.onerror = null
      try {
        sock.close()
      } catch {
        /* already gone */
      }
      failPending('disconnected')
      status()
      if (!superseded) setTimeout(connect, 800)
    }

    const beat = setInterval(() => {
      if (sock.readyState !== WebSocket.OPEN) return
      if (sawPong && Date.now() - lastPong > DEAD_MS) return drop()
      sock.send(JSON.stringify({ t: 'ping' }))
    }, PING_MS)

    ws.onopen = (): void => {
      lastPong = Date.now()
      flush()
      // First open is the boot load (App does its own initial fetch); only a
      // RE-open means we were disconnected and missed events — signal a refetch.
      if (opened) for (const l of listeners.get('transport:connected') || []) l({})
      opened = true
      status()
    }
    ws.onclose = (): void => {
      ws = null
      clearInterval(beat)
      failPending('disconnected')
      status()
      if (!superseded) setTimeout(connect, 800) // queued sends flush on reopen
    }
    ws.onerror = (): void => ws?.close()
    ws.onmessage = (ev): void => {
      let msg: { t: string; id?: number; result?: unknown; error?: string; channel?: string; args?: unknown[] }
      try {
        msg = JSON.parse(ev.data as string)
      } catch {
        return
      }
      if (msg.t === 'pong') {
        lastPong = Date.now()
        sawPong = true
      } else if (msg.t === 'superseded') {
        superseded = true
        failPending('superseded')
        ws?.close()
        status()
      } else if (msg.t === 'reply' && msg.id != null) {
        pending.get(msg.id)?.resolve(msg.result)
        pending.delete(msg.id)
      } else if (msg.t === 'error' && msg.id != null) {
        pending.get(msg.id)?.reject(new Error(msg.error || 'error'))
        pending.delete(msg.id)
      } else if (msg.t === 'event' && msg.channel) {
        // Preload listeners expect (event, ...args); pass a dummy event first.
        for (const l of listeners.get(msg.channel) || []) l({}, ...(msg.args || []))
      }
    }
  }
  connect()

  return {
    invoke(channel: string, ...args: unknown[]): Promise<unknown> {
      if (superseded) return Promise.reject(transportError('superseded'))
      const id = nextId++
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        outbox.push(JSON.stringify({ t: 'invoke', id, channel, args }))
        flush()
      })
    },
    on(channel: string, listener: (...a: unknown[]) => void): void {
      const arr = listeners.get(channel) || []
      arr.push(listener)
      listeners.set(channel, arr)
    },
    removeListener(channel: string, listener: (...a: unknown[]) => void): void {
      const arr = listeners.get(channel)
      if (!arr) return
      const i = arr.indexOf(listener)
      if (i >= 0) arr.splice(i, 1)
    }
  }
}
