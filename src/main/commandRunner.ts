import * as pty from 'node-pty'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { existsSync, readFileSync, watch as fsWatch, writeFileSync, type FSWatcher } from 'node:fs'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { app, type BrowserWindow } from 'electron'
import { exitRecord, type ExitInfo } from './commandExit'

// Runs a registered command as a process (a PTY, so output keeps colors and the
// panel can replay scrollback). Keyed by `<worktreePath>#<id>`. A command may
// also declare `watch` globs — then changes under those paths re-run it.

export type CommandEvent =
  | { key: string; kind: 'started' }
  | { key: string; kind: 'data'; data: string }
  | { key: string; kind: 'exit'; code: number; durationMs: number } // how long the run lasted
  | { key: string; kind: 'mem'; rss: number } // resident memory of the process group, in bytes

interface Run {
  proc: pty.IPty
  buffer: string
  running: boolean
  superseded: boolean // a re-run replaced this proc — swallow its exit
  memTimer?: ReturnType<typeof setInterval>
  lastRss?: number // last sampled RSS, to skip unchanged updates
  startedAt: number // epoch ms this run began — for the exit duration
  lastExit?: ExitInfo // set when the proc exits; a fresh run has none (re-run clears it)
}

const runs = new Map<string, Run>()
const watchers = new Map<string, () => void>() // key → close-all-watchers fn
const sizes = new Map<string, { cols: number; rows: number }>()
const MAX_BUFFER = 256 * 1024
const MEM_INTERVAL = 2000 // how often to re-sample a running command's memory

let cachedShell: string | undefined
// The user's login shell, exported so other spawners (e.g. the provisioner) can
// run through it and inherit the real PATH (Herd, asdf, ~/.bun…) that a packaged
// GUI launch otherwise lacks.
export function userShell(): string {
  if (cachedShell) return cachedShell
  if (process.platform === 'win32') {
    cachedShell = process.env.COMSPEC || 'powershell.exe'
    return cachedShell
  }
  cachedShell = loginShellFromSystem() || process.env.SHELL || '/bin/zsh'
  return cachedShell
}
function loginShellFromSystem(): string | undefined {
  try {
    if (process.platform === 'darwin') {
      const out = execFileSync('dscl', ['.', '-read', `/Users/${userInfo().username}`, 'UserShell'], {
        encoding: 'utf8'
      })
      return out.replace(/^UserShell:\s*/, '').trim() || undefined
    }
    const out = execFileSync('getent', ['passwd', userInfo().username], { encoding: 'utf8' })
    return out.trim().split(':').pop() || undefined
  } catch {
    return undefined
  }
}

// One-shot: run `command` in `cwd` and return its combined stdout+stderr. Backs
// the composer's `!` shell mode — the user runs a command and its output is fed
// to the agent as context. Routes through the login shell so PATH matches the
// terminal, and never rejects: a non-zero exit is a normal result the model
// should see, so it comes back in `code` rather than as a throw.
export function runShellCapture(cwd: string, command: string): Promise<{ output: string; code: number }> {
  return new Promise((resolve) => {
    const env = { ...process.env, FORCE_COLOR: '0' }
    const child =
      process.platform === 'win32'
        ? spawn(command, { cwd, env, shell: true })
        : spawn(userShell(), ['-lc', command], { cwd, env })
    let out = ''
    const cap = (d: Buffer): void => {
      out += d.toString()
      if (out.length > MAX_BUFFER) out = out.slice(0, MAX_BUFFER)
    }
    child.stdout?.on('data', cap)
    child.stderr?.on('data', cap)
    child.on('error', (e: Error) => resolve({ output: e.message, code: -1 }))
    child.on('exit', (code) => resolve({ output: out, code: code ?? 0 }))
  })
}

function send(win: BrowserWindow, event: CommandEvent): void {
  if (!win.isDestroyed()) win.webContents.send('command:event', event)
}

// Sum the resident memory (RSS, bytes) of every process in pgid's group via
// `ps`. node-pty makes the child a group leader, so a command like `bun run dev`
// and the vite/esbuild it spawns all share proc.pid as their pgid — this counts
// the whole tree. Async so it never blocks the main thread; resolves 0 if ps
// fails or the group is already gone. Windows has no ps, so it reports nothing.
function sampleGroupRss(pgid: number): Promise<number> {
  return new Promise((resolve) => {
    if (process.platform === 'win32') return resolve(0)
    execFile('ps', ['-A', '-o', 'pgid=,rss='], (err, stdout) => {
      if (err) return resolve(0)
      let total = 0
      for (const line of stdout.split('\n')) {
        const m = line.trim().match(/^(\d+)\s+(\d+)$/)
        if (m && Number(m[1]) === pgid) total += Number(m[2]) * 1024 // ps reports RSS in KiB
      }
      resolve(total)
    })
  })
}

// Poll a running command's memory and push updates to the renderer, skipping
// re-sends when the figure hasn't moved. Samples once right away so the row
// shows a value without waiting a full interval.
function startMemPolling(win: BrowserWindow, key: string, run: Run): void {
  const pgid = run.proc.pid
  const tick = (): void => {
    if (!run.running) return
    void sampleGroupRss(pgid).then((rss) => {
      if (!run.running || run.superseded || rss === run.lastRss) return
      run.lastRss = rss
      send(win, { key, kind: 'mem', rss })
    })
  }
  tick()
  run.memTimer = setInterval(tick, MEM_INTERVAL)
}

function stopMemPolling(run: Run): void {
  if (run.memTimer) clearInterval(run.memTimer)
  run.memTimer = undefined
}

// node-pty spawns the child as a session/group leader, so killing the negative
// pid takes down the whole tree (e.g. `bun run dev` AND the vite it spawns).
// Falls back to a plain pty kill if the group signal can't be sent.
function killTree(proc: pty.IPty, signal: NodeJS.Signals = 'SIGTERM'): void {
  try {
    process.kill(-proc.pid, signal)
  } catch {
    try {
      proc.kill()
    } catch {
      /* already gone */
    }
  }
}

// Kill a process group by its (positive) leader pid — used by the reaper, which
// only has a persisted pid, not an IPty. Same group-kill as killTree.
function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal)
  } catch {
    /* group already gone */
  }
}

// ── Cross-session orphan reaping ──────────────────────────────────────────────
// The `runs` map is in-memory only, so an unclean quit (crash, force-quit) leaves
// every spawned group orphaned (e.g. a vite dev server pegging CPU). We persist
// each running command's group pid to userData; on boot and before each start we
// kill any survivor still matching what we launched. ponytail: pid-reuse guarded
// by a ps command-match; good enough short of cgroups.
interface PersistedRun {
  key: string
  pid: number
  cmd: string
}

function pidFile(): string {
  return join(app.getPath('userData'), 'running-commands.json')
}
function readPersisted(): PersistedRun[] {
  try {
    const list = JSON.parse(readFileSync(pidFile(), 'utf8'))
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}
function writePersisted(list: PersistedRun[]): void {
  try {
    writeFileSync(pidFile(), JSON.stringify(list))
  } catch {
    /* userData not writable — reaping is best-effort */
  }
}
function recordRun(key: string, pid: number, cmd: string): void {
  writePersisted([...readPersisted().filter((e) => e.key !== key), { key, pid, cmd }])
}
function forgetRun(key: string): void {
  writePersisted(readPersisted().filter((e) => e.key !== key))
}

// Map every live process-group id to the joined command lines of its members, so
// we can confirm a persisted group is both alive AND still ours before killing.
function liveGroupCommands(): Map<number, string> {
  const map = new Map<number, string>()
  if (process.platform === 'win32') return map
  try {
    const out = execFileSync('ps', ['-A', '-o', 'pgid=,command='], { encoding: 'utf8' })
    for (const line of out.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(.*)$/)
      if (!m) continue
      const pgid = Number(m[1])
      map.set(pgid, (map.get(pgid) ?? '') + '\n' + m[2])
    }
  } catch {
    /* ps unavailable — skip reaping rather than guess */
  }
  return map
}

// Kill persisted groups still alive and matching their recorded command, then
// drop them from the file. `only` limits it to one key (the pre-start check);
// omit it to reap everything (boot).
function reapPersisted(only?: string): void {
  const persisted = readPersisted()
  if (!persisted.length) return
  const groups = liveGroupCommands()
  const remaining: PersistedRun[] = []
  for (const e of persisted) {
    if (only && e.key !== only) {
      remaining.push(e)
      continue
    }
    const cmds = groups.get(e.pid)
    if (cmds && cmds.includes(e.cmd)) killGroup(e.pid, 'SIGKILL')
    // matched → killed; unmatched → dead or pid reused by another process. Either
    // way the record is stale, so it's not carried into `remaining`.
  }
  writePersisted(remaining)
}

// Kill leftover command groups from a previous (crashed) session. Call once at boot.
export function reapOrphanCommands(): void {
  reapPersisted()
}

// (Re)spawn the process for a key, superseding any previous one. Keeps the
// scrollback buffer so a re-run reads as a continuation.
function spawnProc(win: BrowserWindow, key: string, cwd: string, branch: string, command: string): void {
  const prev = runs.get(key)
  if (prev?.running) {
    prev.superseded = true
    stopMemPolling(prev)
    killTree(prev.proc)
  } else {
    // Nothing tracked in memory, but a crashed session may have left this key's
    // group running — nuke it before starting a fresh one.
    reapPersisted(key)
  }
  const size = sizes.get(key) ?? { cols: 80, rows: 24 }
  const proc = pty.spawn(userShell(), ['-lc', command], {
    name: 'xterm-256color',
    cols: size.cols,
    rows: size.rows,
    cwd,
    env: { ...process.env, FLOE_WORKTREE: branch, TERM: 'xterm-256color' } as Record<string, string>
  })
  const run: Run = { proc, buffer: prev?.buffer ?? '', running: true, superseded: false, startedAt: Date.now() }
  runs.set(key, run)
  if (typeof proc.pid === 'number') recordRun(key, proc.pid, command)
  send(win, { key, kind: 'started' })
  startMemPolling(win, key, run)

  proc.onData((data) => {
    run.buffer = (run.buffer + data).slice(-MAX_BUFFER)
    send(win, { key, kind: 'data', data })
  })
  proc.onExit(({ exitCode }) => {
    stopMemPolling(run)
    if (run.superseded) return // a re-run already re-recorded this key; leave it
    forgetRun(key)
    run.running = false
    run.lastExit = exitRecord(run.startedAt, Date.now(), exitCode)
    send(win, { key, kind: 'exit', code: exitCode, durationMs: run.lastExit.durationMs })
  })
}

// The longest non-glob directory prefix of a watch pattern, resolved to cwd.
function watchRoot(cwd: string, pattern: string): string {
  const segs: string[] = []
  for (const seg of pattern.split('/')) {
    if (/[*?[\]{}]/.test(seg)) break
    segs.push(seg)
  }
  return join(cwd, ...segs)
}

function ensureWatch(
  win: BrowserWindow,
  key: string,
  cwd: string,
  branch: string,
  command: string,
  watch: string[] | undefined
): void {
  if (!watch?.length || watchers.has(key)) return
  const closers: Array<() => void> = []
  const roots = new Set(watch.map((p) => watchRoot(cwd, p)))
  for (const root of roots) {
    if (!existsSync(root)) continue
    let timer: ReturnType<typeof setTimeout> | undefined
    const w: FSWatcher = fsWatch(root, { recursive: true }, () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => spawnProc(win, key, cwd, branch, command), 300)
    })
    closers.push(() => {
      if (timer) clearTimeout(timer)
      w.close()
    })
  }
  if (closers.length) watchers.set(key, () => closers.forEach((c) => c()))
}

export function startCommand(
  win: BrowserWindow,
  key: string,
  cwd: string,
  branch: string,
  command: string,
  cols: number,
  rows: number,
  watch?: string[]
): void {
  if (runs.get(key)?.running) return // already running
  if (cols > 0 && rows > 0) sizes.set(key, { cols, rows })
  spawnProc(win, key, cwd, branch, command)
  ensureWatch(win, key, cwd, branch, command, watch)
}

export function restartCommand(
  win: BrowserWindow,
  key: string,
  cwd: string,
  branch: string,
  command: string,
  cols: number,
  rows: number,
  watch?: string[]
): void {
  if (cols > 0 && rows > 0) sizes.set(key, { cols, rows })
  spawnProc(win, key, cwd, branch, command)
  ensureWatch(win, key, cwd, branch, command, watch)
}

function closeWatch(key: string): void {
  watchers.get(key)?.()
  watchers.delete(key)
}

export function stopCommand(key: string): void {
  closeWatch(key) // stop auto re-runs too
  const run = runs.get(key)
  if (run?.running) killTree(run.proc)
}

export function attachCommand(win: BrowserWindow, key: string, cols: number, rows: number): void {
  if (cols > 0 && rows > 0) sizes.set(key, { cols, rows })
  const run = runs.get(key)
  if (!run) return
  if (run.buffer) send(win, { key, kind: 'data', data: run.buffer })
  if (run.running && cols > 0 && rows > 0) run.proc.resize(cols, rows)
}

export function resizeCommand(key: string, cols: number, rows: number): void {
  if (cols > 0 && rows > 0) sizes.set(key, { cols, rows })
  const run = runs.get(key)
  if (run?.running && cols > 0 && rows > 0) run.proc.resize(cols, rows)
}

export function isCommandRunning(key: string): boolean {
  return !!runs.get(key)?.running
}

// PIDs of every running command's process group leader, for the topbar memory
// readout. systemStats sums each leader's whole descendant tree (e.g. the vite
// a `bun run dev` spawned).
export function getCommandPids(): number[] {
  return [...runs.values()]
    .filter((r) => r.running)
    .map((r) => r.proc.pid)
    .filter((p): p is number => typeof p === 'number')
}

export function killAllCommands(): void {
  for (const close of watchers.values()) close()
  watchers.clear()
  for (const run of runs.values()) {
    stopMemPolling(run)
    killTree(run.proc, 'SIGKILL')
  }
  runs.clear()
}

// Stop every command belonging to one worktree (keys are `<worktreePath>#<id>`).
export function killCommandsForWorktree(worktreePath: string): void {
  const prefix = worktreePath + '#'
  for (const key of [...runs.keys()]) if (key.startsWith(prefix)) stopCommand(key)
}
