import { app, BrowserWindow, clipboard, nativeImage, shell, WebContentsView, type Rectangle } from 'electron'
import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { BrowserSnapshot, BrowserState } from '../shared/types'

type Session = {
  win: BrowserWindow
  key: string
  view: WebContentsView
  mounted: boolean
  visible: boolean
  navigationId: number
  state: BrowserState
  /**
   * The session's opening about:blank load. A fresh page is not ready the
   * moment `createSession` returns, and the first navigation has to wait for
   * it — see navigateBrowser.
   */
  ready: Promise<unknown>
}

/**
 * One page per Floe session, not per window: a new chat must not open on the
 * page another chat left behind. The window remembers which session's page it
 * is showing, so the renderer's calls land there without naming it.
 */
type Host = { active: string; sessions: Map<string, Session> }

const hosts = new Map<number, Host>()
const START_URL = 'about:blank'
const AUTOMATION_TIMEOUT_MS = 10_000

function withBrowserTimeout<T>(operation: string, task: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${operation} timed out after 10 seconds.`)), AUTOMATION_TIMEOUT_MS)
  })
  return Promise.race([task, timeout]).finally(() => clearTimeout(timer))
}

/** Turn what a person types in the address field into a navigable URL. */
export function normalizeBrowserUrl(raw: string): string {
  const value = raw.trim()
  if (!value) return START_URL
  if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?(?:[/?#]|$)/i.test(value)) return `http://${value}`
  if (/^[a-z][a-z\d+.-]*:/i.test(value)) return value
  return `https://${value}`
}

function stateOf(session: Session): BrowserState {
  const history = session.view.webContents.navigationHistory
  return {
    ...session.state,
    url: session.view.webContents.getURL() || session.state.url,
    title: session.view.webContents.getTitle(),
    canGoBack: history.canGoBack(),
    canGoForward: history.canGoForward()
  }
}

function publish(session: Session, patch: Partial<BrowserState> = {}): BrowserState {
  session.state = { ...stateOf(session), ...patch }
  // Only the page on screen talks to the panel. A background session's page is
  // read fresh when its panel mounts again.
  if (!session.win.isDestroyed() && isActive(session)) session.win.webContents.send('browser:state', session.state)
  return session.state
}

export function browserShortcut(input: Electron.Input): string | undefined {
  // Floe's `super` modifier is Command on macOS and the Super key elsewhere.
  // Keep Ctrl+H/L free for the app's cross-panel navigation on every platform.
  const commandOrControl = input.meta
  const key = input.key.toLowerCase()
  const primary: Record<string, string> = {
    l: 'browser.address',
    r: 'browser.reload',
    '[': 'browser.back',
    ']': 'browser.forward',
    w: 'panel.close'
  }
  const control: Record<string, string> = { h: 'panel.left', l: 'panel.right' }
  return (
    (commandOrControl ? primary[key] : undefined) ??
    (commandOrControl && input.alt && key === 'i' ? 'browser.devtools' : undefined) ??
    (commandOrControl && input.shift && key === 's' ? 'browser.screenshot' : undefined) ??
    (input.control ? control[key] : undefined)
  )
}

function hostFor(win: BrowserWindow): Host {
  const id = win.webContents.id
  let host = hosts.get(id)
  if (!host) {
    host = { active: '', sessions: new Map() }
    hosts.set(id, host)
    // Close over the id, not the window: `closed` fires once the window is
    // already gone, and every property access on it (`win.webContents`) throws
    // "Object has been destroyed" from there. That throw leaves a pending napi
    // exception, and the next node-pty callback to cross back into JS turns it
    // into a SIGABRT inside pty.node — the app died on close, blaming the PTY.
    win.on('closed', () => destroyBrowser(id))
  }
  return host
}

function isActive(session: Session): boolean {
  return hosts.get(session.win.webContents.id)?.active === session.key
}

/** Point the window's browser calls at this session's page, hiding any other. */
export function selectBrowserSession(win: BrowserWindow, key: string): void {
  const host = hostFor(win)
  if (host.active === key) return
  const previous = host.sessions.get(host.active)
  if (previous?.mounted && !win.isDestroyed()) {
    win.contentView.removeChildView(previous.view)
    previous.mounted = false
  }
  host.active = key
}

/**
 * The page an agent known by `names` works on: the one on screen when it is
 * theirs, else one they already have, else a new one under their first name.
 * No names (an unknown caller) means the page on screen.
 */
export function browserKeyFor(win: BrowserWindow, names: string[]): string | undefined {
  if (!names.length) return undefined
  const host = hostFor(win)
  if (names.includes(host.active)) return host.active
  return names.find((name) => host.sessions.has(name)) ?? names[0]
}

function shortcut(session: Session, event: Electron.Event, input: Electron.Input): void {
  const command = browserShortcut(input)
  if (!command) return
  event.preventDefault()
  if (session.win.isDestroyed()) return
  // The address field lives in Floe's own page. Focusing it from the renderer
  // alone leaves the OS keyboard focus inside this view, so typing would still
  // go to the site. Hand focus to the host first.
  if (command === 'browser.address') session.win.webContents.focus()
  session.win.webContents.send('browser:shortcut', command)
}

function createSession(win: BrowserWindow, key: string): Session {
  const view = new WebContentsView({
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      partition: 'persist:floe-browser'
    }
  })
  // Match a normal browser canvas. Many local fixtures and generated previews
  // leave the document background transparent and rely on the UA's white page.
  view.setBackgroundColor('#ffffff')
  const session: Session = {
    win,
    key,
    view,
    mounted: false,
    visible: true,
    navigationId: 0,
    state: { url: START_URL, title: '', loading: false, canGoBack: false, canGoForward: false },
    ready: Promise.resolve()
  }
  hostFor(win).sessions.set(key, session)

  const changed = (): BrowserState => publish(session, { error: undefined })
  view.webContents.on('did-start-loading', () => publish(session, { loading: true, error: undefined }))
  view.webContents.on('did-stop-loading', () => publish(session, { loading: false }))
  view.webContents.on('did-navigate', changed)
  view.webContents.on('did-navigate-in-page', changed)
  view.webContents.on('page-title-updated', changed)
  view.webContents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
    if (isMainFrame && code !== -3) publish(session, { loading: false, error: description })
  })
  view.webContents.on('render-process-gone', (_event, details) => {
    publish(session, { loading: false, error: `Page process stopped: ${details.reason}` })
  })
  view.webContents.on('unresponsive', () => publish(session, { loading: false, error: 'Page is unresponsive.' }))
  view.webContents.on('before-input-event', (event, input) => shortcut(session, event, input))
  view.webContents.setWindowOpenHandler(({ url }) => {
    void navigateBrowser(win, url, key)
    return { action: 'deny' }
  })
  // Held, not fired and forgotten: a navigation started while this is still in
  // flight is queued BEHIND it on the same webContents, so the blank page
  // commits last and throws the real one away (navigateBrowser awaits it).
  session.ready = view.webContents.loadURL(START_URL).catch(() => undefined)
  return session
}

/** The page for `key`, or for the session the window is showing when omitted. */
function sessionFor(win: BrowserWindow, key?: string): Session {
  const host = hostFor(win)
  const name = key ?? host.active
  return host.sessions.get(name) ?? createSession(win, name)
}

function activeSession(win: BrowserWindow): Session | undefined {
  const host = hosts.get(win.webContents.id)
  return host?.sessions.get(host.active)
}

function scaledBounds(win: BrowserWindow, bounds: Rectangle): Rectangle {
  const scale = win.webContents.getZoomFactor()
  return {
    x: Math.round(bounds.x * scale),
    y: Math.round(bounds.y * scale),
    width: Math.max(0, Math.round(bounds.width * scale)),
    height: Math.max(0, Math.round(bounds.height * scale))
  }
}

export function mountBrowser(win: BrowserWindow, bounds: Rectangle, key?: string): BrowserState {
  if (key !== undefined) selectBrowserSession(win, key)
  const session = sessionFor(win)
  if (!session.mounted) {
    win.contentView.addChildView(session.view)
    session.mounted = true
  }
  session.visible = true
  session.view.setVisible(true)
  session.view.setBounds(scaledBounds(win, bounds))
  return publish(session)
}

export function setBrowserBounds(win: BrowserWindow, bounds: Rectangle): void {
  const session = activeSession(win)
  if (session?.mounted) session.view.setBounds(scaledBounds(win, bounds))
}

export function setBrowserVisible(win: BrowserWindow, visible: boolean): void {
  const session = activeSession(win)
  if (!session?.mounted) return
  session.visible = visible
  session.view.setVisible(visible)
}

export function unmountBrowser(win: BrowserWindow, key?: string): void {
  const host = hosts.get(win.webContents.id)
  const session = host?.sessions.get(key ?? host.active)
  if (!session?.mounted || win.isDestroyed()) return
  win.contentView.removeChildView(session.view)
  session.mounted = false
}

/**
 * Drop a window's pages, keyed by its host webContents id.
 *
 * Takes the id rather than the window because it runs from `closed`, where the
 * BrowserWindow is unusable (see hostFor). Nothing is unmounted here either:
 * the content view holding the pages died with the window, so only the pages
 * themselves are left to close.
 */
export function destroyBrowser(hostId: number): void {
  const host = hosts.get(hostId)
  if (!host) return
  for (const session of host.sessions.values()) {
    if (!session.view.webContents.isDestroyed()) session.view.webContents.close()
  }
  hosts.delete(hostId)
}

export function browserState(win: BrowserWindow, key?: string): BrowserState {
  return stateOf(sessionFor(win, key))
}

export async function navigateBrowser(win: BrowserWindow, raw: string, key?: string): Promise<BrowserState> {
  const session = sessionFor(win, key)
  const url = normalizeBrowserUrl(raw)
  const navigationId = ++session.navigationId
  // When this call is what CREATED the session, its opening about:blank is
  // still loading. Both loads sit on the same webContents and the blank one
  // commits last: the page below it is discarded and the panel answers
  // `about:blank` with no error at all. That is the whole of "the internal
  // browser blocked file://" — the very first open_browser of a chat lost its
  // page whatever the scheme was, and the second one always worked.
  await session.ready
  try {
    await session.view.webContents.loadURL(url)
    return publish(session, { error: undefined })
  } catch (error) {
    if (navigationId !== session.navigationId) return stateOf(session)
    return publish(session, { loading: false, error: (error as Error).message })
  }
}

export function browserBack(win: BrowserWindow, key?: string): BrowserState {
  const session = sessionFor(win, key)
  session.navigationId++
  if (session.view.webContents.navigationHistory.canGoBack()) session.view.webContents.navigationHistory.goBack()
  return publish(session, { error: undefined })
}

export function browserForward(win: BrowserWindow, key?: string): BrowserState {
  const session = sessionFor(win, key)
  session.navigationId++
  if (session.view.webContents.navigationHistory.canGoForward()) session.view.webContents.navigationHistory.goForward()
  return publish(session, { error: undefined })
}

export function browserReload(win: BrowserWindow, key?: string): BrowserState {
  const session = sessionFor(win, key)
  session.navigationId++
  session.view.webContents.reload()
  return publish(session, { error: undefined })
}

export function browserStop(win: BrowserWindow, key?: string): BrowserState {
  const session = sessionFor(win, key)
  session.navigationId++
  session.view.webContents.stop()
  return publish(session, { loading: false, error: undefined })
}

export function focusBrowser(win: BrowserWindow, key?: string): void {
  sessionFor(win, key).view.webContents.focus()
}

export function openBrowserDevTools(win: BrowserWindow, key?: string): void {
  sessionFor(win, key).view.webContents.openDevTools({ mode: 'detach', activate: true })
}

const SNAPSHOT_SCRIPT = `(() => {
  const visible = (el) => {
    const r = el.getBoundingClientRect()
    const s = getComputedStyle(el)
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'
  }
  document.querySelectorAll('[data-floe-browser-ref]').forEach((el) => el.removeAttribute('data-floe-browser-ref'))
  const nodes = [...document.querySelectorAll('a[href], button, input, textarea, select, [role="button"], [contenteditable="true"]')]
    .filter(visible)
    .slice(0, 250)
  const elements = nodes.map((el, index) => {
    const ref = 'b' + (index + 1)
    el.setAttribute('data-floe-browser-ref', ref)
    const label = el.getAttribute('aria-label') || el.getAttribute('title') || el.innerText || el.getAttribute('placeholder') || el.getAttribute('value') || ''
    return { ref, tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || undefined, name: label.trim().replace(/\\s+/g, ' ').slice(0, 200), href: el.href || undefined, type: el.type || undefined }
  })
  return { url: location.href, title: document.title, text: (document.body?.innerText || '').replace(/\\n{3,}/g, '\\n\\n').slice(0, 30000), elements }
})()`

export async function snapshotBrowser(win: BrowserWindow, key?: string): Promise<BrowserSnapshot> {
  const task = sessionFor(win, key).view.webContents.executeJavaScript(SNAPSHOT_SCRIPT, true) as Promise<BrowserSnapshot>
  return withBrowserTimeout('Browser snapshot', task)
}

function targetScript(target: string): string {
  const value = JSON.stringify(target)
  return `(() => {
    const ref = document.querySelector('[data-floe-browser-ref="' + CSS.escape(${value}) + '"]')
    if (ref) return ref
    try { return document.querySelector(${value}) } catch { return null }
  })()`
}

export async function clickBrowser(win: BrowserWindow, target: string, key?: string): Promise<{ clicked: boolean }> {
  const task = sessionFor(win, key).view.webContents.executeJavaScript(
    `(() => { const el = ${targetScript(target)}; if (!el) return false; el.scrollIntoView({block:'center'}); el.click(); return true })()`,
    true
  )
  const clicked = await withBrowserTimeout('Browser click', task)
  return { clicked: clicked === true }
}

export async function typeInBrowser(
  win: BrowserWindow,
  target: string,
  text: string,
  submit = false,
  key?: string
): Promise<{ typed: boolean }> {
  const task = sessionFor(win, key).view.webContents.executeJavaScript(
    `(() => {
      const el = ${targetScript(target)}
      if (!el) return false
      el.focus()
      const value = ${JSON.stringify(text)}
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
        const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype
          : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
            : HTMLSelectElement.prototype
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
        if (setter) setter.call(el, value); else el.value = value
      } else if (el.isContentEditable) {
        el.textContent = value
      } else {
        return false
      }
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
      if (${submit}) {
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }))
        el.form?.requestSubmit()
      }
      return true
    })()`,
    true
  )
  const typed = await withBrowserTimeout('Browser typing', task)
  return { typed: typed === true }
}

export async function evaluateBrowser(win: BrowserWindow, expression: string, key?: string): Promise<unknown> {
  const task = sessionFor(win, key).view.webContents.executeJavaScript(expression, true)
  const value = await withBrowserTimeout('Browser evaluation', task)
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return String(value)
  }
}

export function pressInBrowser(win: BrowserWindow, keyCode: string, key?: string): void {
  const contents = sessionFor(win, key).view.webContents
  contents.sendInputEvent({ type: 'keyDown', keyCode })
  if (keyCode.length === 1) contents.sendInputEvent({ type: 'char', keyCode })
  contents.sendInputEvent({ type: 'keyUp', keyCode })
}

export async function screenshotBrowser(
  win: BrowserWindow,
  key?: string
): Promise<{ data: string; mimeType: 'image/png' }> {
  const image = await withBrowserTimeout('Browser screenshot', sessionFor(win, key).view.webContents.capturePage())
  return { data: image.toPNG().toString('base64'), mimeType: 'image/png' }
}

/**
 * The whole document, not just the viewport: CDP renders beyond the visible
 * area. Falls back to the viewport when the debugger cannot attach (DevTools
 * already holds it, or there is no page process).
 */
export async function captureFullPage(contents: Electron.WebContents): Promise<Buffer> {
  const dbg = contents.debugger
  let attachedHere = false
  try {
    if (!dbg.isAttached()) {
      dbg.attach('1.3')
      attachedHere = true
    }
    const metrics = await dbg.sendCommand('Page.getLayoutMetrics')
    const size = metrics.cssContentSize ?? metrics.contentSize
    const shot = await dbg.sendCommand('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: Math.ceil(size.width), height: Math.ceil(size.height), scale: 1 }
    })
    return Buffer.from(shot.data as string, 'base64')
  } catch {
    return (await contents.capturePage()).toPNG()
  } finally {
    if (attachedHere && dbg.isAttached()) dbg.detach()
  }
}

/** `localhost-5173-2026-09-14-153012.png` — the host keeps a folder of shots readable. */
export function screenshotFileName(url: string, now: Date): string {
  let host = 'page'
  try {
    host = new URL(url).host.replace(/[^a-z\d.-]+/gi, '-').replace(/^-+|-+$/g, '') || 'page'
  } catch {
    // about:blank and friends keep the generic name.
  }
  const pad = (n: number): string => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `${host}-${stamp}.png`
}

export type ScreenshotDesk = {
  platform: NodeJS.Platform
  hasCleanShot: () => boolean
  openUrl: (url: string) => Promise<void>
  copyImage: (file: string) => void
  openInPreview: (file: string) => Promise<void>
}

export type ScreenshotHandoff = { path: string; openedIn: 'cleanshot' | 'preview' }

/** CleanShot's annotate window when it is installed; otherwise clipboard + Preview. */
export async function handOffScreenshot(file: string, desk: ScreenshotDesk): Promise<ScreenshotHandoff> {
  if (desk.platform === 'darwin' && desk.hasCleanShot()) {
    await desk.openUrl(`cleanshot://open-annotate?filepath=${encodeURIComponent(file)}`)
    return { path: file, openedIn: 'cleanshot' }
  }
  desk.copyImage(file)
  await desk.openInPreview(file)
  return { path: file, openedIn: 'preview' }
}

const electronDesk: ScreenshotDesk = {
  platform: process.platform,
  hasCleanShot: () => app.getApplicationNameForProtocol('cleanshot://') !== '',
  openUrl: (url) => shell.openExternal(url),
  copyImage: (file) => clipboard.writeImage(nativeImage.createFromPath(file)),
  // Preview by name on macOS; elsewhere the desktop's default image viewer.
  openInPreview: (file) =>
    process.platform === 'darwin'
      ? new Promise((resolve, reject) =>
          execFile('open', ['-a', 'Preview', file], (error) => (error ? reject(error) : resolve()))
        )
      : shell.openPath(file).then((error) => {
          if (error) throw new Error(error)
        })
}

/** Capture the full page to a temp PNG and hand it to the desk (CleanShot or Preview). */
export async function screenshotPageToDesk(
  win: BrowserWindow,
  desk: ScreenshotDesk = electronDesk,
  key?: string
): Promise<ScreenshotHandoff> {
  const contents = sessionFor(win, key).view.webContents
  const png = await withBrowserTimeout('Browser screenshot', captureFullPage(contents))
  const dir = join(app.getPath('temp'), 'floe-screenshots')
  await mkdir(dir, { recursive: true })
  const file = join(dir, screenshotFileName(contents.getURL(), new Date()))
  await writeFile(file, png)
  return handOffScreenshot(file, desk)
}
