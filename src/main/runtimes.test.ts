import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import type { AgentEvent } from '../shared/types.ts'
import { installHook } from './config/hook.test-helper.ts'

// Everything these runtimes touch is either an HTTP call to a local model
// server or a CLI on PATH. The server is a fake `fetch`; the CLIs are two
// shell scripts in a bin dir at the front of PATH, so `run()` really spawns,
// really reads stdout and really kills a process — with nothing installed.
const HOME = mkdtempSync(join(tmpdir(), 'floe-runtimes-'))
process.env.FLOE_TEST_USERDATA = HOME
const BIN = join(HOME, 'bin')
mkdirSync(BIN, { recursive: true })
const realPath = process.env.PATH ?? ''
process.env.PATH = `${BIN}:${realPath}`

// The house rules come out of `configDir()`, which honours XDG_CONFIG_HOME.
// Pointed at the scratch dir so a turn never picks up the real
// ~/.config/floe/system-prompt.md — the user's own instructions in the middle
// of an argv assertion.
const CONFIG = join(HOME, 'config')
process.env.XDG_CONFIG_HOME = CONFIG

const ARGV = join(HOME, 'argv.log')
process.env.FAKE_ARGV = ARGV

const FAKE = `#!/bin/sh
printf '%s\\n' "$@" >> "$FAKE_ARGV"
printf 'ENDARGS\\n' >> "$FAKE_ARGV"
if [ -n "$FAKE_STDERR" ]; then printf '%s\\n' "$FAKE_STDERR" >&2; fi
if [ -n "$FAKE_STDOUT" ]; then printf '%s\\n' "$FAKE_STDOUT"; fi
exit \${FAKE_CODE:-0}
`
for (const name of ['opencode', 'gemini']) {
  writeFileSync(join(BIN, name), FAKE)
  chmodSync(join(BIN, name), 0o755)
}

/** What the next CLI run prints, and with what exit code. */
function cli(out: string, opts: { stderr?: string; code?: number } = {}): void {
  rmSync(ARGV, { force: true })
  process.env.FAKE_STDOUT = out
  process.env.FAKE_STDERR = opts.stderr ?? ''
  process.env.FAKE_CODE = String(opts.code ?? 0)
}

/** The argument lists the CLI was called with, one array per invocation. */
const argv = (): string[][] =>
  readFileSync(ARGV, 'utf8')
    .split('ENDARGS\n')
    .filter((chunk) => chunk.trim())
    .map((chunk) => chunk.split('\n').filter(Boolean))

installHook()

const { runRuntime, forgetThread } = await import('./runtimes.ts')
const { setSharedDataDir } = await import('./dataDir.ts')
setSharedDataDir(join(HOME, 'data'))

// ── the local model servers ─────────────────────────────────────────────────

type Reply = { ok: boolean; status?: number; statusText?: string; body?: unknown; text?: string }
let up = true
let served: { id: string; type?: string }[] = []
let reply: Reply = { ok: true, body: { choices: [{ message: { content: 'hi' } }] } }
const posted: { url: string; body: { model: string; messages: { role: string; content: string }[] } }[] = []

const realFetch = globalThis.fetch
globalThis.fetch = (async (input: string, init?: { body?: string }) => {
  const url = String(input)
  if (url.endsWith('/chat/completions')) {
    posted.push({ url, body: JSON.parse(init?.body ?? '{}') })
    if (!reply.ok)
      return {
        ok: false,
        status: reply.status ?? 400,
        statusText: reply.statusText ?? 'Bad Request',
        text: async () => reply.text ?? ''
      }
    return { ok: true, json: async () => reply.body }
  }
  if (!up) throw new Error('connection refused')
  if (url.endsWith('/api/v0/models')) return { ok: true, json: async () => ({ data: served }) }
  if (url.endsWith('/v1/models')) return { ok: true }
  throw new Error(`unexpected fetch: ${url}`)
}) as unknown as typeof fetch

// ── the window ──────────────────────────────────────────────────────────────

function fakeWin(): { win: BrowserWindow; events: AgentEvent[] } {
  const events: AgentEvent[] = []
  const win = {
    isDestroyed: () => false,
    webContents: { send: (_ch: string, payload: { event: AgentEvent }) => events.push(payload.event) }
  }
  return { win: win as unknown as BrowserWindow, events }
}

const text = (events: AgentEvent[]): string[] =>
  events.flatMap((e) => (e.kind === 'text' ? [e.text] : []))
const errors = (events: AgentEvent[]): string[] =>
  events.flatMap((e) => (e.kind === 'error' ? [e.message] : []))
const ok = (events: AgentEvent[]): boolean | undefined => {
  const done = events.filter((e) => e.kind === 'done')
  assert.equal(done.length, 1, 'exactly one done event')
  return done[0].kind === 'done' ? done[0].ok : undefined
}

const worktree = mkdtempSync(join(tmpdir(), 'floe-runtimes-wt-'))
let n = 0
/** A fresh session key per turn: threads and transcripts are keyed by it. */
const key = (): string => `sess-${++n}`

// ── lmstudio / ollama ───────────────────────────────────────────────────────

test('lmstudio: the picker’s directory name is resolved to the id the API takes', async () => {
  up = true
  served = [{ id: 'kimi-k2.7-code', type: 'llm' }]
  reply = { ok: true, body: { choices: [{ message: { content: 'hello' } }], usage: { total_tokens: 42 } } }
  const { win, events } = fakeWin()
  await runRuntime(win, key(), worktree, 'ping', 'lmstudio', 'unsloth/Kimi-K2.7-Code-GGUF')

  const sent = posted.at(-1)
  assert.equal(sent?.url, 'http://127.0.0.1:1234/v1/chat/completions')
  // `unsloth/Kimi-K2.7-Code-GGUF` and `kimi-k2.7-code` are the same model:
  // compared on letters and digits alone, one is a prefix of the other.
  assert.equal(sent?.body.model, 'kimi-k2.7-code')
  assert.deepEqual(sent?.body.messages, [{ role: 'user', content: 'ping' }])
  assert.deepEqual(text(events), ['hello'])
  assert.deepEqual(
    events.flatMap((e) => (e.kind === 'tokens' ? [e.tokens] : [])),
    [42]
  )
  assert.equal(ok(events), true)
})

test('lmstudio: an id the server already lists is sent unchanged', async () => {
  up = true
  served = [{ id: 'qwen3-4b' }, { id: 'kimi-k2.7-code' }]
  reply = { ok: true, body: { choices: [{ message: { content: 'a' } }] } }
  const { win } = fakeWin()
  await runRuntime(win, key(), worktree, 'ping', 'lmstudio', 'qwen3-4b')
  assert.equal(posted.at(-1)?.body.model, 'qwen3-4b')
})

test('lmstudio: nothing to resolve against leaves the id alone', async () => {
  const { win } = fakeWin()
  // Server up but listing nothing…
  up = true
  served = []
  await runRuntime(win, key(), worktree, 'ping', 'lmstudio', 'mystery-model')
  assert.equal(posted.at(-1)?.body.model, 'mystery-model')
  // …and a listing with no relative of the wanted model.
  served = [{ id: 'llama3' }]
  await runRuntime(win, key(), worktree, 'ping', 'lmstudio', 'mystery-model')
  assert.equal(posted.at(-1)?.body.model, 'mystery-model')
})

test('lmstudio: the conversation is ours, so it is genuinely multi-turn', async () => {
  up = true
  served = []
  const k = key()
  const { win } = fakeWin()
  reply = { ok: true, body: { choices: [{ message: { content: 'first answer' } }] } }
  await runRuntime(win, k, worktree, 'one', 'lmstudio', 'm')
  reply = { ok: true, body: { choices: [{ message: { content: 'second answer' } }] } }
  await runRuntime(win, k, worktree, 'two', 'lmstudio', 'm')

  const sent = posted.at(-1)?.body.messages ?? []
  assert.equal(sent.length, 3)
  assert.deepEqual(sent[1], { role: 'assistant', content: 'first answer' })
  assert.equal(sent[0].role, 'user')
  assert.ok(sent[0].content.endsWith('one'))
  assert.ok(sent[2].content.endsWith('two'))

  // Forgetting the thread starts the next turn from nothing.
  forgetThread(k)
  reply = { ok: true, body: { choices: [{ message: { content: 'third' } }] } }
  await runRuntime(win, k, worktree, 'three', 'lmstudio', 'm')
  assert.equal(posted.at(-1)?.body.messages.length, 1)
})

test('ollama talks to its own port, and is never asked to resolve a model', async () => {
  up = true
  posted.length = 0
  reply = { ok: true, body: { choices: [{ message: { content: 'woof' } }] } }
  const { win, events } = fakeWin()
  await runRuntime(win, key(), worktree, 'ping', 'ollama', 'llama3:8b')
  assert.deepEqual(
    posted.map((p) => p.url),
    ['http://127.0.0.1:11434/v1/chat/completions']
  )
  assert.equal(posted[0].body.model, 'llama3:8b')
  assert.deepEqual(text(events), ['woof'])
})

test('an answer with no content falls back to what the model managed to think', async () => {
  up = true
  reply = {
    ok: true,
    body: { choices: [{ message: { content: '', reasoning_content: 'halfway through…' } }] }
  }
  const { win, events } = fakeWin()
  await runRuntime(win, key(), worktree, 'ping', 'ollama', 'm')
  assert.deepEqual(text(events), ['halfway through…'])
})

test('an answer with nothing at all is said out loud, not left blank', async () => {
  up = true
  reply = { ok: true, body: { choices: [{ message: { content: '' } }], usage: { total_tokens: 0 } } }
  const { win, events } = fakeWin()
  await runRuntime(win, key(), worktree, 'ping', 'ollama', 'm')
  assert.deepEqual(text(events), [])
  assert.match(errors(events)[0], /ollama answered with nothing/)
  // A turn that produced no text still ends cleanly — the run itself worked.
  assert.equal(ok(events), true)
  assert.equal(
    events.filter((e) => e.kind === 'tokens').length,
    0,
    'no token gauge for zero tokens'
  )
})

test('a failed completion says what the body said, not "400 Bad Request"', async () => {
  up = true
  const cases: [Reply, RegExp][] = [
    [{ ok: false, text: JSON.stringify({ error: { message: 'model not loaded' } }) }, /model not loaded/],
    [{ ok: false, text: JSON.stringify({ error: 'insufficient system resources' }) }, /insufficient system resources/],
    [{ ok: false, text: 'plain text explosion' }, /plain text explosion/],
    [{ ok: false, text: '', status: 503, statusText: 'Service Unavailable' }, /503 Service Unavailable/],
    [{ ok: true, body: { error: 'no model loaded' } }, /no model loaded/]
  ]
  for (const [r, expected] of cases) {
    reply = r
    const { win, events } = fakeWin()
    await runRuntime(win, key(), worktree, 'ping', 'ollama', 'm')
    assert.match(errors(events)[0], expected)
    assert.match(errors(events)[0], /^ollama: /)
    assert.equal(ok(events), false)
  }
})

// ── opencode ────────────────────────────────────────────────────────────────

test('opencode: the reply and the session id come out of its JSON stream', async () => {
  cli(
    [
      '{"type":"log","message":"connecting"}',
      'not json at all',
      '{"sessionID":"ses_abc","part":{"type":"text","text":"first part"}}',
      '{"part":{"type":"text","text":"  "}}',
      '{"part":{"type":"text","text":"the answer"}}'
    ].join('\n')
  )
  const k = key()
  const { win, events } = fakeWin()
  await runRuntime(win, k, worktree, 'hello', 'opencode', 'anthropic/sonnet')

  // The LAST part that carries text wins; blank parts and prose are skipped.
  assert.deepEqual(text(events), ['the answer'])
  assert.equal(ok(events), true)
  const args = argv()[0]
  assert.deepEqual(args.slice(0, 4), ['run', '--format', 'json', '--print-logs'])
  assert.ok(args.includes('-m') && args.includes('anthropic/sonnet'))
  // "ask" is not something opencode can do, so the default mode snaps to plan.
  assert.deepEqual(args.slice(-3), ['--agent', 'plan', 'hello'])
  assert.equal(args.includes('-s'), false, 'no session to continue on the first turn')

  // The id it reported is carried into the next turn.
  cli('{"type":"text","text":"again"}')
  await runRuntime(win, k, worktree, 'more', 'opencode', undefined, undefined, 'skip')
  // `skip` is looser than anything opencode has: it snaps to build.
  const second = argv()[0]
  assert.deepEqual(second.slice(-5), ['--agent', 'build', '-s', 'ses_abc', 'more'])
  assert.equal(second.includes('-m'), false, 'no model flag when none was picked')
})

test('opencode: `sessionId` spelled the other way is read too', async () => {
  cli('{"sessionId":"ses_camel","part":{"type":"text","text":"ok"}}')
  const k = key()
  const { win } = fakeWin()
  await runRuntime(win, k, worktree, 'a', 'opencode')
  cli('{"type":"text","text":"b"}')
  await runRuntime(win, k, worktree, 'b', 'opencode')
  assert.ok(argv()[0].includes('ses_camel'))
})

test('a CLI that answers prose instead of JSON is an error, not a reply', async () => {
  // ANSI codes and all: the first non-JSON line is what it has to say.
  cli('[33mPlease sign in to continue[0m')
  const { win, events } = fakeWin()
  await runRuntime(win, key(), worktree, 'hi', 'opencode')
  assert.deepEqual(text(events), [])
  // "sign in" is a symptom with a known cure, so the message says the cure.
  assert.equal(
    errors(events)[0],
    'opencode is not signed in — run `opencode` once in a terminal (Please sign in to continue)'
  )
  assert.equal(ok(events), false)
})

test('a CLI that prints nothing usable says "no answer"', async () => {
  cli('{"type":"log","message":"nothing to say"}')
  const { win, events } = fakeWin()
  await runRuntime(win, key(), worktree, 'hi', 'opencode')
  assert.equal(errors(events)[0], 'opencode: no answer')
})

// ── gemini ──────────────────────────────────────────────────────────────────

test('gemini: -o json, the prompt, and our mode in its own spelling', async () => {
  const modes = [
    ['skip', 'yolo'],
    ['acceptEdits', 'auto_edit'],
    ['plan', 'default'] // gemini has no read-only mode: plan snaps to ask
  ] as const
  for (const [mode, approval] of modes) {
    cli('{"response":"the gemini answer"}')
    const { win, events } = fakeWin()
    await runRuntime(win, key(), worktree, 'hi', 'gemini', 'gemini-3-pro', undefined, mode)
    assert.deepEqual(text(events), ['the gemini answer'])
    assert.equal(ok(events), true)
    const args = argv()[0]
    assert.deepEqual(args.slice(0, 6), ['-p', 'hi', '-o', 'json', '--approval-mode', approval])
    assert.deepEqual(args.slice(6), ['-m', 'gemini-3-pro'])
  }
})

// ── the house rules ─────────────────────────────────────────────────────────

test('the standing instructions ride on the first message of a thread, once', async () => {
  const promptFile = join(CONFIG, 'floe', 'system-prompt.md')
  mkdirSync(join(CONFIG, 'floe'), { recursive: true })
  writeFileSync(promptFile, '<!-- a comment, never sent -->\nAnswer in Portuguese.\n')
  const k = key()
  const { win } = fakeWin()

  // The fake CLI logs one line per argv entry, so a multi-line prompt arrives
  // split: what was sent is everything after the last flag, rejoined.
  const sent = (): string => {
    const args = argv()[0]
    return args.slice(args.indexOf('--print-logs') + 1).join('\n')
  }

  cli('{"sessionID":"ses_rules","part":{"type":"text","text":"claro"}}')
  await runRuntime(win, k, worktree, 'oi', 'opencode')
  const first = sent()
  assert.match(first, /<!-- floe:house-rules:v1 -->/, 'the block rides at the top')
  assert.match(first, /Answer in Portuguese\./)
  assert.ok(!first.includes('a comment, never sent'), 'HTML comments are stripped')
  assert.ok(first.endsWith('oi'), 'the user prompt still comes last')

  // Second turn on the same thread: opencode has them already, and repeating
  // them every turn is a paragraph of noise per message.
  cli('{"type":"text","text":"de novo"}')
  await runRuntime(win, k, worktree, 'e agora', 'opencode')
  assert.equal(sent().includes('floe:house-rules'), false)
  assert.ok(sent().endsWith('e agora'))

  // A reset thread is a new one, so they go again.
  forgetThread(k)
  cli('{"type":"text","text":"outra vez"}')
  await runRuntime(win, k, worktree, 'de novo', 'opencode')
  assert.match(sent(), /<!-- floe:house-rules:v1 -->/)

  // A turn that failed delivered nothing, so the rules go with the retry.
  const k2 = key()
  cli('', { stderr: 'Error: provider unreachable', code: 2 })
  await runRuntime(win, k2, worktree, 'oi', 'opencode')
  cli('{"type":"text","text":"agora vai"}')
  await runRuntime(win, k2, worktree, 'oi', 'opencode')
  assert.match(sent(), /<!-- floe:house-rules:v1 -->/)

  rmSync(promptFile, { force: true })
})

test('a CLI that exits non-zero fails the turn with its last stderr line', async () => {
  cli('', { stderr: 'warming up\nError: provider unreachable', code: 2 })
  const { win, events } = fakeWin()
  await runRuntime(win, key(), worktree, 'hi', 'gemini')
  assert.equal(errors(events)[0], 'gemini: Error: provider unreachable')
  assert.equal(ok(events), false)
})

test('a CLI that exits non-zero silently is reported with its exit code', async () => {
  cli('', { code: 3 })
  const { win, events } = fakeWin()
  await runRuntime(win, key(), worktree, 'hi', 'gemini')
  assert.equal(errors(events)[0], 'gemini: gemini exited 3')
})

test('a CLI that stops to ask a question is killed, not waited on', async () => {
  // Nobody is at this end of the pipe, so the question is the answer.
  cli('Do you want to continue? [Y/n]')
  const { win, events } = fakeWin()
  await runRuntime(win, key(), worktree, 'hi', 'gemini')
  assert.equal(errors(events)[0], 'gemini: Do you want to continue? [Y/n]')
  assert.equal(ok(events), false)
})

test('a CLI that is not installed says so', async () => {
  const withBin = process.env.PATH
  process.env.PATH = '/nonexistent'
  try {
    cli('{"response":"never printed"}')
    const { win, events } = fakeWin()
    await runRuntime(win, key(), worktree, 'hi', 'gemini')
    assert.equal(errors(events)[0], 'gemini: gemini not found')
    assert.equal(ok(events), false)
  } finally {
    process.env.PATH = withBin
  }
})

test('a runtime with no branch fails the turn instead of going quiet', async () => {
  const { win, events } = fakeWin()
  await runRuntime(win, key(), worktree, 'hi', 'wat')
  assert.equal(errors(events)[0], 'wat: no runtime for "wat"')
  assert.equal(ok(events), false)
})

test('the turn is announced before anyone answers', async () => {
  up = true
  reply = { ok: true, body: { choices: [{ message: { content: 'x' } }] } }
  const { win, events } = fakeWin()
  await runRuntime(win, key(), worktree, 'hi', 'ollama', 'm', 'high')
  const turn = events[0]
  assert.equal(turn.kind, 'turn')
  assert.deepEqual(turn.kind === 'turn' ? { provider: turn.provider, model: turn.model } : null, {
    provider: 'ollama',
    model: 'm'
  })
})

after(() => {
  globalThis.fetch = realFetch
  process.env.PATH = realPath
})
