// The browser's stand-in for the preload.
//
// `buildFloeApi(ipc, host)` was split out of the preload for exactly this (see
// scripts/extract-preload-api.mjs): the api is pure, so the same object the
// desktop renderer talks to can be built over a WebSocket instead of Electron
// IPC. `createSocketIpc` is already browser code — it uses the WebSocket global
// — so the transport is reused as-is.
//
// The one thing that does not carry over is PINNED_CHANNELS. On the desktop
// those mean "run this on the machine the WINDOW is on, not the backend". In a
// browser there is no such machine: the window is a tab. So each pinned channel
// is resolved one of two ways, and there is no third:
//
//   - it describes the workspace (config, keybindings, plugins, the user) — the
//     daemon is the only machine there is, so it goes over the socket like
//     everything else, and the pin simply does not apply;
//   - it describes a native window (vibrancy, hide, login item, the updater) —
//     the daemon shims it into a no-op and answering it there would be a lie, so
//     the tab answers it itself, with a browser API when one exists.

import { buildFloeApi, type BackendInfo, type FloeHost, type IpcLike } from '../preload/api'
import { createSocketIpc, type SocketIpc } from '../preload/socketIpc'
import { PINNED_CHANNELS } from '../shared/remoteProtocol'
import { secureBackendUrl } from './backendUrl'
import { rewriteProbe } from './mediaRewrite'

/** Written into the page by the server plugin's HTTP face, before this module loads. */
export interface FloeBoot {
  token: string
  homeDir: string
  platform: string
  version: string
  wsUrl: string
  /** The serving daemon's hostname — what the rail calls the "local" machine. */
  label: string
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type Listener = (...a: any[]) => void

/**
 * Channels the tab answers, because the daemon cannot answer them truthfully.
 *
 * `emit` pushes an event frame the same way the socket does, so a handler can
 * feed the renderer's `on(...)` subscriptions — that is how theme changes and
 * notification clicks arrive without a main process behind them.
 */
export function browserHandlers(
  emit: (channel: string, ...args: unknown[]) => void
): Record<string, (...args: any[]) => Promise<any>> {
  return {
    // The window is a tab. Capturing, hiding and vibrancy have no meaning, and
    // an answer of "done" is closer to the truth than the daemon's shim, which
    // would report on a window that is not the one being looked at.
    'window:capture': async () => undefined,
    'window:hide': async () => undefined,
    'window:focus': async () => {
      window.focus()
      return true
    },
    'window:getVibrancy': async () => false,
    'window:setVibrancy': async () => undefined,

    // Open at login belongs to an installed app; there is none.
    'app:getLoginItem': async () => false,
    'app:setLoginItem': async () => undefined,

    // On the desktop this hands the url to the OS. Here the browser IS the OS
    // handler, so a new tab is the whole behaviour. `noopener` because the page
    // holds a live session token.
    'open:external': async (url: string) => {
      window.open(url, '_blank', 'noopener,noreferrer')
    },

    // The daemon has no notification centre; the tab does, once permitted.
    // Clicking one has to reach the renderer's `onNotificationClick`, which
    // listens for a `notification:click` frame — so the click emits one.
    'notify:show': async (payload: { title: string; body: string; sessionId: string }) => {
      if (!('Notification' in window)) return
      if (Notification.permission === 'default') await Notification.requestPermission()
      if (Notification.permission !== 'granted') return
      const n = new Notification(payload.title, { body: payload.body, tag: payload.sessionId })
      n.onclick = () => {
        window.focus()
        emit('notification:click', payload.sessionId)
      }
    },

    // Light/dark follows the browser, not the daemon's (shimmed) nativeTheme.
    'theme:get': async () => matchMedia('(prefers-color-scheme: dark)').matches,

    // The desktop auto-updater installs a .app. A tab updates by reloading, and
    // the daemon it talks to is updated by a deploy — so there is nothing to
    // check and nothing to install.
    'update:check': async () => 'Floe na web acompanha o servidor — recarregue a página após um deploy.',
    'update:install': async () => {
      window.location.reload()
    },

    // Revealing a file in a file manager would open it on the daemon's desktop,
    // which nobody is sitting at.
    'config:reveal': async () => undefined,
    'keybindings:reveal': async () => undefined
    // `backends:get` is NOT here: it is the serving daemon's own machine list,
    // and the router below asks it over the socket like the preload asks main.
  }
}

export interface WebBridge {
  ipc: IpcLike
  host: FloeHost
  socket: SocketIpc
}

/** Wire the api's transport: browser handlers first, the socket for the rest. */
export function createWebBridge(boot: FloeBoot): WebBridge {
  const url =
    boot.wsUrl || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`
  const socket = createSocketIpc(url, boot.token, boot.version)

  // Events the tab raises itself. Kept separate from the socket's listener map
  // so a `theme:changed` synthesized here and a `session:output` arriving from
  // the daemon reach the same subscription without either knowing about the
  // other.
  const local = new Map<string, Set<Listener>>()
  const emit = (channel: string, ...args: unknown[]): void => {
    for (const l of local.get(channel) ?? []) l({}, ...args)
  }

  const handlers = browserHandlers(emit)

  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) =>
    emit('theme:changed', e.matches)
  )

  // --- multi-backend routing -------------------------------------------------
  // The preload's router (src/preload/index.ts), with one substitution: there,
  // "local" is Electron IPC to the main process in the same app; here it is the
  // socket to the daemon that served the page. Everything else is the same —
  // one pointer says where workspace calls go, PINNED channels ignore it, and
  // every subscription replays onto a socket opened later so a machine paired
  // mid-session still delivers its events.
  const remotes = new Map<string, { info: BackendInfo; ipc: SocketIpc }>()
  const urls = new Map<string, string>()
  const subscriptions: Array<{ channel: string; listener: Listener }> = []
  let current = 'local'

  const syncBackends = (): void => {
    void socket
      .invoke('backends:get')
      .then((list: Array<{ id: string; label: string; url: string; token: string }>) => {
        const wanted = new Set<string>()
        for (const b of list) {
          const secure = secureBackendUrl(b.url, location.protocol)
          // A machine this page cannot open safely is dropped rather than shown
          // broken: see backendUrl.ts for why there is no downgrade path.
          if (!secure) continue
          wanted.add(b.id)
          const key = `${secure}#${b.token}`
          if (remotes.has(b.id)) {
            if (urls.get(b.id) === key) continue
            remotes.get(b.id)!.ipc.close()
            remotes.delete(b.id)
          }
          const ipc = createSocketIpc(secure, b.token, boot.version)
          for (const s of subscriptions) ipc.on(s.channel, s.listener)
          remotes.set(b.id, {
            info: { id: b.id, label: b.label, homeDir: '', remote: true },
            ipc
          })
          urls.set(b.id, key)
        }
        for (const [id, r] of remotes) {
          if (wanted.has(id)) continue
          r.ipc.close()
          remotes.delete(id)
          urls.delete(id)
          if (current === id) current = 'local'
        }
      })
      .catch(() => {
        // No backends handler on the daemon just means this machine only.
      })
  }
  syncBackends()
  socket.on('backends:changed', syncBackends)

  const routeFor = (channel: string): IpcLike =>
    current !== 'local' && !PINNED_CHANNELS.has(channel)
      ? (remotes.get(current)?.ipc ?? socket)
      : socket

  const ipc: IpcLike = {
    invoke: (channel, ...args) => {
      const handler = handlers[channel]
      if (handler) return handler(...args)
      const answer = routeFor(channel).invoke(channel, ...args)
      // The one answer whose CONTENT is host-specific: a `floe-media://` address
      // means nothing to a tab. Rewritten here so the renderer never learns that
      // a web build exists — see mediaRewrite.ts.
      return channel === 'media:probe' ? answer.then(rewriteProbe) : answer
    },
    on: (channel, listener) => {
      if (!local.has(channel)) local.set(channel, new Set())
      local.get(channel)!.add(listener)
      subscriptions.push({ channel, listener })
      socket.on(channel, listener)
      // Events fan IN from every machine at once, exactly as on the desktop.
      for (const r of remotes.values()) r.ipc.on(channel, listener)
    },
    removeListener: (channel, listener) => {
      local.get(channel)?.delete(listener)
      const i = subscriptions.findIndex((s) => s.channel === channel && s.listener === listener)
      if (i >= 0) subscriptions.splice(i, 1)
      socket.removeListener(channel, listener)
      for (const r of remotes.values()) r.ipc.removeListener(channel, listener)
    }
  }

  const host: FloeHost = {
    // The browser's platform, not the daemon's: this only ever labels the
    // machine the keys are pressed on.
    platform: navigator.platform || 'web',
    version: navigator.userAgent,
    appVersion: boot.version,
    homeDir: boot.homeDir,
    // A tab is not launched from a worktree, so there is no tag to tell builds
    // apart by.
    worktreeTag: null,
    backendsCtl: {
      list: () => [
        { id: 'local', label: boot.label, homeDir: boot.homeDir, remote: false },
        ...[...remotes.values()].map((r) => r.info)
      ],
      current: () => current,
      use: (id) => {
        if (id !== 'local' && !remotes.has(id)) return false
        current = id
        return true
      },
      state: (id) => remotes.get(id)?.ipc.state() ?? (id === 'local' ? socket.state() : 'closed'),
      invokeOn: (id, channel, ...args) => {
        // Same rule as the router, enforced here so the escape hatch cannot go
        // around it: a pinned channel is this page's own, whatever id it names.
        if (id === 'local' || PINNED_CHANNELS.has(channel)) return socket.invoke(channel, ...args)
        const remote = remotes.get(id)
        // Refuse rather than fall back: rerouting to the serving daemon would
        // check the named machine's path against the wrong disk.
        if (!remote) return Promise.reject(new Error(`No such backend: ${id}`))
        return remote.ipc.invoke(channel, ...args)
      }
    }
  }

  return { ipc, host, socket }
}

/** Install `window.floe`. Must run before the renderer's entry module. */
export function installFloe(boot: FloeBoot): void {
  const { ipc, host } = createWebBridge(boot)
  ;(window as unknown as { floe: unknown }).floe = buildFloeApi(ipc, host)
}
