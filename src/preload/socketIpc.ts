// An IpcLike over a WebSocket to a remote Floe backend — the transport half of
// attached mode. Same shape the preload hands buildFloeApi, so the api layer
// cannot tell a socket from Electron IPC. Reconnects with backoff, keeps every
// listener across reconnects, and queues invokes until the hello handshake
// clears; pending invokes reject when the socket drops so callers fail fast
// instead of hanging.
//
// A phone is the hard case for all of this: the OS freezes the tab and the radio
// changes networks, and the socket can stay OPEN here long after it died. So the
// connection is probed on a timer and on every return to the page, and each
// reconnect after the first is announced: the gate keeps no backlog per client,
// so whatever it broadcast in the gap is gone unless the renderer asks again.

// Explicit .ts extension: this module is loaded by a plain `node --test` run as
// well as by Vite, and Node's ESM resolver does not guess extensions.
import type { IpcLike } from './api'
import { parseServerMsg, type ClientMsg } from '../shared/remoteProtocol.ts'

export type SocketState = 'connecting' | 'open' | 'closed'

export interface SocketIpc extends IpcLike {
  close(): void
  state(): SocketState
  onState(cb: (s: SocketState) => void): void
  /** The remote's app version, once hello-ok arrived — feeds the skew warning. */
  serverVersion(): string | null
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type Listener = (...a: any[]) => void

/** Raised locally on every reconnect after the first; never sent by a server. */
export const RECONNECTED_CHANNEL = 'backend:reconnected'

/** Any answer proves the socket is alive, even "no handler", so any channel will do. */
const PROBE_CHANNEL = 'backends:get'

export interface ProbeTiming {
  everyMs: number
  timeoutMs: number
}

const DEFAULT_PROBE: ProbeTiming = { everyMs: 15_000, timeoutMs: 5_000 }

/** Call `onWake` when the page comes back or the network does. A no-op outside a page. */
function watchWake(onWake: () => void): () => void {
  if (typeof document === 'undefined') return () => {}
  const onVisible = (): void => {
    if (!document.hidden) onWake()
  }
  document.addEventListener('visibilitychange', onVisible)
  window.addEventListener('online', onWake)
  return () => {
    document.removeEventListener('visibilitychange', onVisible)
    window.removeEventListener('online', onWake)
  }
}

export function createSocketIpc(
  url: string,
  token: string,
  version: string,
  probeTiming: ProbeTiming = DEFAULT_PROBE
): SocketIpc {
  const listeners = new Map<string, Set<Listener>>()
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  const stateCbs: Array<(s: SocketState) => void> = []
  let queue: ClientMsg[] = []
  let ws: WebSocket | null = null
  let ready = false
  let closedByUser = false
  let nextId = 1
  let retryMs = 1000
  let remoteVersion: string | null = null
  let currentState: SocketState = 'connecting'
  let everConnected = false
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let probeTimer: ReturnType<typeof setInterval> | undefined
  let probeDeadline: ReturnType<typeof setTimeout> | undefined

  const setState = (s: SocketState): void => {
    if (s === currentState) return
    currentState = s
    for (const cb of stateCbs) cb(s)
  }

  const failPending = (why: string): void => {
    for (const p of pending.values()) p.reject(new Error(why))
    pending.clear()
  }

  const send = (msg: ClientMsg): void => {
    if (ready && ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
    else queue.push(msg)
  }

  /** The socket is gone, however we found out. Owns the retry. */
  const lost = (): void => {
    ready = false
    clearInterval(probeTimer)
    failPending('remote backend disconnected')
    if (closedByUser) return setState('closed')
    setState('connecting')
    retryTimer = setTimeout(connect, retryMs)
    retryMs = Math.min(retryMs * 2, 10_000)
  }

  /** Stop listening to the current socket. A dead one may never report its own close. */
  const abandon = (): void => {
    if (!ws) return
    ws.onclose = null
    ws.onmessage = null
    ws.close()
  }

  const probe = (): void => {
    if (!ready || probeDeadline) return
    const settle = (): void => {
      clearTimeout(probeDeadline)
      probeDeadline = undefined
    }
    const id = nextId++
    pending.set(id, { resolve: settle, reject: settle })
    probeDeadline = setTimeout(() => {
      probeDeadline = undefined
      abandon()
      lost()
    }, probeTiming.timeoutMs)
    send({ kind: 'invoke', id, channel: PROBE_CHANNEL, args: [] })
  }

  // Don't wait out a backoff, or an attempt started on the network that just
  // went away: this is the moment someone is looking at the page.
  const wake = (): void => {
    if (closedByUser) return
    if (ready) return probe()
    clearTimeout(retryTimer)
    retryMs = 1000
    abandon()
    connect()
  }

  const connect = (): void => {
    if (closedByUser) return
    setState('connecting')
    ready = false
    ws = new WebSocket(url)
    ws.onopen = () => {
      ws?.send(JSON.stringify({ kind: 'hello', token, version } satisfies ClientMsg))
    }
    ws.onmessage = (ev) => {
      const msg = parseServerMsg(ev.data)
      if (!msg) return
      if (msg.kind === 'hello-ok') {
        ready = true
        retryMs = 1000
        remoteVersion = msg.version
        setState('open')
        const backlog = queue
        queue = []
        for (const m of backlog) send(m)
        probeTimer = setInterval(probe, probeTiming.everyMs)
        // Under Node a timer holds the process open, and a heartbeat is no reason
        // to stay. A browser's timer is a number, with nothing to call.
        ;(probeTimer as { unref?: () => void }).unref?.()
        if (everConnected) for (const fn of listeners.get(RECONNECTED_CHANNEL) ?? []) fn({})
        everConnected = true
        return
      }
      if (msg.kind === 'hello-err') {
        // Wrong token never fixes itself — stop instead of hammering the server.
        closedByUser = true
        failPending(`remote refused: ${msg.error}`)
        ws?.close()
        setState('closed')
        return
      }
      if (msg.kind === 'result') {
        const p = pending.get(msg.id)
        if (!p) return
        pending.delete(msg.id)
        if (msg.ok) p.resolve(msg.value)
        else p.reject(new Error(msg.error ?? 'remote invoke failed'))
        return
      }
      // event — same calling convention Electron uses: the event object first.
      for (const fn of listeners.get(msg.channel) ?? []) fn({}, ...msg.args)
    }
    ws.onclose = lost
    ws.onerror = () => {
      // onclose follows and owns the retry.
    }
  }
  connect()
  const stopWatching = watchWake(wake)

  return {
    invoke: (channel: string, ...args: any[]): Promise<any> =>
      new Promise((resolve, reject) => {
        if (closedByUser) return reject(new Error('remote backend connection is closed'))
        const id = nextId++
        pending.set(id, { resolve, reject })
        send({ kind: 'invoke', id, channel, args })
      }),
    on: (channel, listener) => {
      let set = listeners.get(channel)
      if (!set) listeners.set(channel, (set = new Set()))
      set.add(listener)
    },
    removeListener: (channel, listener) => {
      listeners.get(channel)?.delete(listener)
    },
    close: () => {
      closedByUser = true
      stopWatching()
      clearTimeout(retryTimer)
      clearInterval(probeTimer)
      failPending('remote backend connection closed')
      ws?.close()
      setState('closed')
    },
    state: () => currentState,
    onState: (cb) => stateCbs.push(cb),
    serverVersion: () => remoteVersion
  }
}
