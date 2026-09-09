import { spawn } from 'node:child_process'
import type { BrowserWindow } from 'electron'
import type { AgentEvent, PermissionMode } from '../shared/types'
import { DEFAULT_MODE, nearestMode } from '../shared/modes'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { chatWithCodexServer } from './codexServer'
import { touchCreatedSession } from './sessionStore'
import { logTurn } from './runtimeLog'
import { markTurnStart, sendAgentEvent } from './agent'
import { seedFor } from './handoff'
import { lmStudioServerModels } from './localAgents'
import { harnessMcp } from './mcpHarness'
import { forgetHouseRules, houseRulesFor } from './houseRules'
import { forgetThreads, rememberThread, threadFor } from './threads'

// Running a turn on something other than Claude.
//
// Every runtime here answers into the SAME `agent:event` channel the Claude
// agent uses, so the chat panel needs to know nothing about who replied — the
// transcript, the token gauge and the done/error handling are already written.
//
// What each one gets is only what it can honestly do:
//
//  - codex     — full turn, resumable thread (main/codex.ts, unchanged)
//  - opencode  — full turn, resumable session (`-s <id>`, id read back from JSON)
//  - gemini    — one turn at a time (see the note on continuity below)
//  - lmstudio  — full conversation, because we hold the messages ourselves
//  - ollama    — same, via its own OpenAI-compatible endpoint
//
// The permission mode travels the same way: shared/modes.ts says which of the
// four each runtime can do, and each branch below spells its own flag for it.
// A runtime with no tools (LM Studio, Ollama) has nothing to spell.
//
// ponytail: prose only. None of these forward tool activity as tool rows the
// way agent.ts does for Claude — their JSON event streams each spell tools
// differently, and a wrong row is worse than no row. Upgrade path: translate
// per runtime in `parse`, one at a time, when someone actually needs to watch
// a Gemini turn work.

// agent.ts's funnel: stamps the per-session seq and feeds the replay snapshot.
const emit = (win: BrowserWindow, key: string, event: AgentEvent): void =>
  sendAgentEvent(win, key, event)

/**
 * Say it AND write it down.
 *
 * Every reply from these runtimes goes through here, so there is one place
 * that can forget to persist rather than four.
 */
function say(
  win: BrowserWindow,
  key: string,
  text: string,
  meta: { model?: string; effort?: string; provider: string }
): void {
  emit(win, key, { kind: 'text', text })
  logTurn(key, { role: 'assistant', text, ...meta })
}

/** Per-chat continuity: whatever the runtime needs to carry a conversation. */
interface Thread {
  /** opencode's session id, read out of its first reply. */
  sessionId?: string
  /** The whole conversation, for the endpoints that take one (LM Studio, Ollama). */
  messages?: { role: 'user' | 'assistant'; content: string }[]
}

const threads = new Map<string, Thread>()

/**
 * Forget a chat's continuity — used when a query closes or a thread is reset.
 *
 * All three halves of it: the in-memory thread, the id written down for a
 * restart (threads.ts), and the record of having delivered the house rules —
 * the next thread is a new one and starts with them again.
 */
export function forgetThread(key: string): void {
  threads.delete(key)
  forgetThreads(key)
  forgetHouseRules(key)
}

/** Run a command, hand back stdout. Rejects with stderr's last line. */
// A CLI that wants an answer from a human. Closing stdin is not enough — some
// of them print the question and wait anyway — so the first sign of one ends
// the run instead of leaving "is typing" on screen for ten minutes.
const ASKING = /\[Y\/n\]|\(y\/N\)|Do you want to continue|authentication page|Press Enter/i

const killTree = (child: { pid?: number; kill: (s?: NodeJS.Signals) => boolean }): void => {
  try {
    if (child.pid) process.kill(-child.pid, 'SIGKILL')
    else child.kill('SIGKILL')
  } catch {
    /* already gone */
  }
}

export function run(
  bin: string,
  args: string[],
  cwd: string,
  timeoutMs = 10 * 60 * 1000,
  /** What the harness needs to see Floe's MCP servers — mcpHarness.ts. */
  extraEnv: Record<string, string> = {}
): Promise<string> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>
    try {
      // stdin closed: a CLI that wants to ask something ("Open the browser?
      // [Y/n]") must fail instead of waiting forever on an answer that is
      // never coming — there is nobody at this end of the pipe.
      // detached = its own process GROUP, so aborting kills the whole tree:
      // gemini re-executes itself in a child node that outlives a SIGTERM sent
      // only to the parent, and an orphaned CLI keeps burning its login prompt.
      child = spawn(bin, args, {
        cwd,
        env: { ...process.env, ...extraEnv },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true
      })
    } catch (e) {
      return reject(e instanceof Error ? e : new Error(String(e)))
    }
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      killTree(child)
      // A CLI that retries a dead provider forever produces nothing on stdout
      // and everything on stderr. Its last error line is the actual answer to
      // "why is this taking so long".
      const why = err
        .split('\n')
        .filter((l) => /error/i.test(l))
        .pop()
      reject(new Error(why ? why.slice(0, 300) : `${bin} timed out`))
    }, timeoutMs)
    const abort = (message: string): void => {
      killTree(child)
      clearTimeout(timer)
      reject(new Error(message))
    }
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (c: string) => {
      out += c
      // eslint-disable-next-line no-control-regex
      const clean = out.replace(/\u001b\[[0-9;]*m/g, '')
      if (ASKING.test(clean)) abort(clean.trim().split('\n').filter(Boolean).pop() ?? 'needs input')
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (c: string) => (err += c))
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(new Error(e.message.includes('ENOENT') ? `${bin} not found` : e.message))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) return resolve(out)
      const last = err.trim().split('\n').filter(Boolean).pop()
      reject(new Error(last || `${bin} exited ${code}`))
    })
  })
}

/**
 * Bring the LM Studio server up if it is not already.
 *
 * The picker can list models from the models directory while the server is
 * down, so the first message of the day would otherwise fail with a bare
 * "fetch failed". Starting it is a side effect, but it is the one the user
 * asked for by pressing send.
 */
async function ensureLmStudio(): Promise<void> {
  try {
    const res = await fetch('http://127.0.0.1:1234/v1/models', { signal: AbortSignal.timeout(700) })
    if (res.ok) return
  } catch {
    /* not up yet */
  }
  const lms = join(homedir(), '.lmstudio', 'bin', 'lms')
  await run(lms, ['server', 'start'], homedir(), 90_000)
}

/**
 * The id the API will accept for a model the picker offered.
 *
 * Over HTTP a model is `kimi-k2.7-code`; on disk the same thing is
 * `unsloth/Kimi-K2.7-Code-GGUF`. When the picker listed the directory (server
 * was down) the two have to be reconciled, by comparing on letters and digits
 * alone — everything else is packaging.
 */
async function resolveLmStudioModel(wanted: string): Promise<string> {
  const models = await lmStudioServerModels()
  if (!models.length) return wanted
  if (models.some((m) => m.slug === wanted)) return wanted
  const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
  const want = key(wanted.split('/').pop() ?? wanted)
  const hit = models.find((m) => {
    const have = key(m.slug.split('/').pop() ?? m.slug)
    return have.startsWith(want) || want.startsWith(have)
  })
  return hit?.slug ?? wanted
}

/** POST a chat completion to an OpenAI-compatible local server. */
export async function openAiChat(
  base: string,
  model: string,
  messages: { role: string; content: string }[]
): Promise<{ text: string; tokens: number }> {
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: false })
  })
  if (!res.ok) {
    // The body carries the reason — "insufficient system resources", a model
    // that will not load, a bad id. `400 Bad Request` on its own tells you
    // nothing you can act on.
    const detail = await res.text().catch(() => '')
    let message = ''
    try {
      const parsed = JSON.parse(detail) as { error?: { message?: string } | string }
      message = typeof parsed.error === 'string' ? parsed.error : (parsed.error?.message ?? '')
    } catch {
      message = detail.slice(0, 300)
    }
    throw new Error(message || `${res.status} ${res.statusText}`)
  }
  const body = (await res.json()) as {
    choices?: { message?: { content?: string; reasoning_content?: string } }[]
    usage?: { total_tokens?: number }
    error?: string
  }
  if (body.error) throw new Error(body.error)
  const message = body.choices?.[0]?.message
  return {
    // A reasoning model that ran out of room before its answer has said
    // everything it managed to say in `reasoning_content` — showing that beats
    // showing an empty bubble.
    text: message?.content || message?.reasoning_content || '',
    tokens: body.usage?.total_tokens ?? 0
  }
}

/**
 * One call to a local OpenAI-compatible server, whoever is asking.
 *
 * Shared with the peer runner (peer.ts): the endpoint, the "start LM Studio if
 * it is down" side effect and the on-disk-vs-http model id reconciliation are
 * facts about the runtime, not about who is talking to it. Answers with the id
 * it actually ran, which is what the caller has to label the reply with.
 */
export async function askLocalModel(
  runtime: string,
  model: string | undefined,
  messages: { role: 'user' | 'assistant'; content: string }[]
): Promise<{ text: string; tokens: number; model: string }> {
  const base = runtime === 'lmstudio' ? 'http://127.0.0.1:1234/v1' : 'http://127.0.0.1:11434/v1'
  let id = model ?? ''
  if (runtime === 'lmstudio') {
    await ensureLmStudio()
    id = await resolveLmStudioModel(id)
  }
  const { text, tokens } = await openAiChat(base, id, messages)
  return { text, tokens, model: id }
}

/**
 * Pull the reply out of a CLI's JSON output.
 *
 * Both `gemini -o json` and `opencode run --format json` print JSON, but not
 * the same JSON — and opencode prints a stream of objects, one per line. This
 * takes the last thing that looks like assistant text either way, so a change
 * in the surrounding envelope does not silently return an empty answer.
 */
export function textFromJson(raw: string): { text: string; sessionId?: string } {
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean)
  let text = ''
  let sessionId: string | undefined
  for (const line of lines) {
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      continue
    }
    const o = value as Record<string, unknown>
    // gemini -o json: { response: "…" }
    if (typeof o.response === 'string' && o.response.trim()) text = o.response
    // opencode --format json: parts carrying text, plus the session it ran in.
    if (typeof o.sessionID === 'string') sessionId = o.sessionID
    if (typeof o.sessionId === 'string') sessionId = o.sessionId
    const part = o.part as Record<string, unknown> | undefined
    if (part && part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
      text = part.text
    }
    if (o.type === 'text' && typeof o.text === 'string' && o.text.trim()) text = o.text
  }
  if (text) return { text, sessionId }

  // We asked for JSON and got prose, which means the CLI answered something
  // other than our question — nearly always a sign-in prompt or a refusal.
  // Presenting that as the model's reply would be a lie; it is an error, and
  // the CLI's own first line is the most useful thing to say about it.
  const first = lines.find((l) => !l.startsWith('{')) ?? ''
  const stripped = first.replace(/\u001b\[[0-9;]*m/g, '').trim()
  throw new Error(stripped || 'no answer')
}

export async function runRuntime(
  win: BrowserWindow,
  key: string,
  worktreePath: string,
  prompt: string,
  runtime: string,
  model?: string,
  effort?: string,
  mode: PermissionMode = DEFAULT_MODE,
  /** The line as typed, when the handle addressing this runtime came off it. */
  shown?: string,
  /** The panel that typed it — it is already showing the line (AgentRunOptions). */
  panel?: string
): Promise<void> {
  // These runtimes write no transcript, so nothing on disk would say this
  // session was ever used. Stamp it, or the sidebar sorts it by the day it was
  // created for the rest of its life.
  touchCreatedSession(key)
  // Same turn bookkeeping as Claude's sendToAgent: a panel opening mid-turn
  // asks agent.replay for what it missed, whoever is answering.
  markTurnStart(key, { provider: runtime, model, effort, mode }, win, {
    text: shown ?? prompt,
    panel
  })
  // What this runtime has not seen — the turns another harness answered, or its
  // own from before the restart that emptied its thread. Read BEFORE the prompt
  // is logged, or the message being sent would come back inside its own packet.
  const seed = seedFor(win, key, worktreePath, runtime)
  // Logged as typed, not as sent: the packet is context we added, and a
  // transcript that showed it would put thousands of characters of history
  // under the user's name (and hand them straight back on the next switch).
  // Same rule for the `@codex` that addressed this runtime — the log is the
  // conversation, and the conversation is what was written.
  logTurn(key, { role: 'user', text: shown ?? prompt })
  // The user's standing instructions, once per thread. Above the packet on
  // purpose: the packet is data this turn is about, and an instruction placed
  // under the data it governs is read as part of it (see handoff.ts).
  const rules = houseRulesFor(key, runtime)
  if (seed) prompt = seed + prompt
  if (rules) prompt = rules + prompt
  // Codex already has a home: the app-server session (codexServer.ts), which
  // is also the only channel that can surface its request_user_input questions.
  // Snapped here rather than trusted: the picker snaps too, but a scheduled run
  // or an older saved choice can still arrive with a mode this runtime has no
  // flag for, and that fails the whole turn.
  const allowed = nearestMode(mode, runtime)
  if (runtime === 'codex')
    return chatWithCodexServer(win, key, worktreePath, prompt, model, effort, allowed)

  const thread = threads.get(key) ?? {}
  threads.set(key, thread)

  try {
    if (runtime === 'lmstudio' || runtime === 'ollama') {
      // We keep the conversation, so these are genuinely multi-turn.
      thread.messages = [...(thread.messages ?? []), { role: 'user', content: prompt }]
      const { text, tokens, model: id } = await askLocalModel(runtime, model, thread.messages)
      thread.messages.push({ role: 'assistant', content: text })
      if (text) say(win, key, text, { model: id, effort, provider: runtime })
      // A reasoning model that spent its whole budget thinking answers with
      // nothing at all. Saying so beats a turn that ends with no line in the
      // chat, which reads as the message never having been sent.
      else emit(win, key, { kind: 'error', message: `${runtime} answered with nothing — the model ran out of room before it wrote anything. Try again, or a shorter message.` })
      if (tokens > 0) emit(win, key, { kind: 'tokens', tokens })
      emit(win, key, { kind: 'done', ok: true })
      return
    }

    if (runtime === 'opencode') {
      // `--print-logs` sends its reasoning to stderr, which is the only place a
      // stalled run says what is wrong (a provider it cannot reach, say).
      const args = ['run', '--format', 'json', '--print-logs']
      if (model) args.push('-m', model)
      // opencode spells the mode as a built-in agent: `plan` reads and reasons,
      // `build` edits. There is nothing looser than build, which is why skip is
      // not on opencode's list of modes.
      args.push('--agent', allowed === 'plan' ? 'plan' : 'build')
      // ponytail: no `--variant`. opencode's variants are provider-specific
      // ("high", "max", "minimal" — not our five), and an unknown one fails the
      // run instead of being ignored. Map them per provider if it ever matters.
      // Continue the same session, so the chat is a conversation and not a
      // series of strangers.
      // Written down as well as held: opencode's session outlives our process,
      // and after a restart resuming it is the difference between a
      // conversation and a stranger (threads.ts).
      thread.sessionId = thread.sessionId ?? threadFor(key, 'opencode')
      if (thread.sessionId) args.push('-s', thread.sessionId)
      args.push(prompt)
      // Floe's own tools plus its MCP registry, in opencode's dialect: a JSON
      // blob in the environment, merged over the user's own config rather than
      // replacing it (mcpHarness.ts).
      const { text, sessionId } = textFromJson(
        await run('opencode', args, worktreePath, 3 * 60 * 1000, harnessMcp('opencode', key, worktreePath))
      )
      if (sessionId) {
        thread.sessionId = sessionId
        rememberThread(key, 'opencode', sessionId)
      }
      if (text) say(win, key, text, { model, effort, provider: runtime })
      emit(win, key, { kind: 'done', ok: true })
      return
    }

    if (runtime === 'gemini') {
      // gemini's three approval modes line up with ours from "ask" upwards; it
      // has no read-only mode, which is why plan is not on gemini's list.
      const approval =
        allowed === 'skip' ? 'yolo' : allowed === 'acceptEdits' ? 'auto_edit' : 'default'
      const args = ['-p', prompt, '-o', 'json', '--approval-mode', approval]
      if (model) args.push('-m', model)
      // ponytail: one turn at a time. `--resume` takes "latest" or an index
      // rather than an id we chose, so there is no way to name OUR session
      // among several open at once. Sending the transcript as context would be
      // the upgrade, once these panels can hand one over.
      const { text } = textFromJson(
        await run('gemini', args, worktreePath, 3 * 60 * 1000, harnessMcp('gemini', key, worktreePath))
      )
      if (text) say(win, key, text, { model, effort, provider: runtime })
      emit(win, key, { kind: 'done', ok: true })
      return
    }

    throw new Error(`no runtime for "${runtime}"`)
  } catch (e) {
    const raw = (e as Error).message
    // The turn never landed, so the standing instructions never landed either:
    // put them back on the pile or the next (working) turn would run without
    // them, because this one was counted as having delivered them.
    forgetHouseRules(key, runtime)
    // "Opening authentication page…" is not an error message, it is a symptom.
    // Say what it means for the thing the user actually pressed.
    const auth = /authenticat|sign in|log ?in|credential|api key/i.test(raw)
    emit(win, key, {
      kind: 'error',
      message: auth ? `${runtime} is not signed in — run \`${runtime}\` once in a terminal (${raw})` : `${runtime}: ${raw}`
    })
    emit(win, key, { kind: 'done', ok: false })
  }
}
