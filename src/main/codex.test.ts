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

const { codexModels, resolveModel, codexPosture, chatWithCodex, getCodexUsage } =
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

// ---------------------------------------------------------------- the tests

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

test('codexPosture maps Floe modes onto codex sandbox + collaboration', () => {
  assert.deepEqual(codexPosture('plan'), { sandbox: 'read-only', collaboration: 'plan' })
  assert.deepEqual(codexPosture('acceptEdits'), { sandbox: 'workspace-write', collaboration: 'default' })
  assert.deepEqual(codexPosture('skip'), { sandbox: 'danger-full-access', collaboration: 'default' })
  // "ask" is not a mode codex has (shared/modes.ts), so it lands on read-only
  // rather than on something looser than the caller asked for.
  assert.deepEqual(codexPosture('default'), { sandbox: 'read-only', collaboration: 'plan' })
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
