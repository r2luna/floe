import test from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { BrowserWindow } from 'electron'

// terminal.ts spawns real PTYs through node-pty — a native addon built for
// Electron, which a `node --test` process cannot even load. So the module hook
// (same shape as config/hook.test-helper.ts, plus one stub) serves a fake
// node-pty that records what was spawned, written and resized. Everything else
// in the graph — terminalBuffer, editors, config/floe — is the real thing.

const ptyStub = `
const spawned = []
globalThis.__ptySpawned = spawned
export function spawn(file, args, opts) {
  const t = {
    file,
    args,
    opts,
    pid: 999999,
    cols: opts.cols,
    rows: opts.rows,
    written: [],
    resizes: [],
    onData(cb) { t.emitData = cb },
    onExit(cb) { t.emitExit = cb },
    write(d) { t.written.push(d) },
    resize(c, r) { t.cols = c; t.rows = r; t.resizes.push(c + 'x' + r) },
    kill() { t.killed = true }
  }
  spawned.push(t)
  return t
}
export default { spawn }
`

const hookSource = `
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
const PTY = ${JSON.stringify(ptyStub)}
export async function resolve(specifier, context, next) {
  if (specifier === 'electron') return { url: 'stub:electron', shortCircuit: true, format: 'module' }
  if (specifier === 'node-pty') return { url: 'stub:node-pty', shortCircuit: true, format: 'module' }
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\\.[a-z]+$/i.test(specifier)) {
    try {
      const base = context.parentURL ? new URL(specifier, context.parentURL) : pathToFileURL(specifier)
      const tsPath = fileURLToPath(base) + '.ts'
      if (existsSync(tsPath)) return next(specifier + '.ts', context)
    } catch {}
  }
  return next(specifier, context)
}
export async function load(url, context, next) {
  if (url === 'stub:electron') {
    return {
      format: 'module',
      shortCircuit: true,
      source: "export const app = { getPath: () => '/tmp' }; export default {};"
    }
  }
  if (url === 'stub:node-pty') return { format: 'module', shortCircuit: true, source: PTY }
  return next(url, context)
}
`

// floe.toml is read from XDG_CONFIG_HOME, so point it at a temp dir before the
// config module can resolve the real one.
const configHome = mkdtempSync(join(tmpdir(), 'floe-term-cfg-'))
process.env.XDG_CONFIG_HOME = configHome
mkdirSync(join(configHome, 'floe'), { recursive: true })

register('data:text/javascript,' + encodeURIComponent(hookSource), import.meta.url)

const { invalidateFloeConfig } = await import('./config/floe.ts')
const {
  getTerminalPids,
  listLiveTerminals,
  notifyTerminalsTheme,
  openEditor,
  openTerminal,
  resolveCwd,
  writeTerminal
} = await import('./terminal.ts')

interface FakePty {
  file: string
  args: string[]
  opts: { cwd: string; cols: number; rows: number; env: Record<string, string> }
  cols: number
  rows: number
  written: string[]
  resizes: string[]
  emitData?: (data: string) => void
  emitExit?: (e: { exitCode: number }) => void
}

const spawned = (globalThis as unknown as { __ptySpawned: FakePty[] }).__ptySpawned

function lastSpawn(): FakePty {
  assert.ok(spawned.length, 'nothing was spawned')
  return spawned[spawned.length - 1]
}

interface FakeWin {
  win: BrowserWindow
  events: { id: string; kind: string; data?: string; code?: number }[]
}

function fakeWin(): FakeWin {
  const events: FakeWin['events'] = []
  const win = {
    isDestroyed: () => false,
    webContents: { send: (_channel: string, event: FakeWin['events'][number]) => events.push(event) }
  }
  return { win: win as unknown as BrowserWindow, events }
}

function setConfig(toml: string): void {
  writeFileSync(join(configHome, 'floe', 'floe.toml'), toml)
  invalidateFloeConfig()
}

// Longer than the 8ms output-coalescing window.
const flushed = (): Promise<void> => new Promise((r) => setTimeout(r, 40))

test.after(() => rmSync(configHome, { recursive: true, force: true }))

test('resolveCwd expands the Home terminal tilde, and leaves real paths alone', () => {
  assert.equal(resolveCwd('~'), homedir())
  assert.equal(resolveCwd('~/code'), join(homedir(), 'code'))
  assert.equal(resolveCwd('/tmp/wt'), '/tmp/wt')
})

// Must run before any test that configures `[terminal] shell`: userShell caches
// the system answer, and a configured shell would short-circuit it forever.
test('with no shell configured the PTY gets the login shell from the OS', () => {
  setConfig('')
  const { win } = fakeWin()
  assert.equal(openTerminal(win, 'term:/wt-a#1', '~', 'main', 0, 0), null)

  const first = lastSpawn()
  // dscl/getent, never a bare name: a GUI launch has no useful PATH.
  assert.ok(isAbsolute(first.file), first.file)
  assert.ok(existsSync(first.file), first.file)
  // `~` is expanded here because a bare tilde is a directory that does not exist.
  assert.equal(first.opts.cwd, homedir())
  // A panel that has not measured itself yet still gets a usable geometry.
  assert.equal(first.opts.cols, 80)
  assert.equal(first.opts.rows, 24)
  assert.equal(first.opts.env.FLOE_WORKTREE, 'main')
  assert.equal(first.opts.env.TERM, 'xterm-256color')

  openTerminal(win, 'term:/wt-a#2', '/tmp', 'main', 100, 30)
  assert.equal(lastSpawn().file, first.file, 'the login shell is looked up once and cached')
})

test('[terminal] shell in floe.toml wins over the system shell', () => {
  setConfig('[terminal]\nshell = "/bin/sh"\n')
  const { win } = fakeWin()
  openTerminal(win, 'term:/wt-b#1', '/tmp', 'feat', 120, 40)
  assert.equal(lastSpawn().file, '/bin/sh')
  setConfig('')
})

test('re-opening a terminal replays its scrollback instead of spawning again', async () => {
  const { win, events } = fakeWin()
  openTerminal(win, 'term:/wt-c#1', '/tmp', 'feat', 80, 24)
  const proc = lastSpawn()
  const before = spawned.length

  proc.emitData!('hello')
  await flushed()
  assert.deepEqual(events, [{ id: 'term:/wt-c#1', kind: 'data', data: 'hello' }])

  const replayed = openTerminal(win, 'term:/wt-c#1', '/tmp', 'feat', 100, 30)
  assert.equal(replayed, 'hello')
  assert.equal(spawned.length, before, 'the long-lived PTY is reused')
  assert.deepEqual(proc.resizes, ['100x30'])
})

test('a burst of output crosses to the renderer as one message', async () => {
  const { win, events } = fakeWin()
  openTerminal(win, 'term:/wt-d#1', '/tmp', 'feat', 80, 24)
  const proc = lastSpawn()

  for (const chunk of ['a', 'b', 'c']) proc.emitData!(chunk)
  await flushed()
  assert.deepEqual(events, [{ id: 'term:/wt-d#1', kind: 'data', data: 'abc' }])
})

test('the shell primary-device-attribute query is answered by us', async () => {
  const { win } = fakeWin()
  openTerminal(win, 'term:/wt-e#1', '/tmp', 'feat', 80, 24)
  const proc = lastSpawn()

  // fish re-emits DA1 on every prompt render and blocks ~10s without a reply,
  // so every one is answered, not just the first.
  proc.emitData!('\x1b[c')
  proc.emitData!('\x1b[0c')
  await flushed()
  assert.deepEqual(proc.written, ['\x1b[?1;2c', '\x1b[?1;2c'])
})

test('only PTYs that asked for color-scheme reports are told the theme flipped', async () => {
  const { win } = fakeWin()
  openTerminal(win, 'term:/wt-f#1', '/tmp', 'feat', 80, 24)
  const optedIn = lastSpawn()
  openTerminal(win, 'term:/wt-f#2', '/tmp', 'feat', 80, 24)
  const plain = lastSpawn()

  optedIn.emitData!('\x1b[?2031h')
  await flushed()
  // Nothing yet: the app has not reported an appearance to us.
  assert.deepEqual(optedIn.written, [])

  notifyTerminalsTheme(true)
  assert.deepEqual(optedIn.written, ['\x1b[?997;1n'])
  assert.deepEqual(plain.written, [], 'a shell that never opted in gets nothing typed at it')

  notifyTerminalsTheme(false)
  assert.deepEqual(optedIn.written, ['\x1b[?997;1n', '\x1b[?997;2n'])

  // Opting out again stops the reports.
  optedIn.emitData!('\x1b[?2031l')
  await flushed()
  notifyTerminalsTheme(true)
  assert.deepEqual(optedIn.written, ['\x1b[?997;1n', '\x1b[?997;2n'])

  // A shell that boots late and opts in gets the appearance we already know.
  plain.emitData!('\x1b[?2031h')
  await flushed()
  assert.deepEqual(plain.written, ['\x1b[?997;1n'])
})

test('an exiting PTY flushes its last bytes, announces the code, and is dropped', async () => {
  const { win, events } = fakeWin()
  openTerminal(win, 'term:/wt-g#1', '/tmp', 'feat', 80, 24)
  const proc = lastSpawn()
  assert.deepEqual(listLiveTerminals('/wt-g'), [{ id: 'term:/wt-g#1', cwd: '/tmp' }])
  assert.ok(getTerminalPids().includes(999999))

  proc.emitData!('bye')
  proc.emitExit!({ exitCode: 3 })
  assert.deepEqual(events, [
    { id: 'term:/wt-g#1', kind: 'data', data: 'bye' },
    { id: 'term:/wt-g#1', kind: 'exit', code: 3 }
  ])
  assert.deepEqual(listLiveTerminals('/wt-g'), [])

  // Output that arrives after the teardown is dropped rather than written back
  // into a PTY we no longer own.
  proc.emitData!('\x1b[c')
  writeTerminal('term:/wt-g#1', 'x')
  await flushed()
  assert.deepEqual(proc.written, [])
  assert.equal(events.length, 2)
})

// --- openEditor -------------------------------------------------------------

test('a fresh editor is spawned with the file and line in its argv', () => {
  setConfig('[editor]\ncommand = "nvim"\n')
  const { win } = fakeWin()
  assert.equal(openEditor(win, 'ed:/wt-h#1', '/tmp', 'feat', 'src/a.ts', 0, 0, 12), null)

  const proc = lastSpawn()
  // `--` terminates option parsing so a file named like a flag cannot smuggle one in.
  assert.deepEqual(proc.args, ['+12', '--', 'src/a.ts'])
  assert.equal(proc.opts.cwd, '/tmp')
  assert.equal(proc.opts.env.FLOE_WORKTREE, 'feat')
})

test('a non-positive or missing line is dropped, and no file means no argv', () => {
  const { win } = fakeWin()
  openEditor(win, 'ed:/wt-i#1', '/tmp', 'feat', 'src/a.ts', 80, 24, 0)
  assert.deepEqual(lastSpawn().args, ['--', 'src/a.ts'])

  openEditor(win, 'ed:/wt-i#2', '/tmp', 'feat', 'src/a.ts', 80, 24, 1.5)
  assert.deepEqual(lastSpawn().args, ['--', 'src/a.ts'])

  openEditor(win, 'ed:/wt-i#3', '/tmp', 'feat', null, 80, 24, 9)
  assert.deepEqual(lastSpawn().args, [])
})

test('a running editor is told to open the next file rather than respawning', async () => {
  const { win } = fakeWin()
  openEditor(win, 'ed:/wt-j#1', '/tmp', 'feat', 'a.ts', 80, 24)
  const proc = lastSpawn()
  const before = spawned.length
  proc.emitData!('welcome')
  await flushed()

  const replayed = openEditor(win, 'ed:/wt-j#1', '/tmp', 'feat', 'b.ts', 100, 30, 7)
  assert.equal(replayed, 'welcome')
  assert.equal(spawned.length, before, 'one editor per worktree gathers every file')
  assert.deepEqual(proc.resizes, ['100x30'])
  // Escape first — the editor may be in insert mode — then :edit and the line.
  assert.deepEqual(proc.written, [
    "\x1b:execute 'edit ' . fnameescape('b.ts')\r\x1b:7\r"
  ])
})

test('an editor we have no command for is left showing what it had', async () => {
  setConfig('[editor]\ncommand = "some-unknown-editor"\n')
  const { win } = fakeWin()
  openEditor(win, 'ed:/wt-k#1', '/tmp', 'feat', 'a.ts', 80, 24)
  const proc = lastSpawn()
  proc.emitData!('x')
  await flushed()

  assert.equal(openEditor(win, 'ed:/wt-k#1', '/tmp', 'feat', 'b.ts', 80, 24), 'x')
  assert.deepEqual(proc.written, [], 'typing a guess into an unknown program is worse than nothing')
  setConfig('[editor]\ncommand = "nvim"\n')
})

test('openEditor refuses a file outside the worktree or with control characters', () => {
  const { win } = fakeWin()
  const before = spawned.length
  assert.throws(() => openEditor(win, 'ed:/wt-l#1', '/tmp', 'feat', '../etc/passwd', 80, 24), /outside/)
  assert.throws(() => openEditor(win, 'ed:/wt-l#1', '/tmp', 'feat', 'a\x1b:!id\rb', 80, 24), /control/)
  assert.throws(() => openEditor(win, 'ed:/wt-l#1', '/tmp', 'feat', 'a|b', 80, 24), /control/)
  assert.equal(spawned.length, before, 'the open is a no-op')
})
