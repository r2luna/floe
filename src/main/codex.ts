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
  type PermissionMode,
  CODEX_CONTEXT_WINDOW
} from '../shared/types'
import { sendAgentEvent } from './agent'
import { logTurn } from './runtimeLog'
import { rememberThread, threadFor } from './threads'

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

// agent.ts's funnel: stamps the per-session seq and feeds the replay snapshot.
function emit(win: BrowserWindow, key: string, event: AgentEvent): void {
  sendAgentEvent(win, key, event)
}

// Hard ceiling on a single Codex turn so a hung caller cannot wait on a wedged
// subprocess forever.
const TURN_TIMEOUT_MS = 240_000

// The mechanics of driving the local `codex` CLI: which argv to build, how to
// read its JSONL, what posture each permission mode maps onto. Who may talk to
// codex, in whose name, and how many times before checking in with the user is
// NOT here — that is peer.ts, and it asks the same questions of every harness.

/** Floe's four modes in codex's own two settings. */
export function codexPosture(mode: PermissionMode): { sandbox: string; collaboration: string } {
  if (mode === 'skip') return { sandbox: 'danger-full-access', collaboration: 'default' }
  if (mode === 'acceptEdits') return { sandbox: 'workspace-write', collaboration: 'default' }
  return { sandbox: 'read-only', collaboration: 'plan' }
}

/**
 * One `codex exec` turn, resuming `threadId` when there is one.
 *
 * The mode is passed in rather than pinned: codex used to be hard-wired to
 * read-only here because this path only ever served "a second pair of eyes for
 * Claude". A peer is not a reviewer with a fixed ceiling — what it may do is
 * decided by whoever calls it, against the caller's own mode (peer.ts).
 */
export function runCodexExchange(
  worktreePath: string,
  o: { threadId?: string; prompt: string; model?: string; effort?: string; mode: PermissionMode },
  onProgress?: (tool: string | undefined, tokens: number) => void
): Promise<{ reply: string; threadId?: string; tokens: number }> {
  const args = codexArgs(o.threadId, o.prompt, resolveModel(o.model), o.effort, o.mode)
  return runCodex(worktreePath, args, onProgress)
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
  // `plan` keeps this path's long-standing read-only sandbox. The user's real
  // codex chat runs on the app-server instead (codexServer.ts), which does take
  // the picker's mode — this is the exec fallback, and it does not write.
  const args = codexArgs(threadFor(key, 'codex'), prompt, resolveModel(model), effort, 'plan')
  try {
    const { reply, threadId, tokens } = await runCodex(worktreePath, args)
    if (threadId) rememberThread(key, 'codex', threadId)
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
  model: string,
  effort?: string,
  mode: PermissionMode = 'plan'
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
    : [
        'exec',
        '--json',
        '--skip-git-repo-check',
        ...modelArg,
        '-s',
        codexPosture(mode).sandbox,
        ...cfg,
        '--',
        prompt
      ]
}

// Floe's five effort levels → codex's three. xhigh/max both land on high.
function mapEffort(effort: string): string {
  if (effort === 'low') return 'low'
  if (effort === 'medium') return 'medium'
  return 'high'
}

/**
 * codex's stderr, minus the line it prints on every single run.
 *
 * "Reading additional input from stdin..." appears even with stdin closed
 * immediately, so as the last line of stderr it became the error message for
 * every failed turn — telling the user to look at a pipe when the actual
 * problem was a usage limit.
 */
function cleanStderr(stderr: string): string {
  return stderr
    .split('\n')
    .filter((l) => l.trim() && !l.trim().startsWith('Reading additional input from stdin'))
    .join('\n')
    .trim()
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
    // What codex said went wrong, in its own words. Its failures arrive as JSON
    // events on stdout — a usage limit, a provider it cannot reach — while
    // stderr carries only startup noise, so a turn that died with a readable
    // reason was being reported as "Reading additional input from stdin...".
    let failure = ''

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
        } else if (msg.type === 'error' || msg.type === 'turn.failed') {
          const said =
            typeof msg.message === 'string'
              ? msg.message
              : ((msg.error as { message?: string } | undefined)?.message ?? '')
          if (said) failure = said
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
      else reject(new Error(failure || cleanStderr(stderr) || 'Codex produced no reply.'))
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
