import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { watch, statSync, openSync, readSync, closeSync, existsSync, type FSWatcher } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { contextTokens } from '../shared/types'
import type { AgentEvent, AgentQuestion, AgentReplay, AgentRunOptions, FileAttachment, ImageAttachment, PermissionMode } from '../shared/types'
import { parseArtifactSpec } from '../shared/artifact'
import { getCreatedSession, getCreatedSessionClaudeId, linkCreatedSession } from './sessionStore'
import { getSystemPrompt } from './appSettings'
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

function permissionArgs(mode: PermissionMode): string[] {
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
  const seq = (seqs.get(key) ?? 0) + 1
  seqs.set(key, seq)
  recordForReplay(key, event, seq)
  if (!win.isDestroyed()) win.webContents.send('agent:event', { key, event, seq })
}
const send = sendAgentEvent

const lastErrors = new Map<string, { at: number; message: string }>()
const seqs = new Map<string, number>()

// The turn in flight, replayed to a panel that opens mid-turn. The JSONL on
// disk only has what the CLI already wrote; everything streamed since the turn
// started lives here until `done`, when the file catches up and this resets.
// The user prompt is NOT kept — the CLI writes it to the JSONL at submit, so
// the panel's initial read already has it.
const replays = new Map<string, AgentReplay>()

export function markTurnStart(key: string): void {
  replays.set(key, { running: true, lastSeq: seqs.get(key) ?? 0, events: [], startedAt: Date.now() })
}

export function replaySnapshot(key: string): AgentReplay {
  return replays.get(key) ?? { running: false, lastSeq: seqs.get(key) ?? 0, events: [] }
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
    // A question is part of the turn: a panel mounting mid-question must get
    // it back or the session looks idle with the CLI still blocked on it.
    case 'question':
      r.events.push(event)
      break
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
  const resumeId = conns.get(key)?.sessionId ?? getCreatedSessionClaudeId(key)

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
  let conn = conns.get(key)
  // The process may have died while we were idle (machine slept, claude reaped)
  // before `close` fired. Writing to its stdin would break; drop it so we respawn
  // and --resume from the persisted session id instead.
  if (conn && isChildDead(conn.child)) {
    conns.delete(key)
    conn = undefined
  }
  // A send while a turn is in flight is a steer: the message goes into the live
  // CLI loop (the SDK queues it and folds it into the same turn). No turn-state
  // reset — the running turn continues, and its replay buffer stays intact.
  // Option changes are ignored here: honouring them means killing the child,
  // which would abort the very turn being steered.
  if (conn && conn.turnActive) {
    conn.lastActivityAt = Date.now()
    log('turn-steer', { key, promptLen: prompt.length, images: images.length, files: files.length })
    pushTranscript(conn, `user: ${prompt}`)
    write(conn, { type: 'user', message: { role: 'user', content: buildContent(prompt, images, files) } })
    return
  }
  if (conn && conn.optionsKey !== optionsKey) {
    clearDeltas(conn) // a late flush from the dead conn must not leak into the new one
    conn.child.kill('SIGTERM')
    conns.delete(key)
    conn = undefined
  }
  const freshSpawn = !conn
  if (!conn) conn = spawnConn(win, key, worktreePath, options)
  // A new user turn starts: clear the accumulator so send_message(wait) returns
  // only this turn's reply, and record the prompt in the live transcript buffer.
  conn.lastAssistantText = ''
  lastErrors.delete(key) // a new turn supersedes the previous failure
  markTurnStart(key)
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
  log('turn-start', { key, promptLen: prompt.length, images: images.length, files: files.length })
  pushTranscript(conn, `user: ${prompt}`)
  write(conn, { type: 'user', message: { role: 'user', content: buildContent(prompt, images, files) } })
}

// Answer a tool-permission prompt over the control channel. `allow` runs the
// tool (with its original input); otherwise it's refused with a short reason.
export function respondPermission(key: string, requestId: string, allow: boolean): void {
  const conn = conns.get(key)
  if (!conn) return
  // Echo back the original tool input the CLI handed us when it asked.
  const toolInput = conn.pendingPerms.get(requestId) ?? {}
  conn.pendingPerms.delete(requestId)
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
  const conn = conns.get(key)
  if (!conn) return
  conn.pendingPerms.delete(requestId)
  write(conn, {
    type: 'control_response',
    response: { subtype: 'success', request_id: requestId, response: { behavior: 'deny', message: answer } }
  })
}

export function stopAgent(win: BrowserWindow, key: string): void {
  const conn = conns.get(key)
  if (!conn) return
  // Deregister first so the child's late `close` (guarded by isCurrent) is a
  // no-op, then release any send_message(wait) caller with the text so far —
  // otherwise it blocks until the 120s timeout — and kill. Emit the one
  // authoritative `done` ourselves (the guarded close won't): this is the single
  // reset every stop caller relies on — the composer Stop AND worktree merge/
  // remove, which stop turns without touching renderer state — so their sessions
  // don't stay stuck "running" with orphaned subagent rows.
  conns.delete(key)
  stopTaskWatcher(conn)
  conn.turnActive = false
  conn.turnClosed = true
  log('stop', { key, turnMs: conn.turnStartedAt ? Date.now() - conn.turnStartedAt : 0, subagents: conn.subagents.size })
  flushDeltas(win, key, conn) // surface whatever text had streamed before the stop
  resolveWaiters(key, conn.lastAssistantText)
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
  send(win, key, { kind: 'done', ok: true })
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

export function startAgentWatchdog(): void {
  if (watchdog) return
  watchdog = setInterval(() => runWatchdogTick(conns, Date.now()), WATCHDOG_MS)
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
    linkCreatedSession(key, msg.session_id)
  }

  const type = msg.type
  // The turn is alive as long as the CLI keeps talking. The watchdog reads these
  // to tell a genuinely-stuck turn from one that's still streaming.
  conn.lastActivityAt = Date.now()
  if (typeof type === 'string') {
    conn.lastLineType = type
    conn.lastLineSubtype = typeof msg.subtype === 'string' ? msg.subtype : ''
    // Any non-`system` line proves real turn progress (assistant token, tool_use,
    // tool_result, control_request, result). A turn wedged at startup emits only
    // `system` lines (init/status/api_retry) — see SILENT_RECOVER_MS.
    if (type !== 'system') conn.turnHadMeaningfulOutput = true
  }

  // Anything that isn't a streaming delta drains the coalesced delta queue
  // first, so the renderer always sees text/tools/results in arrival order.
  if (type !== 'stream_event') flushDeltas(win, key, conn)

  // A subagent's internal activity is streamed inline on the same stdout, tagged
  // with the parent Task's tool-use id. Route it to that subagent's nested row
  // (live tokens + current tool) and stop — it must not land in the parent's
  // transcript or inflate the parent's token gauge. The Task's own tool_result
  // (which ends the subagent) arrives WITHOUT this tag, so it falls through below.
  // ponytail: known limitation — a subagent that itself launches a Task is invisible
  // after the first hint (the inner parent_tool_use_id never enters conn.subagents,
  // so it just routes away here). Harmless: it pollutes neither transcript nor gauge.
  // Only build a childId→rootTopLevelId alias if nested Tasks become common.
  const parentToolUseId = typeof msg.parent_tool_use_id === 'string' ? msg.parent_tool_use_id : ''
  if (parentToolUseId) {
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
    // must still reach the handler below: the CLI blocks on it, so swallowing it
    // here would hang the whole session with nothing surfaced to answer. Only a
    // subagent's own internal chatter (assistant/tool_result/…) is dropped.
    if (type !== 'control_request') return
  }

  // The CLI asks for tool permission over the control channel (we opted in with
  // `--permission-prompt-tool stdio`). Remember the input so we can echo it back
  // on allow, then surface an approve/deny prompt in the transcript.
  if (type === 'control_request' && msg.request && typeof msg.request === 'object') {
    const req = msg.request as Record<string, unknown>
    const requestId = String(msg.request_id ?? '')
    if (req.subtype === 'can_use_tool' && requestId) {
      // AskUserQuestion arrives here too: the CLI blocks on this control_request,
      // so the session genuinely pauses. Surface the question card and answer it
      // by resolving this same request (see answerQuestion) — no auto-dismiss.
      if (req.tool_name === 'AskUserQuestion') {
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
          return
        }
        const questions = parseQuestions(req.input)
        if (questions.length) {
          conn.pendingPerms.set(requestId, req.input)
          send(win, key, { kind: 'question', toolUseId: requestId, questions })
          return
        }
      }
      conn.pendingPerms.set(requestId, req.input)
      send(win, key, {
        kind: 'permission',
        permission: {
          requestId,
          toolName: String(req.tool_name ?? 'tool'),
          summary:
            (typeof req.description === 'string' && req.description) ||
            summarizeTool({ input: req.input }) ||
            undefined
        }
      })
    }
    return
  }

  if (type === 'system') {
    if (msg.subtype === 'init' && typeof msg.session_id === 'string') {
      send(win, key, {
        kind: 'session',
        sessionId: msg.session_id,
        model: typeof msg.model === 'string' ? msg.model : undefined
      })
    }
    return
  }

  if (type === 'stream_event' && msg.event && typeof msg.event === 'object') {
    const ev = msg.event as {
      type?: string
      delta?: { type?: string; text?: string; thinking?: string }
    }
    if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
      queueDelta(win, key, conn, 'text', ev.delta.text ?? '')
    } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'thinking_delta') {
      queueDelta(win, key, conn, 'reasoning', ev.delta.thinking ?? '')
    }
    return
  }

  if (type === 'assistant' && msg.message && typeof msg.message === 'object') {
    // Real context usage lives on each assistant message's `usage`. Summing
    // input + cache + output gives how much of the context window this turn
    // consumed — the right number for the Nk/1000k gauge.
    const used = contextTokens((msg.message as { usage?: unknown }).usage)
    if (used > 0) send(win, key, { kind: 'tokens', tokens: used })
    const content = (msg.message as { content?: unknown }).content
    if (Array.isArray(content)) {
      for (const block of content as Array<Record<string, unknown>>) {
        // Accumulate the assistant's text for this turn (used by send_message(wait))
        // and mirror it into the live buffer (used by read_session_output).
        if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
          conn.lastAssistantText += (conn.lastAssistantText ? '\n' : '') + block.text
          pushTranscript(conn, `assistant: ${block.text.trim()}`)
          continue
        }
        if (block.type !== 'tool_use') continue
        // The present_decision tool renders as an inline decision panel, not a
        // tool card. Emit the artifact (after flushing any streamed text so it
        // lands in order) and skip the default tool chip. On a malformed spec,
        // fall through to the plain tool card so nothing silently disappears.
        if (block.name === 'mcp__floe__present_decision') {
          const spec = parseArtifactSpec(block.input)
          if (spec) {
            flushDeltas(win, key, conn)
            send(win, key, { kind: 'artifact', spec })
            continue
          }
        }
        // The question is delivered (and paused on) via the can_use_tool control
        // request in every mode now — even skip, where the prompt tool stays
        // attached so AskUserQuestion remains answerable — so skip it here to
        // avoid rendering a duplicate, non-interactive tool card.
        if (block.name === 'AskUserQuestion') continue
        // The Task tool (named "Agent" on the wire) launches a subagent. Track its
        // id so we can match the inline progress + the closing tool_result, and
        // surface a live nested row — see the subagent routing above.
        if ((block.name === 'Task' || block.name === 'Agent') && typeof block.id === 'string') {
          const input = (block.input ?? {}) as Record<string, unknown>
          conn.subagents.add(block.id)
          // An async (background) agent's completion never reaches our stdout —
          // watch the CLI transcript so its finish clears this row (see below).
          ensureTaskWatcher(win, key, conn)
          log('subagent-start', { key, id: block.id, outstanding: conn.subagents.size })
          send(win, key, {
            kind: 'subagent-start',
            toolUseId: block.id,
            agentType: typeof input.subagent_type === 'string' ? input.subagent_type : 'agent',
            description: typeof input.description === 'string' ? input.description : '',
            harness: 'claude'
          })
          continue
        }
        const toolName = String(block.name ?? 'tool')
        const toolSummary = summarizeTool(block)
        pushTranscript(conn, `[tool ${toolName}]${toolSummary ? ` ${toolSummary}` : ''}`)
        send(win, key, { kind: 'tool', name: toolName, summary: toolSummary })
      }
    }
    return
  }

  // Tool results arrive as `user` messages. Surface any image they carry (e.g.
  // a Read of a PNG) so the transcript can show what Claude saw.
  if (type === 'user' && msg.message && typeof msg.message === 'object') {
    const content = (msg.message as { content?: unknown }).content
    // The Agent tool now launches async agents by default: they run detached and
    // report completion via a top-level user message whose content is a plain
    // `<task-notification>` string carrying the launching tool_use id. THAT is
    // when the row is really done — the immediate "Async agent launched" ack
    // below only acknowledges the launch, it doesn't mean the work is finished.
    if (typeof content === 'string' && content.includes('<task-notification>')) {
      const id = content.match(/<tool-use-id>([^<]+)<\/tool-use-id>/)?.[1] ?? ''
      if (id && conn.subagents.has(id)) {
        conn.subagents.delete(id)
        log('subagent-done', { key, id, via: 'notification', outstanding: conn.subagents.size })
        send(win, key, { kind: 'subagent-done', toolUseId: id })
      } else {
        // A notification whose id we don't recognise can't clear its row — this
        // is exactly how a turn strands "Thinking…" forever. Record the mismatch.
        log('subagent-notify-unmatched', { key, id, outstanding: conn.subagents.size })
      }
      return
    }
    if (Array.isArray(content)) {
      for (const block of content as Array<Record<string, unknown>>) {
        if (block.type !== 'tool_result') continue
        // A tracked subagent's result returning marks it done — clear its row's
        // running state. (Its internal steps were routed away above by parent id.)
        // But an async Agent returns an immediate "Async agent launched" ack while
        // it keeps running in the background: keep the row alive until its
        // <task-notification> completion above. Only a classic blocking Task's
        // result (its real output) closes the row here.
        const resultFor = typeof block.tool_use_id === 'string' ? block.tool_use_id : ''
        if (resultFor && conn.subagents.has(resultFor) && !isAsyncLaunchAck(block.content)) {
          conn.subagents.delete(resultFor)
          log('subagent-done', { key, id: resultFor, via: 'tool_result', outstanding: conn.subagents.size })
          send(win, key, { kind: 'subagent-done', toolUseId: resultFor })
        }
        if (!Array.isArray(block.content)) continue
        for (const part of block.content as Array<Record<string, unknown>>) {
          if (part.type !== 'image') continue
          const src = part.source as { type?: string; media_type?: string; data?: string } | undefined
          if (src?.type === 'base64' && typeof src.data === 'string' && src.data) {
            send(win, key, { kind: 'image', mediaType: src.media_type ?? 'image/png', data: src.data })
          }
        }
      }
    }
    return
  }

  if (type === 'result') {
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

// One transcript line. A finished async agent shows up as a `<task-notification>`
// carrying the launching tool-use id — the same id tracked in conn.subagents. Any
// terminal status (completed/failed) means the agent is no longer running, so
// clearing the last one while the turn is held closes the turn here — the stdout
// `result` that would normally do it is never coming for this session.
export function handleTaskLine(win: BrowserWindow, key: string, conn: Conn, line: string): void {
  if (!line.includes('<task-notification>')) return
  const id = line.match(/<tool-use-id>([^<]+)<\/tool-use-id>/)?.[1] ?? ''
  if (!id || !conn.subagents.has(id)) return
  conn.subagents.delete(id)
  log('subagent-done', { key, id, via: 'transcript', outstanding: conn.subagents.size })
  send(win, key, { kind: 'subagent-done', toolUseId: id })
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

// The Agent tool's async launch returns this ack immediately, long before the
// agent finishes — so it must NOT be read as the subagent's completion result.
function isAsyncLaunchAck(content: unknown): boolean {
  if (!Array.isArray(content)) return false
  return (content as Array<Record<string, unknown>>).some(
    (part) => part.type === 'text' && typeof part.text === 'string' && part.text.includes('Async agent launched')
  )
}

function summarizeTool(block: Record<string, unknown>): string | undefined {
  const input = (block.input ?? {}) as Record<string, unknown>
  for (const field of ['file_path', 'command', 'pattern', 'path', 'url', 'description']) {
    const value = input[field]
    if (typeof value === 'string') return value
  }
  return undefined
}
