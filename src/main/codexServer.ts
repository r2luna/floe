import { spawn, type ChildProcess } from 'node:child_process'
import type { BrowserWindow } from 'electron'
import type { AgentQuestion } from '../shared/types'
import { sendAgentEvent } from './agent'
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
// "plan" collaboration mode (codex_core rejects it in Default mode). Plan mode
// costs us nothing: the exec path already ran codex read-only.

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
      params: { clientInfo: { name: 'rookery', version: '1.0.0' }, capabilities: { experimentalApi: true } }
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
  // Threads die with the server process; a fresh one must thread/resume.
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
 * Resolve a pending codex question with the renderer's per-question answers
 * (labels or free text, in presentation order). Returns false when this
 * session has no codex question — the caller then tries the Claude path.
 */
export function answerCodexQuestion(key: string, answered: string[][]): boolean {
  const q = questionBySession.get(key)
  if (!q) return false
  questionBySession.delete(key)
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

// Rookery's five effort levels → codex's three (same mapping as codex.ts).
function mapEffort(effort?: string): string | undefined {
  if (!effort) return undefined
  if (effort === 'low') return 'low'
  if (effort === 'medium') return 'medium'
  return 'high'
}

/**
 * One user turn against the session's codex thread. Starts (or resumes) the
 * thread on the shared app-server, flips it to plan mode so requestUserInput
 * is available, and streams the outcome through the normal AgentEvents.
 */
export async function chatWithCodexServer(
  win: BrowserWindow,
  key: string,
  worktreePath: string,
  prompt: string,
  model: string | undefined,
  effort?: string
): Promise<void> {
  const slug = resolveModel(model)
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
        // Match the exec path's posture: codex chat analyses, it doesn't edit.
        // "never" also means no approval requests can wedge the turn.
        approvalPolicy: 'never',
        sandbox: 'read-only'
      })
      threadId = String((started.thread as { id?: string })?.id ?? '')
      if (!threadId) throw new Error('codex thread/start returned no thread id.')
      threadBySession.set(key, threadId)
      // Plan mode is the gate on requestUserInput. Best-effort: an older codex
      // without the method still chats, just never asks.
      await request('thread/settings/update', {
        threadId,
        collaborationMode: { mode: 'plan', settings: { model: slug } }
      }).catch(() => {})
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
