import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { settle, waitFor as until } from './watch.test-helper.ts'

// node-pty is a native addon built for Electron's ABI, so `node --test` cannot
// load it. The stub runs the command for real — `/bin/sh -c`, detached, so the
// child is a process-group leader exactly as a PTY child is — and records what
// the runner asked for. That keeps the parts this file is about honest: real
// pids for the group kill and the `ps` memory poll, real exit codes, real
// output; only the terminal emulation is dropped.
const hookSource = `
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
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
const SOURCE = {
  'stub:electron':
    "export const app = { getPath: () => process.env.FLOE_TEST_USERDATA || '/tmp' }; export default {};",
  'stub:node-pty': \`
import { spawn as nodeSpawn } from 'node:child_process'
export function spawn(file, args, opts) {
  globalThis.__ptySpawns.push({ file, args, cwd: opts.cwd, cols: opts.cols, rows: opts.rows, env: opts.env })
  const child = nodeSpawn('/bin/sh', ['-c', args[args.length - 1]], {
    cwd: opts.cwd, env: opts.env, detached: true, stdio: ['ignore', 'pipe', 'pipe']
  })
  const onData = [], onExit = []
  const emit = (d) => { for (const cb of onData) cb(d.toString()) }
  child.stdout.on('data', emit)
  child.stderr.on('data', emit)
  child.on('error', () => { for (const cb of onExit) cb({ exitCode: 127, signal: undefined }) })
  child.on('exit', (code, signal) => { for (const cb of onExit) cb({ exitCode: code ?? 0, signal }) })
  return {
    pid: child.pid,
    onData: (cb) => onData.push(cb),
    onExit: (cb) => onExit.push(cb),
    kill: (sig) => { try { child.kill(sig || 'SIGTERM') } catch {} },
    resize: (cols, rows) => globalThis.__resizes.push({ cols, rows }),
    write: () => {}
  }
}
\`
}
export async function load(url, context, next) {
  if (SOURCE[url]) return { format: 'module', shortCircuit: true, source: SOURCE[url] }
  return next(url, context)
}
`

interface PtySpawn {
  file: string
  args: string[]
  cwd: string
  cols: number
  rows: number
  env: Record<string, string>
}
declare global {
  // eslint-disable-next-line no-var
  var __ptySpawns: PtySpawn[]
  // eslint-disable-next-line no-var
  var __resizes: Array<{ cols: number; rows: number }>
}
globalThis.__ptySpawns = []
globalThis.__resizes = []

process.env.FLOE_TEST_USERDATA = mkdtempSync(join(tmpdir(), 'floe-cmd-'))
register('data:text/javascript,' + encodeURIComponent(hookSource), import.meta.url)

const runner = await import('./commandRunner.ts')
type CommandEvent = import('./commandRunner.ts').CommandEvent

function reset(): string {
  runner.killAllCommands()
  globalThis.__ptySpawns = []
  globalThis.__resizes = []
  process.env.FLOE_TEST_USERDATA = mkdtempSync(join(tmpdir(), 'floe-cmd-'))
  return process.env.FLOE_TEST_USERDATA
}

afterEach(() => runner.killAllCommands())

function makeWin(): { win: BrowserWindow; events: CommandEvent[]; focused: { value: boolean } } {
  const events: CommandEvent[] = []
  const focused = { value: true }
  const win = {
    isDestroyed: () => false,
    isFocused: () => focused.value,
    isVisible: () => true,
    webContents: {
      send: (_channel: string, event: CommandEvent) => {
        events.push(event)
      }
    }
  }
  return { win: win as unknown as BrowserWindow, events, focused }
}

const of = <K extends CommandEvent['kind']>(
  events: CommandEvent[],
  kind: K
): Array<Extract<CommandEvent, { kind: K }>> =>
  events.filter((e): e is Extract<CommandEvent, { kind: K }> => e.kind === kind)

// The shared poller, with the label first — it reads better at the call sites
// below, where the thing being waited for is the point.
const waitFor = (what: string, ok: () => boolean, ms = 4000): Promise<void> => until(ok, ms, what)

const MEM_TICK = 2100 // one poll interval, to prove the timer is gone

function persistedFile(dir: string): string {
  return join(dir, 'running-commands.json')
}
function readPersisted(dir: string): Array<{ key: string; pid: number; cmd: string }> {
  return JSON.parse(readFileSync(persistedFile(dir), 'utf8'))
}

test('a non-zero exit comes back as a code, not a throw', async () => {
  const { output, code } = await runner.runShellCapture(tmpdir(), 'echo out; exit 7')
  assert.equal(code, 7)
  assert.match(output, /out/)
})

test('the login shell is resolved once and reused', () => {
  const first = runner.userShell()
  assert.ok(first.startsWith('/'), `expected an absolute shell path, got ${first}`)
  assert.equal(runner.userShell(), first)
})

test('a run reports started, running, its output, and its exit', async () => {
  reset()
  const { win, events } = makeWin()
  const dir = mkdtempSync(join(tmpdir(), 'floe-run-'))
  runner.startCommand(win, `${dir}#one`, dir, 'feat', 'echo hi', 80, 24)
  await waitFor('exit', () => of(events, 'exit').length > 0)

  assert.equal(of(events, 'started').length, 1)
  assert.equal(of(events, 'state')[0].state, 'running')
  assert.ok(of(events, 'data').some((e) => e.data.includes('hi')))
  const exit = of(events, 'exit')[0]
  assert.equal(exit.code, 0)
  assert.ok(exit.durationMs >= 0)
  assert.equal(of(events, 'state').at(-1)?.state, 'exited')
  assert.equal(runner.isCommandRunning(`${dir}#one`), false)
  assert.deepEqual(runner.commandRuns().map((r) => [r.key, r.state, r.exitCode]), [
    [`${dir}#one`, 'exited', 0]
  ])
})

test('the pty gets the login shell, the stored size and the worktree branch', async () => {
  reset()
  const { win, events } = makeWin()
  const dir = mkdtempSync(join(tmpdir(), 'floe-run-'))
  runner.startCommand(win, `${dir}#a`, dir, 'my-branch', 'true', 120, 40)
  await waitFor('exit', () => of(events, 'exit').length > 0)

  const spawned = globalThis.__ptySpawns[0]
  assert.equal(spawned.file, runner.userShell())
  assert.deepEqual(spawned.args, ['-lc', 'true'])
  assert.equal(spawned.cwd, dir)
  assert.equal(spawned.cols, 120)
  assert.equal(spawned.rows, 40)
  assert.equal(spawned.env.FLOE_WORKTREE, 'my-branch')
  assert.equal(spawned.env.TERM, 'xterm-256color')
})

test('a size of zero keeps the last one, and an unsized key falls back to 80x24', async () => {
  reset()
  const { win, events } = makeWin()
  const dir = mkdtempSync(join(tmpdir(), 'floe-run-'))
  runner.attachCommand(win, `${dir}#sized`, 100, 30) // no run yet — only records the size
  runner.startCommand(win, `${dir}#sized`, dir, 'feat', 'true', 0, 0)
  runner.startCommand(win, `${dir}#fresh`, dir, 'feat', 'true', 0, 0)
  await waitFor('both exits', () => of(events, 'exit').length === 2)

  assert.deepEqual([globalThis.__ptySpawns[0].cols, globalThis.__ptySpawns[0].rows], [100, 30])
  assert.deepEqual([globalThis.__ptySpawns[1].cols, globalThis.__ptySpawns[1].rows], [80, 24])
})

test('attach replays the scrollback and the state a reloaded renderer lost', async () => {
  reset()
  const first = makeWin()
  const dir = mkdtempSync(join(tmpdir(), 'floe-run-'))
  const key = `${dir}#attach`
  runner.startCommand(first.win, key, dir, 'feat', 'echo scrollback', 80, 24)
  await waitFor('exit', () => of(first.events, 'exit').length > 0)

  const second = makeWin()
  runner.attachCommand(second.win, key, 90, 20)
  assert.match(of(second.events, 'data')[0].data, /scrollback/)
  assert.equal(of(second.events, 'state')[0].state, 'exited')
  assert.equal(globalThis.__resizes.length, 0) // the process is gone — nothing to resize
})

test('attach resizes a live process; an unknown key sends nothing', async () => {
  reset()
  const { win, events } = makeWin()
  const dir = mkdtempSync(join(tmpdir(), 'floe-run-'))
  const key = `${dir}#live`
  runner.startCommand(win, key, dir, 'feat', 'sleep 5', 80, 24)
  await waitFor('started', () => of(events, 'state').length > 0)

  runner.attachCommand(win, key, 111, 44)
  assert.deepEqual(globalThis.__resizes.at(-1), { cols: 111, rows: 44 })
  runner.resizeCommand(key, 50, 12)
  assert.deepEqual(globalThis.__resizes.at(-1), { cols: 50, rows: 12 })

  const before = events.length
  runner.attachCommand(win, `${dir}#nobody`, 80, 24)
  assert.equal(events.length, before)
})

test('a stop signals the group and reports stopping before the exit', async () => {
  reset()
  const { win, events } = makeWin()
  const dir = mkdtempSync(join(tmpdir(), 'floe-run-'))
  const key = `${dir}#stop`
  runner.startCommand(win, key, dir, 'feat', 'sleep 30', 80, 24)
  await waitFor('running', () => runner.isCommandRunning(key))
  assert.deepEqual(runner.getCommandPids().length, 1)

  runner.stopCommand(win, key)
  assert.equal(of(events, 'state').at(-1)?.state, 'stopping')
  await waitFor('exit', () => of(events, 'exit').length > 0)
  assert.equal(runner.isCommandRunning(key), false)

  const before = events.length
  runner.stopCommand(win, key) // already stopped — no second signal, no events
  assert.equal(events.length, before)
})

test('memory is sampled at once, and stops being sampled when the run does', async () => {
  reset()
  const { win, events, focused } = makeWin()
  const dir = mkdtempSync(join(tmpdir(), 'floe-run-'))
  const key = `${dir}#mem`
  runner.startCommand(win, key, dir, 'feat', 'sleep 30', 80, 24)
  // The ps snapshot is cached for ~1.5s app-wide, so the immediate sample can
  // still be reading a table taken before this child existed; the next tick sees it.
  await waitFor('a memory sample', () => of(events, 'mem').some((e) => e.rss > 0))

  focused.value = false // a blurred window is nobody reading the figure
  runner.stopCommand(win, key)
  await waitFor('exit', () => of(events, 'exit').length > 0)
  const samples = of(events, 'mem').length
  await settle(() => of(events, 'mem').length, MEM_TICK)
  assert.equal(of(events, 'mem').length, samples)
})
test('a crash with auto-restart waits out the backoff, then comes back', async () => {
  reset()
  const { win, events } = makeWin()
  const dir = mkdtempSync(join(tmpdir(), 'floe-run-'))
  runner.startCommand(win, `${dir}#flaky`, dir, 'feat', 'exit 3', 80, 24, undefined, true)
  await waitFor('exit', () => of(events, 'exit').length > 0)

  assert.equal(of(events, 'exit')[0].code, 3)
  assert.equal(of(events, 'state').at(-1)?.restartIn, 1000)
  await waitFor('the respawn', () => of(events, 'started').length === 2, 3000)
})

test('a stop during the backoff cancels the respawn', async () => {
  reset()
  const { win, events } = makeWin()
  const dir = mkdtempSync(join(tmpdir(), 'floe-run-'))
  const key = `${dir}#backoff`
  runner.startCommand(win, key, dir, 'feat', 'exit 3', 80, 24, undefined, true)
  await waitFor('exit', () => of(events, 'exit').length > 0)

  runner.stopCommand(win, key)
  assert.equal(of(events, 'state').at(-1)?.state, 'exited')
  // Quiet for longer than the 1s backoff the stop was meant to cancel.
  await settle(() => of(events, 'started').length, 1400)
  assert.equal(of(events, 'started').length, 1)
})

test('a re-run supersedes the old process without reporting its exit', async () => {
  reset()
  const { win, events } = makeWin()
  const dir = mkdtempSync(join(tmpdir(), 'floe-run-'))
  const key = `${dir}#rerun`
  runner.startCommand(win, key, dir, 'feat', 'sleep 30', 80, 24)
  await waitFor('running', () => runner.isCommandRunning(key))
  const firstPid = runner.getCommandPids()[0]

  runner.restartCommand(win, key, dir, 'feat', 'sleep 30', 80, 24)
  await waitFor('the second spawn', () => globalThis.__ptySpawns.length === 2)
  assert.notEqual(runner.getCommandPids()[0], firstPid)
  await settle(() => events.length)
  assert.equal(of(events, 'exit').length, 0) // the superseded proc's exit is swallowed
  assert.equal(of(events, 'started').length, 2)
})

test('a second start is refused while one is already running', async () => {
  reset()
  const { win, events } = makeWin()
  const dir = mkdtempSync(join(tmpdir(), 'floe-run-'))
  const key = `${dir}#once`
  runner.startCommand(win, key, dir, 'feat', 'sleep 30', 80, 24)
  await waitFor('running', () => runner.isCommandRunning(key))

  runner.startCommand(win, key, dir, 'feat', 'sleep 30', 80, 24)
  assert.equal(globalThis.__ptySpawns.length, 1)
  assert.equal(of(events, 'started').length, 1)
})

test('a write under a watch root re-runs the command after the debounce', async () => {
  reset()
  const { win, events } = makeWin()
  const dir = mkdtempSync(join(tmpdir(), 'floe-run-'))
  const watched = join(dir, 'database', 'migrations')
  mkdirSync(watched, { recursive: true })
  const key = `${dir}#watch`
  runner.startCommand(win, key, dir, 'feat', 'echo ran', 80, 24, [
    'database/migrations/*.php',
    'missing/**/*.ts' // a root that does not exist is skipped, not watched
  ])
  await waitFor('the first exit', () => of(events, 'exit').length > 0)

  writeFileSync(join(watched, '0001_create.php'), '<?php')
  await waitFor('the re-run', () => of(events, 'started').length === 2)
  await waitFor('the second exit', () => of(events, 'exit').length === 2)

  runner.stopCommand(win, key) // closes the watch
  writeFileSync(join(watched, '0002_create.php'), '<?php')
  // Quiet for longer than the 300ms debounce a re-run would have gone through.
  await settle(() => of(events, 'started').length, 500)
  assert.equal(of(events, 'started').length, 2)
})

test('no watch globs means no watcher at all', async () => {
  reset()
  const { win, events } = makeWin()
  const dir = mkdtempSync(join(tmpdir(), 'floe-run-'))
  const key = `${dir}#nowatch`
  runner.startCommand(win, key, dir, 'feat', 'echo ran', 80, 24, [])
  await waitFor('exit', () => of(events, 'exit').length > 0)

  writeFileSync(join(dir, 'whatever.txt'), 'x')
  await settle(() => of(events, 'started').length, 500)
  assert.equal(of(events, 'started').length, 1)
})

test('a running command is persisted by group pid and forgotten when it exits', async () => {
  const userData = reset()
  const { win, events } = makeWin()
  const dir = mkdtempSync(join(tmpdir(), 'floe-run-'))
  const key = `${dir}#persist`
  runner.startCommand(win, key, dir, 'feat', 'sleep 30', 80, 24)
  await waitFor('running', () => runner.isCommandRunning(key))

  const [record] = readPersisted(userData)
  assert.equal(record.key, key)
  assert.equal(record.cmd, 'sleep 30')
  assert.equal(record.pid, runner.getCommandPids()[0])

  runner.stopCommand(win, key)
  await waitFor('exit', () => of(events, 'exit').length > 0)
  assert.deepEqual(readPersisted(userData), [])
})

test('the reaper kills a survivor whose group still runs the recorded command', async () => {
  const userData = reset()
  const marker = `floe-reap-${process.pid}`
  // `sleep 30; :` and not `sleep 30`: a lone simple command is exec'd in place by
  // sh, and the marker would go with the shell it replaced.
  const orphan = spawn('/bin/sh', ['-c', `sleep 30; : ${marker}`], {
    cwd: tmpdir(), // never let a spawned child sit in the repository
    detached: true,
    stdio: 'ignore'
  })
  try {
    await new Promise((r) => orphan.once('spawn', r)) // in ps before the reaper looks
    writeFileSync(
      persistedFile(userData),
      JSON.stringify([
        { key: 'gone#dev', pid: orphan.pid, cmd: marker },
        { key: 'stale#dev', pid: 2 ** 22 - 1, cmd: 'never-launched' } // pid long dead
      ])
    )

    runner.reapOrphanCommands()
    await waitFor('the orphan to die', () => orphan.exitCode !== null || orphan.signalCode !== null)
    assert.equal(orphan.signalCode, 'SIGKILL')
    assert.deepEqual(readPersisted(userData), []) // both records are stale now
  } finally {
    try {
      process.kill(-(orphan.pid ?? 0), 'SIGKILL')
    } catch {
      /* already reaped */
    }
  }
})

test('the pre-start reap only touches its own key', async () => {
  const userData = reset()
  const { win, events } = makeWin()
  const dir = mkdtempSync(join(tmpdir(), 'floe-run-'))
  const key = `${dir}#mine`
  writeFileSync(
    persistedFile(userData),
    JSON.stringify([
      { key, pid: 2 ** 22 - 1, cmd: 'an old run of mine' },
      { key: 'other#dev', pid: 2 ** 22 - 2, cmd: 'someone else' }
    ])
  )

  runner.startCommand(win, key, dir, 'feat', 'sleep 30', 80, 24)
  await waitFor('running', () => runner.isCommandRunning(key))
  const after = readPersisted(userData)
  assert.deepEqual(
    after.map((e) => e.key).sort(),
    ['other#dev', key].sort()
  )
  assert.equal(after.find((e) => e.key === 'other#dev')?.cmd, 'someone else') // untouched
  assert.equal(after.find((e) => e.key === key)?.cmd, 'sleep 30') // replaced by the live run

  runner.stopCommand(win, key)
  await waitFor('exit', () => of(events, 'exit').length > 0)
})

test('killing a worktree stops every command under its prefix', async () => {
  reset()
  const { win, events } = makeWin()
  const dir = mkdtempSync(join(tmpdir(), 'floe-run-'))
  const other = mkdtempSync(join(tmpdir(), 'floe-run-'))
  runner.startCommand(win, `${dir}#a`, dir, 'feat', 'sleep 30', 80, 24)
  runner.startCommand(win, `${dir}#b`, dir, 'feat', 'sleep 30', 80, 24)
  runner.startCommand(win, `${other}#a`, other, 'feat', 'sleep 30', 80, 24)
  await waitFor('all three running', () => runner.getCommandPids().length === 3)

  runner.killCommandsForWorktree(dir)
  await waitFor('the two exits', () => of(events, 'exit').length === 2)
  assert.equal(runner.isCommandRunning(`${other}#a`), true)
})
