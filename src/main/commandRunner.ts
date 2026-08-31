import * as pty from 'node-pty'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, readFileSync, watch as fsWatch, writeFileSync, type FSWatcher } from 'node:fs'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { app, type BrowserWindow } from 'electron'
import { exitRecord, type ExitInfo } from './commandExit'
import {
  canStart,
  newLife,
  onExit as lifeExit,
  onSpawned,
  onStart as lifeStart,
  onStop as lifeStop,
  shouldWatchFire,
  type CommandLife,
  type CommandState
} from './commandState'
import { snapshotProcesses } from './psSnapshot'

// Runs a registered command as a process (a PTY, so output keeps colors and the
// panel can replay scrollback). Keyed by `<worktreePath>#<id>`. A command may
// also declare `watch` globs — then changes under those paths re-run it.

export type CommandEvent =
  | { key: string; kind: 'started' }
  | { key: string; kind: 'data'; data: string }
  | { key: string; kind: 'exit'; code: number; durationMs: number } // how long the run lasted
  | { key: string; kind: 'mem'; rss: number } // resident memory of the process group, in bytes
  // Where the command IS. Sent on every transition the other events do not
  // already imply — a stop that has been asked for, a restart waiting out its
  // backoff, a breaker that opened — so the row never has to infer it.
  | { key: string; kind: 'state'; state: CommandState; reason?: string; restartIn?: number }

interface Run {
  proc: pty.IPty
  buffer: string
  running: boolean
  life: CommandLife
  /** Everything a respawn needs, so auto-restart and the watch can do it alone. */
  spec: { cwd: string; branch: string; command: string; autoRestart?: boolean }
  /** The pending auto-restart, so a stop or a manual start can cancel it. */
  restartTimer?: ReturnType<typeof setTimeout>
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

// Sum the resident memory (RSS, bytes) of every process in pgid's group, from
// the shared `ps` snapshot (see psSnapshot.ts). node-pty makes the child a
// group leader, so a command like `bun run dev` and the vite/esbuild it spawns
// all share proc.pid as their pgid — this counts the whole tree. Resolves 0 if
// ps fails or the group is already gone.
async function sampleGroupRss(pgid: number): Promise<number> {
  let total = 0
  for (const row of await snapshotProcesses()) if (row.pgid === pgid) total += row.rssBytes
  return total
}

// Poll a running command's memory and push updates to the renderer, skipping
// re-sends when the figure hasn't moved. Samples once right away so the row
// shows a value without waiting a full interval. Ticks are skipped while the
// window is blurred or hidden — nobody is reading the figure, and sampling
// spawns `ps`; the next focused tick (≤2s after refocus) catches up.
function startMemPolling(win: BrowserWindow, key: string, run: Run): void {
  const pgid = run.proc.pid
  const tick = (): void => {
    if (!run.running || win.isDestroyed() || !win.isFocused() || !win.isVisible()) return
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
  /** Where it was launched, and when — so a stale record can be read by a human. */
  cwd?: string
  startedAt?: number
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
function recordRun(key: string, pid: number, cmd: string, cwd: string, startedAt: number): void {
  writePersisted([...readPersisted().filter((e) => e.key !== key), { key, pid, cmd, cwd, startedAt }])
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

// Tell the renderer where this command is now. Sent alongside `started`/`exit`
// rather than instead of them: those two carry the terminal's own payloads
// (scrollback continuity, the exit code), this one carries the state machine.
function sendState(win: BrowserWindow, key: string, run: Run, restartIn?: number): void {
  send(win, { key, kind: 'state', state: run.life.state, reason: run.life.reason, restartIn })
}

// (Re)spawn the process for a key, superseding any previous one. Keeps the
// scrollback buffer so a re-run reads as a continuation.
function spawnProc(win: BrowserWindow, key: string, spec: Run['spec'], life: CommandLife): void {
  const { cwd, branch, command } = spec
  const prev = runs.get(key)
  if (prev?.restartTimer) clearTimeout(prev.restartTimer) // a spawn cancels a pending one
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
  const run: Run = {
    proc,
    buffer: prev?.buffer ?? '',
    running: true,
    superseded: false,
    startedAt: Date.now(),
    life: onSpawned(life),
    spec
  }
  runs.set(key, run)
  if (typeof proc.pid === 'number') recordRun(key, proc.pid, command, cwd, run.startedAt)
  send(win, { key, kind: 'started' })
  sendState(win, key, run)
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
    const next = lifeExit(run.life, exitCode, Date.now(), !!run.spec.autoRestart)
    run.life = next.life
    send(win, { key, kind: 'exit', code: exitCode, durationMs: run.lastExit.durationMs })
    sendState(win, key, run, next.restartIn)
    // `auto-restart` waits out a backoff rather than respawning on the spot, so
    // a command that dies instantly cannot spin. The breaker in commandState
    // decides when there is no `restartIn` left to schedule.
    if (next.restartIn != null) {
      run.restartTimer = setTimeout(() => {
        if (runs.get(key) !== run) return // superseded while we waited
        spawnProc(win, key, run.spec, run.life)
      }, next.restartIn)
    }
  })
}

// Recursive fs.watch is not universal: Linux only gained it in Node 20, and on
// an older runtime the call throws ERR_FEATURE_UNAVAILABLE_ON_PLATFORM rather
// than degrading. Watching the root alone still catches writes directly inside
// it, which covers the shape these globs actually take (`database/migrations`),
// so the fallback is a narrower watch rather than no watch at all.
function watchDir(root: string, onChange: () => void): FSWatcher | undefined {
  try {
    return fsWatch(root, { recursive: true }, onChange)
  } catch {
    try {
      return fsWatch(root, onChange)
    } catch {
      return undefined // vanished between the existsSync and here
    }
  }
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
  spec: Run['spec'],
  watch: string[] | undefined
): void {
  if (!watch?.length || watchers.has(key)) return
  const closers: Array<() => void> = []
  const roots = new Set(watch.map((p) => watchRoot(spec.cwd, p)))
  for (const root of roots) {
    if (!existsSync(root)) continue
    let timer: ReturnType<typeof setTimeout> | undefined
    const w = watchDir(root, () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        // A command that writes into the very directory it watches (a migration
        // re-runner does) fires this on its own output. Firing mid-spawn stacks
        // a second process on one that has not finished starting, and the two
        // race for the same port or the same database.
        const life = runs.get(key)?.life ?? newLife()
        if (!shouldWatchFire(life)) return
        spawnProc(win, key, spec, life)
      }, 300)
    })
    if (!w) continue
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
  watch?: string[],
  autoRestart?: boolean
): void {
  const run = runs.get(key)
  // `canStart` refuses a second spawn while one is in flight — which `running`
  // alone could not see: a command mid-start, or one waiting out an auto-restart
  // backoff, used to read as stopped and start a rival process.
  if (run && !canStart(run.life)) return
  if (cols > 0 && rows > 0) sizes.set(key, { cols, rows })
  const spec = { cwd, branch, command, autoRestart }
  spawnProc(win, key, spec, lifeStart())
  ensureWatch(win, key, spec, watch)
}

export function restartCommand(
  win: BrowserWindow,
  key: string,
  cwd: string,
  branch: string,
  command: string,
  cols: number,
  rows: number,
  watch?: string[],
  autoRestart?: boolean
): void {
  if (cols > 0 && rows > 0) sizes.set(key, { cols, rows })
  const spec = { cwd, branch, command, autoRestart }
  // A restart is a manual start, so it re-arms the breaker: you are asking again
  // with your own hands, after reading why it stopped.
  spawnProc(win, key, spec, lifeStart())
  ensureWatch(win, key, spec, watch)
}

function closeWatch(key: string): void {
  watchers.get(key)?.()
  watchers.delete(key)
}

export function stopCommand(win: BrowserWindow | undefined, key: string): void {
  closeWatch(key) // stop auto re-runs too
  const run = runs.get(key)
  if (!run) return
  if (run.restartTimer) {
    // Stopping during a backoff has to cancel the pending respawn, or the
    // command comes back seconds after you told it not to.
    clearTimeout(run.restartTimer)
    run.restartTimer = undefined
    run.life = { ...run.life, state: 'exited' }
    if (win) sendState(win, key, run)
    return
  }
  if (!run.running) return
  // Marked before the signal, so the exit that follows is read as asked-for and
  // auto-restart leaves it alone.
  run.life = lifeStop(run.life)
  if (win) sendState(win, key, run)
  killTree(run.proc)
}

export function attachCommand(win: BrowserWindow, key: string, cols: number, rows: number): void {
  if (cols > 0 && rows > 0) sizes.set(key, { cols, rows })
  const run = runs.get(key)
  if (!run) return
  if (run.buffer) send(win, { key, kind: 'data', data: run.buffer })
  // The panel may be opening long after the process started — or after a window
  // reload, when the renderer knows nothing at all. Replaying the scrollback
  // without the state is what made a live process render as stopped.
  sendState(win, key, run)
  if (run.running && cols > 0 && rows > 0) run.proc.resize(cols, rows)
}

export function resizeCommand(key: string, cols: number, rows: number): void {
  if (cols > 0 && rows > 0) sizes.set(key, { cols, rows })
  const run = runs.get(key)
  if (run?.running && cols > 0 && rows > 0) run.proc.resize(cols, rows)
}

/** One command's state as main knows it — what a reloading renderer asks for. */
export interface CommandRun {
  key: string
  state: CommandState
  /** Why auto-restart gave up, when it did. */
  reason?: string
  rss?: number
  exitCode?: number
  endedAt?: number
  durationMs?: number
}

/**
 * Every command main is tracking, for a renderer that just (re)loaded.
 *
 * The renderer's own map is in-memory only, so without this a window reload
 * showed "stopped" for processes main is still running — and then start and stop
 * did nothing, because the row was offering the wrong button.
 */
export function commandRuns(): CommandRun[] {
  return [...runs.entries()].map(([key, r]) => ({
    key,
    state: r.life.state,
    reason: r.life.reason,
    rss: r.running ? r.lastRss : undefined,
    exitCode: r.lastExit?.code,
    endedAt: r.lastExit?.endedAt,
    durationMs: r.lastExit?.durationMs
  }))
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
    if (run.restartTimer) clearTimeout(run.restartTimer) // nothing to come back to
    killTree(run.proc, 'SIGKILL')
  }
  runs.clear()
}

// Stop every command belonging to one worktree (keys are `<worktreePath>#<id>`).
export function killCommandsForWorktree(worktreePath: string): void {
  const prefix = worktreePath + '#'
  for (const key of [...runs.keys()]) if (key.startsWith(prefix)) stopCommand(undefined, key)
}
