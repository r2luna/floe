// The embedded browser pane: a native WebContentsView laid over the renderer's
// browser area. WebContentsView (not <iframe>, not <webview>) because the page
// must be a first-class CDP target of type "page": X-Frame-Options can't block
// a top-level load, and Playwright's connectOverCDP only drives "page" targets —
// which is how the attached server's Claude gets to see and drive the app under
// test. The one cost: it's an OS-level overlay that ignores z-index, so the
// renderer hides it (browser:setVisible) whenever an overlay/palette opens.
//
// One browser per window (the app backs a single worktree view at a time; the
// renderer remembers per-worktree URLs and re-points this view on switch).
import { BrowserWindow, WebContentsView, type IpcMainInvokeEvent } from 'electron'
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { WebSocketServer, WebSocket } from 'ws'
import { getAttachedServer } from './sessionStore'
import { parseSshTarget, ensureForward, freePort } from './sshTunnel'

export interface BrowserState {
  url: string
  title: string
  canGoBack: boolean
  canGoForward: boolean
}

const views = new Map<number, WebContentsView>() // host window webContents.id → view
// Last rect the renderer asked for, per host window. The pane's bounds push
// races view creation (React runs the pane's mount effect before App's `open`
// IPC resolves), and a push that lands first has nowhere to go — so remember it
// and apply it when the view appears. Without this the view is born 0×0 (or
// keeps a previous layout's rect) until something happens to resize the surface.
const paneBounds = new Map<number, { x: number; y: number; width: number; height: number }>()

// When attached over SSH, a loopback URL names a port on the SERVER (that's
// where the worktree apps listen) — transparently forward it and load the local
// end. Detached (or URL-attached), loopback is genuinely local: pass through.
async function resolveUrl(raw: string): Promise<string> {
  let u: URL
  try {
    u = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `http://${raw}`)
  } catch {
    throw new Error(`Invalid URL: ${raw}`)
  }
  const ssh = parseSshTarget(getAttachedServer())
  const loopback = u.hostname === '127.0.0.1' || u.hostname === 'localhost'
  if (ssh && loopback && u.port) {
    const localPort = await ensureForward(ssh.host, Number(u.port))
    u.port = String(localPort)
  }
  return u.toString()
}

// Slack (and Google sign-in, and every other login wall that sniffs the UA)
// refuses anything that isn't a current stock Chrome: Electron 33's UA carries
// Chrome/130 plus `Electron/` and `rookery/` tokens, and slack.com/workspace-signin
// answers it with a full-page "your browser is not supported" — which is what
// an MCP OAuth consent lands on. Present the pane as plain Chrome, floored at a
// version those checks still accept.
// ponytail: hardcoded floor — bump it if a site starts refusing us again, and
// delete the Math.max once Electron ships a Chromium newer than the floor.
const CHROME_FLOOR = 141
function chromeUserAgent(ua: string): string {
  const major = Number(ua.match(/Chrome\/(\d+)/)?.[1] ?? 0)
  return ua
    .replace(/ \S*(?:Electron|rookery)\/[\d.]+/gi, '')
    .replace(/Chrome\/[\d.]+/, `Chrome/${Math.max(major, CHROME_FLOOR)}.0.0.0`)
}

function state(view: WebContentsView): BrowserState {
  const wc = view.webContents
  return {
    url: wc.getURL(),
    title: wc.getTitle(),
    canGoBack: wc.navigationHistory.canGoBack(),
    canGoForward: wc.navigationHistory.canGoForward()
  }
}

function getView(event: IpcMainInvokeEvent): WebContentsView | null {
  return views.get(event.sender.id) ?? null
}

// Create (or reuse) `win`'s browser view. Shared by the IPC handler (a human
// or session switching to the browser view) and the CDP relay below (a
// session's Playwright creating its first target) — same map, same view,
// whichever side gets there first.
function getOrCreateView(win: BrowserWindow): WebContentsView {
  const hostId = win.webContents.id
  let view = views.get(hostId)
  if (view) return view
  view = new WebContentsView({ webPreferences: { sandbox: true } })
  views.set(hostId, view)
  win.contentView.addChildView(view)
  view.setBounds(paneBounds.get(hostId) ?? { x: 0, y: 0, width: 0, height: 0 })
  const wc = view.webContents
  wc.setUserAgent(chromeUserAgent(wc.getUserAgent()))
  const host = win.webContents
  // Keep the renderer's URL bar / sidebar title in step with the page.
  const push = (): void => {
    if (!host.isDestroyed() && view) host.send('browser:event', state(view))
  }
  wc.on('did-navigate', push)
  wc.on('did-navigate-in-page', push)
  wc.on('page-title-updated', push)
  // A load that never connected (ERR_CONNECTION_REFUSED and friends) does NOT
  // fire did-navigate, but getURL() still holds the URL it tried — and that URL
  // matters: it's how an MCP OAuth redirect to the backend's loopback callback
  // gets reported when the backend is remote (see app/hooks/useMcpAuthBrowser).
  // Main frame only; a broken image shouldn't repaint the URL bar.
  wc.on('did-fail-load', (_e, _code, _desc, _url, isMainFrame) => {
    if (isMainFrame) push()
  })
  // Keyboard-first escape hatch: the native view owns keyboard focus while the
  // page is focused, so app chords (⌘Y terminal, ⌘K palette, ⌘1..9, Esc, …)
  // would never reach the renderer. Forward Cmd/Ctrl-modified keys — and Esc —
  // to the host so its global handler runs; keep the in-page editing chords
  // (copy/paste/cut/undo/select-all) and lone typing in the page.
  const IN_PAGE = new Set(['c', 'v', 'x', 'z', 'a'])
  wc.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return
    const mod = input.meta || input.control
    const editing = mod && IN_PAGE.has(input.key.toLowerCase())
    if (!((mod && !editing) || input.key === 'Escape')) return
    e.preventDefault()
    if (!host.isDestroyed())
      host.send('browser:key', {
        key: input.key,
        code: input.code,
        meta: input.meta,
        control: input.control,
        shift: input.shift,
        alt: input.alt
      })
  })
  // New-window clicks (target=_blank) stay inside the pane — it's a preview
  // surface, not a full browser.
  wc.setWindowOpenHandler(({ url: target }) => {
    void resolveUrl(target).then((resolved) => wc.loadURL(resolved))
    return { action: 'deny' }
  })
  win.on('closed', () => {
    views.delete(hostId)
    paneBounds.delete(hostId)
    // `webContents` is gone once closeBrowser() already tore this view down — this
    // closure still holds the stale `view`, and the unguarded read threw a
    // "Cannot read properties of undefined (reading 'close')" uncaughtException on
    // window close (docs/bug-report-agent-spawn-hang.md, item 4).
    view?.webContents?.close()
  })
  return view
}

// Create (or reuse) the window's browser view and navigate it. Bounds arrive
// separately (browser:setBounds) from the renderer's ResizeObserver.
export async function openBrowser(event: IpcMainInvokeEvent, url: string): Promise<BrowserState> {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win || win.isDestroyed()) throw new Error('no window')
  const view = getOrCreateView(win)
  await view.webContents.loadURL(await resolveUrl(url)).catch(() => {
    /* load errors still fire did-navigate with the attempted URL; the page shows
       Chromium's own error surface. Don't reject the IPC for a bad site. */
  })
  return state(view)
}

// Render a local file in the pane. The pane is a local WebContentsView, so a
// detached app just loads file://; attached over SSH the file lives on the
// SERVER, which a local Chromium can't read — so route it through the server's
// /rk-file endpoint on its loopback port, and let resolveUrl SSH-forward that
// port exactly like a worktree app. `absPath` is absolute on whichever machine
// backs the workspace (local when detached, the server when attached).
export async function openBrowserFile(event: IpcMainInvokeEvent, absPath: string): Promise<BrowserState> {
  const ssh = parseSshTarget(getAttachedServer())
  const url = ssh
    ? `http://127.0.0.1:${ssh.remotePort}/rk-file?path=${encodeURIComponent(absPath)}`
    : pathToFileURL(absPath).href
  return openBrowser(event, url)
}

export async function navigateBrowser(event: IpcMainInvokeEvent, url: string): Promise<void> {
  const view = getView(event)
  if (view) await view.webContents.loadURL(await resolveUrl(url)).catch(() => {})
}

export function browserBack(event: IpcMainInvokeEvent): void {
  getView(event)?.webContents.navigationHistory.goBack()
}

export function browserForward(event: IpcMainInvokeEvent): void {
  getView(event)?.webContents.navigationHistory.goForward()
}

export function browserReload(event: IpcMainInvokeEvent): void {
  getView(event)?.webContents.reload()
}

// Toggle DevTools for the previewed page. Detached (its own window) because the
// pane is a bare WebContentsView with no chrome to dock a panel into, and a
// separate window stays out of the ⌘K/z-index fight the pane already navigates.
export function browserDevtools(event: IpcMainInvokeEvent): void {
  const wc = getView(event)?.webContents
  if (!wc) return
  if (wc.isDevToolsOpened()) wc.closeDevTools()
  else wc.openDevTools({ mode: 'detach' })
}

export function setBrowserBounds(
  event: IpcMainInvokeEvent,
  bounds: { x: number; y: number; width: number; height: number }
): void {
  // Renderer CSS pixels map 1:1 onto contentView coordinates (frameless window,
  // zoomFactor 1), so the rect from getBoundingClientRect can be used as-is.
  const rect = {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height)
  }
  // Record it whether or not a view exists yet — see paneBounds.
  paneBounds.set(event.sender.id, rect)
  getView(event)?.setBounds(rect)
}

// The view is an OS-level overlay: anything the renderer draws (⌘K palette,
// dialogs, toasts) would appear UNDER it. The renderer flips this off while any
// overlay is open, and when the browser view isn't the selected center view.
export function setBrowserVisible(event: IpcMainInvokeEvent, visible: boolean): void {
  getView(event)?.setVisible(visible)
}

export function closeBrowser(event: IpcMainInvokeEvent): void {
  const view = views.get(event.sender.id)
  if (!view) return
  views.delete(event.sender.id)
  BrowserWindow.fromWebContents(event.sender)?.contentView.removeChildView(view)
  view.webContents.close()
}

// --- scoped CDP relay ------------------------------------------------------
// A session's Bash/Playwright access must never reach further than this pane.
// Chromium's own `--remote-debugging-port` exposes EVERY WebContents in the
// process as a CDP target — including the app's own main window, whose JS
// world holds the full `window.api` IPC bridge (create/delete worktrees, run
// commands, read files...). Turning that switch on and handing the port to a
// session (directly, or indirectly since every session has unrestricted Bash
// and could just curl the port) would let it drive Rookery's own UI with the
// app's own privilege — a full takeover, not just a peek at an embedded page.
//
// So the real Chromium debug port is never opened. Instead this relay speaks
// just enough of the CDP `Target` domain — over Electron's per-webContents
// `debugger` API, which is scoped to a single WebContents and has no notion
// of sibling targets — to present exactly ONE synthetic browser with exactly
// ONE target: this window's browser pane. Everything else (Page, Runtime,
// DOM, Input, Network, ...) is blind-forwarded to that one target's debugger.
// There is no code path here that can name or reach a second target.
let relayPort: number | null = null
let relayGetWindow: (() => BrowserWindow | null) | null = null

const targetIds = new WeakMap<WebContentsView, string>()
function targetIdFor(view: WebContentsView): string {
  let id = targetIds.get(view)
  if (!id) {
    id = randomUUID()
    targetIds.set(view, id)
  }
  return id
}

function targetInfoFor(view: WebContentsView): Record<string, unknown> {
  const wc = view.webContents
  const id = targetIdFor(view)
  return {
    targetId: id,
    type: 'page',
    title: wc.getTitle(),
    url: wc.getURL() || 'about:blank',
    attached: false,
    canAccessOpener: false,
    browserContextId: 'rookery'
  }
}

function currentView(): WebContentsView | undefined {
  const win = relayGetWindow?.()
  return win ? views.get(win.webContents.id) : undefined
}

interface Attached {
  view: WebContentsView
  sessionId: string
  onMessage: (event: unknown, method: string, params: unknown, sessionId?: string) => void
  onDetach: () => void
}

interface RelayConn {
  ws: WebSocket
  autoAttach: boolean
  attached: Attached | null
}

function detach(conn: RelayConn): void {
  if (!conn.attached) return
  const dbg = conn.attached.view.webContents.debugger
  dbg.removeListener('message', conn.attached.onMessage)
  dbg.removeListener('detach', conn.attached.onDetach)
  conn.attached = null
}

// Attach `conn` to `view`'s debugger (idempotent) and tell the client — used
// both by an explicit Target.attachToTarget and by auto-attach.
function attach(conn: RelayConn, view: WebContentsView): string | null {
  if (conn.attached) return conn.attached.sessionId
  const dbg = view.webContents.debugger
  try {
    if (!dbg.isAttached()) dbg.attach()
  } catch {
    return null
  }
  const sessionId = randomUUID()
  const onMessage: Attached['onMessage'] = (_event, method, params, msgSessionId) => {
    if (conn.ws.readyState !== WebSocket.OPEN) return
    conn.ws.send(JSON.stringify({ method, params, sessionId: msgSessionId || sessionId }))
  }
  const onDetach = (): void => {
    if (conn.ws.readyState === WebSocket.OPEN) {
      conn.ws.send(JSON.stringify({ method: 'Target.detachedFromTarget', params: { sessionId } }))
    }
    conn.attached = null
  }
  dbg.on('message', onMessage)
  dbg.on('detach', onDetach)
  conn.attached = { view, sessionId, onMessage, onDetach }
  conn.ws.send(
    JSON.stringify({
      method: 'Target.attachedToTarget',
      params: { sessionId, targetInfo: { ...targetInfoFor(view), attached: true }, waitingForDebugger: false }
    })
  )
  return sessionId
}

type CdpMessage = { id: number; method: string; params?: Record<string, unknown>; sessionId?: string }

async function handleRelayMessage(conn: RelayConn, msg: CdpMessage): Promise<void> {
  const reply = (body: Record<string, unknown>): void => {
    if (conn.ws.readyState === WebSocket.OPEN) conn.ws.send(JSON.stringify({ id: msg.id, ...body }))
  }

  // A session-scoped command: forward through this connection's attached
  // debugger. Our own fake top-level sessionId maps to "no sessionId" (the
  // debugger's default/primary target); a genuinely nested sessionId (e.g. an
  // OOPIF a page later attached to via a passthrough Target.attachToTarget)
  // is Chromium's own and passes straight through.
  if (msg.sessionId) {
    if (!conn.attached) return reply({ sessionId: msg.sessionId, error: { message: 'No attached session' } })
    const forwardSessionId = msg.sessionId === conn.attached.sessionId ? undefined : msg.sessionId
    try {
      const result = await conn.attached.view.webContents.debugger.sendCommand(msg.method, msg.params, forwardSessionId)
      reply({ sessionId: msg.sessionId, result })
    } catch (err) {
      reply({ sessionId: msg.sessionId, error: { message: (err as Error).message } })
    }
    return
  }

  // Browser-level bootstrap — the only place a second target could ever leak
  // in, so everything here is explicit and hardcoded to our one view.
  const view = currentView()
  switch (msg.method) {
    case 'Target.setDiscoverTargets':
      reply({ result: {} })
      return
    case 'Target.getTargets':
      reply({ result: { targetInfos: view ? [targetInfoFor(view)] : [] } })
      return
    case 'Target.setAutoAttach':
      conn.autoAttach = Boolean(msg.params?.autoAttach)
      reply({ result: {} })
      if (conn.autoAttach && view) attach(conn, view)
      return
    case 'Target.createTarget': {
      const win = relayGetWindow?.()
      if (!win) return reply({ error: { message: 'No window' } })
      const created = getOrCreateView(win)
      const url = typeof msg.params?.url === 'string' ? msg.params.url : 'about:blank'
      await created.webContents.loadURL(await resolveUrl(url)).catch(() => {})
      if (conn.autoAttach) attach(conn, created)
      reply({ result: { targetId: targetIdFor(created) } })
      return
    }
    case 'Target.attachToTarget': {
      const targetId = msg.params?.targetId
      if (!view || targetId !== targetIdFor(view)) {
        reply({ error: { message: 'No target with given id found' } })
        return
      }
      const sessionId = attach(conn, view)
      if (!sessionId) return reply({ error: { message: 'Could not attach' } })
      reply({ result: { sessionId } })
      return
    }
    case 'Target.detachFromTarget':
    case 'Target.closeTarget':
      detach(conn)
      reply({ result: {} })
      return
    case 'Browser.getVersion':
      reply({ result: { protocolVersion: '1.3', product: 'Rookery', userAgent: 'Rookery' } })
      return
    default:
      // Best-effort passthrough for anything else sent at browser level
      // (some clients probe capabilities before ever attaching).
      if (view) {
        try {
          const dbg = view.webContents.debugger
          if (!dbg.isAttached()) dbg.attach()
          const result = await dbg.sendCommand(msg.method, msg.params)
          reply({ result })
        } catch (err) {
          reply({ error: { message: (err as Error).message } })
        }
      } else {
        reply({ error: { message: `Unsupported method: ${msg.method}` } })
      }
  }
}

function handleRelayHttp(req: IncomingMessage, res: ServerResponse, port: number, browserId: string): void {
  res.setHeader('Content-Type', 'application/json')
  if (req.url === '/json/version') {
    res.end(
      JSON.stringify({
        Browser: 'Rookery/1.0',
        'Protocol-Version': '1.3',
        webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/${browserId}`
      })
    )
    return
  }
  if (req.url === '/json' || req.url === '/json/list') {
    const view = currentView()
    res.end(
      JSON.stringify(
        view
          ? [{ ...targetInfoFor(view), id: targetIdFor(view), webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/${targetIdFor(view)}` }]
          : []
      )
    )
    return
  }
  res.statusCode = 404
  res.end('{}')
}

// Start the relay (idempotent) and return its port. `getWindow` names the one
// window whose pane this process's sessions may drive — the same "local
// window" getter used for the MCP server and scheduler.
export async function startCdpRelay(getWindow: () => BrowserWindow | null): Promise<number> {
  if (relayPort) return relayPort
  relayGetWindow = getWindow
  const port = await freePort()
  const browserId = randomUUID()
  const http = createHttpServer((req, res) => handleRelayHttp(req, res, port, browserId))
  const wss = new WebSocketServer({ server: http, path: `/devtools/browser/${browserId}` })
  wss.on('connection', (ws) => {
    const conn: RelayConn = { ws, autoAttach: false, attached: null }
    ws.on('message', (raw) => {
      let msg: CdpMessage
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }
      void handleRelayMessage(conn, msg)
    })
    ws.on('close', () => detach(conn))
  })
  // freePort picks a port then closes its probe, so there's a TOCTOU window where
  // another process (or a lingering previous instance after an update) can grab it
  // before we listen. Without an 'error' handler that races into an unhandled
  // server error AND leaves this promise pending forever — which, since the boot
  // chain awaits us, would hang createWindow and leave the app windowless. Reject
  // instead so the caller can carry on without the (non-critical) browser relay.
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject)
    http.listen(port, '127.0.0.1', () => {
      http.off('error', reject)
      resolve()
    })
  })
  relayPort = port
  return port
}
