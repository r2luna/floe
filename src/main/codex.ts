import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import {
  type AgentEvent,
  type CodexModel,
  type CodexUsage,
  type CodexUsageWindow,
  CODEX_CONTEXT_WINDOW
} from '../shared/types'
import { sendAgentEvent } from './agent'
import { logTurn } from './runtimeLog'

// The Codex models Floe offers, read from codex's own on-disk cache so the
// picker matches exactly what `codex` can run — no hardcoded list to rot. Only
// user-listable, API-supported entries. Falls back to codex's configured model
// (or gpt-5.5) if the cache is missing, so there's always at least one option.
export function codexModels(): CodexModel[] {
  try {
    const raw = readFileSync(join(homedir(), '.codex', 'models_cache.json'), 'utf8')
    const models = (JSON.parse(raw) as { models?: Array<Record<string, unknown>> }).models ?? []
    const list = models
      .filter((m) => m.visibility === 'list' && m.supported_in_api)
      .map((m) => ({
        slug: String(m.slug),
        label: typeof m.display_name === 'string' ? m.display_name : String(m.slug),
        contextWindow: typeof m.context_window === 'number' ? m.context_window : CODEX_CONTEXT_WINDOW
      }))
    if (list.length) return list
  } catch {
    // no cache yet (codex never run) — fall through to the configured default
  }
  const slug = codexConfigModel() ?? 'gpt-5.5'
  return [{ slug, label: slug, contextWindow: CODEX_CONTEXT_WINDOW }]
}

// The model from ~/.codex/config.toml (`model = "..."`), the user's own default.
function codexConfigModel(): string | undefined {
  try {
    const raw = readFileSync(join(homedir(), '.codex', 'config.toml'), 'utf8')
    return /^\s*model\s*=\s*"([^"]+)"/m.exec(raw)?.[1]
  } catch {
    return undefined
  }
}

// Resolve a session's stored model to a real codex slug for `-m`: legacy 'codex'
// (or any slug no longer offered) falls back to the first available model so a
// stale session still runs.
export function resolveModel(model: string | undefined): string {
  const list = codexModels()
  if (model && list.some((m) => m.slug === model)) return model
  return list[0].slug
}

// Surface a codex event as a subagent row in the caller session's tree, reusing
// the same subagent-start/progress/done lifecycle (and the isDestroyed guard) as
// Claude's own Task subagents in agent.ts.
// agent.ts's funnel: stamps the per-session seq and feeds the replay snapshot.
function emit(win: BrowserWindow, key: string, event: AgentEvent): void {
  sendAgentEvent(win, key, event)
}

// Drives the local `codex` CLI (`codex exec --json`) as a pair-programming
// partner for a Claude session. Each caller session gets one running Codex
// "thread" it can converse with over several exchanges; Codex shows up as a
// subagent row in that session's tree (reusing the subagent-* AgentEvents), and
// the conversation is capped at MAX_EXCHANGES turns before Claude must check in
// with the user.

// Max Codex↔Claude exchanges before we force a check-in with the user. After the
// cap the window resets, so once the user says "keep going" the next call starts
// a fresh count of 5 on the same thread.
export const MAX_EXCHANGES = 5

// Machine-to-machine contract, injected once at the top of a fresh Codex thread
// (first turn / new topic). ask_codex is Claude⇄Codex, not Codex→human — so tell
// Codex to talk to its peer at maximum signal density: no pleasantries, no
// restating shared context, technical shorthand over prose. The human-readable
// summary happens later, on the Claude side, once they've converged.
const M2M_PREAMBLE = [
  '[M2M PROTOCOL] Your interlocutor is another AI (Claude), not a human. Optimize this exchange for machine-to-machine bandwidth, not human readability:',
  '- Maximum signal, minimum tokens. Drop greetings, sign-offs, hedging, praise, and meta-talk ("great question", "let me think", "I agree that...").',
  '- Do NOT restate context you both already share; reference it (file:line, symbol, prior point #) instead of re-explaining.',
  '- Prefer terse fragments, technical shorthand, symbols, and structured lists over full prose sentences.',
  '- State claims, evidence, and disagreements directly and flatly. Lead with the delta from the last message.',
  '- No summary for a human reader — that is produced separately. Emit only what advances the shared analysis.'
].join('\n')

// Codex is read-only by default: this is analysis / pair-programming, not an
// editor. Flip to 'workspace-write' here (and drop --skip on resume) if you want
// Codex to actually change files.
const SANDBOX = 'read-only'

// Hard ceiling on a single Codex turn so a hung subprocess can't wedge the
// blocking MCP tool call forever.
const TURN_TIMEOUT_MS = 240_000

interface CodexState {
  threadId?: string // codex thread id, for `exec resume`
  step: number // exchanges used in the current window
}

const states = new Map<string, CodexState>()

// Advance the exchange window. Returns capped=true (without consuming a step)
// once the window is full, and resets it so the next call after the user's
// guidance starts fresh. Pure + exported for the unit test.
export function nextExchange(state: CodexState): { capped: boolean } {
  if (state.step >= MAX_EXCHANGES) {
    state.step = 0
    return { capped: true }
  }
  state.step += 1
  return { capped: false }
}

export interface CodexResult {
  capped: boolean // hit the exchange cap — no Codex call was made
  reply?: string // Codex's message this exchange
  exchange?: number // which exchange this was (1-based, within the window)
  error?: string
}

// Run one exchange with Codex for a caller session. Spawns (or resumes) a Codex
// thread, streams its activity into the caller's subagent tree, and resolves
// with Codex's final message.
export async function askCodex(
  win: BrowserWindow,
  callerKey: string,
  worktreePath: string,
  prompt: string,
  newTopic = false
): Promise<CodexResult> {
  const state = states.get(callerKey) ?? { step: 0 }
  states.set(callerKey, state)
  if (newTopic) {
    state.threadId = undefined
    state.step = 0
  }

  const { capped } = nextExchange(state)
  if (capped) return { capped: true }

  const toolUseId = `codex:${callerKey}:${Date.now()}`
  const startedAt = Date.now()
  emit(win, callerKey, {
    kind: 'subagent-start',
    toolUseId,
    agentType: 'codex',
    description: prompt.slice(0, 120),
    harness: 'codex'
  })

  // Set the machine-to-machine contract once, at the top of a fresh thread — a
  // new topic reset threadId to undefined above, so this covers both cases.
  // Resumed turns inherit the tone, so we don't re-inject it (and don't pollute
  // the subagent row's description with the preamble).
  const codexPrompt = state.threadId ? prompt : `${M2M_PREAMBLE}\n\n---\n\n${prompt}`
  const args = codexArgs(state.threadId, codexPrompt, callerKey, resolveModel(undefined))
  try {
    const { reply, threadId } = await runCodex(worktreePath, args, (tool, tokens) =>
      emit(win, callerKey, { kind: 'subagent-progress', toolUseId, tokens, tool })
    )
    if (threadId) state.threadId = threadId
    // Hand the answer to the renderer so the exchange can become a visible block
    // in the thread instead of vanishing with the subagent row.
    emit(win, callerKey, { kind: 'subagent-done', toolUseId, reply, ms: Date.now() - startedAt })
    return { capped: false, reply, exchange: state.step }
  } catch (e) {
    emit(win, callerKey, { kind: 'subagent-done', toolUseId, ms: Date.now() - startedAt })
    return { capped: false, error: (e as Error).message, exchange: state.step }
  }
}

// Chat directly with Codex as the backend of a Floe session (the user picked
// the "codex" model). Persists a thread per session key and streams the reply
// into the transcript via the normal text/done AgentEvents — no exchange cap,
// this is the user's own conversation. effort maps to codex's reasoning effort.
export async function chatWithCodex(
  win: BrowserWindow,
  key: string,
  worktreePath: string,
  prompt: string,
  model: string | undefined,
  effort?: string
): Promise<void> {
  const state = states.get(key) ?? { step: 0 }
  states.set(key, state)
  const args = codexArgs(state.threadId, prompt, key, resolveModel(model), effort)
  try {
    const { reply, threadId, tokens } = await runCodex(worktreePath, args)
    if (threadId) state.threadId = threadId
    if (reply) {
      emit(win, key, { kind: 'text', text: reply })
      // Codex writes its own rollout, but under an id we cannot resume by, so
      // the app keeps its own copy like it does for every other runtime.
      logTurn(key, { role: 'assistant', text: reply, model, effort, provider: 'codex' })
    }
    // Feed the Nk/272k context gauge: codex's input_tokens already includes the
    // resumed history, so input + output ≈ this turn's context fill (mirrors how
    // agent.ts reports Claude's per-turn usage).
    if (tokens > 0) emit(win, key, { kind: 'tokens', tokens })
    emit(win, key, { kind: 'done', ok: true })
  } catch (e) {
    emit(win, key, { kind: 'error', message: (e as Error).message })
    emit(win, key, { kind: 'done', ok: false })
  }
}

// Build the `codex exec` argv: resume an existing thread or start a fresh one
// (read-only sandbox, set only on the first turn — resume inherits it). Optional
// reasoning effort maps onto codex's own config key.
function codexArgs(
  threadId: string | undefined,
  prompt: string,
  token: string,
  model: string,
  effort?: string
): string[] {
  const cfg = effort ? ['-c', `model_reasoning_effort=${mapEffort(effort)}`] : []
  // '--' terminates codex's option parsing so a prompt starting with '-' can't
  // smuggle a flag (e.g. `-c sandbox_mode=danger-full-access` to escape the
  // read-only sandbox). threadId comes from codex's own output, but guard its
  // shape too before trusting it as a leading argv token; on a bad shape, fall
  // back to a fresh thread rather than resume.
  const safe = threadId && /^[A-Za-z0-9-]+$/.test(threadId) ? threadId : undefined
  // Pin the chosen model so the token gauge's window is truthful — the stream
  // never tells us which model ran, so we decide it (resolved to a real slug).
  const modelArg = ['-m', model]
  return safe
    ? ['exec', 'resume', safe, '--json', '--skip-git-repo-check', ...modelArg, ...cfg, '--', prompt]
    : ['exec', '--json', '--skip-git-repo-check', ...modelArg, '-s', SANDBOX, ...cfg, '--', prompt]
}

// Floe's five effort levels → codex's three. xhigh/max both land on high.
function mapEffort(effort: string): string {
  if (effort === 'low') return 'low'
  if (effort === 'medium') return 'medium'
  return 'high'
}

// Spawn one `codex exec` process, parse its JSONL events, report live progress
// via onProgress, and resolve with the last agent_message + the thread id.
function runCodex(
  worktreePath: string,
  args: string[],
  onProgress?: (tool: string | undefined, tokens: number) => void
): Promise<{ reply: string; threadId?: string; tokens: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn('codex', args, { cwd: worktreePath, env: process.env })
    // The prompt is passed as an argv arg, so we send nothing on stdin. Close it
    // immediately: with an open stdin pipe, `codex exec` blocks forever "Reading
    // additional input from stdin..." and never produces a turn.
    child.stdin.end()
    let buffer = ''
    let stderr = ''
    let threadId: string | undefined
    let reply = ''
    let tokens = 0

    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      if (reply) resolve({ reply, threadId, tokens })
      else reject(new Error('Codex timed out.'))
    }, TURN_TIMEOUT_MS)

    child.stdin.on('error', () => {})
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk
      let nl: number
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (!line || line[0] !== '{') continue // skip codex's stray log lines
        let msg: Record<string, unknown>
        try {
          msg = JSON.parse(line)
        } catch {
          continue
        }
        if (msg.type === 'thread.started' && typeof msg.thread_id === 'string') {
          threadId = msg.thread_id
        } else if (msg.type === 'item.completed' && msg.item && typeof msg.item === 'object') {
          const item = msg.item as { type?: string; text?: string }
          if (item.type === 'agent_message' && typeof item.text === 'string') reply = item.text
          onProgress?.(item.type, tokens)
        } else if (msg.type === 'turn.completed' && msg.usage && typeof msg.usage === 'object') {
          // input_tokens is the full prompt the model saw this turn (incl. the
          // resumed thread + the cached portion), so input + output is the
          // context-window fill — the right number for the gauge. cached_input_
          // tokens is a subset of input_tokens, so don't add it (double-count).
          const u = msg.usage as { input_tokens?: number; output_tokens?: number }
          const n = (v: unknown): number => (typeof v === 'number' ? v : 0)
          tokens = n(u.input_tokens) + n(u.output_tokens)
        }
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (c: string) => {
      stderr += c
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(new Error(e.message.includes('ENOENT') ? 'codex CLI not found on PATH.' : e.message))
    })
    child.on('close', () => {
      clearTimeout(timer)
      if (reply) resolve({ reply, threadId, tokens })
      else reject(new Error(stderr.trim() || 'Codex produced no reply.'))
    })
  })
}

// Read Codex's rate limits via `codex app-server` (JSON-RPC over stdio): send
// `initialize` then `account/rateLimits/read` and harvest the reply. Returns
// undefined if codex isn't installed / logged in, so the usage panel degrades to
// Claude-only rather than erroring. Mirrors the headless probe pattern in
// claudeInfo.ts.
export function getCodexUsage(): Promise<CodexUsage | undefined> {
  return new Promise((resolve) => {
    let settled = false
    let child: ReturnType<typeof spawn>
    const finish = (usage?: CodexUsage): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        child?.kill('SIGTERM')
      } catch {
        /* already gone */
      }
      resolve(usage)
    }
    const timer = setTimeout(() => finish(undefined), 6000)
    try {
      child = spawn('codex', ['app-server'], { env: process.env })
    } catch {
      finish(undefined)
      return
    }
    child.on('error', () => finish(undefined))

    const toWindow = (w: unknown): CodexUsageWindow | undefined => {
      const o = w as Record<string, unknown> | null
      if (!o || typeof o.usedPercent !== 'number') return undefined
      return {
        usedPercent: o.usedPercent,
        resetsAt: typeof o.resetsAt === 'number' ? o.resetsAt : undefined,
        windowMins: typeof o.windowDurationMins === 'number' ? o.windowDurationMins : undefined
      }
    }

    let buf = ''
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      buf += chunk
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        let msg: Record<string, unknown>
        try {
          msg = JSON.parse(line)
        } catch {
          continue
        }
        const result = msg.id === 2 ? (msg.result as Record<string, unknown> | undefined) : undefined
        const rl = result?.rateLimits as Record<string, unknown> | undefined
        if (rl) {
          finish({
            planType: typeof rl.planType === 'string' ? rl.planType : undefined,
            primary: toWindow(rl.primary),
            secondary: toWindow(rl.secondary)
          })
        }
      }
    })

    const send = (o: unknown): void => {
      child.stdin?.write(JSON.stringify(o) + '\n')
    }
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'floe', version: '1.0.0' } } })
    send({ jsonrpc: '2.0', id: 2, method: 'account/rateLimits/read' })
  })
}
