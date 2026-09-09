import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { register } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import type { AgentEvent } from '../shared/types'

// peer.ts drives real CLIs, so the seam under test is argv: who gets spawned,
// with which flags, carrying which prompt. Same hermetic setup codex.test.ts
// uses — `electron` stubbed, extensionless imports rewritten — with
// `node:child_process` swapped for a fake in BOTH modules that spawn: codex.ts
// (the codex peer) and runtimes.ts (every other CLI peer).
const hookSource = `
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
export async function resolve(specifier, context, next) {
  if (specifier === 'electron') return { url: 'stub:electron', shortCircuit: true, format: 'module' }
  if (specifier === 'node:child_process' && /\\/(codex|runtimes)\\.ts$/.test(context.parentURL ?? '')) {
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
    const src = 'export function spawn(cmd, args, opts) { return globalThis.__floeSpawnPeer(cmd, args, opts) }\\nexport default { spawn }'
    return { format: 'module', shortCircuit: true, source: src }
  }
  return next(url, context)
}
`
register('data:text/javascript,' + encodeURIComponent(hookSource), import.meta.url)

// Every disk read hangs off HOME (~/.codex/models_cache.json) or the electron
// userData stub; the config directory is where the house rules would live.
// All three go to throwaway dirs, so the test never reads the real ones.
const home = mkdtempSync(join(tmpdir(), 'floe-peer-home-'))
mkdirSync(join(home, '.codex'), { recursive: true })
writeFileSync(
  join(home, '.codex', 'models_cache.json'),
  JSON.stringify({ models: [{ slug: 'gpt-5.5', visibility: 'list', supported_in_api: true }] })
)
process.env.HOME = home
process.env.FLOE_TEST_USERDATA = mkdtempSync(join(tmpdir(), 'floe-peer-data-'))
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'floe-peer-config-'))

const { setSharedDataDir } = await import('./dataDir.ts')
setSharedDataDir(mkdtempSync(join(tmpdir(), 'floe-peer-store-')))

const { askPeer, nextExchange, m2mPreamble, readClaudeJson, MAX_EXCHANGES } = await import('./peer.ts')

// ---------------------------------------------------------------- fixtures

interface FakeChild extends EventEmitter {
  stdin: EventEmitter & { end: () => void; write: (s: string) => boolean; ended: boolean }
  stdout: EventEmitter & { setEncoding: (e: string) => void }
  stderr: EventEmitter & { setEncoding: (e: string) => void }
  kill: (sig?: string) => boolean
}

interface Spawned {
  cmd: string
  args: string[]
  opts: { cwd?: string; env?: Record<string, string> }
  child: FakeChild
}

const spawns: Spawned[] = []

declare global {
  var __floeSpawnPeer: (cmd: string, args: string[], opts: Spawned['opts']) => FakeChild
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild
  const stdin = new EventEmitter() as FakeChild['stdin']
  stdin.ended = false
  stdin.end = (): void => {
    stdin.ended = true
  }
  stdin.write = (): boolean => true
  child.stdin = stdin
  for (const name of ['stdout', 'stderr'] as const) {
    const s = new EventEmitter() as FakeChild['stdout']
    s.setEncoding = (): void => {}
    child[name] = s
  }
  child.kill = (): boolean => true
  return child
}

globalThis.__floeSpawnPeer = (cmd, args, opts): FakeChild => {
  const child = fakeChild()
  spawns.push({ cmd, args, opts, child })
  return child
}

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

const REPLY = (text: string): string =>
  JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } })

// ---------------------------------------------------------------- the tests

// The exchange window: MAX_EXCHANGES real turns, then one capped call that
// resets it so the next round starts fresh after the user's guidance.
test('nextExchange caps after MAX_EXCHANGES and then resets', () => {
  const state = { step: 0 }
  for (let i = 1; i <= MAX_EXCHANGES; i++) {
    assert.deepEqual(nextExchange(state), { capped: false })
    assert.equal(state.step, i)
  }
  assert.deepEqual(nextExchange(state), { capped: true })
  assert.equal(state.step, 0)
  assert.deepEqual(nextExchange(state), { capped: false })
  assert.equal(state.step, 1)
})

test('the M2M contract names the caller instead of assuming Claude', () => {
  assert.match(m2mPreamble('codex'), /another AI agent \(codex\)/)
  assert.match(m2mPreamble('claude'), /another AI agent \(claude\)/)
})

test('askPeer drives one codex turn and reports it as a subagent row', async () => {
  const { win, events } = fakeWin()
  const p = askPeer(win, 's1', '/work/tree', { harness: 'codex', prompt: 'compare the two parsers' })

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
    '{"type":"thread.started","thread_id":"th-abc-1"}',
    JSON.stringify({ type: 'item.completed', item: { type: 'command_execution' } }),
    REPLY('parser B wins')
  ])

  assert.deepEqual(await p, { capped: false, reply: 'parser B wins', exchange: 1 })
  assert.equal(events[0].kind, 'subagent-start')
  assert.equal((events[0] as { harness?: string }).harness, 'codex', 'the row says who answered')
  assert.equal(events[0].description, 'compare the two parsers', 'the preamble stays out of the row title')
  const done = events.at(-1) as { kind: string; reply?: string }
  assert.equal(done.kind, 'subagent-done')
  assert.equal(done.reply, 'parser B wins')
})

test('the next exchange resumes the thread codex reported, without the preamble', async () => {
  const { win } = fakeWin()
  const p = askPeer(win, 's1', '/work/tree', { harness: 'codex', prompt: 'and the allocator?' })
  const { args, child } = last()
  assert.deepEqual(args.slice(0, 5), ['exec', 'resume', 'th-abc-1', '--json', '--skip-git-repo-check'])
  assert.equal(args.at(-1), 'and the allocator?')
  assert.ok(!args.includes('-s'), 'resume inherits the sandbox from the first turn')
  stream(child, [REPLY('same')])
  assert.equal((await p).exchange, 2)
})

test('a new topic forgets the thread and restarts the exchange count', async () => {
  const { win } = fakeWin()
  const p = askPeer(win, 's1', '/work/tree', {
    harness: 'codex',
    prompt: 'different question',
    newTopic: true
  })
  const { args, child } = last()
  assert.equal(args[0], 'exec')
  assert.notEqual(args[1], 'resume')
  stream(child, [REPLY('ok')])
  assert.deepEqual(await p, { capped: false, reply: 'ok', exchange: 1 })
})

test('a thread id that is not a plain token is never used as argv', async () => {
  const { win } = fakeWin()
  const first = askPeer(win, 'evil', '/w', { harness: 'codex', prompt: 'go' })
  // A harness's own output is still input: a thread id shaped like a flag must
  // not become a leading argument.
  stream(last().child, [
    '{"type":"thread.started","thread_id":"-c sandbox_mode=danger-full-access"}',
    REPLY('a')
  ])
  await first

  const second = askPeer(win, 'evil', '/w', { harness: 'codex', prompt: 'again' })
  assert.notEqual(last().args[1], 'resume', 'a bad thread id falls back to a fresh thread')
  stream(last().child, [REPLY('b')])
  await second
})

test('a peer may not be given more than the calling session has', async () => {
  const { win } = fakeWin()
  // 'ask-for-skip' names no created session, so the ceiling is `plan` — asking
  // for bypass must not widen what this consult can touch.
  const p = askPeer(win, 'ask-for-skip', '/w', { harness: 'codex', prompt: 'q', mode: 'skip' })
  const { args, child } = last()
  assert.deepEqual(args.slice(5, 7), ['-s', 'read-only'], 'the clamp holds, not the request')
  stream(child, [REPLY('a')])
  await p
})

test('the exchange cap is per pair, so a peer consulting back keeps its own window', async () => {
  const { win } = fakeWin()
  const turn = async (): Promise<{ exchange?: number; capped: boolean }> => {
    const p = askPeer(win, 'capped', '/w', { harness: 'codex', prompt: 'q' })
    stream(last().child, [REPLY('a')])
    return p
  }
  for (let i = 0; i < MAX_EXCHANGES; i++) await turn()
  const before = spawns.length
  assert.deepEqual(await askPeer(win, 'capped', '/w', { harness: 'codex', prompt: 'one too many' }), {
    capped: true
  })
  assert.equal(spawns.length, before, 'a capped call must not spawn anything at all')

  // Same caller, different peer: its own window, untouched by codex's.
  const other = askPeer(win, 'capped', '/w', { harness: 'gemini', prompt: 'you then' })
  assert.equal(last().cmd, 'gemini')
  stream(last().child, [JSON.stringify({ response: 'sure' })])
  assert.deepEqual(await other, { capped: false, reply: 'sure', exchange: 1 })

  // And the codex window reset, so "keep going" starts a fresh round.
  assert.equal((await turn()).exchange, 1)
})

test('every harness has a runner, and the ones that need a model say so', async () => {
  const { win } = fakeWin()
  const opencode = askPeer(win, 'oc', '/w', { harness: 'opencode', prompt: 'look' })
  assert.equal(last().cmd, 'opencode')
  assert.ok(last().args.includes('plan'), 'a read-only consult runs opencode\'s plan agent')
  stream(last().child, [JSON.stringify({ type: 'text', text: 'seen', sessionID: 'oc-1' })])
  assert.equal((await opencode).reply, 'seen')

  const unknown = await askPeer(win, 'oc', '/w', { harness: 'nope', prompt: 'x' })
  assert.match(String(unknown.error), /Unknown harness: nope/)

  // LM Studio and Ollama take the model in the request body — there is no
  // default to fall back on, so this is refused before anything is spawned.
  const local = await askPeer(win, 'oc', '/w', { harness: 'lmstudio', prompt: 'x' })
  assert.match(String(local.error), /name one in `model`/)
})

test('a failure the peer explained is reported in its own words', async () => {
  const { win } = fakeWin()
  const p = askPeer(win, 'limit', '/w', { harness: 'codex', prompt: 'q' })
  // codex says why it failed on stdout, as JSON, while stderr carries only the
  // line it prints on every run. Reporting the pipe noise instead of the reason
  // is how "you've hit your usage limit" reached the user as "Reading
  // additional input from stdin...".
  stream(
    last().child,
    [JSON.stringify({ type: 'turn.failed', error: { message: "You've hit your usage limit." } })],
    { stderr: 'Reading additional input from stdin...\n', code: 1 }
  )
  assert.equal((await p).error, "You've hit your usage limit.")
})

test('a turn that produces no reply surfaces the CLI stderr, and the row still closes', async () => {
  const { win, events } = fakeWin()
  const p = askPeer(win, 'boom', '/w', { harness: 'codex', prompt: 'q' })
  stream(last().child, [], {
    stderr: 'Reading additional input from stdin...\n  stream error: 401 unauthorized\n',
    code: 1
  })
  const r = await p
  assert.equal(r.error, 'stream error: 401 unauthorized')
  assert.equal(r.reply, undefined)
  const done = events.at(-1) as { kind: string; reply?: string }
  assert.equal(done.kind, 'subagent-done', 'the subagent row must not be left running')
  assert.equal(done.reply, undefined)
})

test('readClaudeJson pins the shape `claude -p --output-format json` answers with', () => {
  assert.deepEqual(
    readClaudeJson('{"type":"result","result":"looks fine","session_id":"cl-1"}'),
    { reply: 'looks fine', threadId: 'cl-1' }
  )
  // Prose instead of JSON is a sign-in prompt or a refusal, not an answer.
  assert.throws(
    () => readClaudeJson('Invalid API key · Please run /login'),
    /Please run \/login/
  )
  assert.throws(
    () => readClaudeJson('{"type":"result","is_error":true,"result":"usage limit reached"}'),
    /usage limit reached/
  )
})
