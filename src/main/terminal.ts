import * as pty from 'node-pty'
import { execFileSync } from 'node:child_process'
import { homedir, userInfo } from 'node:os'
import { appendFileSync } from 'node:fs'
import { resolve, relative, isAbsolute, sep } from 'node:path'
import type { BrowserWindow } from 'electron'
import { appendScrollback, newScrollback, type Scrollback } from './terminalBuffer'
import { floeConfig } from './config/floe'
import { currentEditor, editKeys, resolveEditorBin, spawnArgs } from './editors'

export type TerminalEvent =
  | { id: string; kind: 'data'; data: string }
  | { id: string; kind: 'exit'; code: number }

interface Term {
  proc: pty.IPty
  cwd: string
  // Recent output kept so a re-opened panel (e.g. after toggling ⌘Y or switching
  // worktrees) can repaint its scrollback instead of showing a blank screen.
  scrollback: Scrollback
  // Live output coalesced since the last IPC flush, plus its scheduled flusher.
  // A flood of PTY output arrives as many small chunks; batching a burst into one
  // 'data' message cuts the per-chunk serialize + main→renderer crossing.
  pending: string
  flush?: ReturnType<typeof setTimeout>
  // Whether the program asked for color-scheme change reports (DECSET 2031) —
  // only those PTYs receive notifyTheme()'s CSI ?997;n, so a shell that never
  // opted in (bash, plain scripts) can't get the report typed into its input.
  themeReports?: boolean
}

// Keyed by terminal id (the renderer uses the worktree path), so each worktree
// keeps one long-lived shell that survives the panel being hidden.
const terms = new Map<string, Term>()
// Última aparência que o renderer reportou, para nudge de PTYs que ligam o
// DECSET 2031 depois (fish que bootou antes do tema chegar até nós).
let lastKnownDark: boolean | null = null

// The shell the terminal panel opens. `[terminal] shell` in floe.toml wins when
// set; otherwise it's the user's default login shell — the same one they'd get
// in a real terminal (e.g. fish). The OS user record (dscl/getent) is
// authoritative over `process.env.SHELL`, which can be stale or plain wrong
// (e.g. inherited as /bin/zsh from whatever launched the app), so we trust the
// system record first and only fall back to $SHELL.
let cachedShell: string | undefined
function userShell(): string {
  const configured = floeConfig().terminal.shell
  if (configured) return configured
  if (cachedShell) return cachedShell
  if (process.platform === 'win32') {
    cachedShell = process.env.COMSPEC || 'powershell.exe'
    return cachedShell
  }
  cachedShell = loginShellFromSystem() || process.env.SHELL || '/bin/zsh'
  return cachedShell
}

// The editor binary the in-app editor panel runs: whatever `[editor] command`
// names, resolved to a full path so the spawn works from a packaged GUI launch
// with a minimal environment. $EDITOR and then vim are the fallbacks, for a
// configured editor that isn't installed — an empty panel would say nothing.
function editorBin(): string {
  const spec = currentEditor()
  const found = resolveEditorBin(spec)
  if (found) return found
  const editorEnv = process.env.EDITOR?.trim().split(/\s+/)[0]
  return (editorEnv ? resolveBin(editorEnv) : undefined) ?? resolveBin('vim') ?? 'vim'
}

// The renderer says `~` when the panel belongs to no worktree (the Home
// terminal). Only a shell expands that — a bare `~` handed to spawn is a
// directory that doesn't exist, and the PTY dies before printing anything
// ("[process exited (1)]" in a blank panel). Expand it here, where every spawn
// site passes through.
export function resolveCwd(cwd: string): string {
  if (cwd === '~') return homedir()
  if (cwd.startsWith('~/')) return resolve(homedir(), cwd.slice(2))
  return cwd
}

function resolveBin(name: string): string | undefined {
  try {
    const out = execFileSync('/usr/bin/which', [name], { encoding: 'utf8' }).trim()
    return out || undefined
  } catch {
    return undefined
  }
}

// Read the login shell from the OS user database, since GUI launches lack $SHELL.
function loginShellFromSystem(): string | undefined {
  try {
    if (process.platform === 'darwin') {
      const out = execFileSync('dscl', ['.', '-read', `/Users/${userInfo().username}`, 'UserShell'], {
        encoding: 'utf8'
      })
      // Output looks like: "UserShell: /opt/homebrew/bin/fish\n"
      const shell = out.replace(/^UserShell:\s*/, '').trim()
      return shell || undefined
    }
    // Linux/other: getent passwd <user> → last field is the shell.
    const out = execFileSync('getent', ['passwd', userInfo().username], { encoding: 'utf8' })
    const shell = out.trim().split(':').pop()
    return shell || undefined
  } catch {
    return undefined
  }
}

// TEMPORARY diagnostic (FLOE_PTY_TAP=<file>): timestamped log of every byte a
// PTY emits, every answer we inject, and the open/replay/resize/write calls — to
// find why fish's DA1 goes unanswered on a return to Home. Remove once fixed.
const TAP = process.env.FLOE_PTY_TAP
function tap(id: string, kind: string, data: string): void {
  if (!TAP) return
  try {
    appendFileSync(TAP, `${Date.now()} ${id} ${kind} ${JSON.stringify(data)}\n`)
  } catch {
    /* diagnostics must never break the terminal */
  }
}

function send(win: BrowserWindow, event: TerminalEvent): void {
  if (!win.isDestroyed()) win.webContents.send('terminal:event', event)
}

// Kill the whole process group (node-pty makes the child a session leader), so
// anything launched from the shell dies with it instead of being orphaned.
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

// Open (or re-attach to) a terminal for `id`. If one already exists we hand back
// its buffered output for the panel to repaint and resize it to the new viewport,
// rather than spawning again.
export function openTerminal(
  win: BrowserWindow,
  id: string,
  cwd: string,
  branch: string,
  cols: number,
  rows: number
): string | null {
  const existing = terms.get(id)
  if (existing) {
    tap(id, 'OPEN-reattach', `${cols}x${rows} scrollback=${existing.scrollback.buffer.length}`)
    resizeTerminal(id, cols, rows)
    return replay(id, existing)
  }

  const dir = resolveCwd(cwd)
  tap(id, 'OPEN-spawn', `${cols}x${rows} cwd=${dir}`)
  const proc = pty.spawn(userShell(), [], {
    name: 'xterm-256color',
    cols: cols || 80,
    rows: rows || 24,
    cwd: dir,
    env: { ...process.env, FLOE_WORKTREE: branch, TERM: 'xterm-256color' } as Record<string, string>
  })

  const term: Term = { proc, cwd: dir, scrollback: newScrollback(), pending: '' }
  terms.set(id, term)
  wire(win, id, term)
  return null
}

// File names come from a filesystem walk, so they're attacker-controllable (a
// cloned repo can ship a file named `-c`, `foo|!cmd`, or one with embedded
// newlines). Before a name reaches nvim's argv or its `:edit` command line we
// confirm it's a real, in-worktree path: no control characters or ex-command
// separators, and its realpath-free resolution must stay inside `cwd`. Returns
// the safe worktree-relative path, or throws (the open is then a no-op).
function safeEditorFile(file: string, cwd: string): string {
  // Reject every control char (esp. ESC \x1b), not just newlines/pipe: the path
  // is written into the PTY inside an `\x1b:execute …` sequence, so a stray ESC
  // could break out of insert mode and run arbitrary ex-commands.
  if (/[\x00-\x1f\x7f|]/.test(file)) {
    throw new Error('Refusing to open file with control characters in its name')
  }
  const abs = resolve(cwd, file)
  const rel = relative(cwd, abs)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('Refusing to open a file outside the worktree')
  }
  return rel.split(sep).join('/')
}

// Open (or re-attach to) the terminal editor for `id`. Reuses the same
// long-lived PTY machinery as the shell: a fresh editor spawns `<editor>
// <file>`; an existing one replays its scrollback and is told to open the
// requested file, so a single editor per worktree gathers every file opened.
export function openEditor(
  win: BrowserWindow,
  id: string,
  cwd: string,
  branch: string,
  file: string | null,
  cols: number,
  rows: number,
  // 1-based line to place the cursor on (e.g. the selected .http request). Only
  // honored alongside `file`; a non-finite/≤0 value is ignored.
  line?: number
): string | null {
  const dir = resolveCwd(cwd)
  const safeFile = file ? safeEditorFile(file, dir) : null
  const safeLine = safeFile && Number.isInteger(line) && (line as number) > 0 ? (line as number) : null

  const existing = terms.get(id)
  if (existing) {
    resizeTerminal(id, cols, rows)
    const buffer = replay(id, existing)
    // Tell the running editor to open this file — see editKeys. An editor we
    // have no command for keeps showing what it had; typing a guess into an
    // unknown program is worse than one extra `:e`.
    const keys = safeFile ? editKeys(currentEditor(), safeFile, safeLine) : null
    if (keys) existing.proc.write(keys)
    return buffer
  }

  const args = spawnArgs(currentEditor(), safeFile, safeLine)
  const proc = pty.spawn(editorBin(), args, {
    name: 'xterm-256color',
    cols: cols || 80,
    rows: rows || 24,
    cwd: dir,
    env: { ...process.env, FLOE_WORKTREE: branch, TERM: 'xterm-256color' } as Record<string, string>
  })

  const term: Term = { proc, cwd: dir, scrollback: newScrollback(), pending: '' }
  terms.set(id, term)
  wire(win, id, term)
  return null
}

// Forward a PTY's output to the renderer (keeping a replayable scrollback) and
// announce its exit. Shared by the shell and the editor.
function wire(win: BrowserWindow, id: string, term: Term): void {
  term.proc.onData((data) => {
    // Already killed (killTerminal/killAllTerminals/killTerminalsForWorktree) —
    // a dying process can still flush buffered output after the kill signal;
    // don't write back into a PTY we just tore down (crashed the app once,
    // see 5.2.3 SIGABRT in pty.node during app-quit teardown).
    if (!terms.has(id)) return
    // Answer the shell's Primary Device Attribute query (ESC[c / ESC[0c)
    // ourselves. Normally the browser's xterm answers it, but only while the one
    // active tab has this terminal's pane mounted — on the headless server the
    // shell often boots without that (page mid-load, pane hidden, tab superseded),
    // and fish then blocks its startup for 10s and prints a terminal-compatibility
    // warning into the scrollback. If xterm also answers, the shell parses the
    // duplicate report and discards it.
    //
    // fish re-emits DA1 on EVERY prompt render, not just at startup (verified with
    // a raw PTY), and only a mounted pane answers the repeats. So on a view/project
    // switch the post-remount repaint's DA1 lands with no responder — the pane was
    // gone while switched away, or its reply is swallowed by the renderer's replay
    // gate on return — and fish blocks ~10s on its DA1 timeout ("freezes, then
    // comes back"). Answer every DA1, not just the first: mount-independent, and a
    // duplicate from a live pane is harmless (discarded, as above).
    if (/\x1b\[0?c/.test(data)) {
      term.proc.write('\x1b[?1;2c')
      tap(id, 'ANSWER-DA1', '')
    }
    tap(id, 'out', data)
    // Track DECSET/DECRST 2031 (color-scheme change reports; fish 4 and nvim
    // enable it at startup) so notifyTheme() knows which PTYs want the report.
    const repOn = data.lastIndexOf('\x1b[?2031h')
    const repOff = data.lastIndexOf('\x1b[?2031l')
    if (repOn !== repOff) {
      term.themeReports = repOn > repOff
      // Acabou de optar por reports de color-scheme: conte o tema atual agora, pra
      // um shell que bootou antes do tema chegar (sua query OSC 11 correu com o
      // round-trip pela rede no attach) ainda recolorir.
      if (term.themeReports && lastKnownDark !== null) {
        term.proc.write(`\x1b[?997;${lastKnownDark ? '1' : '2'}n`)
      }
    }
    appendScrollback(term.scrollback, data)
    term.pending += data
    // Coalesce the burst into one IPC message. ~8ms batches heavy output into
    // far fewer crossings with no perceptible lag on interactive echo.
    // ponytail: fixed 8ms; revisit only if echo ever feels sluggish.
    if (!term.flush) term.flush = setTimeout(() => flushPending(win, id), 8)
  })
  term.proc.onExit(({ exitCode }) => {
    if (!terms.has(id)) return // already torn down by an explicit kill
    flushPending(win, id) // don't drop the final bytes before the exit notice
    terms.delete(id)
    send(win, { id, kind: 'exit', code: exitCode })
  })
}

// The scrollback a re-opened panel repaints itself from. Handed back through the
// open() reply rather than pushed as an event: the resize above makes the shell
// repaint its prompt (fish redraws relative to where the cursor is — `\r\x1b[A`),
// and if those live bytes reach the panel before the scrollback does, they paint
// a prompt the replay then pushes down — the duplicated prompt on re-open. A
// return value can't overtake the replay it belongs to.
//
// A program still on the alternate screen (nvim, lazygit) can't be repainted
// faithfully from a byte window — its frames are absolutely positioned and the
// window can start mid-frame — so nudge the size to make it redraw itself from
// scratch. The kernel only raises SIGWINCH when the size actually changes, hence
// the jiggle.
function replay(id: string, term: Term): string | null {
  const { cols, rows } = term.proc
  if (term.scrollback.altDepth > 0 && rows > 1) {
    term.proc.resize(cols, rows - 1)
    term.proc.resize(cols, rows)
  }
  tap(id, 'REPLAY', String(term.scrollback.buffer.length))
  return term.scrollback.buffer || null
}

// Send whatever output has accumulated since the last flush as a single message.
function flushPending(win: BrowserWindow, id: string): void {
  const term = terms.get(id)
  if (!term) return
  if (term.flush) {
    clearTimeout(term.flush)
    term.flush = undefined
  }
  if (!term.pending) return
  const data = term.pending
  term.pending = ''
  send(win, { id, kind: 'data', data })
}

export function writeTerminal(id: string, data: string): void {
  tap(id, 'IN-keystroke', data)
  terms.get(id)?.proc.write(data)
}

export function resizeTerminal(id: string, cols: number, rows: number): void {
  const term = terms.get(id)
  if (term && cols > 0 && rows > 0) {
    tap(id, 'RESIZE', `${term.proc.cols}x${term.proc.rows} -> ${cols}x${rows}`)
    term.proc.resize(cols, rows)
  }
}

// Tell every shell that opted into color-scheme reports (DECSET 2031) that the
// app's resolved appearance flipped: CSI ?997;1n = dark, ?997;2n = light. fish 4
// (and nvim) react by re-querying OSC 10/11 — answered by the pane's xterm with
// the new palette — and recolor live, without us typing anything into the shell.
export function notifyTerminalsTheme(dark: boolean): void {
  lastKnownDark = dark
  const report = `\x1b[?997;${dark ? '1' : '2'}n`
  for (const [id, term] of terms.entries()) {
    if (term.themeReports) {
      tap(id, 'NOTIFY-THEME', report)
      term.proc.write(report)
    }
  }
}

export function killTerminal(id: string): void {
  const term = terms.get(id)
  if (!term) return
  killTree(term.proc)
  terms.delete(id)
}

// Tear every shell (and whatever it launched) down — called on quit — so no
// processes are left orphaned.
export function killAllTerminals(): void {
  for (const term of terms.values()) killTree(term.proc, 'SIGKILL')
  terms.clear()
}

// Kill every terminal opened in one worktree (ids are `term:<worktreePath>#<n>`).
export function killTerminalsForWorktree(worktreePath: string): void {
  const prefix = `term:${worktreePath}#`
  // A snapshot, not a view: killTerminal deletes from `terms` as we go.
  for (const id of Array.from(terms.keys())) if (id.startsWith(prefix)) killTerminal(id)
}

// Which terminal PTYs for a worktree are still alive in this process. Used on
// project/worktree return to prune persisted terminal snapshots down to the ones
// we can actually re-attach to — after a restart this is empty (the PTYs are
// gone), so the renderer drops every stale snapshot instead of spawning blanks.
export function listLiveTerminals(worktreePath: string): { id: string; cwd: string }[] {
  const prefix = `term:${worktreePath}#`
  return [...terms.entries()]
    .filter(([id]) => id.startsWith(prefix))
    .map(([id, t]) => ({ id, cwd: t.cwd }))
}

// PIDs of every live terminal/editor PTY, for the topbar memory readout.
export function getTerminalPids(): number[] {
  return [...terms.values()].map((t) => t.proc.pid).filter((p): p is number => typeof p === 'number')
}
