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

// Explicit .ts extensions, for the same reason socketIpc.ts uses them: this
// module is loaded by a plain `node --test` run as well as by Vite, and Node's
// ESM resolver does not guess extensions.
import { buildFloeApi, type BackendInfo, type FloeHost, type IpcLike } from '../preload/api.ts'
import { createSocketIpc, type SocketIpc } from '../preload/socketIpc.ts'
import { PINNED_CHANNELS } from '../shared/remoteProtocol.ts'
import { secureBackendUrl } from './backendUrl.ts'
import { rewriteProbe, rewriteTranscript } from './mediaRewrite.ts'

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
    // A browser cannot read the desk it runs on, and the daemon's Omarchy is
    // another machine's desktop — so `theme = "omarchy"` is `system` here.
    'omarchy:get': async () => null,

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
    'keybindings:reveal': async () => undefined,

    // The same reason `o` never opens a path here: the machine that holds the
    // file is not the one the browser is on. The renderer has already read the
    // bytes across (renderer/src/download.ts), so this is where they become a
    // download — the tab's only way to put a file on the user's computer.
    // Answers null: where it landed is the browser's business, not ours.
    'files:openDownload': async (name: string, base64: string) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
      const url = URL.createObjectURL(new Blob([bytes]))
      const link = document.createElement('a')
      link.href = url
      link.download = name
      link.click()
      // Revoked on the next tick, not now: Chromium reads the blob after the
      // click returns, and a url pulled out from under it downloads nothing.
      setTimeout(() => URL.revokeObjectURL(url), 0)
      return null
    }
    // `backends:get` is NOT here: it is the serving daemon's own machine list,
    // and the router below asks it over the socket like the preload asks main.
  }
}

export interface WebBridge {
  ipc: IpcLike
  host: FloeHost
  socket: SocketIpc
}

/** One paired machine: the socket to it, and the row the rail shows for it. */
interface Remote {
  info: BackendInfo
  ipc: SocketIpc
}

/**
 * The multi-backend routing state, in one object.
 *
 * It lives out here rather than in `createWebBridge`'s closure so the three
 * pieces below can be module-level functions: a nested arrow is scored as part
 * of its parent, so only a real extraction lowers the parent's number
 * (docs/crap.md).
 */
export interface BackendTable {
  remotes: Map<string, Remote>
  /** id → `url#token`, so a machine re-paired at a new address gets a new socket. */
  urls: Map<string, string>
  /** Every on() ever made, replayed onto a socket opened later. */
  subscriptions: Array<{ channel: string; listener: Listener }>
  /** Where workspace calls go: a remote id, or 'local' for the serving daemon. */
  current: string
}

export function newBackendTable(): BackendTable {
  return { remotes: new Map(), urls: new Map(), subscriptions: [], current: 'local' }
}

export interface BackendRow {
  id: string
  label: string
  url: string
  token: string
}

/**
 * Bring `table` in line with the daemon's machine list: open sockets for what is
 * new, replace the ones whose address or token changed, close what is gone.
 *
 * `open` is passed in rather than called directly so the app version it stamps
 * on the handshake stays the page's, and so a test can watch the sockets.
 */
export function reconcileBackends(
  table: BackendTable,
  list: BackendRow[],
  open: (url: string, token: string) => SocketIpc,
  pageProtocol: string
): void {
  const wanted = new Set<string>()
  for (const b of list) {
    const secure = secureBackendUrl(b.url, pageProtocol)
    // A machine this page cannot open safely is dropped rather than shown
    // broken: see backendUrl.ts for why there is no downgrade path.
    if (!secure) continue
    wanted.add(b.id)
    const key = `${secure}#${b.token}`
    if (table.remotes.has(b.id)) {
      if (table.urls.get(b.id) === key) continue
      table.remotes.get(b.id)!.ipc.close()
      table.remotes.delete(b.id)
    }
    const ipc = open(secure, b.token)
    for (const s of table.subscriptions) ipc.on(s.channel, s.listener)
    table.remotes.set(b.id, {
      info: { id: b.id, label: b.label, homeDir: '', remote: true },
      ipc
    })
    table.urls.set(b.id, key)
  }
  for (const [id, r] of table.remotes) {
    if (wanted.has(id)) continue
    r.ipc.close()
    table.remotes.delete(id)
    table.urls.delete(id)
    if (table.current === id) table.current = 'local'
  }
}

/**
 * The api's transport: browser handlers first, then the pointer's socket.
 *
 * `local` holds the subscriptions the tab feeds itself (see `emit` below), and
 * is the same set `on`/`removeListener` maintain for the socket — so a
 * `theme:changed` synthesized here and a `session:output` arriving from the
 * daemon reach the same subscription without either knowing about the other.
 */
export function webIpc(
  socket: SocketIpc,
  table: BackendTable,
  handlers: Record<string, (...args: any[]) => Promise<any>>,
  local: Map<string, Set<Listener>>
): IpcLike {
  // Which machine a channel lands on. Named rather than resolved straight to a
  // socket because a media answer has to say WHERE it came from, and the rail
  // can be moved while the invoke is still in flight.
  const backendFor = (channel: string): string =>
    table.current !== 'local' &&
    !PINNED_CHANNELS.has(channel) &&
    table.remotes.has(table.current)
      ? table.current
      : 'local'

  return {
    invoke: (channel, ...args) => {
      const handler = handlers[channel]
      if (handler) return handler(...args)
      const on = backendFor(channel)
      const answer = (on === 'local' ? socket : table.remotes.get(on)!.ipc).invoke(
        channel,
        ...args
      )
      // The two answers whose CONTENT is host-specific: a `floe-media://`
      // address means nothing to a tab. Rewritten here — with the machine that
      // answered, since that is the only one holding the file — so the renderer
      // never learns that a web build exists. See mediaRewrite.ts.
      if (channel === 'media:probe') return answer.then((r) => rewriteProbe(r, on))
      if (channel === 'claude:transcript') return answer.then((r) => rewriteTranscript(r, on))
      return answer
    },
    on: (channel, listener) => {
      if (!local.has(channel)) local.set(channel, new Set())
      local.get(channel)!.add(listener)
      table.subscriptions.push({ channel, listener })
      socket.on(channel, listener)
      // Events fan IN from every machine at once, exactly as on the desktop.
      for (const r of table.remotes.values()) r.ipc.on(channel, listener)
    },
    removeListener: (channel, listener) => {
      local.get(channel)?.delete(listener)
      const i = table.subscriptions.findIndex(
        (s) => s.channel === channel && s.listener === listener
      )
      if (i >= 0) table.subscriptions.splice(i, 1)
      socket.removeListener(channel, listener)
      for (const r of table.remotes.values()) r.ipc.removeListener(channel, listener)
    }
  }
}

/** What the tab knows about itself, plus the controls the rail steers with. */
export function webHost(boot: FloeBoot, table: BackendTable, socket: SocketIpc): FloeHost {
  return {
    // Never — whichever machine the rail points at, it is not the computer the
    // browser is running on. `o` reads that and copies the file over instead of
    // opening a path on someone else's desk.
    onThisMachine: () => false,
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
        ...[...table.remotes.values()].map((r) => r.info)
      ],
      current: () => table.current,
      use: (id) => {
        if (id !== 'local' && !table.remotes.has(id)) return false
        table.current = id
        return true
      },
      state: (id) =>
        table.remotes.get(id)?.ipc.state() ?? (id === 'local' ? socket.state() : 'closed'),
      invokeOn: (id, channel, ...args) => {
        // Same rule as the router, enforced here so the escape hatch cannot go
        // around it: a pinned channel is this page's own, whatever id it names.
        if (id === 'local' || PINNED_CHANNELS.has(channel)) return socket.invoke(channel, ...args)
        const remote = table.remotes.get(id)
        // Refuse rather than fall back: rerouting to the serving daemon would
        // check the named machine's path against the wrong disk.
        if (!remote) return Promise.reject(new Error(`No such backend: ${id}`))
        return remote.ipc.invoke(channel, ...args)
      }
    }
  }
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
  const table = newBackendTable()
  const openSocket = (u: string, token: string): SocketIpc =>
    createSocketIpc(u, token, boot.version)

  const syncBackends = (): void => {
    void socket
      .invoke('backends:get')
      .then((list: BackendRow[]) =>
        reconcileBackends(table, list, openSocket, location.protocol)
      )
      .catch(() => {
        // No backends handler on the daemon just means this machine only.
      })
  }
  syncBackends()
  socket.on('backends:changed', syncBackends)

  return { ipc: webIpc(socket, table, handlers, local), host: webHost(boot, table, socket), socket }
}

/** Install `window.floe`. Must run before the renderer's entry module. */
export function installFloe(boot: FloeBoot): void {
  const { ipc, host } = createWebBridge(boot)
  ;(window as unknown as { floe: unknown }).floe = buildFloeApi(ipc, host)
}
