import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Everything this module touches is a side effect on something that does not
// exist in a test process: electron's app/Notification and electron-updater's
// singleton. Both are stubbed through the loader, so the test can drive a
// packaged app, a feed that answers, and a window that is behind another one —
// the three states the real updater only reaches on a signed build.
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'floe-update-cfg-'))

interface UpdateResult {
  isUpdateAvailable: boolean
  updateInfo: { version: string }
}
interface FakeNotification {
  opts: { title: string; body: string }
  click?: () => void
}
interface FakeUpdater {
  autoDownload?: boolean
  autoInstallOnAppQuit?: boolean
  checks: number
  installs: number
  listeners: Map<string, ((arg: unknown) => void)[]>
  reply: () => Promise<UpdateResult>
  on(event: string, fn: (arg: unknown) => void): void
  checkForUpdates(): Promise<UpdateResult>
  quitAndInstall(): void
  emit(event: string, arg: unknown): void
}

const updater: FakeUpdater = {
  checks: 0,
  installs: 0,
  listeners: new Map(),
  reply: () => Promise.resolve({ isUpdateAvailable: false, updateInfo: { version: '0.0.0' } }),
  on(event, fn) {
    const list = this.listeners.get(event) ?? []
    list.push(fn)
    this.listeners.set(event, list)
  },
  checkForUpdates() {
    this.checks++
    return this.reply()
  },
  quitAndInstall() {
    this.installs++
  },
  emit(event, arg) {
    for (const fn of this.listeners.get(event) ?? []) fn(arg)
  }
}

const g = globalThis as typeof globalThis & {
  __floeUpdater?: FakeUpdater
  __floeApp?: { isPackaged: boolean; version: string }
  __floeNotifications?: { supported: boolean; shown: FakeNotification[] }
  __floeOpened?: string[]
}
g.__floeUpdater = updater
g.__floeApp = { isPackaged: false, version: '1.2.3' }
g.__floeNotifications = { supported: true, shown: [] }
g.__floeOpened = []

const hookSource = `
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const ELECTRON = [
  'export const app = {',
  '  get isPackaged() { return globalThis.__floeApp.isPackaged },',
  '  getVersion: () => globalThis.__floeApp.version,',
  "  getPath: () => '/tmp'",
  '};',
  'export class Notification {',
  '  static isSupported() { return globalThis.__floeNotifications.supported }',
  '  constructor(opts) { this.opts = opts }',
  '  on(event, fn) { if (event === "click") this.click = fn }',
  '  show() { globalThis.__floeNotifications.shown.push(this) }',
  '}',
  'export const shell = { openExternal: (url) => { globalThis.__floeOpened.push(url); return Promise.resolve() } };',
  'export const ipcMain = { handle(){}, removeHandler(){} };',
  'export default {};'
].join('\\n')
export async function resolve(specifier, context, next) {
  if (specifier === 'electron') return { url: 'stub:electron', shortCircuit: true, format: 'module' }
  if (specifier === 'electron-updater') return { url: 'stub:updater', shortCircuit: true, format: 'module' }
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\\.[a-z]+$/i.test(specifier)) {
    try {
      const tsPath = fileURLToPath(new URL(specifier, context.parentURL)) + '.ts'
      if (existsSync(tsPath)) return next(specifier + '.ts', context)
    } catch {}
  }
  return next(specifier, context)
}
export async function load(url, context, next) {
  if (url === 'stub:electron') return { format: 'module', shortCircuit: true, source: ELECTRON }
  if (url === 'stub:updater') {
    return {
      format: 'module',
      shortCircuit: true,
      source: 'export default { autoUpdater: globalThis.__floeUpdater };'
    }
  }
  return next(url, context)
}
`
register('data:text/javascript,' + encodeURIComponent(hookSource), import.meta.url)

const { initAutoUpdate } = await import('./autoUpdate.ts')
const { invokeHandler, registeredChannels } = await import('./plugins/handleMap.ts')

interface FakeWindow {
  focused: boolean
  sent: [string, unknown][]
}

function fakeWindow(focused: boolean): FakeWindow & { isFocused: () => boolean } {
  const win = {
    focused,
    sent: [] as [string, unknown][],
    isFocused: () => win.focused,
    webContents: { send: (channel: string, payload: unknown) => win.sent.push([channel, payload]) }
  }
  return win
}

// initAutoUpdate is called once per test, so listeners are dropped first — the
// real app calls it once, and stacked listeners would fire N times here.
function init(win?: ReturnType<typeof fakeWindow>, selfInstall = true): { intervals: number[] } {
  updater.listeners.clear()
  const intervals: number[] = []
  const real = globalThis.setInterval
  // Never let a real interval start: it would outlive the test and keep the
  // runner alive polling a fake feed.
  globalThis.setInterval = ((_fn: () => void, ms: number) => {
    intervals.push(ms)
    return 0 as unknown as NodeJS.Timeout
  }) as typeof globalThis.setInterval
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    initAutoUpdate(() => win as any, { selfInstall })
  } finally {
    globalThis.setInterval = real
  }
  return { intervals }
}

const check = (): Promise<string> => invokeHandler('update:check', undefined) as Promise<string>

// The logs are the module's normal output; capture them so the reporter stays
// readable and the messages can be asserted.
function captureLogs<T>(fn: () => T): { out: string[]; result: T } {
  const out: string[] = []
  const log = console.log
  const error = console.error
  console.log = (...args: unknown[]) => out.push(args.join(' '))
  console.error = (...args: unknown[]) => out.push(args.join(' '))
  try {
    return { out, result: fn() }
  } finally {
    console.log = log
    console.error = error
  }
}

test('in dev the check command answers instead of failing the invoke', async () => {
  g.__floeApp = { isPackaged: false, version: '1.2.3' }
  const { intervals } = init(fakeWindow(true))

  assert.ok(registeredChannels().includes('update:check'))
  assert.equal(await check(), 'Updates only apply to a packaged build.')
  // Nothing else is wired: no install channel, no poll, no feed traffic.
  assert.equal(registeredChannels().includes('update:install'), false)
  assert.deepEqual(intervals, [])
  assert.equal(updater.checks, 0)
})

test('a packaged app downloads in the background but never installs on quit', () => {
  g.__floeApp = { isPackaged: true, version: '1.2.3' }
  const { intervals } = init(fakeWindow(true))

  assert.equal(updater.autoDownload, true)
  assert.equal(updater.autoInstallOnAppQuit, false)
  assert.equal(updater.checks, 1) // one check right away
  assert.deepEqual(intervals, [6 * 60 * 60 * 1000]) // then `[update] check-interval-hours`
})

test('the check command reports what the feed said', async () => {
  g.__floeApp = { isPackaged: true, version: '1.2.3' }
  init(fakeWindow(true))

  updater.reply = () => Promise.resolve({ isUpdateAvailable: false, updateInfo: { version: '1.2.3' } })
  assert.equal(await check(), 'Floe 1.2.3 is up to date.')

  updater.reply = () => Promise.resolve({ isUpdateAvailable: true, updateInfo: { version: '9.9.9' } })
  assert.equal(
    await check(),
    "Floe 9.9.9 found — downloading; you'll get a restart prompt when it's ready."
  )

  // A dead feed is a message, not an unhandled rejection in the ⌘K palette.
  updater.reply = () => Promise.reject(new Error('boom'))
  assert.equal(await check(), 'Update check failed: boom')
  updater.reply = () => Promise.resolve({ isUpdateAvailable: false, updateInfo: { version: '1.2.3' } })
})

test('feed errors and downloads are logged, not thrown', () => {
  g.__floeApp = { isPackaged: true, version: '1.2.3' }
  init(fakeWindow(true))

  const { out } = captureLogs(() => {
    updater.emit('error', new Error('offline'))
    updater.emit('update-available', { version: '9.9.9' })
  })

  assert.deepEqual(out, ['[auto-update] error: offline', '[auto-update] downloading 9.9.9…'])
})

// The in-app banner is enough when Floe is the window you are looking at.
test('a downloaded update tells the focused window, and nothing else', () => {
  g.__floeApp = { isPackaged: true, version: '1.2.3' }
  const win = fakeWindow(true)
  init(win)
  g.__floeNotifications = { supported: true, shown: [] }

  captureLogs(() => updater.emit('update-downloaded', { version: '9.9.9' }))

  assert.deepEqual(win.sent, [['update:downloaded', { version: '9.9.9', download: false }]])
  assert.deepEqual(g.__floeNotifications?.shown, [])
})

test('behind another window it takes an OS notification that restarts on click', async () => {
  g.__floeApp = { isPackaged: true, version: '1.2.3' }
  const win = fakeWindow(false)
  init(win)
  g.__floeNotifications = { supported: true, shown: [] }

  captureLogs(() => updater.emit('update-downloaded', { version: '9.9.9' }))

  const shown = g.__floeNotifications?.shown ?? []
  assert.equal(shown.length, 1)
  assert.match(shown[0].opts.body, /9\.9\.9/)
  const before = updater.installs
  shown[0].click?.()
  assert.equal(updater.installs, before + 1)

  // And a repeat check now points at the restart instead of re-downloading.
  assert.equal(
    await check(),
    'Floe 9.9.9 is downloaded — run "Install update" to apply it.'
  )
})

test('the restart command hands the swap to the updater', async () => {
  g.__floeApp = { isPackaged: true, version: '1.2.3' }
  init(fakeWindow(true))

  const before = updater.installs
  await invokeHandler('update:install', undefined)
  assert.equal(updater.installs, before + 1)
})

// macOS: unsigned builds cannot be swapped in by Squirrel, so Floe fetches and
// swaps the bundle itself (macUpdate.ts). Under `node --test` there is no .app
// to swap, which is also the fallback path: the release page, as before.
test('on macOS an update is announced, then installed by Floe itself', async () => {
  g.__floeApp = { isPackaged: true, version: '1.2.3' }
  const win = fakeWindow(true)
  init(win, false)

  assert.equal(updater.autoDownload, false)
  updater.reply = () => Promise.resolve({ isUpdateAvailable: true, updateInfo: { version: '9.9.9' } })
  assert.equal(await check(), 'Floe 9.9.9 is out — run "Install update" to download and apply it.')
  updater.reply = () => Promise.resolve({ isUpdateAvailable: false, updateInfo: { version: '1.2.3' } })

  captureLogs(() => updater.emit('update-available', { version: '9.9.9' }))
  assert.deepEqual(win.sent, [['update:downloaded', { version: '9.9.9', download: true }]])

  const before = updater.installs
  const said = await invokeHandler('update:install', undefined)
  assert.equal(updater.installs, before, 'never hands an unsigned bundle to Squirrel')
  // No bundle to swap here, so it says why and falls back to the page.
  assert.match(String(said), /Could not install it here .*not running from an .app bundle/)
  assert.deepEqual(g.__floeOpened, ['https://github.com/r2luna/floe/releases/tag/v9.9.9'])
})
