import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { register } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import type { AgentEvent } from '../shared/types'

// Same hermetic hook the other main tests use (rewrite extensionless
// `./x` → `./x.ts`, stub `electron`), plus a stub for `node:child_process`
// scoped to codexServer.ts: `codex app-server` becomes a fake child whose stdio
// this test drives, so the whole JSON-RPC dance runs with no CLI installed.
const hookSource = `
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
export async function resolve(specifier, context, next) {
  if (specifier === 'electron') return { url: 'stub:electron', shortCircuit: true, format: 'module' }
  if (specifier === 'node:child_process' && context.parentURL?.endsWith('/codexServer.ts')) {
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
    const src = 'export function spawn(cmd, args, opts) { return globalThis.__floeSpawnCodexServer(cmd, args, opts) }\\nexport default { spawn }'
    return { format: 'module', shortCircuit: true, source: src }
  }
  return next(url, context)
}
`
register('data:text/javascript,' + encodeURIComponent(hookSource), import.meta.url)

// resolveModel reads ~/.codex/models_cache.json, and the answered-question log
// is written under electron's userData. Both go to throwaway dirs.
const home = mkdtempSync(join(tmpdir(), 'floe-codexsrv-home-'))
mkdirSync(join(home, '.codex'), { recursive: true })
writeFileSync(
  join(home, '.codex', 'models_cache.json'),
  JSON.stringify({ models: [{ slug: 'gpt-5.5', visibility: 'list', supported_in_api: true }] })
)
process.env.HOME = home
process.env.FLOE_TEST_USERDATA = mkdtempSync(join(tmpdir(), 'floe-codexsrv-data-'))

const { chatWithCodexServer, answerCodexQuestion, codexWaitingKeys } = await import('./codexServer.ts')
const { readRuntimeTranscript } = await import('./runtimeLog.ts')

// ---------------------------------------------------------------- the fake app-server

interface FakeChild extends EventEmitter {
  stdin: EventEmitter & { write: (s: string) => boolean }
  stdout: EventEmitter & { setEncoding: (e: string) => void }
  sent: Record<string, unknown>[]
}

/** Reply to a request: a plain result, a full envelope, or MUTE for silence. */
const MUTE = Symbol('no reply')
type Reply = unknown | ((msg: { id: number }) => Record<string, unknown>)

let replies: Record<string, Reply> = {}
const spawns: { cmd: string; args: string[]; child: FakeChild }[] = []

// The seam the child_process stub above calls through.
declare global {
  var __floeSpawnCodexServer: (cmd: string, args: string[]) => FakeChild
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild
  child.sent = []
  const stdout = new EventEmitter() as FakeChild['stdout']
  stdout.setEncoding = (): void => {}
  child.stdout = stdout
  const stdin = new EventEmitter() as FakeChild['stdin']
  stdin.write = (line: string): boolean => {
    const msg = JSON.parse(line) as { id: number; method?: string }
    child.sent.push(msg)
    if (!msg.method) return true // our answer to a server→client request
    const reply = msg.method in replies ? replies[msg.method] : {}
    if (reply === MUTE) return true
    // Async, like a real server: the caller is still inside write() right now.
    queueMicrotask(() => {
      const body = typeof reply === 'function' ? (reply as (m: { id: number }) => object)(msg) : { result: reply }
      child.stdout.emit('data', JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...body }) + '\n')
    })
    return true
  }
  child.stdin = stdin
  return child
}

globalThis.__floeSpawnCodexServer = (cmd: string, args: string[]): FakeChild => {
  const child = fakeChild()
  spawns.push({ cmd, args, child })
  return child
}

const server = (): FakeChild => spawns[spawns.length - 1].child

/** The params of the one request the client sent for `method`. */
function sentParams(method: string): Record<string, unknown> {
  const msgs = server().sent.filter((m) => (m as { method?: string }).method === method)
  assert.equal(msgs.length > 0, true, `expected a ${method} request`)
  return (msgs[msgs.length - 1] as { params: Record<string, unknown> }).params
}

/** A notification or a server→client request, straight down stdout. */
function push(msg: Record<string, unknown>): void {
  server().stdout.emit('data', JSON.stringify(msg) + '\n')
}

function fakeWin(): { win: BrowserWindow; events: AgentEvent[] } {
  const events: AgentEvent[] = []
  const win = {
    isDestroyed: () => false,
    webContents: { send: (_ch: string, payload: { event: AgentEvent }) => events.push(payload.event) }
  }
  return { win: win as unknown as BrowserWindow, events }
}

const kinds = (events: AgentEvent[]): string[] => events.map((e) => e.kind)

/** Default happy handshake; every test starts from this and overrides. */
function resetReplies(threadId = 'th-1'): void {
  replies = {
    initialize: {},
    'thread/start': { thread: { id: threadId } },
    'thread/settings/update': {},
    'thread/resume': {},
    'turn/start': {}
  }
}

/** Kill the shared app-server so the next test spawns a fresh one. */
function killServer(): void {
  if (spawns.length) server().emit('close', 0)
}

// ---------------------------------------------------------------- the tests

test('a full turn: spawn, start the thread, run it, settle the reply', async () => {
  resetReplies()
  const { win, events } = fakeWin()
  await chatWithCodexServer(win, 'k-happy', '/work/tree', 'what changed?', 'gpt-5.5', 'medium')

  assert.deepEqual(
    { cmd: spawns[0].cmd, args: spawns[0].args },
    { cmd: 'codex', args: ['app-server'] },
    'one shared `codex app-server`, not one process per turn'
  )
  // experimentalApi is what unlocks plan mode and requestUserInput at all.
  assert.equal(
    (sentParams('initialize').capabilities as { experimentalApi: boolean }).experimentalApi,
    true
  )
  assert.deepEqual(sentParams('thread/start'), {
    cwd: '/work/tree',
    model: 'gpt-5.5',
    // "never" is deliberate: an approval request is answered with a flat
    // decline, so a policy that asks would wedge the turn.
    approvalPolicy: 'never',
    sandbox: 'read-only',
    // Floe's own tools, scoped to this thread so the url carries THIS session's
    // token. `approve` is required: with approvalPolicy "never" and anything
    // else, every MCP call comes back "requires approval".
    config: {
      mcp_servers: {
        floe: {
          url: 'http://127.0.0.1:0/mcp/k-happy',
          default_tools_approval_mode: 'approve'
        }
      }
    }
  })
  assert.deepEqual(sentParams('thread/settings/update'), {
    threadId: 'th-1',
    collaborationMode: { mode: 'plan', settings: { model: 'gpt-5.5' } }
  })
  assert.deepEqual(sentParams('turn/start'), {
    threadId: 'th-1',
    input: [{ type: 'text', text: 'what changed?' }],
    effort: 'medium'
  })
  assert.deepEqual(events, [], 'turn/start resolving is not the turn finishing')

  // Now the notifications the server sends as the turn runs.
  push({ method: 'item/completed', params: { threadId: 'th-1', item: { type: 'reasoning', text: 'hmm' } } })
  push({ method: 'item/completed', params: { threadId: 'th-1', item: { type: 'agentMessage', text: 'first draft' } } })
  push({ method: 'item/completed', params: { threadId: 'th-1', item: { type: 'agentMessage', text: 'three files' } } })
  push({
    method: 'thread/tokenUsage/updated',
    params: { threadId: 'th-1', tokenUsage: { last: { inputTokens: 900, outputTokens: 100 } } }
  })
  // A zero-token update says nothing and must not move the gauge.
  push({ method: 'thread/tokenUsage/updated', params: { threadId: 'th-1', tokenUsage: {} } })
  push({ method: 'turn/completed', params: { threadId: 'th-1', turn: { status: 'completed', error: null } } })

  assert.deepEqual(kinds(events), ['tokens', 'text', 'done'])
  assert.equal((events[0] as { tokens: number }).tokens, 1000)
  // The turn's reply is its LAST agentMessage, same contract as `codex exec`.
  assert.equal((events[1] as { text: string }).text, 'three files')
  assert.equal((events[2] as { ok: boolean }).ok, true)

  // The reply is persisted: codex writes no transcript Floe can resume by.
  assert.deepEqual(
    readRuntimeTranscript('k-happy').map((i) => ({ role: i.role, text: i.text })),
    [{ role: 'assistant', text: 'three files' }]
  )

  // turn/completed dropped the routing, so a late notification is a no-op.
  push({ method: 'item/completed', params: { threadId: 'th-1', item: { type: 'agentMessage', text: 'late' } } })
  push({ method: 'turn/completed', params: { threadId: 'th-1', turn: {} } })
  assert.equal(events.length, 3)
})

test('a known thread is resumed, and a mode change is pushed at it', async () => {
  const { win, events } = fakeWin()
  // Same session key as the happy turn: the thread is known, so this rejoins it
  // instead of starting a second one.
  await chatWithCodexServer(win, 'k-happy', '/work/tree', 'now build it', 'gpt-5.5', undefined, 'acceptEdits')

  // The config is restated on resume: it does not survive the server process,
  // and a rejoined thread that quietly lost its Floe tools is worse than one
  // that never had them.
  assert.deepEqual(sentParams('thread/resume'), {
    threadId: 'th-1',
    cwd: '/work/tree',
    model: 'gpt-5.5',
    config: {
      mcp_servers: {
        floe: { url: 'http://127.0.0.1:0/mcp/k-happy', default_tools_approval_mode: 'approve' }
      }
    }
  })
  assert.equal(server().sent.filter((m) => (m as { method?: string }).method === 'thread/start').length, 1)
  // acceptEdits is workspace-write + the default collaboration mode.
  assert.deepEqual(sentParams('thread/settings/update'), {
    threadId: 'th-1',
    sandboxPolicy: 'workspace-write',
    collaborationMode: { mode: 'default', settings: { model: 'gpt-5.5' } }
  })
  assert.equal(sentParams('turn/start').effort, undefined)

  // Fail the turn from the server side.
  push({
    method: 'turn/completed',
    params: { threadId: 'th-1', turn: { status: 'failed', error: { message: 'sandbox denied write' } } }
  })
  assert.deepEqual(kinds(events), ['error', 'done'])
  assert.equal((events[0] as { message: string }).message, 'sandbox denied write')
  assert.equal((events[1] as { ok: boolean }).ok, false)
})

test('a mode codex will not switch to is said out loud, not swallowed', async () => {
  replies['thread/settings/update'] = () => ({ error: { message: 'unknown sandbox' } })
  const turnsBefore = server().sent.filter((m) => (m as { method?: string }).method === 'turn/start').length
  const { win, events } = fakeWin()
  await chatWithCodexServer(win, 'k-happy', '/work/tree', 'go', 'gpt-5.5', undefined, 'skip')

  assert.deepEqual(kinds(events), ['error', 'done'])
  assert.match((events[0] as { message: string }).message, /codex would not switch to skip mode: unknown sandbox/)
  assert.equal(
    server().sent.filter((m) => (m as { method?: string }).method === 'turn/start').length,
    turnsBefore,
    'a turn must not run in the posture the user just moved away from'
  )
})

test('a rollout codex can no longer resume starts a fresh thread', async () => {
  resetReplies('th-2')
  replies['thread/resume'] = () => ({ error: { message: 'no rollout for that id' } })
  const { win, events } = fakeWin()
  await chatWithCodexServer(win, 'k-happy', '/work/tree', 'still there?', 'gpt-5.5')

  assert.equal(sentParams('thread/start').cwd, '/work/tree')
  assert.equal(sentParams('turn/start').threadId, 'th-2')
  push({ method: 'turn/completed', params: { threadId: 'th-2', turn: {} } })
  assert.deepEqual(kinds(events), ['done'])
  assert.equal((events[0] as { ok: boolean }).ok, true, 'a turn with no reply still closes cleanly')
})

test('a thread/start with no id fails the turn instead of running headless', async () => {
  resetReplies()
  replies['thread/start'] = {}
  const { win, events } = fakeWin()
  await chatWithCodexServer(win, 'k-noid', '/work/tree', 'hi', undefined)

  assert.deepEqual(kinds(events), ['error', 'done'])
  assert.equal((events[0] as { message: string }).message, 'codex thread/start returned no thread id.')
})

test('an error reply with no message still fails the request', async () => {
  resetReplies()
  replies['thread/start'] = () => ({ error: {} })
  const { win, events } = fakeWin()
  await chatWithCodexServer(win, 'k-blankerr', '/work/tree', 'hi', undefined)
  assert.equal((events[0] as { message: string }).message, 'codex request failed')
})

test('requestUserInput becomes the same question event Claude uses, and the answer goes back', async () => {
  resetReplies('th-q')
  const { win, events } = fakeWin()
  await chatWithCodexServer(win, 'k-ask', '/work/tree', 'which parser?', 'gpt-5.5', 'low')

  push({
    method: 'item/tool/requestUserInput',
    id: 'req-7',
    params: {
      threadId: 'th-q',
      questions: [
        {
          id: 'q0',
          header: 'Parser',
          question: 'Which parser should I keep?',
          options: [{ label: 'A', description: 'faster' }, { label: 'B' }, { description: 'nameless' }]
        },
        // Header identical to the question — not worth saying twice.
        { id: 'q1', header: 'Ship it?', question: 'Ship it?' },
        // Nothing usable at all: index becomes the id, text stays empty.
        {}
      ]
    }
  })

  assert.deepEqual(kinds(events), ['question'])
  const q = events[0] as { toolUseId: string; questions: unknown[] }
  assert.equal(q.toolUseId, 'req-7')
  assert.deepEqual(q.questions, [
    {
      question: 'Which parser should I keep?',
      header: 'Parser',
      multiSelect: false, // codex questions are single-answer
      options: [
        { label: 'A', description: 'faster' },
        { label: 'B', description: undefined },
        { label: '', description: 'nameless' }
      ]
    },
    { question: 'Ship it?', header: 'Ship it?', multiSelect: false, options: [] },
    { question: '', header: undefined, multiSelect: false, options: [] }
  ])
  assert.deepEqual(codexWaitingKeys(), ['k-ask'], 'the renderer reconciles `?` against this list')

  // Only two answers for three questions — the third must not throw.
  assert.equal(answerCodexQuestion('k-ask', [['A'], []]), true)
  const answer = server().sent.at(-1) as { id: string; result: { answers: Record<string, unknown> } }
  assert.deepEqual(answer, {
    jsonrpc: '2.0',
    id: 'req-7',
    result: { answers: { q0: { answers: ['A'] }, q1: { answers: [] }, '2': { answers: [] } } }
  })
  assert.deepEqual(codexWaitingKeys(), [])

  // The exchange is persisted the way the renderer showed it: question as the
  // model's line, answer as the user's. Unanswered questions log nothing.
  assert.deepEqual(
    readRuntimeTranscript('k-ask').map((i) => ({ role: i.role, text: i.text })),
    [
      { role: 'assistant', text: 'Parser — Which parser should I keep?' },
      { role: 'user', text: 'A' }
    ]
  )

  push({ method: 'turn/completed', params: { threadId: 'th-q', turn: {} } })
  assert.deepEqual(kinds(events), ['question', 'done'])
})

test('a session with no codex question hands the answer back to the Claude path', () => {
  assert.equal(answerCodexQuestion('k-ask', [['A']]), false)
  assert.equal(answerCodexQuestion('never-heard-of-it', [['A']]), false)
})

test('a question with no live turn is declined rather than left stranded', () => {
  const before = server().sent.length
  push({ method: 'item/tool/requestUserInput', id: 42, params: { threadId: 'ghost', questions: [] } })
  assert.deepEqual(server().sent.slice(before), [{ jsonrpc: '2.0', id: 42, result: { answers: {} } }])
})

test('any other server request is declined so the turn cannot hang on it', () => {
  const before = server().sent.length
  push({ method: 'item/command/requestApproval', id: 'appr-1', params: { threadId: 'th-q' } })
  assert.deepEqual(server().sent.slice(before), [
    { jsonrpc: '2.0', id: 'appr-1', result: { decision: 'denied' } }
  ])
})

test('junk on stdout, and traffic for threads we do not know, are ignored', () => {
  const { win, events } = fakeWin()
  const before = server().sent.length
  server().stdout.emit('data', '\n   \ncodex app-server listening\n{"broken\n')
  push({ method: 'item/completed', params: { threadId: 'nobody', item: { type: 'agentMessage', text: 'x' } } })
  push({ method: 'turn/completed', params: {} })
  // A reply to an id we never sent (a retry after teardown, say).
  push({ id: 99_999, result: {} })
  assert.equal(server().sent.length, before, 'nothing above deserves an answer')
  assert.deepEqual(kinds(events), [])
  assert.equal(win.isDestroyed(), false)
})

test('the app-server dying fails every in-flight turn instead of hanging them', async () => {
  resetReplies('th-dead')
  const { win, events } = fakeWin()
  await chatWithCodexServer(win, 'k-dead', '/work/tree', 'long job', 'gpt-5.5')
  assert.deepEqual(kinds(events), [])

  killServer()
  assert.deepEqual(kinds(events), ['error', 'done'])
  assert.equal((events[0] as { message: string }).message, 'codex app-server exited.')
  assert.equal((events[1] as { ok: boolean }).ok, false)

  // Re-armed: the next turn spawns a new server rather than writing into a dead pipe.
  resetReplies('th-alive')
  const spawnCount = spawns.length
  const { win: win2, events: events2 } = fakeWin()
  await chatWithCodexServer(win2, 'k-revive', '/work/tree', 'again', 'gpt-5.5')
  assert.equal(spawns.length, spawnCount + 1)
  push({ method: 'turn/completed', params: { threadId: 'th-alive', turn: {} } })
  assert.deepEqual(kinds(events2), ['done'])
})

test('a codex binary that is not there is named, not left as a spawn error', async () => {
  killServer()
  resetReplies('th-enoent')
  replies.initialize = MUTE // never completes the handshake; the error wins
  const { win, events } = fakeWin()
  const p = chatWithCodexServer(win, 'k-enoent', '/work/tree', 'hi', 'gpt-5.5')
  server().emit('error', new Error('spawn codex ENOENT'))
  await p
  assert.deepEqual(kinds(events), ['error', 'done'])
  assert.equal((events[0] as { message: string }).message, 'codex CLI not found on PATH.')
})

// Last, on purpose: a spawn that throws leaves `ready` a rejected promise (the
// executor's `ready = null` is overwritten by the assignment that follows it),
// so every later turn in this process would see the same failure.
test('a spawn that throws outright fails the turn rather than raising', async () => {
  killServer()
  const real = globalThis.__floeSpawnCodexServer
  globalThis.__floeSpawnCodexServer = (): never => {
    throw new Error('EAGAIN')
  }
  try {
    const { win, events } = fakeWin()
    await chatWithCodexServer(win, 'k-nospawn', '/work/tree', 'hi', 'gpt-5.5')
    assert.deepEqual(kinds(events), ['error', 'done'])
    assert.equal((events[0] as { message: string }).message, 'EAGAIN')
    assert.equal((events[1] as { ok: boolean }).ok, false)
  } finally {
    globalThis.__floeSpawnCodexServer = real
  }
})
