import type { BrowserWindow } from 'electron'
import type { AgentEvent, PermissionMode } from '../shared/types'
import { HARNESSES, NEEDS_MODEL, clampMode, nearestMode } from '../shared/modes'
import { permissionArgs, sendAgentEvent } from './agent'
import { getSystemPrompt } from './appSettings'
import { runCodexExchange } from './codex'
import { houseRulesFor, forgetHouseRules } from './houseRules'
import { log } from './log'
import { peerMcp } from './mcpHarness'
import { askLocalModel, run, textFromJson } from './runtimes'
import { getCreatedSession } from './sessionStore'
import { forgetThreads, rememberThread, threadFor } from './threads'

// Asking another agent, whoever is asking and whoever is asked.
//
// This used to be `ask_codex`: one tool, one direction, one name. Claude could
// consult codex; codex could not consult Claude, and nothing could consult
// gemini or opencode at all. That is not a peer relationship, it is a Claude
// session with an accessory — and it is why a codex-answered session felt like
// a different, smaller app.
//
// What a peer gets here is what any harness answering a turn gets:
//
//   - the user's standing instructions (houseRules.ts / --append-system-prompt)
//   - a thread that survives the call, and the restart after it (threads.ts)
//   - a mode the CALLER decides, bounded by the caller's own (clampMode)
//   - the same exchange window, in whichever direction the asking goes
//
// What it does NOT get is Floe's control plane. A consult runs with every MCP
// server switched off (peerMcp, the query rule D8): a peer answering inside
// someone else's session must never be able to act as that session — open
// panels, send messages, create sessions — under a token it was lent.

/**
 * How many exchanges one pair may have before checking in with the user.
 *
 * Per PAIR, not per session: `claude → codex` and `codex → claude` each keep
 * their own count, so a peer consulting back does not spend the window its
 * caller was holding. Two agents that keep asking each other one more question
 * is a loop nobody ordered, and every hop is a real turn on a real CLI.
 */
export const MAX_EXCHANGES = 5

/** Longest one consult may take before the caller is unwedged. */
const TURN_TIMEOUT_MS = 240_000

export interface ExchangeWindow {
  step: number
}

/** The windows, by `caller harness`. */
const windows = new Map<string, ExchangeWindow>()

/**
 * Advance a pair's window. Returns capped=true (without consuming a step) once
 * it is full, and resets it — so the next call after the user's guidance starts
 * a fresh count. Pure + exported for the unit test.
 */
export function nextExchange(state: ExchangeWindow): { capped: boolean } {
  if (state.step >= MAX_EXCHANGES) {
    state.step = 0
    return { capped: true }
  }
  state.step += 1
  return { capped: false }
}

export interface PeerSpec {
  /** Who to ask. One of shared/modes.ts's HARNESSES. */
  harness: string
  prompt: string
  /** Drop the thread and start the conversation over. */
  newTopic?: boolean
  /** What the peer may do. Never more than the calling session may do. */
  mode?: PermissionMode
  model?: string
  effort?: string
}

export interface PeerResult {
  /** Hit the exchange cap — no peer was called. */
  capped: boolean
  reply?: string
  /** Which exchange this was, 1-based within the window. */
  exchange?: number
  error?: string
}

/**
 * The machine-to-machine contract, set once at the top of a fresh thread.
 *
 * It names the CALLER rather than assuming Claude. The peer is being asked by
 * an agent, and which agent it is changes what "context you both already share"
 * means — telling codex it is talking to Claude when it is talking to gemini is
 * a small lie that costs a paragraph of misaimed framing on every answer.
 */
export function m2mPreamble(caller: string): string {
  return [
    `[M2M PROTOCOL] Your interlocutor is another AI agent (${caller}), not a human. Optimize this exchange for machine-to-machine bandwidth, not human readability:`,
    '- Maximum signal, minimum tokens. Drop greetings, sign-offs, hedging, praise, and meta-talk ("great question", "let me think", "I agree that...").',
    '- Do NOT restate context you both already share; reference it (file:line, symbol, prior point #) instead of re-explaining.',
    '- Prefer terse fragments, technical shorthand, symbols, and structured lists over full prose sentences.',
    '- State claims, evidence, and disagreements directly and flatly. Lead with the delta from the last message.',
    '- No summary for a human reader — that is produced separately. Emit only what advances the shared analysis.'
  ].join('\n')
}

/** The harness a session answers as — who is doing the asking. */
function callerHarness(callerKey: string): string {
  return getCreatedSession(callerKey)?.provider ?? 'claude'
}

/**
 * The ceiling on a consult: what the calling session itself was given.
 *
 * An agent running in a `plan` chat must not be able to open a peer that
 * writes — that would be a way out of read-only that the user never granted,
 * one MCP call wide. Absent (a session with no recorded mode, or a query key)
 * reads as `plan`, the safe end.
 */
function ceilingFor(callerKey: string): PermissionMode {
  return getCreatedSession(callerKey)?.permissionMode ?? 'plan'
}

/** The thread this pair is holding — namespaced, so a consult is not the chat. */
const threadName = (harness: string): string => `peer:${harness}`

/**
 * The house-rules scope for a consult.
 *
 * Separate from the session's own chat with that harness (they are separate
 * threads), and passed with the REAL harness name so Claude is still recognised
 * as the one that takes a system prompt instead of a message.
 */
const peerScope = (callerKey: string): string => `${callerKey} peer`

const emit = (win: BrowserWindow, key: string, event: AgentEvent): void =>
  sendAgentEvent(win, key, event)

/**
 * Ask a peer one question and wait for its answer.
 *
 * The consult shows up in the caller's chat as a subagent row (the same
 * subagent-start/progress/done lifecycle Claude's own Task rows use), so a
 * conversation between two agents is watchable rather than a silent gap in the
 * middle of a turn.
 */
export async function askPeer(
  win: BrowserWindow,
  callerKey: string,
  worktreePath: string,
  spec: PeerSpec
): Promise<PeerResult> {
  const harness = spec.harness
  if (!HARNESSES.includes(harness))
    return { capped: false, error: `Unknown harness: ${harness}. One of: ${HARNESSES.join(', ')}.` }
  if (NEEDS_MODEL.includes(harness) && !spec.model)
    return { capped: false, error: `${harness} has no default model — name one in \`model\`.` }

  const pair = `${callerKey} ${harness}`
  const state = windows.get(pair) ?? { step: 0 }
  windows.set(pair, state)
  if (spec.newTopic) {
    forgetThreads(callerKey, threadName(harness))
    forgetHouseRules(peerScope(callerKey), harness)
    state.step = 0
  }

  const { capped } = nextExchange(state)
  if (capped) return { capped: true }

  // What the peer may do: what was asked for, never more than the caller has,
  // and then only what this harness can honestly spell (a mode it cannot do is
  // snapped down rather than approximated — shared/modes.ts).
  const mode = nearestMode(clampMode(spec.mode ?? 'plan', ceilingFor(callerKey)), harness)
  const threadId = threadFor(callerKey, threadName(harness))
  // Fresh thread → the contract and the house rules; a continuing one has both
  // already, and re-sending them is a paragraph of noise on every exchange.
  const prompt = threadId
    ? spec.prompt
    : `${houseRulesFor(peerScope(callerKey), harness)}${m2mPreamble(callerHarness(callerKey))}\n\n---\n\n${spec.prompt}`

  const toolUseId = `peer:${harness}:${callerKey}:${Date.now()}`
  const startedAt = Date.now()
  emit(win, callerKey, {
    kind: 'subagent-start',
    toolUseId,
    agentType: harness,
    description: spec.prompt.slice(0, 120),
    harness
  })
  log('peer-ask', { key: callerKey, harness, mode, exchange: state.step })

  try {
    const out = await runPeer(harness, {
      worktreePath,
      prompt,
      threadId,
      model: spec.model,
      effort: spec.effort,
      mode,
      // Never the caller's own key: the generated config files are named after
      // it, and a peer must not be handed a file minted for the session.
      peerKey: `peer-${harness}`
    })
    if (out.threadId) rememberThread(callerKey, threadName(harness), out.threadId)
    // Hand the answer to the renderer so the exchange becomes a visible block in
    // the thread instead of vanishing with the subagent row.
    emit(win, callerKey, {
      kind: 'subagent-done',
      toolUseId,
      reply: out.reply,
      ms: Date.now() - startedAt
    })
    return { capped: false, reply: out.reply, exchange: state.step }
  } catch (e) {
    // Nothing was said, so nothing was delivered: the next attempt carries the
    // house rules again rather than assuming this one got them there.
    forgetHouseRules(peerScope(callerKey), harness)
    emit(win, callerKey, { kind: 'subagent-done', toolUseId, ms: Date.now() - startedAt })
    return { capped: false, error: (e as Error).message, exchange: state.step }
  }
}

interface RunSpec {
  worktreePath: string
  prompt: string
  threadId?: string
  model?: string
  effort?: string
  mode: PermissionMode
  /** Names the generated MCP config files. Not a session token. */
  peerKey: string
}

/**
 * One turn on one harness, in its own dialect.
 *
 * Each branch is the same three facts the chat runtimes already spell
 * (runtimes.ts): how to continue a thread, how to say the mode, how to read the
 * reply back out. What is different is only that this one answers to a caller
 * instead of to a panel.
 */
async function runPeer(
  harness: string,
  o: RunSpec
): Promise<{ reply: string; threadId?: string }> {
  if (harness === 'codex') {
    const out = await runCodexExchange(o.worktreePath, {
      threadId: o.threadId,
      prompt: o.prompt,
      model: o.model,
      effort: o.effort,
      mode: o.mode
    })
    return { reply: out.reply, threadId: out.threadId }
  }

  if (harness === 'claude') return runClaudePeer(o)

  if (harness === 'opencode') {
    const args = ['run', '--format', 'json', '--print-logs']
    if (o.model) args.push('-m', o.model)
    args.push('--agent', o.mode === 'plan' ? 'plan' : 'build')
    if (o.threadId) args.push('-s', o.threadId)
    args.push(o.prompt)
    const { text, sessionId } = textFromJson(
      await run('opencode', args, o.worktreePath, TURN_TIMEOUT_MS, peerMcp('opencode', o.peerKey))
    )
    return { reply: text, threadId: sessionId }
  }

  if (harness === 'gemini') {
    // gemini has no id we can name a session by, so a consult is one turn at a
    // time — the same limit its chat panel lives with (runtimes.ts).
    const approval = o.mode === 'skip' ? 'yolo' : o.mode === 'acceptEdits' ? 'auto_edit' : 'default'
    const args = ['-p', o.prompt, '-o', 'json', '--approval-mode', approval]
    if (o.model) args.push('-m', o.model)
    const { text } = textFromJson(
      await run('gemini', args, o.worktreePath, TURN_TIMEOUT_MS, peerMcp('gemini', o.peerKey))
    )
    return { reply: text }
  }

  if (harness === 'lmstudio' || harness === 'ollama') {
    // No tools, so no mode and nothing to sandbox: this is a chat completion.
    const { text } = await askLocalModel(harness, o.model, [{ role: 'user', content: o.prompt }])
    return { reply: text }
  }

  throw new Error(`no peer runner for "${harness}"`)
}

/**
 * A one-shot `claude -p`, resuming the consult's own session.
 *
 * Not the persistent stream-json conn agent.ts holds: that one IS a chat panel,
 * keyed by a session the user can see. A consult is a question and an answer,
 * and `-p --output-format json` gives both plus the session id to continue from
 * next time.
 *
 * `--strict-mcp-config` over an empty file is the same isolation a query gets:
 * without it the peer inherits Floe's globally registered control server and
 * comes back holding tools it was never lent (D8).
 */
async function runClaudePeer(o: RunSpec): Promise<{ reply: string; threadId?: string }> {
  // Imported here rather than at the top: mcpServer.ts imports this module, and
  // the cycle is only safe as long as neither side reaches across at load time.
  const { emptyMcpConfigFor } = await import('./mcpServer')
  const args = ['-p', '--output-format', 'json']
  if (o.model) args.push('--model', o.model)
  if (o.effort) args.push('--effort', o.effort)
  if (o.threadId) args.push('--resume', o.threadId)
  args.push(...permissionArgs(o.mode))
  // The peer is answering in this app, so it holds the same standing
  // instructions as any other turn — as a real system prompt, which is the one
  // thing Claude can take that the others cannot (houseRules.ts).
  const rules = getSystemPrompt()
  if (rules) args.push('--append-system-prompt', rules)
  args.push('--mcp-config', emptyMcpConfigFor(o.peerKey), '--strict-mcp-config')
  // `--` last, as codexArgs does: a prompt that opens with a dash is a prompt,
  // not a flag somebody smuggled past the mode this consult was clamped to.
  args.push('--', o.prompt)
  const raw = await run('claude', args, o.worktreePath, TURN_TIMEOUT_MS)
  return readClaudeJson(raw)
}

/**
 * `claude -p --output-format json` prints one object: the reply in `result`,
 * the thread in `session_id`. Exported for the test — the shape is the CLI's,
 * so it is worth pinning.
 */
export function readClaudeJson(raw: string): { reply: string; threadId?: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.trim())
  } catch {
    // We asked for JSON and got prose: a sign-in prompt, a usage limit, a
    // refusal. Its own words are the most useful thing to say about it.
    const line = raw.trim().split('\n').filter(Boolean).pop()
    throw new Error(line?.slice(0, 300) || 'claude answered with nothing')
  }
  const o = parsed as { result?: unknown; session_id?: unknown; is_error?: unknown }
  const reply = typeof o.result === 'string' ? o.result : ''
  if (o.is_error === true) throw new Error(reply || 'claude reported an error')
  return { reply, threadId: typeof o.session_id === 'string' ? o.session_id : undefined }
}

/** Forget a pair's window and thread — the session, or the query, is gone. */
export function forgetPeers(callerKey: string): void {
  for (const key of windows.keys()) if (key.startsWith(`${callerKey} `)) windows.delete(key)
  for (const harness of HARNESSES) {
    forgetThreads(callerKey, threadName(harness))
    forgetHouseRules(peerScope(callerKey), harness)
  }
}
