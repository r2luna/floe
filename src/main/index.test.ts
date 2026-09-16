import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { makeGitRepo } from './gitFixture.test-helper.ts'
import type { Worktree } from '../shared/types'

// index.ts is the Electron main entry: it imports the whole main-process module
// graph and runs boot side effects at load. Three things make it loadable under
// `node --test` — the same hook the other main tests register, plus two stubs:
//
//  * `electron`, which does not exist outside an Electron process. `ipcMain`
//    here records what was registered, which is what locks the IPC surface.
//  * `node-pty`, a native module built against Electron's ABI, not Node's.
//  * `electron-updater`, which reads `require('electron').app` at import.
//
// `app.whenReady()` never resolves, so the boot chain (createWindow, the MCP
// server, the auto-updater) never runs and the test drives registerIpc itself.
const hookSource = `
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
export async function resolve(specifier, context, next) {
  if (specifier === 'electron') return { url: 'stub:electron', shortCircuit: true, format: 'module' }
  if (specifier === 'node-pty') return { url: 'stub:pty', shortCircuit: true, format: 'module' }
  if (specifier === 'electron-updater') return { url: 'stub:updater', shortCircuit: true, format: 'module' }
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\\.[a-z]+$/i.test(specifier)) {
    try {
      const base = context.parentURL ? new URL(specifier, context.parentURL) : pathToFileURL(specifier)
      if (existsSync(fileURLToPath(base) + '.ts')) return next(specifier + '.ts', context)
      if (existsSync(fileURLToPath(base) + '/index.ts')) return next(specifier + '/index.ts', context)
    } catch {}
  }
  return next(specifier, context)
}
export async function load(url, context, next) {
  if (url === 'stub:pty') {
    return { format: 'module', shortCircuit: true, source: 'export function spawn(){ throw new Error("no pty under node --test") }' }
  }
  if (url === 'stub:updater') {
    const src = 'const autoUpdater = { on(){}, checkForUpdates: async () => null, quitAndInstall(){}, autoDownload: false, logger: null }\\nexport default { autoUpdater }'
    return { format: 'module', shortCircuit: true, source: src }
  }
  if (url === 'stub:electron') {
    const src = [
      "const g = globalThis",
      "export const app = {",
      "  isPackaged: false,",
      "  getPath: () => process.env.FLOE_TEST_USERDATA,",
      "  getVersion: () => '0.0.0-test',",
      "  on(){}, setPath(){}, quit(){},",
      "  whenReady: () => new Promise(() => {}),",
      "  commandLine: { appendSwitch(){} },",
      "  getLoginItemSettings: () => ({ openAtLogin: false }),",
      "  setLoginItemSettings(){},",
      "  focus: () => (g.__floeAppCalls ??= []).push('focus'),",
      "  hide: () => (g.__floeAppCalls ??= []).push('hide')",
      "}",
      "export class BrowserWindow {",
      "  static getAllWindows(){ return g.__floeWindows ?? [] }",
      "  static fromWebContents(wc){ return wc && wc.__win ? wc.__win : null }",
      "  static getFocusedWindow(){ return null }",
      "}",
      "export class WebContentsView {}",
      "export const ipcMain = {",
      "  handle(channel, fn){ (g.__floeIpc ??= []).push([channel, fn]) },",
      "  on(){}, removeHandler(){}",
      "}",
      "export class Notification {",
      "  static isSupported(){ return g.__floeNotifySupported !== false }",
      "  constructor(opts){ this.opts = opts; this.handlers = {}; this.shown = false; (g.__floeNotifications ??= []).push(this) }",
      "  on(event, fn){ this.handlers[event] = fn }",
      "  show(){ this.shown = true }",
      "}",
      "export const nativeTheme = { on(){}, get shouldUseDarkColors(){ return g.__floeDark === true } }",
      "export const clipboard = { writeText: (t) => (g.__floeClipboard ??= []).push(t), writeImage(){} }",
      "export const shell = { openExternal: (u) => (g.__floeOpened ??= []).push(u), openPath(){}, showItemInFolder(){} }",
      "export const nativeImage = { createFromDataURL: () => ({ isEmpty: () => true }) }",
      "export const protocol = { registerSchemesAsPrivileged(){}, handle(){} }",
      "export const dialog = { showMessageBoxSync: () => 0 }",
      "export const Menu = { setApplicationMenu(){}, buildFromTemplate: (items) => ({ popup: () => (g.__floeMenus ??= []).push(items) }) }",
      "export const safeStorage = { isEncryptionAvailable: () => false }",
      "export default { app, BrowserWindow, ipcMain, Notification, nativeTheme, clipboard, shell, nativeImage, protocol, dialog, Menu, safeStorage }"
    ].join('\\n')
    return { format: 'module', shortCircuit: true, source: src }
  }
  return next(url, context)
}
`

// Every store index.ts reaches is path-driven: the config files come from
// XDG_CONFIG_HOME and the persistent JSON stores from `app.getPath('userData')`.
// Point both at throwaway dirs BEFORE the import, so loading the app's real boot
// path cannot see — or write to — the machine's own Floe state.
const configHome = mkdtempSync(join(tmpdir(), 'floe-index-cfg-'))
const userData = mkdtempSync(join(tmpdir(), 'floe-index-data-'))
process.env.XDG_CONFIG_HOME = configHome
process.env.FLOE_TEST_USERDATA = userData
// createWindow's options name the preload relative to __dirname. electron-vite
// bundles main as CJS, where that exists; under node --test the file is ESM and
// the identifier resolves against the global object, so define it there.
Object.assign(globalThis, { __dirname: join(userData, 'out', 'main') })
delete process.env.ELECTRON_RENDERER_URL

register('data:text/javascript,' + encodeURIComponent(hookSource), import.meta.url)

const index = await import('./index.ts')
const { registeredChannels } = await import('./plugins/handleMap.ts')
const { addCreatedSession, touchCreatedSession } = await import('./sessionStore.ts')
const { addProjectByPath } = await import('./projects.ts')
const { setFloeValue } = await import('./config/floe.ts')

// The glass is `[appearance] transparency` now, so a test that needs it on or
// off writes the (temp) config file the same way Settings does.
const setTransparency = (on: boolean): void =>
  setFloeValue('appearance', 'transparency', on ? 'all' : 'off')

type FakeNotification = {
  opts: { title: string; body: string }
  handlers: Record<string, () => void>
  shown: boolean
}
type TestGlobals = {
  __floeIpc?: [string, (...args: unknown[]) => unknown][]
  __floeWindows?: unknown[]
  __floeNotifications?: FakeNotification[]
  __floeNotifySupported?: boolean
  __floeDark?: boolean
  __floeAppCalls?: string[]
  __floeClipboard?: string[]
  __floeOpened?: string[]
  __floeMenus?: Electron.MenuItemConstructorOptions[][]
}
const g = globalThis as TestGlobals

/** A window that records what was asked of it, standing in for a real one. */
function fakeWin(state: { destroyed?: boolean; minimized?: boolean } = {}): {
  win: BrowserWindow
  sent: [string, ...unknown[]][]
  calls: string[]
} {
  const sent: [string, ...unknown[]][] = []
  const calls: string[] = []
  const win = {
    isDestroyed: () => state.destroyed === true,
    isMinimized: () => state.minimized === true,
    restore: () => calls.push('restore'),
    show: () => calls.push('show'),
    focus: () => calls.push('focus'),
    hide: () => calls.push('hide'),
    setBackgroundColor: (c: string) => calls.push(`bg:${c}`),
    webContents: {
      send: (channel: string, ...args: unknown[]) => sent.push([channel, ...args]),
      setZoomFactor: (f: number) => calls.push(`zoom:${f}`),
      copyImageAt: (x: number, y: number) => calls.push(`copyImageAt:${x},${y}`)
    }
  }
  return { win: win as unknown as BrowserWindow, sent, calls }
}

/** The synthetic invoke event a handler gets, carrying `win` as its sender. */
const eventFor = (win: BrowserWindow | null): Electron.IpcMainInvokeEvent =>
  ({ sender: { __win: win } }) as unknown as Electron.IpcMainInvokeEvent

after(() => {
  // registerIpc opens one long-lived fs.watch on the config dir; without this
  // the test process never exits.
  index.stopConfigWatcher()
  rmSync(configHome, { recursive: true, force: true })
  rmSync(userData, { recursive: true, force: true })
})

// ── the IPC surface ─────────────────────────────────────────────────────────
//
// The point of this list. registerIpc is the app's entire renderer-facing API,
// and a channel dropped while moving handlers between registrars breaks a
// feature silently — the invoke rejects at runtime, months later, in whatever
// panel used it. Written out in full and in order, so a lost or reordered
// channel is a failing diff rather than a bug report.
const CHANNELS = [
  'projects:list',
  'projects:groups',
  'projects:addGroup',
  'projects:deleteGroup',
  'projects:renameGroup',
  'projects:rename',
  'projects:add',
  'projects:addByPath',
  'projects:probe',
  'projects:hosts',
  'projects:addHost',
  'projects:setEnv',
  'projects:setGroup',
  'projects:remove',
  'projects:setReadOnly',
  'projects:setPinned',
  'projects:activity',
  'sessions:needsYou',
  'sessions:all',
  'sessions:recent',
  'rail:get',
  'rail:set',
  'projects:getHidden',
  'projects:setHidden',
  'codex:models',
  'agent:start',
  'shell:run',
  'agent:answer',
  'agent:permission',
  'agent:replay',
  'agent:active',
  'agent:waiting',
  'agent:stop',
  'agent:recap',
  'query:list',
  'query:open',
  'query:peek',
  'query:merge',
  'query:discard',
  'query:all',
  'query:transcript',
  'query:reopen',
  'mcp:command-result',
  'mcp:installGlobal',
  'mcp:servers:list',
  'mcp:servers:add',
  'mcp:servers:update',
  'mcp:servers:remove',
  'claude:sessions',
  'claude:resumable',
  'sessions:resume',
  'claude:transcript',
  'sessions:setTitle',
  'sessions:setMode',
  'sessions:setModel',
  'sessions:setEffort',
  'sessions:setChoice',
  'sessions:choice',
  'sessions:create',
  'sessions:renameCreated',
  'sessions:adoptAiTitle',
  'sessions:link',
  'sessions:close',
  'viewState:get',
  'viewState:setProjectWorktree',
  'viewState:setWorktreeView',
  'viewState:setWorktreeAgent',
  'viewState:setProjectUi',
  'viewState:setWorktreeUi',
  'slash:list',
  'claude:info',
  'claude:contextUsage',
  'stats:getMemory',
  'stats:refreshUsage',
  'stats:lastUsage',
  'stats:setUsageCwd',
  'mcp:auth:start',
  'mcp:auth:cancel',
  'mcp:auth:paste',
  'claude:auth:status',
  'claude:stats',
  'agents:local',
  'agents:usage',
  'agents:stats',
  'claude:auth:login',
  'claude:auth:paste',
  'claude:auth:cancel',
  'claude:auth:logout',
  'commands:list',
  'commands:add',
  'commands:update',
  'commands:remove',
  'commands:setScope',
  'dev:detect',
  'dev:start',
  'dev:stop',
  'terminal:open',
  'editor:open',
  'editor:launch',
  'browser:mount',
  'browser:session',
  'browser:bounds',
  'browser:visible',
  'browser:unmount',
  'browser:state',
  'browser:navigate',
  'browser:back',
  'browser:forward',
  'browser:reload',
  'browser:stop',
  'browser:focus',
  'browser:devtools',
  'browser:screenshot',
  'files:list',
  'files:all',
  'files:read',
  'files:definition',
  'files:renderDoc',
  'media:probe',
  'media:read',
  'media:copyImage',
  'files:resolveLink',
  'files:apply',
  'files:open',
  'files:readChunk',
  'files:openDownload',
  'review:changedFiles',
  'review:lastCommit',
  'review:fileDiff',
  'review:commits',
  'review:commitDiff',
  'review:clear',
  'review:restore',
  'review:isCleared',
  'threadComments:list',
  'threadComments:add',
  'threadComments:remove',
  'threadComments:markSent',
  'review:watch',
  'plans:list',
  'plans:read',
  'plans:watch',
  'plans:copy',
  'draw:list',
  'draw:read',
  'draw:apply',
  'draw:create',
  'draw:promote',
  'draw:watch',
  'draw:reveal',
  'plans:implementPhases',
  'colony:board',
  'colony:add',
  'colony:release',
  'colony:remove',
  'colony:events',
  'colony:undoMerge',
  'colony:setAutomerge',
  'colony:setReport',
  'colony:openReport',
  'colony:hold',
  'colony:mergeTask',
  'colony:nanny',
  'terminal:write',
  'terminal:resize',
  'terminal:kill',
  'terminal:list',
  'terminal:notifyTheme',
  'command:start',
  'command:stop',
  'command:restart',
  'command:runs',
  'command:attach',
  'command:resize',
  'worktrees:list',
  'worktrees:status',
  'branches:list',
  'branches:listRemote',
  'worktrees:create',
  'worktrees:remove',
  'worktrees:reorder',
  'worktrees:setBlocked',
  'worktrees:merge',
  'provision:run',
  'premise:ensure',
  'provision:answer',
  'provision:ensureUp',
  'merge:preflight',
  'merge:stash',
  'merge:base',
  'merge:resolveCheck',
  'merge:commit',
  'merge:ff',
  'worktree:teardown',
  'remove:preflight',
  'remove:worktree',
  'remove:branch',
  'remove:unlinkSite',
  'remove:dropDatabase',
  'window:capture',
  'open:external',
  'notify:show',
  'window:focus',
  'window:hide',
  'keybindings:load',
  'keybindings:reveal',
  'keybindings:rebind',
  'keybindings:reset',
  'skills:list',
  'skills:create',
  'skills:rename',
  'skills:delete',
  'config:get',
  'config:set',
  'config:errors',
  'config:paths',
  'config:reveal',
  'theme:get',
  'omarchy:get',
  'app:getLoginItem',
  'app:setLoginItem',
  'user:name',
  'settings:probe',
  'settings:getSystemPrompt',
  'settings:setSystemPrompt',
  'support:stack',
]

test('registerIpc registers the whole IPC surface, once each, in order', () => {
  g.__floeIpc = []
  index.registerIpc()
  const registered = (g.__floeIpc ?? []).map(([channel]) => channel)

  assert.deepEqual(registered, CHANNELS)
  assert.equal(new Set(registered).size, registered.length, 'a channel was registered twice')
  // docs/plugins.md: core channels must go through plugins/handleMap's handle(),
  // or ctx.invoke cannot reach them. Registering straight on ipcMain would still
  // work for the renderer, which is exactly why it needs asserting.
  assert.deepEqual([...registeredChannels()].sort(), [...CHANNELS].sort())
})

test('every registered channel is a callable handler', () => {
  for (const [channel, fn] of g.__floeIpc ?? []) {
    assert.equal(typeof fn, 'function', `${channel} registered a non-function`)
  }
})

// ── the cross-project scans ─────────────────────────────────────────────────

test('the project scans walk a real project and report what is on disk', async () => {
  const repo = makeGitRepo('floe-index-repo-')
  try {
    repo.write('README.md', '# fixture\n')
    repo.commit('init')
    const added = await addProjectByPath(repo.dir)
    assert.equal(added.error, undefined)

    // Nothing has been opened yet: a project with no sessions today contributes
    // no glyph to the rail at all, rather than an empty one.
    assert.deepEqual(await index.projectsActivity(), [])
    assert.deepEqual(await index.allSessions(), [])

    addCreatedSession({ id: 'sess-1', worktreePath: repo.dir, title: 'Fix the thing' })

    const jump = await index.allSessions()
    assert.equal(jump.length, 1)
    assert.equal(jump[0]?.projectPath, repo.dir)
    assert.equal(jump[0]?.worktreePath, repo.dir)
    assert.equal(jump[0]?.branch, 'main')
    assert.equal(jump[0]?.sessionId, 'sess-1')
    assert.equal(jump[0]?.title, 'Fix the thing')
    // No turn in flight — "running" is the live turn, not "a child exists".
    assert.equal(jump[0]?.running, false)

    const rail = await index.projectsActivity()
    assert.equal(rail.length, 1)
    assert.equal(rail[0]?.path, repo.dir)
    assert.equal(rail[0]?.sessionsToday, 1)
    assert.equal(rail[0]?.status, 'done')

    // The session has never spawned, so it has no claudeId and cannot be
    // holding a question — nothing needs you.
    assert.deepEqual(index.waitingSessions(repo.dir), [])
    assert.deepEqual(await index.needsYouSessions(), [])

    // The `active` panel's slice: the same walk, newest first, with the one
    // thing the jump index leaves out. Never spawned means never blocked.
    const active = await index.recentSessions()
    assert.equal(active.length, 1)
    assert.equal(active[0]?.sessionId, 'sess-1')
    assert.equal(active[0]?.needsYou, false)
  } finally {
    repo.cleanup()
  }
})

test('recentSessions returns the newest sessions first and stops at the limit', async () => {
  const repo = makeGitRepo('floe-index-recent-')
  try {
    repo.write('README.md', '# recent\n')
    repo.commit('init')
    await addProjectByPath(repo.dir)

    // Recency for a session that never spawned is its `usedAt` — there is no
    // transcript on disk to take an mtime from. Touched in a deliberate order,
    // a millisecond apart, because Date.now() cannot separate three calls made
    // in the same tick.
    for (const id of ['old', 'mid', 'new']) {
      addCreatedSession({ id, worktreePath: repo.dir, title: id })
      touchCreatedSession(id)
      await new Promise((r) => setTimeout(r, 2))
    }

    assert.deepEqual(
      (await index.recentSessions()).map((s) => s.sessionId),
      ['new', 'mid', 'old']
    )
    // The limit is applied AFTER the sort, or the newest rows are the ones it
    // would drop.
    assert.deepEqual(
      (await index.recentSessions(2)).map((s) => s.sessionId),
      ['new', 'mid']
    )
    assert.deepEqual(await index.recentSessions(0), [])
  } finally {
    repo.cleanup()
  }
})

test('a project whose repo has moved is left off the rail, not thrown from', async () => {
  const repo = makeGitRepo('floe-index-gone-')
  repo.write('README.md', '# gone\n')
  repo.commit('init')
  await addProjectByPath(repo.dir)
  repo.cleanup() // the directory the store still points at is now missing

  // listWorktrees throws for it; the scan has to survive and keep going.
  assert.deepEqual(await index.projectsActivity(), [])
  assert.deepEqual(await index.allSessions(), [])
  assert.deepEqual(await index.needsYouSessions(), [])
})

// ── worktree descriptions ───────────────────────────────────────────────────

test('refreshWorktreeDescs skips the main and home worktrees entirely', async () => {
  const { win, sent } = fakeWin()
  const worktrees = [
    { path: '/tmp/floe-desc-main', branch: 'main', isMain: true, blocked: false },
    { path: homedir(), branch: '', home: true, blocked: false }
  ] as unknown as Worktree[]

  await index.refreshWorktreeDescs(win, '/tmp/floe-desc-main', worktrees)
  // Nothing to describe means no re-list and no push: the sidebar is not
  // repainted for a project that has only a main worktree.
  assert.deepEqual(sent, [])
})

test('refreshWorktreeDescs pushes nothing when no description changed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'floe-desc-'))
  const { win, sent } = fakeWin()
  const worktrees = [
    { path: join(dir, 'a'), branch: 'feat-a', isMain: false, blocked: false },
    { path: join(dir, 'b'), branch: 'feat-b', isMain: false, blocked: false }
  ] as unknown as Worktree[]

  // Neither worktree has a spec.md, so generateWorktreeDesc answers null without
  // ever spawning Haiku — and a pass that produced no new text must not push.
  await index.refreshWorktreeDescs(win, dir, worktrees)
  assert.deepEqual(sent, [])

  // The in-flight guard has to be released on the way out, or the second call
  // (the sidebar re-fetches constantly) would find every worktree still marked
  // busy and quietly stop describing anything for the rest of the session.
  await index.refreshWorktreeDescs(win, dir, worktrees)
  assert.deepEqual(sent, [])
  rmSync(dir, { recursive: true, force: true })
})

test('listWorktreesFor answers Home with its synthetic worktree', async () => {
  const { win } = fakeWin()
  const worktrees = await index.listWorktreesFor(win, homedir())
  assert.equal(worktrees.length, 1)
  assert.equal(worktrees[0]?.home, true)
})

test('worktreeStatuses leaves out Home and every clean worktree', async () => {
  const plain = mkdtempSync(join(tmpdir(), 'floe-nostatus-'))
  // Home is not a repo, and a directory with no git dirt has no status to send.
  assert.deepEqual(await index.worktreeStatuses([homedir(), plain]), {})
  rmSync(plain, { recursive: true, force: true })
})

// ── the window ──────────────────────────────────────────────────────────────

test('windowOptions builds a frameless, hidden-until-ready window', () => {
  const opts = index.windowOptions(false, false, 0)
  assert.equal(opts.frame, false)
  assert.equal(opts.show, false)
  assert.equal(opts.width, 1400)
  assert.equal(opts.height, 900)
  assert.equal(opts.webPreferences?.sandbox, false)
  assert.equal(opts.webPreferences?.plugins, true)
  // Not macOS: no vibrancy view, and an opaque fill so there is no flash.
  assert.equal(opts.vibrancy, undefined)
  assert.equal(opts.backgroundColor, '#fcfdfe')
  // First window sits where the OS puts it; only a second one is offset.
  assert.equal(opts.x, undefined)
  assert.equal(opts.y, undefined)
})

test('windowOptions wires the vibrancy view on macOS even with glass off', () => {
  // The NSWindow has to be created non-opaque or a later light→dark switch
  // cannot reveal the blur without a restart — so the view is always attached
  // and only the fill says whether glass is on.
  const off = index.windowOptions(true, false, 0)
  assert.equal(off.vibrancy, 'fullscreen-ui')
  assert.equal(off.visualEffectState, 'active')
  assert.equal(off.backgroundColor, '#fcfdfe')

  const on = index.windowOptions(true, true, 28)
  assert.equal(on.vibrancy, 'fullscreen-ui')
  assert.equal(on.backgroundColor, '#00000000')
  // Cascaded so a second window doesn't stack invisibly on the first.
  assert.equal(on.x, 88)
  assert.equal(on.y, 88)
})

test('contextMenuItems offers only what the click actually applies to', () => {
  const { win } = fakeWin()
  const params = (over: Partial<Electron.ContextMenuParams>): Electron.ContextMenuParams =>
    ({ linkURL: '', mediaType: 'none', selectionText: '', isEditable: false, x: 0, y: 0, ...over }) as Electron.ContextMenuParams
  const shape = (p: Partial<Electron.ContextMenuParams>): (string | undefined)[] =>
    index.contextMenuItems(win, params(p)).map((i) => i.label ?? i.role ?? i.type)

  // A click on nothing gets no menu at all, rather than an empty one.
  assert.deepEqual(shape({}), [])
  assert.deepEqual(shape({ linkURL: 'https://example.com' }), ['Copy Link'])
  assert.deepEqual(shape({ mediaType: 'image' }), ['Copy Image'])
  assert.deepEqual(shape({ selectionText: 'hi' }), ['copy'])
  // Read-only text: copying is offered, cutting is not.
  assert.deepEqual(shape({ selectionText: 'hi', isEditable: true }), [
    'copy',
    'cut',
    'paste',
    'separator',
    'selectAll'
  ])
  assert.deepEqual(shape({ isEditable: true }), ['paste', 'separator', 'selectAll'])
})

test('the context menu acts on the click it was built from', () => {
  const { win, calls } = fakeWin()
  g.__floeClipboard = []
  const items = index.contextMenuItems(win, {
    linkURL: 'https://example.com/x',
    mediaType: 'image',
    selectionText: '',
    isEditable: false,
    x: 12,
    y: 34
  } as Electron.ContextMenuParams)

  // The handlers close over the click; none of them reads its own arguments.
  const fire = (item?: Electron.MenuItemConstructorOptions): void =>
    (item?.click as (() => void) | undefined)?.()

  fire(items[0])
  assert.deepEqual(g.__floeClipboard, ['https://example.com/x'])
  // A transcript screenshot is a data URL with no link to save, so Copy Image
  // lifts the decoded bitmap off the page at the click's own coordinates.
  fire(items[1])
  assert.deepEqual(calls, ['copyImageAt:12,34'])
})

test('popupContextMenu shows a menu only when something applies', () => {
  const { win } = fakeWin()
  const params = (over: Partial<Electron.ContextMenuParams>): Electron.ContextMenuParams =>
    ({ linkURL: '', mediaType: 'none', selectionText: '', isEditable: false, x: 0, y: 0, ...over }) as Electron.ContextMenuParams

  const menus: Electron.MenuItemConstructorOptions[][] = []
  g.__floeMenus = menus

  // Right-clicking a plain part of the transcript must not flash an empty menu.
  index.popupContextMenu(win, params({}))
  assert.equal(menus.length, 0)

  index.popupContextMenu(win, params({ selectionText: 'hi' }))
  assert.equal(menus.length, 1)
  assert.deepEqual(menus[0]?.map((i) => i.role), ['copy'])
})

test('captureWindow writes the dev screenshot', async () => {
  setTransparency(false) // glass on suppresses the capture; see the note on it
  const shot = join(userData, 'floe-shot.png')
  rmSync(shot, { force: true })

  const win = {
    webContents: { capturePage: async () => ({ toPNG: () => Buffer.from('fake-png') }) }
  } as unknown as BrowserWindow
  await index.captureWindow(win)
  assert.equal(readFileSync(shot, 'utf8'), 'fake-png')
})

test('captureWindow swallows a failed capture', async () => {
  setTransparency(false)
  const win = {
    webContents: {
      capturePage: () => Promise.reject(new Error('window gone'))
    }
  } as unknown as BrowserWindow
  // A dev aid must never take the app down with it.
  await index.captureWindow(win)
})

test('captureWindow leaves the macOS blur alone', async (t) => {
  if (process.platform !== 'darwin') return t.skip('macOS only')
  setTransparency(true)
  const shot = join(userData, 'floe-shot.png')
  rmSync(shot, { force: true })
  let captured = false

  // capturePage() forces an opaque raster of the web layer, which kills the live
  // blur — the classic "vibrancy stops working" symptom. So it must not run.
  await index.captureWindow({
    webContents: {
      capturePage: async () => {
        captured = true
        return { toPNG: () => Buffer.alloc(0) }
      }
    }
  } as unknown as BrowserWindow)
  assert.equal(captured, false)
  setTransparency(false)
})

test('waitForBundle waits for an index.html that reads back intact', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'floe-bundle-'))
  const file = join(dir, 'index.html')
  writeFileSync(file, '<html><body><div id="root"></div></body></html>')
  await index.waitForBundle(file, 1)

  // A half-written bundle never becomes readable within the attempts allowed —
  // it has to give up and let the window load anyway, not hang forever.
  const started = Date.now()
  await index.waitForBundle(join(dir, 'missing.html'), 1)
  assert.ok(Date.now() - started >= 400, 'gave up without waiting between attempts')
  rmSync(dir, { recursive: true, force: true })
})

// ── raising, hiding and notifying ───────────────────────────────────────────

test('raiseWindow refuses a window that is gone', () => {
  assert.equal(index.raiseWindow(null), false)
  const { win, calls } = fakeWin({ destroyed: true })
  assert.equal(index.raiseWindow(win), false)
  assert.deepEqual(calls, [])
})

test('raiseWindow un-minimizes before showing', () => {
  const { win, calls } = fakeWin({ minimized: true })
  assert.equal(index.raiseWindow(win), true)
  assert.deepEqual(calls, ['restore', 'show', 'focus'])

  const live = fakeWin()
  assert.equal(index.raiseWindow(live.win), true)
  assert.deepEqual(live.calls, ['show', 'focus'])
})

test('showNotification tells the renderer which session was clicked', () => {
  g.__floeNotifications = []
  g.__floeNotifySupported = true
  const { win, sent } = fakeWin()

  index.showNotification(win, { title: 'Done', body: 'Turn finished', sessionId: 'sess-9' })
  const note = (g.__floeNotifications ?? [])[0]
  assert.equal(note?.opts.title, 'Done')
  assert.equal(note?.opts.body, 'Turn finished')
  assert.equal(note?.shown, true)
  assert.deepEqual(sent, [])

  note?.handlers.click?.()
  assert.deepEqual(sent, [['notification:click', 'sess-9']])
})

test('a notification clicked after its window closed sends nothing', () => {
  g.__floeNotifications = []
  g.__floeNotifySupported = true
  const { win, sent } = fakeWin({ destroyed: true })

  index.showNotification(win, { title: 'Done', body: 'x', sessionId: 'sess-9' })
  ;(g.__floeNotifications ?? [])[0]?.handlers.click?.()
  assert.deepEqual(sent, [])
})

test('showNotification is a no-op where the OS has no notifications', () => {
  g.__floeNotifications = []
  g.__floeNotifySupported = false
  index.showNotification(fakeWin().win, { title: 'x', body: 'y', sessionId: 'z' })
  assert.deepEqual(g.__floeNotifications, [])
  g.__floeNotifySupported = true
})

test('hideWindow hides the window off macOS', () => {
  const { win, calls } = fakeWin()
  index.hideWindow(win)
  // On darwin this hides the whole app instead; the runner's platform decides.
  if (process.platform === 'darwin') assert.deepEqual(calls, [])
  else assert.deepEqual(calls, ['hide'])
})

test('openExternalUrl hands only safe schemes to the OS', () => {
  g.__floeOpened = []
  index.openExternalUrl('https://example.com')
  index.openExternalUrl('http://example.com')
  index.openExternalUrl('mailto:someone@example.com')
  assert.deepEqual(g.__floeOpened, [
    'https://example.com',
    'http://example.com',
    'mailto:someone@example.com'
  ])

  // The allowlist is the whole defence: anything else reaching shell.openExternal
  // is a renderer string executing on the host.
  g.__floeOpened = []
  index.openExternalUrl('javascript:alert(1)')
  index.openExternalUrl('file:///etc/passwd')
  index.openExternalUrl('  https://sneaky.example')
  assert.deepEqual(g.__floeOpened, [])
})

// ── broadcasts ──────────────────────────────────────────────────────────────

test('broadcastTheme reaches every live window and skips the closed one', () => {
  const live = fakeWin()
  const dead = fakeWin({ destroyed: true })
  g.__floeWindows = [live.win, dead.win]
  g.__floeDark = true

  index.broadcastTheme()
  assert.deepEqual(live.sent, [['theme:changed', true]])
  assert.deepEqual(dead.sent, [])
  g.__floeWindows = []
})

test('broadcastConfigChange repaints every live window and skips the closed one', () => {
  const live = fakeWin()
  const dead = fakeWin({ destroyed: true })
  g.__floeWindows = [live.win, dead.win]

  index.broadcastConfigChange(false)
  assert.deepEqual(live.sent, [['config:changed']])
  // Re-zooming is what makes a config reload visible.
  assert.ok(live.calls.some((c) => c.startsWith('zoom:')), 'font size was not re-applied')
  assert.deepEqual(dead.sent, [])
  g.__floeWindows = []
})

test('a keybindings save repaints the keymap and nothing else', () => {
  const live = fakeWin()
  g.__floeWindows = [live.win]

  index.onConfigChanged('keybindings.toml')
  // Only the keymap channel, and no re-zoom: a keybinding save must not repaint
  // the app, which is the entire reason the two channels are separate. Nor does
  // it reconcile the colony boards — no `colony:event` reaches the window.
  assert.deepEqual(live.sent, [['keybindings:changed']])
  assert.deepEqual(live.calls, [])
  g.__floeWindows = []
})

test('any other config change re-zooms, repaints and re-reads the boards', () => {
  const live = fakeWin()
  g.__floeWindows = [live.win]

  index.onConfigChanged('floe.toml')
  // A board is its config file, so editing one is a move on the board: the
  // stages are re-read before the repaint, and `config:changed` lands last.
  assert.deepEqual(live.sent.at(-1), ['config:changed'])
  assert.ok(live.calls.some((c) => c.startsWith('zoom:')), 'font size was not re-applied')
  assert.equal(live.sent.filter(([c]) => c === 'keybindings:changed').length, 0)
  g.__floeWindows = []
})

test('reconcileBoards does nothing when no window is open', () => {
  g.__floeWindows = []
  // There is nowhere to run a lane, so the colony tick is skipped rather than
  // attempted against an undefined window.
  index.reconcileBoards()
})

// ── queries ─────────────────────────────────────────────────────────────────

test('openAllQueries refuses a fan-out with no targets', () => {
  // R7 in docs/queries.md: the targets come from the caller and are never
  // inferred, so an empty list is an error rather than "ask everyone".
  assert.deepEqual(index.openAllQueries(null, 'sess', '/tmp', [], 'hi'), {
    error: 'No harnesses given.'
  })
  assert.deepEqual(
    index.openAllQueries(null, 'sess', '/tmp', 'claude' as unknown as string[], 'hi'),
    { error: 'No harnesses given.' }
  )
})

test('an unknown query key is reported, never thrown', () => {
  assert.deepEqual(index.reopenQueryFor(null, 'nope'), { error: 'Unknown query: nope' })
  // The fold in the chat asks for a transcript on open; a query whose parent
  // session is gone answers with nothing to show.
  assert.deepEqual(index.queryTranscript('nope'), [])
})

// ── sessions ────────────────────────────────────────────────────────────────

test('sessionKeys names both identities a session answers to', () => {
  assert.deepEqual(index.sessionKeys({ id: 'a', worktreePath: '/tmp' }), ['a'])
  assert.deepEqual(index.sessionKeys({ id: 'a', worktreePath: '/tmp', claudeId: 'c' }), ['a', 'c'])
})

test('closeSessionFully forgets a session under both of its names', () => {
  addCreatedSession({ id: 'close-me', worktreePath: '/tmp/floe-close', title: 'Bye' })
  index.closeSessionFully(null, { id: 'close-me', worktreePath: '/tmp/floe-close', claudeId: 'cid-1' })
  // The store is the observable end: the record is gone, so nothing can find its
  // queries, threads or watermarks afterwards either.
  assert.deepEqual(index.waitingSessions('/tmp/floe-close'), [])
})

test('isPlaceholderTitle knows an auto title from one the user chose', () => {
  const dir = mkdtempSync(join(tmpdir(), 'floe-title-'))
  assert.equal(index.isPlaceholderTitle('Session 3', dir, 'cid'), true)
  assert.equal(index.isPlaceholderTitle('Session 12', dir, 'cid'), true)
  // A real name is never overwritten by the Haiku pass.
  assert.equal(index.isPlaceholderTitle('Rewrite the parser', dir, 'cid'), false)
  assert.equal(index.isPlaceholderTitle('Session', dir, 'cid'), false)
  rmSync(dir, { recursive: true, force: true })
})

test('applyTitle keeps null when there is no title to apply', () => {
  assert.equal(index.applyTitle('cid', null), null)
  assert.equal(index.applyTitle('cid', ''), null)
})

test('adoptAiTitle answers null for a session that never spawned', async () => {
  assert.equal(await index.adoptAiTitle('no-such-session'), null)
  addCreatedSession({ id: 'unspawned', worktreePath: '/tmp/floe-adopt', title: 'Session 1' })
  // No claudeId yet: there is no transcript to read a title out of.
  assert.equal(await index.adoptAiTitle('unspawned'), null)
})

// ── small shared helpers ────────────────────────────────────────────────────

test('firstName greets a person, not a form letter', () => {
  assert.equal(index.firstName('Rafael Lunardelli'), 'Rafael')
  assert.equal(index.firstName('Rafael'), 'Rafael')
  assert.equal(index.firstName(''), '')
})

test('errorText reads a message off anything that was thrown', () => {
  assert.equal(index.errorText(new Error('boom')), 'boom')
  assert.equal(index.errorText('a bare string'), 'a bare string')
  assert.equal(index.errorText(undefined), 'undefined')
})

test('projectScope resolves a worktree to its project, or to global', async () => {
  assert.equal(index.projectScope(undefined), undefined)
  // A path under no known project is global scope, not a refusal.
  assert.equal(index.projectScope('/tmp/floe-not-a-project'), undefined)

  const repo = makeGitRepo('floe-index-scope-')
  try {
    repo.write('README.md', '# scope\n')
    repo.commit('init')
    await addProjectByPath(repo.dir)
    assert.equal(index.projectScope(repo.dir), repo.dir)
  } finally {
    repo.cleanup()
  }
})

test('winOf hands back null once the sender has no window', () => {
  const { win } = fakeWin()
  assert.equal(index.winOf(eventFor(win)), win)
  assert.equal(index.winOf(eventFor(null)), null)
})
