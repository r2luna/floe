import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { register } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import type { AgentEvent } from '../shared/types'

// codex.ts pulls in modules that import `electron`, plus value imports
// from ../shared/types — neither resolvable by raw Node ESM. Register the same
// hermetic hook the other main tests use (rewrite extensionless `./x` → `./x.ts`,
// stub `electron`) before importing codex, so this pure-function test can load it.
//
// On top of that: `node:child_process` is swapped for a stub, but only for
// codex.ts itself, so spawning `codex` is a test-controlled fake child instead of
// a real CLI. Everything else in the graph keeps the real module.
const hookSource = `
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
export async function resolve(specifier, context, next) {
  if (specifier === 'electron') return { url: 'stub:electron', shortCircuit: true, format: 'module' }
  if (specifier === 'node:child_process' && context.parentURL?.endsWith('/codex.ts')) {
    return { url: 'stub:child_process', shortCircuit: true, format: 'module' }
  }
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\\.[a-z]+$/i.test(specifier)) {
    try {
      const base = context.parentURL ? new URL(specifier, context.parentURL) : pathToFileURL(specifier)
      const tsPath = fileURLToPath(base) + '.ts'
      if (existsSync(tsPath)) return next(specifier + '.ts', context)
    } catch {}
  }
  return next(specifier, context)
}
export async function load(url, context, next) {
  if (url === 'stub:electron') {
    const src = [
      "export const app = { getPath: () => process.env.FLOE_TEST_USERDATA || '/tmp' };",
      'export class BrowserWindow {}',
      'export const Menu = { setApplicationMenu(){}, buildFromTemplate: () => ({}) };',
      'export class Notification {}',
      'export const dialog = {};',
      'export const ipcMain = { handle(){}, on(){} };',
      'export const nativeTheme = { on(){}, get shouldUseDarkColors(){ return false } };',
      'export const safeStorage = { isEncryptionAvailable: () => false };',
      'export const shell = {};',
      'export default {};'
    ].join('\\n')
    return { format: 'module', shortCircuit: true, source: src }
  }
  if (url === 'stub:child_process') {
    const src = 'export function spawn(cmd, args, opts) { return globalThis.__floeSpawnCodex(cmd, args, opts) }\\nexport default { spawn }'
    return { format: 'module', shortCircuit: true, source: src }
  }
  return next(url, context)
}
`
register('data:text/javascript,' + encodeURIComponent(hookSource), import.meta.url)

// Every disk read codex.ts does hangs off HOME (~/.codex/…); every write hangs
// off the electron userData stub. Both go to throwaway dirs.
const home = mkdtempSync(join(tmpdir(), 'floe-codex-home-'))
process.env.HOME = home
process.env.FLOE_TEST_USERDATA = mkdtempSync(join(tmpdir(), 'floe-codex-data-'))

const { nextExchange, MAX_EXCHANGES, codexModels, resolveModel, askCodex, chatWithCodex, getCodexUsage } =
  await import('./codex.ts')

// ---------------------------------------------------------------- fixtures

/** Rewrite ~/.codex from scratch; both files are optional. */
function seedHome(opts: { cache?: unknown; config?: string }): void {
  const dir = mkdtempSync(join(tmpdir(), 'floe-codex-home-'))
  mkdirSync(join(dir, '.codex'), { recursive: true })
  if (opts.cache !== undefined) writeFileSync(join(dir, '.codex', 'models_cache.json'), JSON.stringify(opts.cache))
  if (opts.config !== undefined) writeFileSync(join(dir, '.codex', 'config.toml'), opts.config)
  process.env.HOME = dir
}

const TWO_MODELS = {
  models: [
    { slug: 'gpt-5.5', display_name: 'GPT-5.5', context_window: 272_000, visibility: 'list', supported_in_api: true },
    { slug: 'gpt-5.1-codex-max', visibility: 'list', supported_in_api: true },
    { slug: 'internal-preview', visibility: 'hidden', supported_in_api: true },
    { slug: 'chat-only', visibility: 'list', supported_in_api: false }
  ]
}

interface FakeChild extends EventEmitter {
  stdin: EventEmitter & { end: () => void; write: (s: string) => boolean; ended: boolean; lines: string[] }
  stdout: EventEmitter & { setEncoding: (e: string) => void }
  stderr: EventEmitter & { setEncoding: (e: string) => void }
  kill: (sig?: string) => boolean
  signals: string[]
}

interface Spawned {
  cmd: string
  args: string[]
  opts: { cwd?: string }
  child: FakeChild
}

const spawns: Spawned[] = []

// The seam the child_process stub above calls through.
declare global {
  var __floeSpawnCodex: (cmd: string, args: string[], opts: { cwd?: string }) => FakeChild
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild
  const stdin = new EventEmitter() as FakeChild['stdin']
  stdin.ended = false
  stdin.lines = []
  stdin.end = (): void => {
    stdin.ended = true
  }
  stdin.write = (line: string): boolean => {
    stdin.lines.push(line)
    return true
  }
  child.stdin = stdin
  for (const name of ['stdout', 'stderr'] as const) {
    const s = new EventEmitter() as FakeChild['stdout']
    s.setEncoding = (): void => {}
    child[name] = s
  }
  child.signals = []
  child.kill = (sig = 'SIGTERM'): boolean => {
    child.signals.push(sig)
    return true
  }
  return child
}

globalThis.__floeSpawnCodex = (cmd: string, args: string[], opts: { cwd?: string }): FakeChild => {
  const child = fakeChild()
  spawns.push({ cmd, args, opts, child })
  return child
}

/** The process the code under test just started. */
const last = (): Spawned => spawns[spawns.length - 1]

function fakeWin(): { win: BrowserWindow; events: AgentEvent[] } {
  const events: AgentEvent[] = []
  const win = {
    isDestroyed: () => false,
    webContents: { send: (_ch: string, payload: { event: AgentEvent }) => events.push(payload.event) }
  }
  return { win: win as unknown as BrowserWindow, events }
}

/** Feed a codex JSONL stream to the live child and close it. */
function stream(child: FakeChild, lines: string[], opts: { stderr?: string; code?: number } = {}): void {
  if (lines.length) child.stdout.emit('data', lines.join('\n') + '\n')
  if (opts.stderr) child.stderr.emit('data', opts.stderr)
  child.emit('close', opts.code ?? 0)
}

const REPLY = (text: string): string => JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } })

// ---------------------------------------------------------------- the tests

// The exchange window: MAX_EXCHANGES real turns, then one capped call that resets
// the window so the next round starts fresh after the user's guidance.
test('nextExchange caps after MAX_EXCHANGES and then resets', () => {
  const state = { step: 0 }
  for (let i = 1; i <= MAX_EXCHANGES; i++) {
    assert.deepEqual(nextExchange(state), { capped: false })
    assert.equal(state.step, i)
  }
  // Window full: next call is capped and does not consume a step.
  assert.deepEqual(nextExchange(state), { capped: true })
  assert.equal(state.step, 0)
  // Fresh round after the cap.
  assert.deepEqual(nextExchange(state), { capped: false })
  assert.equal(state.step, 1)
})

test('codexModels offers only the user-listable, API-supported cache entries', () => {
  seedHome({ cache: TWO_MODELS })
  assert.deepEqual(codexModels(), [
    { slug: 'gpt-5.5', label: 'GPT-5.5', contextWindow: 272_000 },
    // No display_name / context_window: the slug is the label and the shared
    // default is the window, so the picker never shows a blank row.
    { slug: 'gpt-5.1-codex-max', label: 'gpt-5.1-codex-max', contextWindow: 272_000 }
  ])
})

test('an unusable cache falls back to the model in config.toml', () => {
  // Every entry filtered out — same outcome as no cache at all.
  seedHome({ cache: { models: [{ slug: 'x', visibility: 'hidden' }] }, config: 'model = "gpt-5.1-codex"\n' })
  assert.deepEqual(codexModels(), [{ slug: 'gpt-5.1-codex', label: 'gpt-5.1-codex', contextWindow: 272_000 }])
})

test('no cache and no config still yields one option', () => {
  seedHome({})
  assert.deepEqual(codexModels(), [{ slug: 'gpt-5.5', label: 'gpt-5.5', contextWindow: 272_000 }])
})

test('resolveModel keeps a slug codex still offers and drops one it does not', () => {
  seedHome({ cache: TWO_MODELS })
  assert.equal(resolveModel('gpt-5.1-codex-max'), 'gpt-5.1-codex-max')
  // The legacy stored value, and anything else retired, falls to the first
  // available model so a stale session still runs.
  assert.equal(resolveModel('codex'), 'gpt-5.5')
  assert.equal(resolveModel(undefined), 'gpt-5.5')
})

test('askCodex drives one exec turn and reports it as a subagent row', async () => {
  seedHome({ cache: TWO_MODELS })
  const { win, events } = fakeWin()
  const p = askCodex(win, 's1', '/work/tree', 'compare the two parsers')

  const { cmd, args, opts, child } = last()
  assert.equal(cmd, 'codex')
  assert.equal(opts.cwd, '/work/tree')
  assert.deepEqual(args.slice(0, 7), ['exec', '--json', '--skip-git-repo-check', '-m', 'gpt-5.5', '-s', 'read-only'])
  assert.equal(args[7], '--', "'--' must terminate option parsing before the prompt")
  // A fresh thread gets the machine-to-machine contract; the prompt rides last.
  assert.match(args[8], /^\[M2M PROTOCOL\]/)
  assert.ok(args[8].endsWith('compare the two parsers'))
  assert.equal(child.stdin.ended, true, 'stdin must be closed or `codex exec` never starts a turn')

  stream(child, [
    'codex 0.9.0 starting…', // a stray log line, not JSON
    '{"type":"item.started"', // a truncated line
    '{"type":"thread.started","thread_id":"th-abc-1"}',
    JSON.stringify({ type: 'item.completed', item: { type: 'command_execution' } }),
    REPLY('draft'),
    REPLY('parser B wins'), // the LAST agent_message is the reply
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1200, output_tokens: 34, cached_input_tokens: 900 } })
  ])

  assert.deepEqual(await p, { capped: false, reply: 'parser B wins', exchange: 1 })
  assert.equal(events[0].kind, 'subagent-start')
  assert.equal(events[0].description, 'compare the two parsers', 'the preamble stays out of the row title')
  const progress = events.filter((e) => e.kind === 'subagent-progress')
  assert.deepEqual(
    progress.map((e) => (e as { tool?: string }).tool),
    ['command_execution', 'agent_message', 'agent_message']
  )
  const done = events.at(-1) as { kind: string; reply?: string }
  assert.equal(done.kind, 'subagent-done')
  assert.equal(done.reply, 'parser B wins')
})

test('the next exchange resumes the thread codex reported, without the preamble', async () => {
  const { win } = fakeWin()
  const p = askCodex(win, 's1', '/work/tree', 'and the allocator?')
  const { args, child } = last()
  assert.deepEqual(args.slice(0, 6), ['exec', 'resume', 'th-abc-1', '--json', '--skip-git-repo-check', '-m'])
  assert.equal(args.at(-1), 'and the allocator?')
  assert.ok(!args.includes('-s'), 'resume inherits the sandbox from the first turn')
  stream(child, [REPLY('same')])
  assert.equal((await p).exchange, 2)
})

test('a new topic forgets the thread and restarts the exchange count', async () => {
  const { win } = fakeWin()
  const p = askCodex(win, 's1', '/work/tree', 'different question', true)
  const { args, child } = last()
  assert.equal(args[0], 'exec')
  assert.notEqual(args[1], 'resume')
  stream(child, [REPLY('ok')])
  assert.deepEqual(await p, { capped: false, reply: 'ok', exchange: 1 })
})

test('a thread id that is not a plain token is never used as argv', async () => {
  const { win } = fakeWin()
  const first = askCodex(win, 'evil', '/w', 'go')
  // codex's own output is still input: a thread id shaped like a flag must not
  // become a leading argument.
  stream(last().child, ['{"type":"thread.started","thread_id":"-c sandbox_mode=danger-full-access"}', REPLY('a')])
  await first

  const second = askCodex(win, 'evil', '/w', 'again')
  assert.notEqual(last().args[1], 'resume', 'a bad thread id falls back to a fresh thread')
  stream(last().child, [REPLY('b')])
  await second
})

test('the exchange cap stops calling codex until the user weighs in', async () => {
  const { win } = fakeWin()
  const turn = async (): Promise<unknown> => {
    const p = askCodex(win, 'capped', '/w', 'q')
    stream(last().child, [REPLY('a')])
    return p
  }
  for (let i = 0; i < MAX_EXCHANGES; i++) await turn()
  const before = spawns.length
  assert.deepEqual(await askCodex(win, 'capped', '/w', 'one too many'), { capped: true })
  assert.equal(spawns.length, before, 'a capped call must not spawn codex at all')
  // The window reset, so the user saying "keep going" starts a fresh round.
  assert.equal(((await turn()) as { exchange: number }).exchange, 1)
})

test('a turn that produces no reply surfaces codex stderr, and the row still closes', async () => {
  const { win, events } = fakeWin()
  const p = askCodex(win, 'boom', '/w', 'q')
  stream(last().child, [], { stderr: '  stream error: 401 unauthorized\n', code: 1 })
  const r = (await p) as { error?: string; reply?: string }
  assert.equal(r.error, 'stream error: 401 unauthorized')
  assert.equal(r.reply, undefined)
  const done = events.at(-1) as { kind: string; reply?: string }
  assert.equal(done.kind, 'subagent-done', 'the subagent row must not be left running')
  assert.equal(done.reply, undefined)
})

test('a missing codex binary says so instead of leaking the spawn error', async () => {
  const { win } = fakeWin()
  const p = askCodex(win, 'enoent', '/w', 'q')
  last().child.emit('error', new Error('spawn codex ENOENT'))
  assert.equal(((await p) as { error?: string }).error, 'codex CLI not found on PATH.')
})

test('chatWithCodex streams the reply, the token fill and done into the session', async () => {
  seedHome({ cache: TWO_MODELS })
  const { win, events } = fakeWin()
  const p = chatWithCodex(win, 'chat-1', '/w', 'hello', 'gpt-5.1-codex-max', 'xhigh')
  const { args, child } = last()
  assert.deepEqual(args.slice(0, 5), ['exec', '--json', '--skip-git-repo-check', '-m', 'gpt-5.1-codex-max'])
  // Floe's five effort levels collapse onto codex's three: xhigh → high.
  assert.ok(args.includes('-c') && args.includes('model_reasoning_effort=high'))
  assert.equal(args.at(-1), 'hello', 'the user prompt is sent verbatim, with no M2M preamble')

  // Split across chunks: the reply arrives in two writes that do not line up
  // with the newline.
  child.stdout.emit('data', '{"type":"item.completed","item":{"type":"agent_mess')
  child.stdout.emit('data', 'age","text":"hi there"}}\n')
  stream(child, [JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 90, output_tokens: 10 } })])
  await p

  assert.deepEqual(
    events.map((e) => e.kind),
    ['text', 'tokens', 'done']
  )
  assert.equal((events[0] as { text: string }).text, 'hi there')
  // input + output is the context-window fill; cached_input_tokens is a subset
  // of input and must not be added again.
  assert.equal((events[1] as { tokens: number }).tokens, 100)
  assert.equal((events[2] as { ok: boolean }).ok, true)
})

test('chatWithCodex reports a failed turn as error + done(false)', async () => {
  const { win, events } = fakeWin()
  const p = chatWithCodex(win, 'chat-2', '/w', 'hello', undefined)
  stream(last().child, [], { stderr: 'no such model' })
  await p
  assert.deepEqual(
    events.map((e) => e.kind),
    ['error', 'done']
  )
  assert.equal((events[0] as { message: string }).message, 'no such model')
  assert.equal((events[1] as { ok: boolean }).ok, false)
})

test('getCodexUsage speaks the app-server handshake and parses the rate limits', async () => {
  const p = getCodexUsage()
  const { cmd, args, child } = last()
  assert.equal(cmd, 'codex')
  assert.deepEqual(args, ['app-server'])
  // initialize first, then the read — the server rejects the read on its own.
  assert.deepEqual(
    child.stdin.lines.map((l) => (JSON.parse(l) as { method: string }).method),
    ['initialize', 'account/rateLimits/read']
  )
  child.stdout.emit('data', 'not json at all\n')
  child.stdout.emit(
    'data',
    JSON.stringify({ jsonrpc: '2.0', id: 1, result: { userAgent: 'codex' } }) + '\n'
  )
  child.stdout.emit(
    'data',
    JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      result: {
        rateLimits: {
          planType: 'pro',
          primary: { usedPercent: 12.5, resetsAt: 1_760_000_000, windowDurationMins: 300 },
          secondary: null
        }
      }
    }) + '\n'
  )
  assert.deepEqual(await p, {
    planType: 'pro',
    primary: { usedPercent: 12.5, resetsAt: 1_760_000_000, windowMins: 300 },
    // A window codex did not report is absent, not zeroed.
    secondary: undefined
  })
  assert.deepEqual(child.signals, ['SIGTERM'], 'the probe process must not outlive the answer')
  // Settled once: a late crash cannot re-resolve or re-kill.
  child.emit('error', new Error('gone'))
  assert.deepEqual(child.signals, ['SIGTERM'])
})

test('getCodexUsage degrades to undefined when codex is not installed', async () => {
  const p = getCodexUsage()
  last().child.emit('error', new Error('spawn codex ENOENT'))
  assert.equal(await p, undefined)
})

test('getCodexUsage degrades to undefined when the spawn itself throws', async () => {
  const real = globalThis.__floeSpawnCodex
  globalThis.__floeSpawnCodex = (): never => {
    throw new Error('EMFILE')
  }
  try {
    assert.equal(await getCodexUsage(), undefined)
  } finally {
    globalThis.__floeSpawnCodex = real
  }
})
