// An IpcLike over a WebSocket to a remote Floe backend — the transport half of
// attached mode. Same shape the preload hands buildFloeApi, so the api layer
// cannot tell a socket from Electron IPC. Reconnects with backoff, keeps every
// listener across reconnects, and queues invokes until the hello handshake
// clears; pending invokes reject when the socket drops so callers fail fast
// instead of hanging.

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

export function createSocketIpc(url: string, token: string, version: string): SocketIpc {
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
    ws.onclose = () => {
      ready = false
      failPending('remote backend disconnected')
      if (closedByUser) return setState('closed')
      setState('connecting')
      setTimeout(connect, retryMs)
      retryMs = Math.min(retryMs * 2, 10_000)
    }
    ws.onerror = () => {
      // onclose follows and owns the retry.
    }
  }
  connect()

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
      failPending('remote backend connection closed')
      ws?.close()
      setState('closed')
    },
    state: () => currentState,
    onState: (cb) => stateCbs.push(cb),
    serverVersion: () => remoteVersion
  }
}
