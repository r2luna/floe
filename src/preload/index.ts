import { contextBridge, ipcRenderer } from 'electron'
import { homedir } from 'node:os'
import pkg from '../../package.json'
import { buildFloeApi, type BackendInfo, type FloeHost, type IpcLike } from './api'
import { createSocketIpc, type SocketIpc } from './socketIpc'
import { PINNED_CHANNELS } from '../shared/remoteProtocol'

// The worktree this app instance runs in: explicit env, else the segment after
// `.worktrees/` in the launch path. Null on the main checkout.
function worktreeTag(): string | null {
  const env = process.env.FLOE_WORKTREE
  if (env) return env
  const match = process.cwd().split('/.worktrees/')[1]
  return match ? match.split('/')[0] : null
}

// --- multi-backend routing ---------------------------------------------------
// One IpcLike per remote backend (a Floe served by the server-mode plugin or
// the headless daemon), plus the local ipcRenderer. A single pointer says where
// workspace calls go; PINNED channels (the window, notifications, the local
// theme/config/plugins) always stay local. Backends come from main at load —
// plugins registered them before the window existed (boot order guarantees it) —
// so adding or removing one takes a window reload, while switching is live.

/* eslint-disable @typescript-eslint/no-explicit-any */
type Listener = (...a: any[]) => void

const remotes = new Map<string, { info: BackendInfo; ipc: SocketIpc }>()
let current = 'local'
// Every on() ever made, so a socket created after the api was built still gets
// the full subscription set (events fan IN from all backends at once).
const subscriptions: Array<{ channel: string; listener: Listener }> = []

const router: IpcLike = {
  invoke: (channel: string, ...args: any[]): Promise<any> => {
    const remote = current !== 'local' && !PINNED_CHANNELS.has(channel) ? remotes.get(current) : undefined
    return (remote?.ipc ?? ipcRenderer).invoke(channel, ...args)
  },
  on: (channel, listener) => {
    subscriptions.push({ channel, listener })
    ipcRenderer.on(channel, listener)
    for (const r of remotes.values()) r.ipc.on(channel, listener)
  },
  removeListener: (channel, listener) => {
    const i = subscriptions.findIndex((s) => s.channel === channel && s.listener === listener)
    if (i >= 0) subscriptions.splice(i, 1)
    ipcRenderer.removeListener(channel, listener)
    for (const r of remotes.values()) r.ipc.removeListener(channel, listener)
  }
}

void ipcRenderer
  .invoke('backends:get')
  .then((list: Array<{ id: string; label: string; url: string; token: string }>) => {
    for (const b of list) {
      if (remotes.has(b.id)) continue
      const ipc = createSocketIpc(b.url, b.token, pkg.version as string)
      for (const s of subscriptions) ipc.on(s.channel, s.listener)
      remotes.set(b.id, {
        info: { id: b.id, label: b.label, homeDir: '', remote: true },
        ipc
      })
    }
  })
  .catch(() => {
    // No backends handler (host not loaded) just means local-only.
  })

const host: FloeHost = {
  platform: process.platform,
  version: process.versions.electron,
  appVersion: pkg.version as string,
  // The user's home is the cwd of the synthetic "Home" workspace the app boots into.
  homeDir: homedir(),
  // Names the worktree THIS WINDOW was launched from, so side-by-side dev builds
  // are tellable apart.
  worktreeTag: worktreeTag(),
  backendsCtl: {
    list: () => [
      { id: 'local', label: homedir().split('/').pop() || 'local', homeDir: homedir(), remote: false },
      ...[...remotes.values()].map((r) => r.info)
    ],
    current: () => current,
    use: (id) => {
      if (id !== 'local' && !remotes.has(id)) return false
      current = id
      return true
    },
    state: (id) => remotes.get(id)?.ipc.state() ?? (id === 'local' ? 'open' : 'closed')
  }
}

contextBridge.exposeInMainWorld('floe', buildFloeApi(router, host))

export type { FloeApi } from './api'
