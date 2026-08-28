// Browser bridge: when the app runs as a web page (no Electron preload), reconstruct
// `window.rookery` from the SAME builder the preload uses (src/preload/api.ts), backed by
// a reconnecting WebSocket to the headless server instead of Electron IPC.
//
// Imported first in main.tsx so window.rookery exists before any module-level use. In the
// Electron build the preload already set window.rookery, so this is a no-op.
import { buildRookeryApi, type RookeryHost } from '../../../preload/api'
import { createSocketIpc } from '../../../preload/socket'
import { showConnectionNotice } from '../../../preload/connectionNotice'

interface InjectedHost {
  platform?: string
  appVersion?: string
  homeDir?: string
}

declare global {
  interface Window {
    __ROOKERY_HOST__?: InjectedHost
  }
}

if (!window.rookery) {
  const injected = window.__ROOKERY_HOST__ || {}
  const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`

  // Same transport the attached Electron window uses (reconnect + send queue +
  // heartbeat, so a wedged link can't leave invokes hanging silently), and the
  // same superseded/offline notices.
  const ipc = createSocketIpc(wsUrl, showConnectionNotice)

  const host: RookeryHost = {
    platform: injected.platform || 'linux',
    version: 'web',
    appVersion: injected.appVersion || '0.0.0',
    homeDir: injected.homeDir || '',
    worktreeTag: null
  }

  const api = buildRookeryApi(ipc, host)

  // Native-only Electron APIs the headless server can't perform (its shim just
  // logs/no-ops). In a browser these ARE available natively, so bind them here
  // instead of round-tripping to main.
  api.openExternal = async (url: string): Promise<void> => {
    // Same scheme allowlist the main process enforces (src/main/index.ts) — don't
    // hand window.open an arbitrary (e.g. javascript:) URL from a handler payload.
    if (/^(https?|mailto):/i.test(url)) window.open(url, '_blank', 'noopener,noreferrer')
  }
  // Raising the window: in a tab there IS no window to raise, and the server's
  // shim focus() is an empty stub — so round-tripping would let it answer "raised"
  // when nothing moved. Try the browser's own focus (usually ignored outside a
  // user gesture) and report false, so Fleet tells the user to switch manually
  // instead of claiming the jump worked.
  api.focus = async (): Promise<boolean> => {
    window.focus()
    return false
  }
  const notifyClickCbs = new Set<(id: string) => void>()
  api.notify = async ({ title, body, sessionId }): Promise<void> => {
    if (!('Notification' in window)) return
    if (Notification.permission === 'default') {
      try {
        await Notification.requestPermission()
      } catch {
        /* ignore */
      }
    }
    if (Notification.permission !== 'granted') return
    try {
      const n = new Notification(title, { body })
      n.onclick = () => {
        window.focus()
        notifyClickCbs.forEach((cb) => cb(sessionId))
      }
    } catch {
      /* some browsers throw on the constructor (e.g. Android) — notifications are best-effort */
    }
  }
  api.onNotificationClick = (cb: (sessionId: string) => void): (() => void) => {
    notifyClickCbs.add(cb)
    return () => notifyClickCbs.delete(cb)
  }

  // OS light/dark. The headless server has no nativeTheme (its shim hardcodes
  // dark), so round-tripping theme:get/theme:changed would pin the web app to
  // dark and never follow the browser's OS appearance. In a browser the real
  // source of truth IS matchMedia — bind it natively like the APIs above.
  const darkQuery = window.matchMedia('(prefers-color-scheme: dark)')
  api.theme = {
    isDark: async (): Promise<boolean> => darkQuery.matches,
    onChange: (cb: (isDark: boolean) => void): (() => void) => {
      const listener = (e: MediaQueryListEvent): void => cb(e.matches)
      darkQuery.addEventListener('change', listener)
      return () => darkQuery.removeEventListener('change', listener)
    }
  }

  window.rookery = api

  // failPending rejects in-flight invokes on a disconnect/supersede (correct — the
  // server can't reply to them). Many renderer calls are fire-and-forget without a
  // .catch, so a server restart would otherwise spam unhandled-rejection noise.
  // Swallow ONLY our transport errors (matched by name, not text); real rejections
  // still surface.
  window.addEventListener('unhandledrejection', (e) => {
    if ((e.reason as Error)?.name === 'RookeryTransport') e.preventDefault()
  })
}
