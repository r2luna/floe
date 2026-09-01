import { spawn, type ChildProcess } from 'node:child_process'
import type { BrowserWindow } from 'electron'
import type { AgentQuestion, PermissionMode } from '../shared/types'
import { dropSettled, sendAgentEvent } from './agent'
import { resolveModel } from './codex'
import { logTurn } from './runtimeLog'

// Codex chat over `codex app-server` (JSON-RPC on stdio) instead of one-shot
// `codex exec`: a live session is the only channel that can answer the model's
// `item/tool/requestUserInput` — codex's AskUserQuestion. The question arrives
// as a SERVER→CLIENT request, we surface it through the same `question`
// AgentEvent the Claude path uses, and the JSON-RPC response resolves it.
//
// Scope: only the user's own codex chat runs here. ask_codex (Claude⇄Codex)
// stays on `codex exec` in codex.ts — a machine peer answers its own questions.
//
// The tool is gated twice upstream: the client must declare the
// `experimentalApi` capability at initialize, and the thread must be in the
// "plan" collaboration mode (codex_core rejects it in Default mode) — so codex
// can only ask you something while the picker is on plan. In the modes that
// let it write, it works instead of asking, which is what those modes mean.

const TURN_TIMEOUT_MS = 240_000

interface Pending {
  resolve: (result: Record<string, unknown>) => void
  reject: (error: Error) => void
}

// One live turn per session key. threadId doubles as the routing key for the
// notifications, which are tagged with it rather than with our session key.
interface TurnCtx {
  win: BrowserWindow
  key: string
  threadId: string
  model?: string
  effort?: string
  /** Last agentMessage of the turn — mirrors the exec path's "reply". */
  reply: string
  timer: NodeJS.Timeout | null
}

let child: ChildProcess | null = null
let rpcId = 0
let ready: Promise<void> | null = null
const pending = new Map<number, Pending>()
const turnsByThread = new Map<string, TurnCtx>()
const threadBySession = new Map<string, string>()
// The mode each live thread was last configured for. A thread carries its
// sandbox from thread/start, so a mode picked afterwards has to be pushed at it
// — and pushing the same one on every turn would be a round trip per message.
const modeByThread = new Map<string, PermissionMode>()
// A question the model is blocked on: the JSON-RPC request id to respond to,
// the question ids in presentation order (the renderer answers by index), and
// the display texts so the answered exchange can be written to the runtime log.
const questionBySession = new Map<
  string,
  { rpcId: number | string; ids: string[]; texts: string[]; threadId: string }
>()

function write(obj: unknown): void {
  child?.stdin?.write(JSON.stringify(obj) + '\n')
}

function request(method: string, params?: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const id = ++rpcId
    pending.set(id, { resolve, reject })
    write({ jsonrpc: '2.0', id, method, params })
  })
}

/** Spawn (once) and initialize the shared app-server. Re-arms after a crash. */
function ensureServer(): Promise<void> {
  if (ready) return ready
  ready = new Promise((resolve, reject) => {
    let proc: ChildProcess
    try {
      proc = spawn('codex', ['app-server'], { env: process.env })
    } catch (e) {
      ready = null
      reject(e)
      return
    }
    child = proc
    proc.on('error', (e) => {
      reject(new Error(e.message.includes('ENOENT') ? 'codex CLI not found on PATH.' : e.message))
      teardown()
    })
    proc.on('close', teardown)
    let buf = ''
    proc.stdout?.setEncoding('utf8')
    proc.stdout?.on('data', (chunk: string) => {
      buf += chunk
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (!line.trim()) continue
        try {
          handleMessage(JSON.parse(line) as Record<string, unknown>)
        } catch {
          // codex logs stray non-JSON lines; ignore them
        }
      }
    })
    // experimentalApi is what unlocks thread/settings/update (plan mode) and
    // the requestUserInput server request itself.
    const id = ++rpcId
    pending.set(id, { resolve: () => resolve(), reject })
    write({
      jsonrpc: '2.0',
      id,
      method: 'initialize',
      params: { clientInfo: { name: 'floe', version: '1.0.0' }, capabilities: { experimentalApi: true } }
    })
  })
  return ready
}

/** The server died: fail every in-flight turn so no session hangs "running". */
function teardown(): void {
  child = null
  ready = null
  for (const p of pending.values()) p.reject(new Error('codex app-server exited.'))
  pending.clear()
  for (const ctx of turnsByThread.values()) finishTurn(ctx, 'codex app-server exited.')
  turnsByThread.clear()
  questionBySession.clear()
  // Threads die with the server process; a fresh one must thread/resume — and
  // resume does not carry a sandbox, so forget the posture too or the next turn
  // would skip the update and run in whatever the resumed thread defaults to.
  modeByThread.clear()
}

function handleMessage(msg: Record<string, unknown>): void {
  // Reply to one of our requests.
  if (typeof msg.id === 'number' && !msg.method && pending.has(msg.id)) {
    const p = pending.get(msg.id)!
    pending.delete(msg.id)
    const err = msg.error as { message?: string } | undefined
    if (err) p.reject(new Error(err.message ?? 'codex request failed'))
    else p.resolve((msg.result ?? {}) as Record<string, unknown>)
    return
  }

  const params = (msg.params ?? {}) as Record<string, unknown>

  // SERVER→CLIENT request (has both method and id): the codex analogue of the
  // Claude control_request.
  if (msg.method && msg.id !== undefined) {
    if (msg.method === 'item/tool/requestUserInput') {
      onQuestion(msg.id as number | string, params)
      return
    }
    // Anything else (command/file approvals — shouldn't happen under
    // approvalPolicy "never") is declined so the turn can't hang on it.
    write({ jsonrpc: '2.0', id: msg.id, result: { decision: 'denied' } })
    return
  }

  // Notifications, routed by the thread they belong to.
  const ctx = typeof params.threadId === 'string' ? turnsByThread.get(params.threadId) : undefined
  if (!ctx) return

  if (msg.method === 'item/completed') {
    const item = params.item as { type?: string; text?: string } | undefined
    // Same contract as the exec path: the turn's reply is its last agent
    // message. Deltas are skipped — one settled text per turn.
    if (item?.type === 'agentMessage' && typeof item.text === 'string') ctx.reply = item.text
    return
  }
  if (msg.method === 'thread/tokenUsage/updated') {
    const last = (params.tokenUsage as { last?: { inputTokens?: number; outputTokens?: number } })?.last
    const n = (v: unknown): number => (typeof v === 'number' ? v : 0)
    const tokens = n(last?.inputTokens) + n(last?.outputTokens)
    if (tokens > 0) sendAgentEvent(ctx.win, ctx.key, { kind: 'tokens', tokens })
    return
  }
  if (msg.method === 'turn/completed') {
    const turn = params.turn as { status?: string; error?: { message?: string } | null } | undefined
    finishTurn(ctx, turn?.error?.message ?? undefined)
  }
}

/** Surface a requestUserInput as the same `question` event Claude uses. */
function onQuestion(reqId: number | string, params: Record<string, unknown>): void {
  const ctx = typeof params.threadId === 'string' ? turnsByThread.get(params.threadId) : undefined
  if (!ctx) {
    // No live turn to attach it to — decline rather than strand the server.
    write({ jsonrpc: '2.0', id: reqId, result: { answers: {} } })
    return
  }
  const raw = Array.isArray(params.questions) ? (params.questions as Array<Record<string, unknown>>) : []
  const ids = raw.map((q, i) => (typeof q.id === 'string' ? q.id : String(i)))
  const questions: AgentQuestion[] = raw.map((q) => ({
    question: typeof q.question === 'string' ? q.question : '',
    header: typeof q.header === 'string' ? q.header : undefined,
    // codex questions are single-answer; free text covers its `isOther`.
    multiSelect: false,
    options: Array.isArray(q.options)
      ? (q.options as Array<Record<string, unknown>>).map((o) => ({
          label: String(o.label ?? ''),
          description: typeof o.description === 'string' ? o.description : undefined
        }))
      : []
  }))
  const texts = questions.map((q) =>
    q.header && q.header !== q.question ? `${q.header} — ${q.question}` : q.question || (q.header ?? '')
  )
  questionBySession.set(ctx.key, { rpcId: reqId, ids, texts, threadId: ctx.threadId })
  // The model is blocked on the user now — a turn timeout here would kill a
  // perfectly healthy question. Re-armed when the answer goes back.
  if (ctx.timer) clearTimeout(ctx.timer)
  ctx.timer = null
  sendAgentEvent(ctx.win, ctx.key, { kind: 'question', toolUseId: String(reqId), questions })
}

/**
 * Every codex session blocked on a question right now — the same authority
 * `waitingKeys()` is for Claude, so the renderer's `?` reconciles against one
 * answer whichever runtime asked.
 */
export function codexWaitingKeys(): string[] {
  return [...questionBySession.keys()]
}

/**
 * Resolve a pending codex question with the renderer's per-question answers
 * (labels or free text, in presentation order). Returns false when this
 * session has no codex question — the caller then tries the Claude path.
 */
export function answerCodexQuestion(key: string, answered: string[][]): boolean {
  const q = questionBySession.get(key)
  if (!q) return false
  questionBySession.delete(key)
  // The question also lives in the turn's replay snapshot, which only grows
  // until `done`. Leave it there and reopening the panel mid-turn re-renders
  // the card for a question the model already got its answer to.
  dropSettled(key, String(q.rpcId))
  const answers: Record<string, { answers: string[] }> = {}
  q.ids.forEach((id, i) => {
    answers[id] = { answers: answered[i] ?? [] }
  })
  write({ jsonrpc: '2.0', id: q.rpcId, result: { answers } })
  // Persist the exchange the way the renderer showed it live — question as the
  // model's line, answer as the user's — so a reload still says what the
  // answer was an answer to. Codex writes no transcript of its own we can use.
  const ctx = turnsByThread.get(q.threadId)
  q.ids.forEach((_, i) => {
    const answer = (answered[i] ?? []).join(', ')
    if (!q.texts[i] || !answer) return
    logTurn(key, { role: 'assistant', text: q.texts[i], provider: 'codex', model: ctx?.model, effort: ctx?.effort })
    logTurn(key, { role: 'user', text: answer })
  })
  if (ctx) armTimer(ctx)
  return true
}

function armTimer(ctx: TurnCtx): void {
  if (ctx.timer) clearTimeout(ctx.timer)
  ctx.timer = setTimeout(() => finishTurn(ctx, ctx.reply ? undefined : 'Codex timed out.'), TURN_TIMEOUT_MS)
}

/** Close a turn exactly once: settle text, done event, drop the routing. */
function finishTurn(ctx: TurnCtx, error?: string): void {
  if (turnsByThread.get(ctx.threadId) !== ctx) return
  turnsByThread.delete(ctx.threadId)
  questionBySession.delete(ctx.key)
  if (ctx.timer) clearTimeout(ctx.timer)
  if (ctx.reply) {
    sendAgentEvent(ctx.win, ctx.key, { kind: 'text', text: ctx.reply })
    logTurn(ctx.key, { role: 'assistant', text: ctx.reply, model: ctx.model, effort: ctx.effort, provider: 'codex' })
  }
  if (error) sendAgentEvent(ctx.win, ctx.key, { kind: 'error', message: error })
  sendAgentEvent(ctx.win, ctx.key, { kind: 'done', ok: !error })
}

/**
 * Floe's mode → the two settings codex spells it with.
 *
 * `approvalPolicy` stays "never" in every mode on purpose: an approval request
 * arrives as a server→client request we answer with a flat decline (see the
 * dispatcher above), so a policy that asks would stall the turn on a question
 * nobody can answer. What varies is the sandbox — which is the part that
 * actually decides what a turn can touch — and the collaboration mode.
 *
 * "ask" is not here because codex cannot do it; shared/modes.ts leaves it off
 * codex's list, and runtimes.ts snaps anything that still arrives.
 */
function codexPosture(mode: PermissionMode): { sandbox: string; collaboration: string } {
  if (mode === 'skip') return { sandbox: 'danger-full-access', collaboration: 'default' }
  if (mode === 'acceptEdits') return { sandbox: 'workspace-write', collaboration: 'default' }
  return { sandbox: 'read-only', collaboration: 'plan' }
}

// Floe's five effort levels → codex's three (same mapping as codex.ts).
function mapEffort(effort?: string): string | undefined {
  if (!effort) return undefined
  if (effort === 'low') return 'low'
  if (effort === 'medium') return 'medium'
  return 'high'
}

/**
 * One user turn against the session's codex thread. Starts (or resumes) the
 * thread on the shared app-server, puts it in the posture the picker asked for,
 * and streams the outcome through the normal AgentEvents.
 */
export async function chatWithCodexServer(
  win: BrowserWindow,
  key: string,
  worktreePath: string,
  prompt: string,
  model: string | undefined,
  effort?: string,
  mode: PermissionMode = 'plan'
): Promise<void> {
  const slug = resolveModel(model)
  const posture = codexPosture(mode)
  try {
    await ensureServer()

    let threadId = threadBySession.get(key)
    if (threadId && !turnsByThread.has(threadId)) {
      // Thread known but maybe from a previous server process — resume is
      // idempotent for a running thread, so just always rejoin it.
      try {
        await request('thread/resume', { threadId, cwd: worktreePath, model: slug })
      } catch {
        threadId = undefined // rollout gone — start over
      }
    }
    if (!threadId) {
      const started = await request('thread/start', {
        cwd: worktreePath,
        model: slug,
        // See codexPosture: the sandbox is the setting that carries the mode,
        // and "never" keeps an unanswerable approval request from wedging us.
        approvalPolicy: 'never',
        sandbox: posture.sandbox
      })
      threadId = String((started.thread as { id?: string })?.id ?? '')
      if (!threadId) throw new Error('codex thread/start returned no thread id.')
      threadBySession.set(key, threadId)
      // Plan's collaboration mode is also the gate on requestUserInput.
      // Best-effort: an older codex without the method still chats.
      await request('thread/settings/update', {
        threadId,
        collaborationMode: { mode: posture.collaboration, settings: { model: slug } }
      }).catch(() => {})
      modeByThread.set(threadId, mode)
    } else if (modeByThread.get(threadId) !== mode) {
      // The mode changed mid-chat — the usual path, since plan-then-build is
      // how a session actually goes. The thread keeps its history; only its
      // posture moves. A failure here is said out loud rather than swallowed:
      // silently answering in the old sandbox is how you lose an afternoon
      // wondering why nothing gets written.
      try {
        await request('thread/settings/update', {
          threadId,
          sandboxPolicy: posture.sandbox,
          collaborationMode: { mode: posture.collaboration, settings: { model: slug } }
        })
        modeByThread.set(threadId, mode)
      } catch (e) {
        throw new Error(`codex would not switch to ${mode} mode: ${(e as Error).message}`)
      }
    }

    const ctx: TurnCtx = { win, key, threadId, model, effort, reply: '', timer: null }
    turnsByThread.set(threadId, ctx)
    armTimer(ctx)
    await request('turn/start', {
      threadId,
      input: [{ type: 'text', text: prompt }],
      effort: mapEffort(effort)
    })
    // Completion arrives as the turn/completed notification → finishTurn.
  } catch (e) {
    sendAgentEvent(win, key, { kind: 'error', message: (e as Error).message })
    sendAgentEvent(win, key, { kind: 'done', ok: false })
  }
}
