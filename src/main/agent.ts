import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { watch, statSync, openSync, readSync, closeSync, existsSync, type FSWatcher } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { contextTokens } from '../shared/types'
import type { AgentEvent, AgentQuestion, AgentReplay, AgentRunOptions, FileAttachment, ImageAttachment, PermissionMode } from '../shared/types'
import { parseArtifactSpec } from '../shared/artifact'
import { getCreatedSession } from './sessionStore'
// Who this key IS — session or query. Every alias lookup in this file goes
// through it, so a conversation the session table does not hold still resolves
// instead of silently answering `undefined`. See identity.ts.
import { agentIdentityNames, agentResumeId, linkAgentIdentity } from './identity'
import { isQueryKey } from '../shared/queries'
import { isAsyncLaunchAck, isTaskNotification, parsePeerMessage, parseTaskNotifications, resultText } from './claudeSessions'
// Circular with handoff (it imports sendAgentEvent) — safe: both sides only
// call the other's functions at runtime, never at module top level.
import { seedFor } from './handoff'
// Circular with relay.ts (it parks a waiter here) — safe: neither side touches
// the other at module top level.
import { cancelRelay } from './relay'
import { getSystemPrompt } from './appSettings'
// Circular with mcpServer (it imports sendToAgent/waitForTurn) — safe: both
// sides only call the other's functions at runtime, never at module top level.
import { emptyMcpConfigFor, mcpConfigFor } from './mcpServer'
import { log } from './log'

export interface Conn {
  child: ChildProcessWithoutNullStreams
  win: BrowserWindow // the window to emit events to (lets the watchdog recover a stuck turn)
  buffer: string
  optionsKey: string // permissionMode+model+effort — recreate if it changes
  sessionId?: string // captured for --resume on restart
  stderr: string
  pendingPerms: Map<string, unknown> // requestId → tool input, awaiting allow/deny
  subagents: Set<string> // active Task/Agent tool_use ids → emit `done` when their result returns
  // The MCP control server reads these so another session can watch this one:
  transcriptBuffer: string[] // recent human-readable lines (assistant text + tool summaries), capped
  lastAssistantText: string // assistant text accumulated this turn, returned to a waiting send_message(wait)
  // Streaming deltas are coalesced here and flushed on a short timer instead of
  // being forwarded token-by-token — see queueDelta/flushDeltas.
  pendingDeltas: Array<{ kind: 'text' | 'reasoning'; text: string }>
  flushTimer: NodeJS.Timeout | null
  // Turn-lifecycle bookkeeping for the stuck-session watchdog (see agent.ts log
  // calls + startAgentWatchdog). `turnActive` is true between a user send and the
  // `done` we emit; `lastActivityAt` tracks the last stdout line so the watchdog
  // can spot a silent hang; `heldForSubagentsAt` is set when a `result` arrived
  // but `done` was withheld pending an async subagent's completion — the exact
  // state that strands a turn as "Thinking…" forever if the notification is lost.
  turnActive: boolean
  turnStartedAt: number
  lastActivityAt: number
  lastLineType: string
  lastLineSubtype: string // `system` subtype (init/status/api_retry…) — diagnostic for stuck turns
  // Startup-wedge detection: a fresh spawn that emits only `system` lines (never a
  // real assistant token / tool_use / result) is hung at init. `turnHadMeaningfulOutput`
  // flips true on the first non-system line; `turnStartedOnFreshConn` limits the
  // watchdog's kill to spawns (the observed shape), not persistent-child turns.
  turnHadMeaningfulOutput: boolean
  turnStartedOnFreshConn: boolean
  heldForSubagentsAt: number | null
  stuckLogged: boolean // watchdog: only shout once when a turn first goes stuck
  turnClosed: boolean // `done` already emitted for this turn — collapses the racing close signals (stdout result / transcript notification / watchdog) to one
  // An async agent's completion is written to the CLI's own transcript but never
  // echoed on our stdout (see ensureTaskWatcher) — so we watch that file to learn
  // when a background subagent finishes instead of stranding the turn "Thinking…".
  worktreePath: string // cwd the child was spawned in; builds the transcript path
  taskWatcher: FSWatcher | null
  taskJsonlOffset: number // bytes of the transcript already scanned
  taskJsonlBuffer: string // partial trailing line carried between reads
}

const BUFFER_CAP = 200

// send_message(wait) parks a resolver here keyed by session key; it fires with
// `lastAssistantText` on the next `done` for that key (or on timeout, with
// whatever has accumulated so far). A session with no live conn resolves '' once
// its conn is spawned and finishes a turn.
const turnWaiters = new Map<string, Array<(text: string) => void>>()

function resolveWaiters(key: string, text: string): void {
  const waiters = turnWaiters.get(key)
  if (!waiters || !waiters.length) return
  turnWaiters.delete(key)
  for (const w of waiters) w(text)
}

// Resolve with the session's final assistant text on its next completed turn.
// Used by the MCP send_message(wait) tool for synchronous session-to-session
// request/response. On timeout, resolve with whatever text exists so far.
export function waitForTurn(key: string, timeoutMs = 120_000): Promise<string> {
  return new Promise((resolve) => {
    let done = false
    const finish = (text: string): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(text)
    }
    const timer = setTimeout(() => {
      const arr = turnWaiters.get(key)
      if (arr) {
        const idx = arr.indexOf(finish)
        if (idx >= 0) arr.splice(idx, 1)
        if (!arr.length) turnWaiters.delete(key)
      }
      finish(conns.get(key)?.lastAssistantText ?? '')
    }, timeoutMs)
    const arr = turnWaiters.get(key) ?? []
    arr.push(finish)
    turnWaiters.set(key, arr)
  })
}

/**
 * Call `cb` with the final assistant text of the turn this session is running,
 * once, whenever it ends.
 *
 * waitForTurn's promise with no clock on it. The relay (relay.ts) waits for a
 * turn it started itself, and a timeout there would not be a slow answer to
 * give up on — it would be a second turn fired into a session still working on
 * the first, which is the one thing the queue exists to prevent.
 */
export function onceTurnDone(key: string, cb: (text: string) => void): void {
  const arr = turnWaiters.get(key) ?? []
  arr.push(cb)
  turnWaiters.set(key, arr)
}

// The joined live transcript buffer for a session, for the MCP read_session_output
// tool. Empty string when there's no live conn (never sent a prompt, or reaped).
export function readSessionBuffer(key: string): string {
  return conns.get(key)?.transcriptBuffer.join('\n') ?? ''
}

function pushTranscript(conn: Conn, line: string): void {
  if (!line) return
  conn.transcriptBuffer.push(line)
  if (conn.transcriptBuffer.length > BUFFER_CAP) {
    conn.transcriptBuffer.splice(0, conn.transcriptBuffer.length - BUFFER_CAP)
  }
}

// One persistent `claude` process per session key, talking stream-json over
// stdin/stdout (bidirectional → real multi-turn + interactive prompts).
const conns = new Map<string, Conn>()

/** How a `claude` argv spells a mode. Shared with the peer runner (peer.ts). */
export function permissionArgs(mode: PermissionMode): string[] {
  if (mode === 'skip') return ['--dangerously-skip-permissions']
  return ['--permission-mode', mode]
}

// The identity of a conn's spawn options: if this string changes between turns,
// sendToAgent kills the conn and respawns. Built in exactly one place so the
// spawn-time key and the compare-time key can never silently drift apart.
export function optionsKeyFor(options: AgentRunOptions): string {
  return `${options.permissionMode}|${options.model ?? ''}|${options.effort ?? ''}`
}

// Every runtime (Claude here, codex.ts, runtimes.ts) emits through this one
// function, so the seq counter and the replay snapshot can never miss a source.
export function sendAgentEvent(win: BrowserWindow, key: string, event: AgentEvent): void {
  // Remember the last error per session: the watchdog's recover-silent path ends
  // in stopAgent(), which deletes the conn — so by the next tick the failure is
  // unobservable anywhere in main. Fleet reads it to show `error` instead of a
  // session that just quietly went idle. Cleared when a new turn starts.
  if (event.kind === 'error') lastErrors.set(key, { at: Date.now(), message: event.message })
  // A turn answered by anything but Claude has nothing accumulating its reply,
  // so `send_message(wait)` had nowhere to read one from. Every runtime emits
  // through here, so here is the one place that can hold the answer for them.
  //
  // Decided by WHO IS ANSWERING, not by whether a conn exists: a session that
  // has ever run Claude keeps its conn forever, so a later codex turn in the
  // same chat would take Claude's branch and resolve the waiter with Claude's
  // last answer — the reply to the message before this one.
  const answering = replays.get(key)?.choice?.provider
  if (answering && answering !== 'claude') {
    if (event.kind === 'text') runtimeText.set(key, (runtimeText.get(key) ?? '') + event.text)
    if (event.kind === 'done') {
      resolveWaiters(key, runtimeText.get(key) ?? '')
      runtimeText.delete(key)
    }
  }
  const seq = (seqs.get(key) ?? 0) + 1
  seqs.set(key, seq)
  recordForReplay(key, event, seq)
  if (!win.isDestroyed()) win.webContents.send('agent:event', { key, event, seq })
}

// What a conn-less runtime has said this turn, for waitForTurn to resolve with.
const runtimeText = new Map<string, string>()
const send = sendAgentEvent

const lastErrors = new Map<string, { at: number; message: string }>()
const seqs = new Map<string, number>()

// The turn in flight, replayed to a panel that opens mid-turn. The JSONL on
// disk only has what the CLI already wrote; everything streamed since the turn
// started lives here until `done`, when the file catches up and this resets.
// The user prompt is NOT kept — the CLI writes it to the JSONL at submit, so
// the panel's initial read already has it.
const replays = new Map<string, AgentReplay>()

// The window a turn was announced to, so the sweep below can close a replay
// nothing else can still reach. Kept beside `replays` rather than inside one:
// an AgentReplay crosses the IPC boundary, and a BrowserWindow does not.
const replayWins = new Map<string, BrowserWindow>()

export function markTurnStart(key: string, choice?: AgentReplay['choice'], win?: BrowserWindow): void {
  // Last turn's answer is not this one's — a waiter parked now must not be
  // handed the reply to the question before it.
  runtimeText.delete(key)
  if (win) replayWins.set(key, win)
  replays.set(key, {
    running: true,
    lastSeq: seqs.get(key) ?? 0,
    events: [],
    startedAt: Date.now(),
    // Carried so a panel opening mid-turn can name whoever is answering. Only
    // the caller knows: by the time events flow there is nothing in them that
    // says which harness produced them.
    choice
  })
  // And announced, for the panel already open. It may not have started this
  // turn — an agent can send into a chat someone is reading — so its picker is
  // not the answer to who is working.
  if (win && choice) sendAgentEvent(win, key, { kind: 'turn', ...choice })
}

/**
 * Every id one session answers to: the store's, and the CLI's own.
 *
 * The renderer keys a brand-new chat by Floe's id and every send after the CLI
 * reports its id by that claudeId — so which name a turn runs under depends on
 * when it started. Anything that has to find a session by name has to try all
 * of them; see resolveConn, which does the same for the live conn.
 */
export function sessionNames(key: string): string[] {
  const names = new Set(agentIdentityNames(key))
  // A conn the store has not linked yet still knows the id the CLI gave it.
  const conn = conns.get(key)
  if (conn?.sessionId) names.add(conn.sessionId)
  for (const [k, c] of conns) if (c.sessionId === key) names.add(k)
  return [...names]
}

/**
 * Is the turn this replay claims REALLY still in flight?
 *
 * Where a conn is filed under that name it is the authority — a replay left
 * `running` by a `done` that never arrived would otherwise put the typing line
 * back on screen every time the chat is opened. Where there is no conn (codex
 * and the other one-shot runtimes keep none) the replay is the only mark there
 * is, so it has to be believed.
 *
 * Pure, and exported for its unit test: the whole bug is one branch of it, and
 * the `conns` map it reads has no seam a test can reach. Same reason
 * `watchdogAction` is shaped this way.
 */
export function replayInFlight(
  replay: { running?: boolean } | undefined,
  conn: { turnActive: boolean } | undefined
): boolean {
  if (!replay?.running) return false
  return !conn || conn.turnActive
}

/**
 * Close a turn whose replay still says `running` with nothing left to end it.
 *
 * The `done` is what a panel is waiting for, but sending it is not always safe:
 * one session answers to two names and a panel listens for BOTH, so a strand
 * closed while the session's OTHER name is genuinely working would take the
 * typing line off the live turn. When that is the case the replay is only
 * marked finished — which is all replaySnapshot and activeTurnKeys need to stop
 * serving a turn that ended long ago.
 */
function closeStrandedReplay(
  key: string,
  win: BrowserWindow | undefined,
  why: string,
  text = '',
  notice?: string
): void {
  const replay = replays.get(key)
  if (!replay?.running) return
  const busyAlias = sessionNames(key).some((n) => n !== key && conns.get(n)?.turnActive)
  log('replay-strand-closed', {
    key,
    why,
    ageMs: replay.startedAt ? Date.now() - replay.startedAt : 0,
    provider: replay.choice?.provider ?? 'claude',
    busyAlias,
    emitted: Boolean(win) && !busyAlias
  })
  if (win && !busyAlias) {
    if (notice) send(win, key, { kind: 'error', message: notice })
    // `done` travels the ordinary path, so recordForReplay clears `running`
    // and the panel takes the line off exactly as it would on a real ending.
    send(win, key, { kind: 'done', ok: false })
  } else {
    replay.running = false
    replay.events = []
  }
  // Either way the turn is over, and a parked send_message(wait) must not go on
  // holding another session open for an answer that is never coming.
  resolveWaiters(key, text)
}

export function replaySnapshot(key: string): AgentReplay {
  const names = sessionNames(key)
  // The same liveness test for the panel's OWN key as for its aliases. Asking
  // under the key directly used to skip it, so a strand — a conn killed without
  // a `done`, a turn marked under a name whose child then went — answered every
  // reopen with `running: true` and a `startedAt` from that dead turn. The
  // typing line never stopped, and the panel cut its on-disk transcript at that
  // timestamp expecting this snapshot to replay the rest, which it could not:
  // everything said since the strand simply vanished from the chat.
  const inFlight = (name: string): boolean => replayInFlight(replays.get(name), conns.get(name))
  let snapshot = inFlight(key) ? replays.get(key) : undefined
  if (!snapshot) {
    for (const name of names) {
      if (name === key) continue
      if (inFlight(name)) {
        snapshot = replays.get(name)
        break
      }
    }
  }
  return { running: false, lastSeq: seqs.get(key) ?? 0, events: [], ...snapshot, names }
}

function recordForReplay(key: string, event: AgentEvent, seq: number): void {
  const r = replays.get(key)
  if (!r || !r.running) return
  r.lastSeq = seq
  switch (event.kind) {
    case 'session':
      if (event.model) r.model = event.model
      break
    case 'text':
    case 'reasoning': {
      // Mirror the renderer's own append: consecutive same-kind deltas fold
      // into one event, so a long answer replays as one item, not thousands.
      const last = r.events[r.events.length - 1]
      if (last && last.kind === event.kind) last.text += event.text
      else r.events.push({ ...event })
      break
    }
    case 'tool':
    case 'error':
    // Another session's line is said IN the turn: a panel that mounts after it
    // arrived would otherwise not see it until the chat is reopened.
    case 'peer':
    // A question is part of the turn: a panel mounting mid-question must get
    // it back or the session looks idle with the CLI still blocked on it. Same
    // for a permission prompt — both are answered from the same card, and both
    // are dropped again the moment they settle (dropSettled).
    case 'question':
    case 'permission':
    // A subagent's whole life happens inside the turn: launched, working, and
    // reporting back. A panel that mounts while one is out would otherwise see
    // a row that never opened, never closed, and — worst of the three — never
    // said what it found.
    case 'subagent-start':
    case 'subagent-done':
      r.events.push(event)
      break
    case 'subagent-progress': {
      // Progress fires several times a second per agent. Only the latest one
      // means anything (it is a patch of the row's current state), so it
      // replaces the pending one for that agent instead of stacking.
      const at = r.events.findIndex(
        (e) => e.kind === 'subagent-progress' && e.toolUseId === event.toolUseId
      )
      if (at === -1) r.events.push(event)
      else r.events[at] = event
      break
    }
    case 'done':
      r.running = false
      r.events = []
      break
  }
}

// The model emits text/thinking deltas token-by-token — often hundreds per
// second. Forwarding each one as its own IPC message makes the renderer
// re-render (and re-parse markdown) per token. Instead, coalesce consecutive
// same-kind deltas and flush them at most every FLUSH_MS (~30fps): the stream
// still reads as live, but IPC traffic and renderer work drop by an order of
// magnitude. Order is preserved — any non-delta event flushes the queue first.
const FLUSH_MS = 33

function queueDelta(win: BrowserWindow, key: string, conn: Conn, kind: 'text' | 'reasoning', text: string): void {
  if (!text) return
  const q = conn.pendingDeltas
  const last = q[q.length - 1]
  if (last && last.kind === kind) last.text += text
  else q.push({ kind, text })
  if (!conn.flushTimer) {
    conn.flushTimer = setTimeout(() => {
      // A conn replaced under the same key (options change / stop) was already
      // flushed or cleared by its owner; a late timer must not resurrect it.
      // (A missing entry is fine — close/stop flush before deregistering.)
      const cur = conns.get(key)
      if (cur === undefined || cur === conn) flushDeltas(win, key, conn)
    }, FLUSH_MS)
  }
}

export function flushDeltas(win: BrowserWindow, key: string, conn: Conn): void {
  if (conn.flushTimer) {
    clearTimeout(conn.flushTimer)
    conn.flushTimer = null
  }
  if (!conn.pendingDeltas.length) return
  const q = conn.pendingDeltas
  conn.pendingDeltas = []
  for (const d of q) {
    send(win, key, d.kind === 'text' ? { kind: 'text', text: d.text } : { kind: 'reasoning', text: d.text })
  }
}

function clearDeltas(conn: Conn): void {
  if (conn.flushTimer) {
    clearTimeout(conn.flushTimer)
    conn.flushTimer = null
  }
  conn.pendingDeltas = []
}

// A child we can no longer write to. exitCode/signalCode alone aren't enough: a
// zombie (defunct) process reaped by the OS but whose exit Node hasn't observed
// yet still reads `exitCode === null`, so reusing it writes into a dead pipe and
// the turn hangs forever (docs/bug-report-agent-spawn-hang.md). A destroyed or
// unwritable stdin, or a `kill()` we already issued, are the earlier signals.
export function isChildDead(child: ChildProcessWithoutNullStreams): boolean {
  return (
    child.exitCode !== null ||
    child.signalCode !== null ||
    child.killed ||
    child.stdin.destroyed ||
    child.stdin.writableEnded
  )
}

function write(conn: Conn, payload: unknown): void {
  conn.child.stdin.write(JSON.stringify(payload) + '\n')
}

function spawnConn(win: BrowserWindow, key: string, worktreePath: string, options: AgentRunOptions): Conn {
  const optionsKey = optionsKeyFor(options)
  // Resume the right Claude session even after the process is gone. The live
  // conn's id covers the in-app case; the persisted claudeId covers a respawn
  // after the machine slept or the app restarted — without it, an idle session
  // would silently start fresh and lose its whole history.
  const resumeId = conns.get(key)?.sessionId ?? agentResumeId(key)

  const args = [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--include-partial-messages',
    '--verbose'
  ]
  args.push(...permissionArgs(options.permissionMode))
  // Always route the control channel through stdio. For ordinary tools this only
  // bites outside skip mode (under --dangerously-skip-permissions the CLI
  // auto-allows them and never asks — verified: Bash runs with no prompt). But
  // AskUserQuestion is the exception: even in skip mode the CLI raises a
  // can_use_tool request for it, and WITHOUT this flag the prompt has nowhere to
  // surface, so the CLI auto-dismisses it within seconds and the model continues
  // as if the user ignored the question ("the prompt was dismissed"). With the
  // flag attached, the question is delivered over the control channel and stays
  // answerable — while every other tool still bypasses, as Dangerous mode intends.
  args.push('--permission-prompt-tool', 'stdio')
  if (options.model) args.push('--model', options.model)
  if (options.effort) args.push('--effort', options.effort)
  if (resumeId) args.push('--resume', resumeId)
  const systemPrompt = getSystemPrompt()
  if (systemPrompt) args.push('--append-system-prompt', systemPrompt)

  // Wire the in-app MCP control server: a per-session config whose HTTP url
  // carries this session's key as a token (/mcp/<key>), so a tool call knows its
  // caller. Auto-permit the floe tools — the wildcard covers all mcp__floe__*
  // without raising a permission prompt. These two argv entries are also what
  // the managed hooks' ps-ancestry walk detects (hooks.ts DETECT_FLOE).
  //
  // A query is the exception, and it takes both halves to be real (D8). Its key
  // is not a session id, so the token it would carry resolves to nothing; and
  // merely leaving the token out would let the CLI inherit the Floe server
  // registered globally and come back as `/mcp/global` — the same tools under
  // the wrong identity. So: an empty config, `--strict-mcp-config` to ignore
  // the global and project ones, and no `--allowedTools`.
  //
  // Consequence, deliberately taken: the managed hooks stop firing inside a
  // query, because DETECT_FLOE recognises a Floe process by exactly these two
  // argv entries. `plan` is the barrier that replaces them — which is why a
  // harness without `plan` cannot hold a query at all (queries.ts).
  if (isQueryKey(key)) {
    args.push('--mcp-config', emptyMcpConfigFor(key))
    args.push('--strict-mcp-config')
  } else {
    args.push('--mcp-config', mcpConfigFor(key, worktreePath))
    args.push('--allowedTools', 'mcp__floe')
  }

  const child = spawn('claude', args, { cwd: worktreePath, env: process.env })
  const conn: Conn = {
    child,
    win,
    buffer: '',
    optionsKey,
    sessionId: resumeId,
    stderr: '',
    pendingPerms: new Map(),
    subagents: new Set(),
    transcriptBuffer: [],
    lastAssistantText: '',
    pendingDeltas: [],
    flushTimer: null,
    turnActive: false,
    turnStartedAt: 0,
    lastActivityAt: Date.now(),
    lastLineType: '',
    lastLineSubtype: '',
    turnHadMeaningfulOutput: false,
    turnStartedOnFreshConn: false,
    heldForSubagentsAt: null,
    stuckLogged: false,
    turnClosed: false,
    worktreePath,
    taskWatcher: null,
    taskJsonlOffset: 0,
    taskJsonlBuffer: ''
  }
  conns.set(key, conn)
  log('spawn', { key, worktreePath, optionsKey, resume: Boolean(resumeId) })

  // Guard every async callback below against acting on a conn that's already been
  // replaced for this key. On an options change (or stopAgent) we kill the old
  // child and spawn a new conn under the same key; the dead child's late `close`
  // would otherwise `conns.delete(key)` the NEW conn and fire a spurious
  // done/resolveWaiters. Only the conn still registered under `key` may act.
  const isCurrent = (): boolean => conns.get(key) === conn

  // Terminal failure for a conn we can no longer talk to: deregister it (so the
  // next sendToAgent respawns instead of writing into a dead pipe) and close the
  // turn in the UI. Shared by the stdin-pipe and child-error paths.
  const fail = (event: string, logMessage: string, uiMessage: string): void => {
    if (!isCurrent()) return
    conns.delete(key)
    stopTaskWatcher(conn)
    conn.turnActive = false
    conn.turnClosed = true
    log(event, { key, message: logMessage })
    flushDeltas(win, key, conn)
    send(win, key, { kind: 'error', message: uiMessage })
    send(win, key, { kind: 'done', ok: false })
    resolveWaiters(key, conn.lastAssistantText)
  }

  // A broken stdin pipe (process gone between our check and the write) must not
  // take down the main process. This used to be swallowed entirely, which is how
  // a write to a zombie child left the turn "running" forever with no log line
  // and no UI signal (docs/bug-report-agent-spawn-hang.md) — the `close` event
  // that was supposed to clean up never came. Treat it as fatal for this conn.
  child.stdin.on('error', (e: Error) => fail('stdin-write-error', e.message, 'Claude stopped accepting input. Send your message again.'))
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    if (!isCurrent()) return
    const { lines, rest } = drainLines(conn.buffer, chunk)
    conn.buffer = rest
    for (const line of lines) handleLine(win, key, conn, line)
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (c: string) => {
    conn.stderr += c
  })
  // A dying process must only clean up if it's still the live conn for this key.
  // On Stop-then-drain we kill the old process and immediately spawn a new conn at
  // the same key; the old process's late close/error would otherwise delete that
  // new conn and fire a stale `done`, orphaning the queued turn ("nothing happens").
  child.on('error', (e) => {
    // ENOENT também é o que o spawn dá quando o `cwd` não existe — o caso real é
    // uma sessão de outra máquina roteada pra cá. Não culpe o CLI sem checar.
    const enoent = e.message.includes('ENOENT')
    const cwdGone = enoent && !existsSync(worktreePath)
    fail(
      'child-error',
      cwdGone ? `${e.message} (cwd missing: ${worktreePath})` : e.message,
      cwdGone
        ? `Worktree not found on this machine: ${worktreePath} — this session belongs to another backend.`
        : enoent
          ? 'claude CLI not found'
          : e.message
    )
  })
  child.on('close', (code) => {
    if (!isCurrent()) return
    conns.delete(key)
    stopTaskWatcher(conn)
    conn.turnActive = false
    conn.turnClosed = true
    log('child-close', { key, code, turnMs: conn.turnStartedAt ? Date.now() - conn.turnStartedAt : 0, subagents: conn.subagents.size })
    flushDeltas(win, key, conn)
    if (code && code !== 0 && conn.stderr.trim()) send(win, key, { kind: 'error', message: conn.stderr.trim() })
    send(win, key, { kind: 'done', ok: !code })
    resolveWaiters(key, conn.lastAssistantText)
  })

  return conn
}

// Build the message content: a plain string when there are no attachments, or
// an array of content blocks (image/document + text) the CLI understands.
// PDFs go as base64 `document` blocks; text files as `document` blocks with a
// decoded text source (the API's base64 document source only accepts PDFs).
function buildContent(prompt: string, images: ImageAttachment[], files: FileAttachment[]): unknown {
  if (!images.length && !files.length) return prompt
  const blocks: unknown[] = images.map((img) => ({
    type: 'image',
    source: { type: 'base64', media_type: img.mediaType, data: img.data }
  }))
  for (const f of files) {
    const source =
      f.kind === 'pdf'
        ? { type: 'base64', media_type: 'application/pdf', data: f.data }
        : { type: 'text', media_type: 'text/plain', data: Buffer.from(f.data, 'base64').toString('utf8') }
    blocks.push({ type: 'document', source, title: f.name })
  }
  if (prompt) blocks.push({ type: 'text', text: prompt })
  return blocks
}

// Send a user turn — (re)spawning the process if needed or if options changed.
/**
 * Kill the conns that are this same session under an older name.
 *
 * Two keys name one session — see anyActiveTurn. A live turn is never reaped:
 * the only way two keys are both active is a real steer in flight, and killing
 * that would abort the turn the user is watching.
 */
function reapSiblings(key: string): void {
  const claudeId = agentResumeId(key)
  for (const [k, c] of conns) {
    if (k === key) continue
    const same = c.sessionId === key || (!!claudeId && (k === claudeId || c.sessionId === claudeId))
    if (!same || c.turnActive) continue
    log('reap-alias', { key, stale: k })
    clearDeltas(c)
    c.child.kill('SIGTERM')
    conns.delete(k)
  }
}

export function sendToAgent(
  win: BrowserWindow,
  key: string,
  worktreePath: string,
  prompt: string,
  options: AgentRunOptions,
  images: ImageAttachment[] = [],
  files: FileAttachment[] = []
): void {
  const optionsKey = optionsKeyFor(options)
  // Under every name this session answers to, not just the one the panel holds.
  // The renderer switches its key from the Floe id to the claudeId the moment
  // the CLI reports it, mid-turn — so `conns.get(key)` alone missed the child
  // that was still working and spawned a SECOND claude for the same session.
  // The first one was then stranded: nothing writes to it, nothing reaps it
  // (reapSiblings spares an active turn), so its `turnActive` and its replay
  // stay true forever. That strand is the eternal "claude is typing", and —
  // because replaySnapshot then hands the panel that dead turn's `startedAt` —
  // it is also why reopening the chat dropped every message written since it.
  // Same aliasing answerQuestion/respondPermission already resolve through.
  const found = resolveConn(key)
  let connKey = found?.[0] ?? key
  let conn = found?.[1]
  // The process may have died while we were idle (machine slept, claude reaped)
  // before `close` fired. Writing to its stdin would break; drop it so we respawn
  // and --resume from the persisted session id instead.
  //
  // "While we were idle" was the assumption, and it is not always true: the
  // child can die MID-TURN, and then nothing ever ends that turn. Its late
  // `close` is dropped by isCurrent once this key is deleted, the watchdog only
  // walks `conns` so it never sees a replay again — and the replay left
  // `running` under this name is the eternal "is typing", with a `startedAt`
  // that reopening the chat then cuts the transcript at. This is the last
  // moment anything holds both the dead conn and the name it ran under, so the
  // turn is closed here rather than left for a sweep to find hours later.
  if (conn && isChildDead(conn.child)) {
    stopTaskWatcher(conn)
    conn.turnActive = false
    conn.turnClosed = true
    // Whatever it streamed before it died is still what it said — flushed
    // first, like every other ending, so it lands above the `done` and not
    // into the conn that replaces it.
    flushDeltas(win, connKey, conn)
    // Silent otherwise: the user is sending their next message right now, and
    // the respawn below --resumes the session. The `done` is the correction.
    closeStrandedReplay(connKey, win, 'dead-child', conn.lastAssistantText)
    conns.delete(connKey)
    connKey = key
    conn = undefined
  }
  // A send while a turn is in flight is a steer: the message goes into the live
  // CLI loop (the SDK queues it and folds it into the same turn). No turn-state
  // reset — the running turn continues, and its replay buffer stays intact.
  // Option changes are ignored here: honouring them means killing the child,
  // which would abort the very turn being steered.
  if (conn && conn.turnActive) {
    conn.lastActivityAt = Date.now()
    log('turn-steer', { key, connKey, promptLen: prompt.length, images: images.length, files: files.length })
    pushTranscript(conn, `user: ${prompt}`)
    // Into the replay, not onto the wire: the panel that typed it is already
    // showing it, and every other viewer of this session gets it when the CLI
    // absorbs it into the JSONL. That write only happens at the end of the tool
    // call in flight, so until then the replay is the only place a panel
    // mounting mid-turn can read what was said.
    const replay = replays.get(connKey)
    if (replay?.running) replay.events.push({ kind: 'steer', text: options.shown ?? prompt, at: Date.now() })
    write(conn, { type: 'user', message: { role: 'user', content: buildContent(prompt, images, files) } })
    return
  }
  if (conn && conn.optionsKey !== optionsKey) {
    clearDeltas(conn) // a late flush from the dead conn must not leak into the new one
    conn.child.kill('SIGTERM')
    conns.delete(connKey)
    // Whatever name that child ran under, it is gone: the replacement is filed
    // under the name the panel holds NOW, and the old replay must not outlive
    // its process claiming a turn is still in flight.
    replays.delete(connKey)
    connKey = key
    conn = undefined
  }
  const freshSpawn = !conn
  // Spawning under a name this session has not used before: retire the child it
  // ran under the old one. The renderer switches from the Floe id to the
  // claudeId the moment the CLI reports it, and without this the first child is
  // left alive forever — a second `claude` per session, and two conns whose
  // `turnActive` disagree about the one session they both claim to be.
  if (!conn) reapSiblings(key)
  if (!conn) conn = spawnConn(win, key, worktreePath, options)
  // A new user turn starts: clear the accumulator so send_message(wait) returns
  // only this turn's reply, and record the prompt in the live transcript buffer.
  conn.lastAssistantText = ''
  lastErrors.delete(key) // a new turn supersedes the previous failure
  // Marked under the name the CONN answers to, which is the name its events —
  // and its `done` — will arrive under (spawnConn captured it). Marked under
  // the panel's name instead, a turn steered into an aliased conn would open a
  // replay nothing ever closes. replaySnapshot resolves the alias for readers.
  markTurnStart(connKey, { provider: 'claude', effort: options.effort, mode: options.permissionMode }, win)
  conn.turnActive = true
  conn.turnClosed = false
  conn.turnStartedAt = Date.now()
  conn.lastActivityAt = Date.now()
  // Watchdog startup-wedge state: this turn has produced no real output yet, and
  // whether it began on a fresh spawn (the only shape the watchdog force-recovers).
  conn.turnHadMeaningfulOutput = false
  conn.turnStartedOnFreshConn = freshSpawn
  conn.heldForSubagentsAt = null
  conn.stuckLogged = false
  log('turn-start', { key, connKey, promptLen: prompt.length, images: images.length, files: files.length })
  pushTranscript(conn, `user: ${prompt}`)
  // Everything this session said to another harness since Claude's last turn.
  // Usually '' — a session that has only ever been Claude's is resumed from its
  // own JSONL and needs nothing. Sent as part of the prompt (the CLI takes one
  // user message per turn), which is why the packet is marked: it lands in
  // Claude's transcript, and every read strips it back out.
  const seed = seedFor(win, key, worktreePath, 'claude')
  write(conn, {
    type: 'user',
    message: { role: 'user', content: buildContent(seed + prompt, images, files) }
  })
}

/**
 * The live conn behind ANY of a session's names.
 *
 * A conn stays filed under whatever key spawned it, while the renderer keys a
 * panel by `claudeId ?? id` — so the key an answer arrives with is not always
 * the key the question went out under. `conns.get(key)` alone then missed, and
 * the miss was silent: the card vanished from the panel while the CLI stayed
 * blocked on a control_request nobody would ever resolve, pinning the row's `?`
 * for the rest of the session.
 */
function resolveConn(key: string): [string, Conn] | undefined {
  const direct = conns.get(key)
  if (direct) return [key, direct]
  for (const k of agentIdentityNames(key)) {
    const conn = conns.get(k)
    if (conn) return [k, conn]
  }
  // Last resort: the CLI's own id for a conn the store has not linked yet.
  for (const [k, c] of conns) if (c.sessionId === key) return [k, c]
  return undefined
}

/**
 * A settled prompt leaves the replay too.
 *
 * The snapshot is what a panel opening mid-turn is shown, and it only ever
 * grows — so a question already answered came back as an open card on the next
 * open, asking again for something the model has long since read.
 */
export function pruneSettled(events: AgentEvent[], requestId: string): AgentEvent[] {
  return events.filter(
    (e) =>
      !(
        (e.kind === 'question' && e.toolUseId === requestId) ||
        (e.kind === 'permission' && e.permission.requestId === requestId)
      )
  )
}

/**
 * Prune a settled prompt from the replay of every name this session answers to.
 *
 * One key is not enough: a conn stays filed under whatever name spawned it,
 * while the panel keys itself by `claudeId ?? id` — so the key the ANSWER
 * arrives under and the key the QUESTION was recorded under are not always the
 * same one (the same aliasing `resolveConn` exists for). Pruning only the
 * resolved conn key left the card sitting in the other replay, and the panel
 * read it back as an open question the next time it mounted.
 */
export function dropSettled(key: string, requestId: string): void {
  for (const k of new Set([key, ...aliasKeys(key)])) {
    const replay = replays.get(k)
    if (replay) replay.events = pruneSettled(replay.events, requestId)
  }
}

/** Every other name this conversation is known by — session or query. */
function aliasKeys(key: string): string[] {
  return agentIdentityNames(key)
}

/**
 * Every key blocked on the user right now — an unanswered question or tool
 * permission. `pendingPerms` is the one authority: it is written when the CLI
 * raises the control_request and cleared when we resolve it, so a renderer that
 * missed either edge (a mis-keyed event, a reload, a panel that was never open)
 * can correct itself against this instead of holding a `?` forever.
 */
export function waitingKeys(): string[] {
  return [...conns].filter(([, c]) => c.pendingPerms.size > 0).map(([k]) => k)
}

// Answer a tool-permission prompt over the control channel. `allow` runs the
// tool (with its original input); otherwise it's refused with a short reason.
export function respondPermission(key: string, requestId: string, allow: boolean): void {
  const found = resolveConn(key)
  if (!found) return log('permission-no-conn', { key, requestId })
  const [connKey, conn] = found
  // Echo back the original tool input the CLI handed us when it asked.
  const toolInput = conn.pendingPerms.get(requestId) ?? {}
  conn.pendingPerms.delete(requestId)
  dropSettled(key, requestId)
  dropSettled(connKey, requestId)
  const response = allow
    ? { behavior: 'allow', updatedInput: toolInput }
    : { behavior: 'deny', message: 'The user declined this action.' }
  write(conn, { type: 'control_response', response: { subtype: 'success', request_id: requestId, response } })
}

// What a spawned session hears instead of the user: it was opened by another
// agent, so nobody is watching it. It decides for itself and, when a decision is
// genuinely blocking, hands it up to the parent — which is the one session that
// may interrupt the user.
const CHILD_ANSWERS_ITSELF =
  'No user can see this question: this session was opened by another agent, and only that parent session talks to the user. ' +
  'Do not ask again — decide it yourself from the task you were given, the codebase and its conventions, pick the most sensible option, ' +
  'and state the assumption you made in your reply. If the decision is genuinely blocking and you cannot settle it, stop and end your turn ' +
  'with the open question plus your recommended option, so the parent agent can decide or take it to the user.'

// Answer an AskUserQuestion prompt. The CLI is blocked on the tool's can_use_tool
// control request, so we resolve that request: deny the tool with the user's
// selections as the message. The CLI feeds that back as the tool result and the
// model reads it as the answer, continuing the same turn (no auto-dismiss).
export function answerQuestion(key: string, requestId: string, answer: string): void {
  const found = resolveConn(key)
  if (!found) return log('answer-no-conn', { key, requestId })
  const [connKey, conn] = found
  conn.pendingPerms.delete(requestId)
  dropSettled(key, requestId)
  dropSettled(connKey, requestId)
  log('question-answered', { key, connKey, requestId })
  write(conn, {
    type: 'control_response',
    response: { subtype: 'success', request_id: requestId, response: { behavior: 'deny', message: answer } }
  })
}

/**
 * What a session is parked on, for a caller that is not the window: one entry
 * per unanswered control request, tagged with which of the two it is.
 *
 * The map holds the CLI's own tool input, so the kind is read back off the
 * shape rather than stored twice — a payload `parseQuestions` recognises is an
 * AskUserQuestion, anything else is a tool asking for permission.
 */
export interface PendingPrompt {
  requestId: string
  kind: 'question' | 'permission'
  questions?: AgentQuestion[]
}

export function pendingPrompts(key: string): PendingPrompt[] {
  const found = resolveConn(key)
  if (!found) return []
  return [...found[1].pendingPerms].map(([requestId, input]) => {
    const questions = parseQuestions(input)
    return questions.length
      ? { requestId, kind: 'question' as const, questions }
      : { requestId, kind: 'permission' as const }
  })
}

export function stopAgent(win: BrowserWindow, key: string): void {
  // Before the early return, and before the conn is looked at: stop means stop,
  // and a relay armed on this chat would otherwise answer the turn you just
  // cancelled. It is also the only stop a one-shot runtime gets — those keep no
  // conn, so everything below this line is skipped for them.
  cancelRelay(key)
  // Through every name this session answers to, not just the one the caller
  // holds. The renderer keys a panel by `claudeId ?? id` and the conn stays
  // filed under whatever name spawned it, so `conns.get(key)` alone missed the
  // live child whenever the CLI reported its id after the turn had started —
  // Stop then reset the panel and killed nothing, and the turn it was meant to
  // cancel kept streaming. Same aliasing send/answerQuestion resolve through.
  const found = resolveConn(key)
  if (!found) return
  const [connKey, conn] = found
  if (connKey !== key) cancelRelay(connKey)
  // Deregister first so the child's late `close` (guarded by isCurrent) is a
  // no-op, then release any send_message(wait) caller with the text so far —
  // otherwise it blocks until the 120s timeout — and kill. Emit the one
  // authoritative `done` ourselves (the guarded close won't): this is the single
  // reset every stop caller relies on — the composer Stop AND worktree merge/
  // remove, which stop turns without touching renderer state — so their sessions
  // don't stay stuck "running" with orphaned subagent rows.
  conns.delete(connKey)
  stopTaskWatcher(conn)
  conn.turnActive = false
  conn.turnClosed = true
  log('stop', {
    key,
    connKey,
    turnMs: conn.turnStartedAt ? Date.now() - conn.turnStartedAt : 0,
    subagents: conn.subagents.size
  })
  flushDeltas(win, connKey, conn) // surface whatever text had streamed before the stop
  resolveWaiters(connKey, conn.lastAssistantText)
  if (connKey !== key) resolveWaiters(key, conn.lastAssistantText)
  // A wedged child may ignore SIGTERM. We already deregistered, so a survivor is
  // an invisible orphan — log it (escalate to SIGKILL later only if the log shows
  // this actually happens; ponytail: observability now, escalation when proven).
  const child = conn.child
  const killTimer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null)
      log('stop-sigterm-timeout', { key, pid: child.pid })
  }, 5_000)
  killTimer.unref?.()
  child.once('close', () => clearTimeout(killTimer))
  child.kill('SIGTERM')
  // Under the name the turn RAN under — that is the replay the panel reads and
  // the strand its "is typing" hangs on. A panel listens for every name of its
  // session, so the one `done` reaches whichever of the two it was opened with.
  send(win, connKey, { kind: 'done', ok: true })
}

// PIDs of every live Claude session process, for the topbar memory readout.
// Each `claude` spawns its own subtree (MCP servers, ripgrep…); systemStats sums
// the descendants too.
export function getSessionPids(): number[] {
  return [...conns.values()].map((c) => c.child.pid).filter((p): p is number => typeof p === 'number')
}

// Whether a Claude session id has a live child process right now — lets the
// rail's activity scan tell a real pending question (process still running,
// however long it's been silent) from an orphaned one (process killed/crashed
// before it could write the answering tool_result, stranding the question at
// the transcript's tail forever).
export function isClaudeIdConnected(claudeId: string): boolean {
  return [...conns.values()].some((c) => c.sessionId === claudeId)
}

// Whether a Floe session key has a turn in flight right now. Lets a freshly
// (re)attached renderer re-hydrate `running` from the server instead of assuming
// idle — otherwise it wouldn't queue a type-while-busy message and the send would
// kill the live turn (options-change respawn) it can't see.
export function hasActiveTurn(key: string): boolean {
  return conns.get(key)?.turnActive ?? false
}

/**
 * Whether ANY of a session's names has a turn in flight.
 *
 * One session answers to two keys: the renderer keys a brand-new session by its
 * Floe id and every send after the CLI reports its own id by that claudeId, so
 * the conn is filed under whichever name was current when it spawned. A caller
 * holding only one of the two (the session list holds the Floe id) would read
 * `false` straight through a running turn, and the row's spinner would then be
 * decided by the renderer's live event set alone — with nothing to correct it if
 * a `done` is ever missed.
 */
export function anyActiveTurn(keys: (string | undefined)[]): boolean {
  return keys.some((k) => !!k && hasActiveTurn(k))
}

/**
 * Every key with a turn in flight, for the renderer to reconcile against.
 *
 * Both halves matter. `conns` is Claude's, and only Claude's — codex, opencode
 * and the local agents keep no conn here, so a list built from it alone reads
 * every one of their turns as idle. `markTurnStart` is what they ALL call, and
 * `done` is what clears it (see recordForReplay), which makes the replay the
 * one mark every runtime leaves.
 */
export function activeTurnKeys(): string[] {
  const keys = new Set([...conns].filter(([, c]) => c.turnActive).map(([k]) => k))
  for (const [k, r] of replays) if (r.running) keys.add(k)
  return [...keys]
}

// Everything Fleet needs about one session's live process, in a single read: the
// conns map is private, and a getter per field would be three exports and three
// lookups. `live:false` = no conn (never prompted, or reaped) — the caller still
// gets `error`, which deliberately outlives the conn (see send()).
export interface SessionRuntime {
  live: boolean
  running: boolean
  waiting: boolean // blocked on a tool permission or an AskUserQuestion
  since: number // turn start, 0 when idle
  lastLine: string
  error?: { at: number; message: string }
}

export function sessionRuntime(key: string): SessionRuntime {
  const conn = conns.get(key)
  const error = lastErrors.get(key)
  if (!conn) return { live: false, running: false, waiting: false, since: 0, lastLine: '', error }
  return {
    live: true,
    running: conn.turnActive,
    waiting: conn.pendingPerms.size > 0,
    since: conn.turnActive ? conn.turnStartedAt : 0,
    lastLine: conn.transcriptBuffer[conn.transcriptBuffer.length - 1] ?? '',
    error
  }
}

// Watchdog: periodically scan live conns for a turn that's been "running" (no
// `done` emitted) yet has gone quiet — the on-disk symptom behind a session
// stuck showing "Thinking… (40m)". Two shapes, both logged once per turn so the
// log points straight at the cause:
//   • held-for-subagents: a `result` arrived but `done` was withheld pending an
//     async subagent that never reported back (the known risk at handleLine's
//     result branch). Definite bug — the CLI is done, we're just waiting forever.
//   • silent: turn active, no stdout for a long while, no result held — either a
//     legitimately long tool (Bash) or a genuinely hung CLI. Softer signal;
//     `childAlive` + `lastLineType` in the log tell which.
const WATCHDOG_MS = 30_000
const HELD_STUCK_MS = 60_000
const SILENT_STUCK_MS = 180_000
// A turn held for an async subagent that has gone this long without a single
// stdout line is treated as orphaned: the completion notification is never
// coming, so force the turn closed instead of spinning "Cooking…" forever (the
// 1024-minute bug). A live async agent streams its inline activity, keeping
// lastActivityAt fresh, so it never trips this — only genuine silence does.
const HELD_RECOVER_MS = 600_000
// A freshly (re)spawned CLI that produces NO meaningful output (no assistant
// token, tool_use, tool_result, control_request or result — only `system` lines
// like init/status/api_retry) within this window is wedged at startup: an
// MCP/first-token stall the child never escapes. Kill+idle so the next prompt
// respawns, exactly like the user's manual stop→retry. Empirically the recurring
// 3–20min "Pondering…" freezes (agent.log, 2026-07-21) are all this shape.
// This is a HARD ceiling measured from turn start, NOT a silence timer —
// `system/status/requesting` (emitted before each API request under
// --include-partial-messages) bumps lastActivityAt, so a silence timer would
// never fire; and those system lines are deliberately excluded from "meaningful"
// so a legit slow API call AFTER real tool work is never mistaken for a wedge.
const SILENT_RECOVER_MS = 300_000
// A turn that DID produce real output (so the startup-wedge check above never
// fires) but then goes fully silent for this long is the same "hung forever"
// bug in a different shape: a mid-turn stall, or a --resume'd persistent
// child that wedges. Previously this was only ever logged (log-stuck-silent),
// never recovered — stranding the session exactly like the 67-minute
// "Pondering…" case seen live in agent.log (2026-07-28, key bc4063b5,
// turnMs:4045077) that only ended when the user manually hit Stop. No real
// Bash tool call in this app plausibly runs this silent, so recover instead.
const SILENT_RECOVER_MS_STALLED = 1_200_000
// A replay left `running` with no live turn behind it is a strand the watchdog
// above cannot see: it walks `conns`, and this is precisely the state where
// there is no conn to walk. Before the sweep below, such a turn stayed "is
// typing" until the app was restarted — activeTurnKeys kept reporting it, so
// the renderer's own correction believed it, and replaySnapshot handed the dead
// turn's `startedAt` back on every reopen. That is the 40-hour clock.
//
// Claude holds a conn for as long as it works, so its replay without one is
// stranded the moment the grace window passes — the window only covers the
// respawn a send performs. The one-shot runtimes (codex, opencode…) keep no
// conn by design, so nothing about them can be concluded from its absence and
// only a hard ceiling can judge them.
const CLAUDE_STRAND_MS = 60_000
const RUNTIME_STRAND_MS = 3_600_000
let watchdog: NodeJS.Timeout | null = null

// What the watchdog should do with a single turn this tick — a pure function so
// the recover/log decision is testable without a live process. `recover` closes
// an orphaned held turn; the `log-*` actions shout once per stuck turn.
export type WatchdogAction = 'recover' | 'recover-silent' | 'log-stuck-subagents' | 'log-stuck-silent' | 'none'

export function watchdogAction(conn: Conn, now: number, childAlive: boolean): WatchdogAction {
  if (!conn.turnActive) return 'none'
  if (conn.heldForSubagentsAt != null) {
    // The CLI already produced the turn's result and is only waiting on an async
    // subagent's completion. If the child is gone, or nothing has streamed for
    // HELD_RECOVER_MS, that notification is lost — recover so the session idles.
    // ponytail: silence ceiling, not a hard turn cap — raise HELD_RECOVER_MS if a
    // legit detached agent can run silent (zero inline output) longer than this.
    if (!childAlive || now - conn.lastActivityAt > HELD_RECOVER_MS) return 'recover'
    if (now - conn.heldForSubagentsAt > HELD_STUCK_MS && !conn.stuckLogged) return 'log-stuck-subagents'
    return 'none'
  }
  // Wedged at startup: a fresh spawn that produced no meaningful output for
  // SILENT_RECOVER_MS (measured from turn start, not last activity) is hung at
  // init — recover, don't just log.
  if (
    conn.turnStartedOnFreshConn &&
    !conn.turnHadMeaningfulOutput &&
    conn.pendingPerms.size === 0 && // a pending permission/question is a real pause, not a hang
    now - conn.turnStartedAt > SILENT_RECOVER_MS
  )
    return 'recover-silent'
  // Mid-turn stall: talked earlier, now silent way past any legit tool call.
  if (conn.pendingPerms.size === 0 && now - conn.lastActivityAt > SILENT_RECOVER_MS_STALLED) return 'recover-silent'
  if (
    !conn.stuckLogged &&
    conn.pendingPerms.size === 0 && // a pending permission/question is a real pause, not a hang
    now - conn.lastActivityAt > SILENT_STUCK_MS
  )
    return 'log-stuck-silent'
  return 'none'
}

// One watchdog pass over the live conns. Each key is isolated in its own
// try/catch: a single bad entry (a destroyed `win`, a conn left half-torn-down)
// used to throw out of the whole `for` and silently skip every OTHER session's
// recovery — every tick, forever, with nothing in the log. That's how two
// sessions sat stuck for 2h20m without the watchdog ever firing
// (docs/bug-report-agent-spawn-hang.md). Exported so the isolation is testable.
export function runWatchdogTick(entries: Iterable<[string, Conn]>, now: number): void {
  for (const [key, conn] of entries) {
    try {
      const childAlive = !isChildDead(conn.child)
      const action = watchdogAction(conn, now, childAlive)
      if (action === 'recover') {
        log('recover-stuck-subagents', {
          key,
          heldMs: conn.heldForSubagentsAt ? now - conn.heldForSubagentsAt : 0,
          silentMs: now - conn.lastActivityAt,
          turnMs: now - conn.turnStartedAt,
          subagents: conn.subagents.size,
          ids: [...conn.subagents],
          childAlive
        })
        // Clear the orphaned subagent rows and close the turn exactly like a normal
        // `done` — the session flips to idle. If the lost notification ever does
        // arrive, the CLI resumes the turn and its result closes cleanly (the
        // now-unknown id just logs `subagent-notify-unmatched`, harmless).
        for (const id of conn.subagents) send(conn.win, key, { kind: 'subagent-done', toolUseId: id })
        conn.subagents.clear()
        conn.turnActive = false
        conn.turnClosed = true
        conn.heldForSubagentsAt = null
        conn.stuckLogged = true
        send(conn.win, key, { kind: 'done', ok: true })
        resolveWaiters(key, conn.lastAssistantText)
      } else if (action === 'log-stuck-subagents') {
        conn.stuckLogged = true
        log('stuck-subagents', {
          key,
          heldMs: now - (conn.heldForSubagentsAt ?? now),
          turnMs: now - conn.turnStartedAt,
          subagents: conn.subagents.size,
          ids: [...conn.subagents],
          childAlive
        })
      } else if (action === 'recover-silent') {
        // CLI wedged — either at startup (no meaningful output ever) or mid-turn
        // (talked, then went silent way past any legit tool call). Surface it as
        // an error so the turn doesn't look like a silent empty success, then
        // tear down exactly like a manual stop (kill child, emit `done`, release
        // waiters) so the session idles and the next prompt respawns fresh with
        // --resume.
        log('recover-stuck-silent', {
          key,
          turnMs: now - conn.turnStartedAt,
          silentMs: now - conn.lastActivityAt,
          lastLineType: conn.lastLineType,
          lastLineSubtype: conn.lastLineSubtype,
          childAlive
        })
        send(conn.win, key, {
          kind: 'error',
          message: 'Claude stopped responding. The session was restarted — send your message again.'
        })
        stopAgent(conn.win, key)
      } else if (action === 'log-stuck-silent') {
        conn.stuckLogged = true
        log('stuck-silent', {
          key,
          silentMs: now - conn.lastActivityAt,
          turnMs: now - conn.turnStartedAt,
          lastLineType: conn.lastLineType,
          lastLineSubtype: conn.lastLineSubtype,
          childAlive
        })
      }
    } catch (e) {
      log('watchdog-error', { key, message: e instanceof Error ? e.message : String(e) })
    }
  }
}

/**
 * The replay keys whose turn is over in every way but the flag.
 *
 * Pure, and exported for its unit test, for the same reason `watchdogAction`
 * is: the maps it reads have no seam a test can reach, and the whole bug is one
 * branch of the decision. `hasLiveTurn` is asked rather than `conns` read
 * directly — a conn that exists but is idle is exactly as stranded as no conn
 * at all, and activeTurnKeys reports both.
 */
export function strandedReplayKeys(
  entries: Iterable<[string, { running: boolean; startedAt?: number; choice?: { provider?: string } }]>,
  hasLiveTurn: (key: string) => boolean,
  now: number
): string[] {
  const stranded: string[] = []
  for (const [key, replay] of entries) {
    if (!replay.running || hasLiveTurn(key)) continue
    const provider = replay.choice?.provider ?? 'claude'
    const ceiling = provider === 'claude' ? CLAUDE_STRAND_MS : RUNTIME_STRAND_MS
    if (now - (replay.startedAt ?? now) > ceiling) stranded.push(key)
  }
  return stranded
}

// One sweep over the replays. Isolated per key like runWatchdogTick's loop: a
// single destroyed window must not stop every other strand from being closed.
export function runReplaySweep(now: number): void {
  for (const key of strandedReplayKeys(replays, (k) => conns.get(k)?.turnActive === true, now)) {
    try {
      closeStrandedReplay(
        key,
        replayWins.get(key),
        'watchdog',
        '',
        // Said, unlike the dead-child path: there the user is already sending
        // their next message, here they are watching a spinner that has been
        // lying to them and nothing else will ever explain it.
        'That turn never reported back — the session was released. Send your message again.'
      )
    } catch (e) {
      log('watchdog-error', { key, message: e instanceof Error ? e.message : String(e) })
    }
  }
}

export function startAgentWatchdog(): void {
  if (watchdog) return
  watchdog = setInterval(() => {
    const now = Date.now()
    runWatchdogTick(conns, now)
    runReplaySweep(now)
  }, WATCHDOG_MS)
  watchdog.unref?.() // never keep the app alive just for the watchdog
}

// Append a stdout chunk to `buffer` and split off every complete (newline-
// terminated) line, trimmed with empties dropped. Returns those lines plus the
// leftover partial line to carry into the next chunk — so a JSON message split
// across two `data` events is never parsed half-formed.
export function drainLines(buffer: string, chunk: string): { lines: string[]; rest: string } {
  buffer += chunk
  const lines: string[] = []
  let nl: number
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl).trim()
    buffer = buffer.slice(nl + 1)
    if (line) lines.push(line)
  }
  return { lines, rest: buffer }
}

// The turn is alive as long as the CLI keeps talking. The watchdog reads these
// to tell a genuinely-stuck turn from one that's still streaming.
function noteLineActivity(conn: Conn, msg: Record<string, unknown>, type: string | undefined): void {
  conn.lastActivityAt = Date.now()
  if (type === undefined) return
  conn.lastLineType = type
  conn.lastLineSubtype = typeof msg.subtype === 'string' ? msg.subtype : ''
  // Any non-`system` line proves real turn progress (assistant token, tool_use,
  // tool_result, control_request, result). A turn wedged at startup emits only
  // `system` lines (init/status/api_retry) — see SILENT_RECOVER_MS.
  if (type !== 'system') conn.turnHadMeaningfulOutput = true
}

// A subagent's internal activity is streamed inline on the same stdout, tagged
// with the parent Task's tool-use id. Route it to that subagent's nested row
// (live tokens + current tool) — it must not land in the parent's transcript or
// inflate the parent's token gauge. Answers whether the line is consumed here:
// the Task's own tool_result (which ends the subagent) arrives WITHOUT the tag,
// and a control_request must reach the handler below or the CLI blocks forever.
// ponytail: known limitation — a subagent that itself launches a Task is invisible
// after the first hint (the inner parent_tool_use_id never enters conn.subagents,
// so it just routes away here). Harmless: it pollutes neither transcript nor gauge.
// Only build a childId→rootTopLevelId alias if nested Tasks become common.
function routeSubagentLine(
  win: BrowserWindow,
  key: string,
  msg: Record<string, unknown>,
  type: string | undefined,
  parentToolUseId: string
): boolean {
  if (type === 'assistant' && msg.message && typeof msg.message === 'object') {
    const inner = msg.message as { usage?: unknown; content?: unknown }
    const tokens = contextTokens(inner.usage)
    let tool: string | undefined
    if (Array.isArray(inner.content)) {
      for (const block of inner.content as Array<Record<string, unknown>>) {
        if (block.type === 'tool_use' && typeof block.name === 'string') tool = block.name
      }
    }
    send(win, key, { kind: 'subagent-progress', toolUseId: parentToolUseId, tokens, tool })
  }
  // A control_request (tool permission / AskUserQuestion) tagged to a subagent
  // must still reach the handler: the CLI blocks on it, so swallowing it here
  // would hang the whole session with nothing surfaced to answer.
  return type !== 'control_request'
}

// AskUserQuestion arrives as a control_request too: the CLI blocks on it, so the
// session genuinely pauses. Answers whether the question was dealt with here —
// `false` falls through to the ordinary permission card, which is what a
// malformed/empty question list deserves.
function handleAskUserQuestion(
  win: BrowserWindow,
  key: string,
  conn: Conn,
  req: Record<string, unknown>,
  requestId: string
): boolean {
  // A session an agent opened has no human in front of it: only the parent
  // talks to the user. Answer the child's question here (same deny+message
  // channel the user's answer uses) so it decides for itself and escalates
  // through its parent — never a question card the user has to clear.
  if (getCreatedSession(key)?.spawnedBy) {
    log('child-question-answered', { key, requestId })
    write(conn, {
      type: 'control_response',
      response: { subtype: 'success', request_id: requestId, response: { behavior: 'deny', message: CHILD_ANSWERS_ITSELF } }
    })
    return true
  }
  const questions = parseQuestions(req.input)
  if (!questions.length) return false
  conn.pendingPerms.set(requestId, req.input)
  log('question-asked', { key, requestId })
  send(win, key, { kind: 'question', toolUseId: requestId, questions })
  return true
}

// What the permission card says the tool is about to do. The CLI's own
// description wins; an empty summary is `undefined`, not a blank line.
function permissionSummary(req: Record<string, unknown>): string | undefined {
  if (typeof req.description === 'string' && req.description) return req.description
  return summarizeTool({ input: req.input }) || undefined
}

// The CLI asks for tool permission over the control channel (we opted in with
// `--permission-prompt-tool stdio`). Remember the input so we can echo it back
// on allow, then surface an approve/deny prompt in the transcript.
function handleControlRequest(win: BrowserWindow, key: string, conn: Conn, msg: Record<string, unknown>): void {
  if (!msg.request || typeof msg.request !== 'object') return
  const req = msg.request as Record<string, unknown>
  const requestId = String(msg.request_id ?? '')
  if (req.subtype !== 'can_use_tool' || !requestId) return
  if (req.tool_name === 'AskUserQuestion' && handleAskUserQuestion(win, key, conn, req, requestId)) return
  conn.pendingPerms.set(requestId, req.input)
  send(win, key, {
    kind: 'permission',
    permission: { requestId, toolName: String(req.tool_name ?? 'tool'), summary: permissionSummary(req) }
  })
}

function handleSystemLine(win: BrowserWindow, key: string, msg: Record<string, unknown>): void {
  if (msg.subtype !== 'init' || typeof msg.session_id !== 'string') return
  send(win, key, {
    kind: 'session',
    sessionId: msg.session_id,
    model: typeof msg.model === 'string' ? msg.model : undefined
  })
}

function handleStreamEvent(win: BrowserWindow, key: string, conn: Conn, msg: Record<string, unknown>): void {
  if (!msg.event || typeof msg.event !== 'object') return
  const ev = msg.event as {
    type?: string
    delta?: { type?: string; text?: string; thinking?: string }
  }
  if (ev.type !== 'content_block_delta') return
  if (ev.delta?.type === 'text_delta') queueDelta(win, key, conn, 'text', ev.delta.text ?? '')
  else if (ev.delta?.type === 'thinking_delta') queueDelta(win, key, conn, 'reasoning', ev.delta.thinking ?? '')
}

// Accumulate the assistant's text for this turn (used by send_message(wait)) and
// mirror it into the live buffer (used by read_session_output). Answers whether
// the block was text, so the caller can stop looking at it.
function appendAssistantText(conn: Conn, block: Record<string, unknown>): boolean {
  if (block.type !== 'text' || typeof block.text !== 'string' || !block.text.trim()) return false
  conn.lastAssistantText += (conn.lastAssistantText ? '\n' : '') + block.text
  pushTranscript(conn, `assistant: ${block.text.trim()}`)
  return true
}

// The Task tool (named "Agent" on the wire) launches a subagent. Track its id so
// we can match the inline progress + the closing tool_result, and surface a live
// nested row — see routeSubagentLine.
function startSubagent(win: BrowserWindow, key: string, conn: Conn, block: Record<string, unknown>, id: string): void {
  const input = (block.input ?? {}) as Record<string, unknown>
  conn.subagents.add(id)
  // An async (background) agent's completion never reaches our stdout — watch
  // the CLI transcript so its finish clears this row (see ensureTaskWatcher).
  ensureTaskWatcher(win, key, conn)
  log('subagent-start', { key, id, outstanding: conn.subagents.size })
  send(win, key, {
    kind: 'subagent-start',
    toolUseId: id,
    agentType: typeof input.subagent_type === 'string' ? input.subagent_type : 'agent',
    description: typeof input.description === 'string' ? input.description : '',
    harness: 'claude'
  })
}

// The present_decision tool renders as an inline decision panel, not a tool
// card. Emit the artifact (after flushing any streamed text so it lands in
// order). Answers `false` on a malformed spec so the caller falls through to the
// plain tool card and nothing silently disappears.
function emitDecisionArtifact(win: BrowserWindow, key: string, conn: Conn, block: Record<string, unknown>): boolean {
  // The tool's input carries title/groups/items only — the discriminant is
  // implied by the tool name, so inject it before validating.
  const spec = parseArtifactSpec({ type: 'decision', ...(block.input as Record<string, unknown>) })
  if (!spec) return false
  flushDeltas(win, key, conn)
  send(win, key, { kind: 'artifact', spec })
  return true
}

function handleAssistantBlock(win: BrowserWindow, key: string, conn: Conn, block: Record<string, unknown>): void {
  if (appendAssistantText(conn, block)) return
  if (block.type !== 'tool_use') return
  if (block.name === 'mcp__floe__present_decision' && emitDecisionArtifact(win, key, conn, block)) return
  // The question is delivered (and paused on) via the can_use_tool control
  // request in every mode now — even skip, where the prompt tool stays
  // attached so AskUserQuestion remains answerable — so skip it here to
  // avoid rendering a duplicate, non-interactive tool card.
  if (block.name === 'AskUserQuestion') return
  if ((block.name === 'Task' || block.name === 'Agent') && typeof block.id === 'string')
    return startSubagent(win, key, conn, block, block.id)
  const toolName = String(block.name ?? 'tool')
  const toolSummary = summarizeTool(block)
  pushTranscript(conn, `[tool ${toolName}]${toolSummary ? ` ${toolSummary}` : ''}`)
  send(win, key, { kind: 'tool', name: toolName, summary: toolSummary })
}

function handleAssistantLine(win: BrowserWindow, key: string, conn: Conn, msg: Record<string, unknown>): void {
  if (!msg.message || typeof msg.message !== 'object') return
  // Real context usage lives on each assistant message's `usage`. Summing
  // input + cache + output gives how much of the context window this turn
  // consumed — the right number for the Nk/1000k gauge.
  const used = contextTokens((msg.message as { usage?: unknown }).usage)
  if (used > 0) send(win, key, { kind: 'tokens', tokens: used })
  const content = (msg.message as { content?: unknown }).content
  if (!Array.isArray(content)) return
  for (const block of content as Array<Record<string, unknown>>) handleAssistantBlock(win, key, conn, block)
}

// The Agent tool launches async agents by default: they run detached and report
// completion via a top-level user message whose content is a plain
// `<task-notification>` string carrying the launching tool_use id. THAT is when
// the row is really done — the "Async agent launched" ack only acknowledges the
// launch. One message can close several agents: two that finished together are
// delivered as adjacent blocks, and stopping at the first strands the rest —
// tracked, running, holding the turn open.
function closeNotifiedSubagents(win: BrowserWindow, key: string, conn: Conn, content: string): void {
  for (const notice of parseTaskNotifications(content)) {
    const id = notice.toolUseId
    if (!conn.subagents.has(id)) {
      // A notification whose id we don't recognise can't clear its row —
      // this is exactly how a turn strands "Thinking…" forever. Record it.
      log('subagent-notify-unmatched', { key, id, outstanding: conn.subagents.size })
      continue
    }
    conn.subagents.delete(id)
    log('subagent-done', { key, id, via: 'notification', outstanding: conn.subagents.size })
    // `reply` is the agent reporting back: it speaks in the channel under
    // its own nick. For an async agent this notification is the ONLY place
    // its answer exists — the tool_result was just the launch ack.
    if (notice.result) pushTranscript(conn, `agent: ${notice.result}`)
    send(win, key, notice.result ? { kind: 'subagent-done', toolUseId: id, reply: notice.result } : { kind: 'subagent-done', toolUseId: id })
  }
}

// A tracked subagent's result returning marks it done — clear its row's running
// state. (Its internal steps were routed away by parent id.) A blocking Task's
// result IS the agent's answer to the session that launched it, so it says it
// here in its own voice. Two results are not that: the async launch ack (the
// agent has not started talking yet, so its row stays open for the
// <task-notification>) and an errored result (nothing was said in its name).
function closeBlockingSubagent(win: BrowserWindow, key: string, conn: Conn, block: Record<string, unknown>): void {
  const resultFor = typeof block.tool_use_id === 'string' ? block.tool_use_id : ''
  const reply = resultText(block.content)
  if (!resultFor || !conn.subagents.has(resultFor) || isAsyncLaunchAck(reply)) return
  conn.subagents.delete(resultFor)
  log('subagent-done', { key, id: resultFor, via: 'tool_result', outstanding: conn.subagents.size })
  const spoken = block.is_error === true ? undefined : reply
  if (spoken) pushTranscript(conn, `agent: ${spoken}`)
  send(win, key, spoken ? { kind: 'subagent-done', toolUseId: resultFor, reply: spoken } : { kind: 'subagent-done', toolUseId: resultFor })
}

function handleToolResultBlock(win: BrowserWindow, key: string, conn: Conn, block: Record<string, unknown>): void {
  if (block.type !== 'tool_result') return
  closeBlockingSubagent(win, key, conn, block)
  if (!Array.isArray(block.content)) return
  for (const part of block.content as Array<Record<string, unknown>>) {
    if (part.type !== 'image') continue
    const src = part.source as { type?: string; media_type?: string; data?: string } | undefined
    if (src?.type === 'base64' && typeof src.data === 'string' && src.data) {
      send(win, key, { kind: 'image', mediaType: src.media_type ?? 'image/png', data: src.data })
    }
  }
}

// Tool results arrive as `user` messages. Surface any image they carry (e.g.
// a Read of a PNG) so the transcript can show what Claude saw.
function handleUserLine(win: BrowserWindow, key: string, conn: Conn, msg: Record<string, unknown>): void {
  if (!msg.message || typeof msg.message !== 'object') return
  const content = (msg.message as { content?: unknown }).content
  if (typeof content === 'string') {
    if (isTaskNotification(content)) return closeNotifiedSubagents(win, key, conn, content)
    // Another session messaging this one arrives the same way: injected as a
    // plain user turn. It is someone else talking, so it joins the channel
    // under their nick — live, not only when the transcript is read back.
    const peer = parsePeerMessage(content)
    if (peer && peer.body) {
      pushTranscript(conn, `${peer.from}: ${peer.body}`)
      send(win, key, { kind: 'peer', from: peer.from, text: peer.body })
    }
    return
  }
  if (!Array.isArray(content)) return
  for (const block of content as Array<Record<string, unknown>>) handleToolResultBlock(win, key, conn, block)
}

function handleResultLine(win: BrowserWindow, key: string, conn: Conn, msg: Record<string, unknown>): void {
  // NB: the result's `usage` is cumulative across the whole session (it sums
  // every API call), so it's NOT the context-window fill — feeding it to the
  // gauge makes it climb past 100%. The latest `assistant` message above
  // already reported this turn's actual context size, so don't touch the
  // token count here.
  // A still-tracked subagent here means an async Agent is running in the
  // background: this turn ends, but the session ISN'T idle — the CLI resumes
  // it when the agent's <task-notification> arrives (reliable: it fires even
  // if the model never Monitors). Firing `done` now would wrongly flip the
  // session to finished and ping a "session finished" notification while the
  // agent is still working. Stay running; the resumed turn's result closes it.
  // ponytail: assumes every async agent eventually notifies; it does (fires on
  // every stop). If one could truly vanish, add a timeout sweep here.
  if (conn.subagents.size > 0) {
    // `done` withheld: the turn stays "running" until every async subagent
    // reports back. If one never does, this is where the session gets stuck —
    // record the hold so the watchdog/log can point straight at it.
    conn.heldForSubagentsAt = Date.now()
    log('result-held', { key, subagents: conn.subagents.size, ids: [...conn.subagents], turnMs: Date.now() - conn.turnStartedAt })
    return
  }
  // A <task-notification> read from the transcript may have already closed this
  // turn (its last async agent finished after the result was held, and the CLI
  // never resumed to send its own closing result). Don't fire a second `done`.
  if (conn.turnClosed) return
  // Turn finished — but the process stays alive for the next message.
  conn.turnClosed = true
  conn.turnActive = false
  conn.heldForSubagentsAt = null
  // Surface CLI-level errors (e.g. "Usage credits are required for this model.")
  // that arrive as an error result. The message lives in `msg.result`; skip it
  // when it's already the streamed assistant text so it doesn't render twice.
  if (msg.is_error === true && typeof msg.result === 'string' && msg.result.trim() && msg.result.trim() !== conn.lastAssistantText?.trim()) {
    send(win, key, { kind: 'error', message: msg.result.trim() })
  }
  log('turn-done', { key, ok: msg.is_error !== true, turnMs: conn.turnStartedAt ? Date.now() - conn.turnStartedAt : 0 })
  send(win, key, { kind: 'done', ok: msg.is_error !== true })
  // Release any send_message(wait) callers with this turn's final assistant text.
  resolveWaiters(key, conn.lastAssistantText)
}

// One stream-json line off the CLI's stdout. Past the bookkeeping this is only
// dispatch: each message type owns a module-level handler, so no single unit
// carries the whole protocol's branching (docs/crap.md).
export function handleLine(win: BrowserWindow, key: string, conn: Conn, line: string): void {
  let msg: Record<string, unknown>
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  if (typeof msg.session_id === 'string' && msg.session_id !== conn.sessionId) {
    conn.sessionId = msg.session_id
    // The JSONL is named after THIS id, and `claude --resume` forks into a fresh
    // one on every respawn — so the link has to be re-made each time, or the
    // session reopens showing only the turns up to the last fork. Done here,
    // not in the renderer: the transcript must survive with no panel mounted.
    linkAgentIdentity(key, msg.session_id)
  }

  const type = typeof msg.type === 'string' ? msg.type : undefined
  noteLineActivity(conn, msg, type)

  // Anything that isn't a streaming delta drains the coalesced delta queue
  // first, so the renderer always sees text/tools/results in arrival order.
  if (type !== 'stream_event') flushDeltas(win, key, conn)

  const parentToolUseId = typeof msg.parent_tool_use_id === 'string' ? msg.parent_tool_use_id : ''
  if (parentToolUseId && routeSubagentLine(win, key, msg, type, parentToolUseId)) return

  if (type === 'control_request') return handleControlRequest(win, key, conn, msg)
  if (type === 'system') return handleSystemLine(win, key, msg)
  if (type === 'stream_event') return handleStreamEvent(win, key, conn, msg)
  if (type === 'assistant') return handleAssistantLine(win, key, conn, msg)
  if (type === 'user') return handleUserLine(win, key, conn, msg)
  if (type === 'result') handleResultLine(win, key, conn, msg)
}

// The CLI records this session's turns at ~/.claude/projects/<slug>/<id>.jsonl,
// where <slug> is the cwd with every non-alphanumeric run collapsed to '-'.
function cliSessionJsonl(worktreePath: string, sessionId: string): string {
  const slug = worktreePath.replace(/[^a-zA-Z0-9]/g, '-')
  return join(homedir(), '.claude', 'projects', slug, `${sessionId}.jsonl`)
}

function stopTaskWatcher(conn: Conn): void {
  if (!conn.taskWatcher) return
  try {
    conn.taskWatcher.close()
  } catch {
    /* already closed */
  }
  conn.taskWatcher = null
}

// Why this exists: when the model launches an async (background) Agent, the CLI
// runs it detached and, on completion, ENQUEUES a `<task-notification>` into its
// own transcript to resume the turn. But under `--output-format stream-json` that
// queued turn is processed internally and never echoed on our stdout — so the
// stdout handler's notification match (in handleLine's `user` branch) can't fire,
// the launching tool-use id is never cleared from conn.subagents, and the held
// `result` strands the turn "Thinking…" until the watchdog's 10-min silence sweep.
// The notification IS durably written to the transcript file, so read it there:
// tail the jsonl and clear the subagent the instant its completion lands. Started
// once, on the first async launch; torn down with the conn.
function ensureTaskWatcher(win: BrowserWindow, key: string, conn: Conn): void {
  if (conn.taskWatcher || !conn.sessionId || !conn.worktreePath) return
  const file = cliSessionJsonl(conn.worktreePath, conn.sessionId)
  // Only notifications appended from now on matter; a resumed session's file
  // already holds old (done, untracked) ones we must not reprocess.
  try {
    conn.taskJsonlOffset = statSync(file).size
  } catch {
    conn.taskJsonlOffset = 0 // not on disk yet — read from the top when it appears
  }
  const scan = (): void => {
    if (conns.get(key) !== conn) return // conn was replaced/torn down
    let size: number
    try {
      size = statSync(file).size
    } catch {
      return
    }
    if (size < conn.taskJsonlOffset) conn.taskJsonlOffset = 0 // truncated/rotated — restart
    if (size <= conn.taskJsonlOffset) return
    let chunk: string
    try {
      const fd = openSync(file, 'r')
      const buf = Buffer.alloc(size - conn.taskJsonlOffset)
      readSync(fd, buf, 0, buf.length, conn.taskJsonlOffset)
      closeSync(fd)
      chunk = buf.toString('utf8')
    } catch {
      return
    }
    conn.taskJsonlOffset = size
    const { lines, rest } = drainLines(conn.taskJsonlBuffer, chunk)
    conn.taskJsonlBuffer = rest
    for (const line of lines) handleTaskLine(win, key, conn, line)
  }
  try {
    conn.taskWatcher = watch(file, { persistent: false }, scan)
  } catch {
    return // transcript dir missing — the watchdog stays the safety net
  }
  scan() // catch a completion that landed between the launch and the watch
}

// The notification text inside a transcript line. The file is JSONL, so the
// notification arrives JSON-encoded — read the string out before matching, or
// its `<result>` comes back with every newline still written as `\n`.
function taskLineText(line: string): string {
  try {
    const m = JSON.parse(line) as Record<string, unknown>
    const content = typeof m.content === 'string' ? m.content : (m.message as { content?: unknown } | undefined)?.content
    if (typeof content === 'string') return content
  } catch {
    /* not JSON: the caller's own tests pass the notification verbatim */
  }
  return line
}

// One transcript line. A finished async agent shows up as a `<task-notification>`
// carrying the launching tool-use id — the same id tracked in conn.subagents. Any
// terminal status (completed/failed) means the agent is no longer running, so
// clearing the last one while the turn is held closes the turn here — the stdout
// `result` that would normally do it is never coming for this session.
export function handleTaskLine(win: BrowserWindow, key: string, conn: Conn, line: string): void {
  if (!line.includes('<task-notification>')) return
  let closed = false
  for (const notice of parseTaskNotifications(taskLineText(line))) {
    const id = notice.toolUseId
    if (!conn.subagents.has(id)) continue
    conn.subagents.delete(id)
    closed = true
    log('subagent-done', { key, id, via: 'transcript', outstanding: conn.subagents.size })
    if (notice.result) pushTranscript(conn, `agent: ${notice.result}`)
    send(win, key, notice.result ? { kind: 'subagent-done', toolUseId: id, reply: notice.result } : { kind: 'subagent-done', toolUseId: id })
  }
  if (!closed) return
  if (!conn.turnClosed && conn.subagents.size === 0 && conn.turnActive && conn.heldForSubagentsAt != null) {
    conn.turnClosed = true
    conn.turnActive = false
    conn.heldForSubagentsAt = null
    log('turn-done', { key, ok: true, turnMs: conn.turnStartedAt ? Date.now() - conn.turnStartedAt : 0, via: 'transcript' })
    send(win, key, { kind: 'done', ok: true })
    resolveWaiters(key, conn.lastAssistantText)
  }
}

// Total tokens a turn occupies in the context window: the prompt the model read
// (fresh input + cache creation + cache reads) plus the tokens it generated.
// Moved to shared/types so the transcript parser can use the same arithmetic
// without importing this module, which pulls in electron. Re-exported here
// because this is where its callers and tests have always looked for it.
export { contextTokens }

export function parseQuestions(input: unknown): AgentQuestion[] {
  const raw = (input as { questions?: unknown })?.questions
  if (!Array.isArray(raw)) return []
  return raw
    .map((q): AgentQuestion | null => {
      const obj = q as Record<string, unknown>
      const options = Array.isArray(obj.options)
        ? (obj.options as Array<Record<string, unknown>>).map((o) => ({
            label: String(o.label ?? ''),
            description: typeof o.description === 'string' ? o.description : undefined
          }))
        : []
      if (typeof obj.question !== 'string' || options.length === 0) return null
      return {
        question: obj.question,
        header: typeof obj.header === 'string' ? obj.header : undefined,
        multiSelect: obj.multiSelect === true,
        options
      }
    })
    .filter((q): q is AgentQuestion => q !== null)
}

function summarizeTool(block: Record<string, unknown>): string | undefined {
  const input = (block.input ?? {}) as Record<string, unknown>
  for (const field of ['file_path', 'command', 'pattern', 'path', 'url', 'description']) {
    const value = input[field]
    if (typeof value === 'string') return value
  }
  return undefined
}
