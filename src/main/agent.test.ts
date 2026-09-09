import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { register } from 'node:module'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import type { AgentEvent, AgentRunOptions } from '../shared/types'
import type { Conn } from './agent.ts'
import { settle, waitFor } from './watch.test-helper.ts'

// Every path agent.ts reads out of the machine is redirected into a throwaway
// dir first: `$HOME` (the CLI transcript ensureTaskWatcher tails) and the
// electron stub's `app.getPath` (where the per-session MCP config is written).
// Set before the first import, so nothing can cache the real one.
const HOME = mkdtempSync(join(tmpdir(), 'floe-agent-home-'))
process.env.HOME = HOME
process.env.FLOE_TEST_TMP = HOME

// agent.ts imports sessionStore (which import `electron`) and value
// imports from ../shared/types — none resolvable by raw Node ESM. Register the
// same hermetic hook codex.test.ts uses (rewrite extensionless
// `./x` → `./x.ts`, stub `electron`) before importing agent, so this
// pure-function/handler test can load it.
const hookSource = `
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
export async function resolve(specifier, context, next) {
  if (specifier === 'electron') return { url: 'stub:electron', shortCircuit: true, format: 'module' }
  // Only agent.ts's spawn is faked: every other module keeps the real one.
  if (specifier === 'node:child_process' && (context.parentURL ?? '').endsWith('/agent.ts'))
    return { url: 'stub:child_process', shortCircuit: true, format: 'module' }
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
  if (url === 'stub:child_process')
    return { format: 'module', shortCircuit: true, source: 'export function spawn(...a) { return globalThis.__spawn(...a) }' }
  if (url === 'stub:electron') {
    const src = [
      "export const app = { getPath: () => process.env.FLOE_TEST_TMP || '/tmp' };",
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
  return next(url, context)
}
`
register('data:text/javascript,' + encodeURIComponent(hookSource), import.meta.url)

const {
  drainLines,
  contextTokens,
  parseQuestions,
  optionsKeyFor,
  handleLine,
  handleTaskLine,
  flushDeltas,
  watchdogAction,
  runWatchdogTick,
  isChildDead,
  pruneSettled,
  markTurnStart,
  sendAgentEvent,
  replaySnapshot,
  replayInFlight,
  activeTurnKeys,
  dropSettled,
  waitForTurn,
  strandedReplayKeys,
  runReplaySweep,
  sendToAgent,
  stopAgent,
  hasActiveTurn,
  readSessionBuffer
} = await import('./agent.ts')
const { setSharedDataDir } = await import('./dataDir.ts')
const { addCreatedSession, setCreatedSessionSpawnedBy, linkCreatedSession } = await import(
  './sessionStore.ts'
)

// Point the persistent stores at a throwaway dir — the spawned-session test seeds
// a real sessions.json and must not touch the machine's store.
setSharedDataDir(mkdtempSync(join(tmpdir(), 'floe-agent-test-')))

// A window whose send() captures the emitted AgentEvents so handler tests can
// assert on what reached the renderer.
function fakeWin(): { win: BrowserWindow; events: AgentEvent[] } {
  const events: AgentEvent[] = []
  const win = {
    isDestroyed: () => false,
    webContents: { send: (_ch: string, payload: { event: AgentEvent }) => events.push(payload.event) }
  }
  return { win: win as unknown as BrowserWindow, events }
}

function fakeConn(over: Partial<Conn> = {}): Conn {
  return {
    buffer: '',
    optionsKey: '',
    stderr: '',
    pendingPerms: new Map(),
    subagents: new Set(),
    transcriptBuffer: [],
    lastAssistantText: '',
    pendingDeltas: [],
    flushTimer: null,
    ...over
  } as unknown as Conn
}

// Feed one stream-json message through the handler and return the captured events.
function run(msg: unknown, conn = fakeConn()): { events: AgentEvent[]; conn: Conn } {
  const { win, events } = fakeWin()
  handleLine(win, 'k', conn, JSON.stringify(msg))
  return { events, conn }
}

const kinds = (events: AgentEvent[]): string[] => events.map((e) => e.kind)
const only = (events: AgentEvent[], kind: string): AgentEvent[] => events.filter((e) => e.kind === kind)

// ── the faked CLI ───────────────────────────────────────────────────────────
// A `claude` child that never runs. spawnConn only writes JSON to its stdin,
// listens on the three streams and kills it, so an EventEmitter with those
// pieces is the whole contract — and a test can drive stdout/close/error by
// hand, which is the only way to reach spawnConn's callbacks at all.

interface FakeChild extends EventEmitter {
  pid: number
  exitCode: number | null
  signalCode: string | null
  killed: boolean
  stdin: EventEmitter & { destroyed: boolean; writableEnded: boolean; write: (s: string) => boolean }
  stdout: EventEmitter & { setEncoding: () => void }
  stderr: EventEmitter & { setEncoding: () => void }
  kill: (signal?: string) => boolean
  /** Every stream-json payload agent.ts wrote to this child. */
  writes: string[]
  /** The signals `kill()` was called with, so a reap/respawn is observable. */
  signals: string[]
}

function fakeChildProcess(): FakeChild {
  const child = Object.assign(new EventEmitter(), {
    pid: 4242,
    exitCode: null as number | null,
    signalCode: null as string | null,
    killed: false,
    stdin: Object.assign(new EventEmitter(), {
      destroyed: false,
      writableEnded: false,
      write: (s: string) => {
        child.writes.push(s)
        return true
      }
    }),
    stdout: Object.assign(new EventEmitter(), { setEncoding: () => {} }),
    stderr: Object.assign(new EventEmitter(), { setEncoding: () => {} }),
    kill: (signal?: string) => {
      child.signals.push(signal ?? 'SIGTERM')
      child.killed = true
      return true
    },
    writes: [] as string[],
    signals: [] as string[]
  })
  return child as unknown as FakeChild
}

interface Spawned {
  args: string[]
  opts: { cwd?: string }
  child: FakeChild
}
const spawned: Spawned[] = []
declare global {
  // eslint-disable-next-line no-var
  var __spawn: (cmd: string, args: string[], opts: { cwd?: string }) => FakeChild
}
globalThis.__spawn = (_cmd, args, opts) => {
  const child = fakeChildProcess()
  spawned.push({ args, opts, child })
  return child
}

// A real directory: spawnConn's ENOENT handler asks whether the cwd still
// exists to tell "no claude on PATH" from "this session is another machine's".
const WT = join(HOME, 'wt')
mkdirSync(WT, { recursive: true })
const DEFAULT_OPTS: AgentRunOptions = { permissionMode: 'default' }

/** One turn through the real sendToAgent, against the faked CLI. */
function startSession(
  key: string,
  prompt = 'hello',
  opts: AgentRunOptions = DEFAULT_OPTS
): { win: BrowserWindow; events: AgentEvent[]; spawn: Spawned } {
  const { win, events } = fakeWin()
  const at = spawned.length
  sendToAgent(win, key, WT, prompt, opts)
  assert.equal(spawned.length, at + 1, 'sendToAgent spawned exactly one child')
  return { win, events, spawn: spawned[at] }
}

/** Deregister the conn and clear spawnConn's kill timer — no strays after a test. */
function endSession(win: BrowserWindow, key: string, child: FakeChild): void {
  stopAgent(win, key)
  child.emit('close', 0)
}

/** One stream-json line, as the CLI would deliver it on stdout. */
function emit(child: FakeChild, msg: unknown): void {
  child.stdout.emit('data', JSON.stringify(msg) + '\n')
}

const wrote = (child: FakeChild, n = 0): { type: string; message: { content: unknown } } =>
  JSON.parse(child.writes[n])

test('optionsKeyFor: identical options → identical key (no drift)', () => {
  const opts: AgentRunOptions = { permissionMode: 'plan', model: 'opus', effort: 'high' }
  assert.equal(optionsKeyFor(opts), optionsKeyFor({ ...opts }))
  assert.notEqual(optionsKeyFor(opts), optionsKeyFor({ ...opts, effort: 'low' }))
  // Absent model/effort collapse to empty, not "undefined".
  assert.equal(optionsKeyFor({ permissionMode: 'skip' as const }), 'skip||')
})

test('drainLines: carries a partial line across chunks and drops blanks', () => {
  const a = drainLines('', '{"a":1}\n\n{"b"')
  assert.deepEqual(a.lines, ['{"a":1}']) // blank line dropped, partial withheld
  assert.equal(a.rest, '{"b"')
  const b = drainLines(a.rest, ':2}\n')
  assert.deepEqual(b.lines, ['{"b":2}'])
  assert.equal(b.rest, '')
})

test('contextTokens: sums the four usage fields, ignores junk', () => {
  assert.equal(
    contextTokens({
      input_tokens: 10,
      cache_creation_input_tokens: 5,
      cache_read_input_tokens: 3,
      output_tokens: 2
    }),
    20
  )
  assert.equal(contextTokens({ input_tokens: 'x', output_tokens: NaN }), 0)
  assert.equal(contextTokens(undefined), 0)
})

test('parseQuestions: keeps valid, drops entries missing question or options', () => {
  const qs = parseQuestions({
    questions: [
      { question: 'Pick', options: [{ label: 'A' }, { label: 'B', description: 'b' }], multiSelect: true },
      { question: 'no options', options: [] },
      { options: [{ label: 'X' }] }
    ]
  })
  assert.equal(qs.length, 1)
  assert.equal(qs[0].question, 'Pick')
  assert.equal(qs[0].multiSelect, true)
  assert.equal(qs[0].options.length, 2)
})

test('handleLine: invalid JSON is ignored, no throw, no events', () => {
  const { events } = run('not json' as unknown)
  assert.deepEqual(events, [])
})

test('handleLine: system init emits a session event with model', () => {
  const { events } = run({ type: 'system', subtype: 'init', session_id: 's1', model: 'claude-opus-4-8' })
  assert.deepEqual(events, [{ kind: 'session', sessionId: 's1', model: 'claude-opus-4-8' }])
})

test('handleLine: assistant text emits tokens and accumulates the turn text', () => {
  const conn = fakeConn()
  const { events } = run(
    {
      type: 'assistant',
      message: { usage: { input_tokens: 4, output_tokens: 1 }, content: [{ type: 'text', text: 'hi' }] }
    },
    conn
  )
  assert.deepEqual(only(events, 'tokens'), [{ kind: 'tokens', tokens: 5 }])
  assert.equal(conn.lastAssistantText, 'hi')
})

const textDelta = (text: string): unknown => ({
  type: 'stream_event',
  event: { type: 'content_block_delta', delta: { type: 'text_delta', text } }
})
const thinkingDelta = (thinking: string): unknown => ({
  type: 'stream_event',
  event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking } }
})

test('handleLine: consecutive text deltas coalesce into one event on flush', () => {
  const conn = fakeConn()
  const { win, events } = fakeWin()
  handleLine(win, 'k', conn, JSON.stringify(textDelta('yo')))
  handleLine(win, 'k', conn, JSON.stringify(textDelta(' ho')))
  assert.deepEqual(events, []) // buffered, nothing forwarded per token
  flushDeltas(win, 'k', conn)
  assert.deepEqual(events, [{ kind: 'text', text: 'yo ho' }])
  assert.equal(conn.pendingDeltas.length, 0)
})

test('handleLine: a non-delta message drains pending deltas first, in order', () => {
  const conn = fakeConn()
  const { win, events } = fakeWin()
  handleLine(win, 'k', conn, JSON.stringify(thinkingDelta('hm')))
  handleLine(win, 'k', conn, JSON.stringify(textDelta('yo')))
  handleLine(win, 'k', conn, JSON.stringify({ type: 'result', is_error: false }))
  assert.deepEqual(events, [
    { kind: 'reasoning', text: 'hm' },
    { kind: 'text', text: 'yo' },
    { kind: 'done', ok: true }
  ])
})

test('handleLine: buffered deltas flush on the timer without another message', async () => {
  const conn = fakeConn()
  const { win, events } = fakeWin()
  handleLine(win, 'k', conn, JSON.stringify(textDelta('tick')))
  assert.deepEqual(events, [])
  // The flush is a real timer, so wait for it to fire and then for the queue to
  // stop moving — one flush, not one flush plus whatever followed it.
  await waitFor(() => events.length > 0, 5000, 'the delta flush')
  await settle(() => events.length, 100)
  assert.deepEqual(events, [{ kind: 'text', text: 'tick' }])
})

test('handleLine: a plain tool_use surfaces a tool event with its summary', () => {
  const { events } = run({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] }
  })
  assert.deepEqual(only(events, 'tool'), [{ kind: 'tool', name: 'Bash', summary: 'ls' }])
})

test('handleLine: Task tool_use starts a tracked subagent', () => {
  const conn = fakeConn()
  const { events } = run(
    {
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', name: 'Task', id: 't1', input: { subagent_type: 'Explore', description: 'look' } }]
      }
    },
    conn
  )
  assert.deepEqual(only(events, 'subagent-start'), [
    { kind: 'subagent-start', toolUseId: 't1', agentType: 'Explore', description: 'look', harness: 'claude' }
  ])
  assert.ok(conn.subagents.has('t1'))
})

test('handleLine: subagent activity routes to its row, never the parent gauge', () => {
  const { events } = run({
    type: 'assistant',
    parent_tool_use_id: 't1',
    message: { usage: { output_tokens: 5 }, content: [{ type: 'tool_use', name: 'Grep' }] }
  })
  // Routed as subagent-progress; the parent must NOT get a `tokens` event.
  assert.deepEqual(kinds(events), ['subagent-progress'])
  assert.equal((events[0] as { toolUseId: string }).toolUseId, 't1')
  assert.equal((events[0] as { tool?: string }).tool, 'Grep')
})

test('handleLine: a tracked subagent result marks it done and clears tracking', () => {
  const conn = fakeConn({ subagents: new Set(['t1']) })
  const { events } = run(
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [] }] } },
    conn
  )
  assert.deepEqual(only(events, 'subagent-done'), [{ kind: 'subagent-done', toolUseId: 't1' }])
  assert.ok(!conn.subagents.has('t1'))
})

test('handleLine: async Agent launch ack keeps the row alive (not done)', () => {
  const conn = fakeConn({ subagents: new Set(['t1']) })
  const { events } = run(
    {
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'Async agent launched successfully.\nagentId: abc' }] }
        ]
      }
    },
    conn
  )
  assert.deepEqual(only(events, 'subagent-done'), [])
  assert.ok(conn.subagents.has('t1'), 'async agent stays tracked until its <task-notification>')
})

test('handleLine: <task-notification> completion closes the async subagent row', () => {
  const conn = fakeConn({ subagents: new Set(['t1']) })
  const { events } = run(
    { type: 'user', message: { content: '<task-notification>\n<tool-use-id>t1</tool-use-id>\n<status>completed</status>\n</task-notification>' } },
    conn
  )
  assert.deepEqual(only(events, 'subagent-done'), [{ kind: 'subagent-done', toolUseId: 't1' }])
  assert.ok(!conn.subagents.has('t1'))
})

test('handleLine: another session\'s message joins the channel under its nick', () => {
  const conn = fakeConn({})
  const { events } = run(
    {
      type: 'user',
      message: {
        content:
          'Another Claude session sent a message:\n' +
          '<cross-session-message from="uds:/tmp/cc-socks/24482.sock" from-name="floe-8f" from-mode="bypass">\n' +
          'Vou mexer em skills.ts, não toca nele.\n' +
          '</cross-session-message>\n\n' +
          'This came from another Claude session — not typed by your user.'
      }
    },
    conn
  )
  assert.deepEqual(only(events, 'peer'), [
    { kind: 'peer', from: 'floe-8f', text: 'Vou mexer em skills.ts, não toca nele.' }
  ])
})

test('handleLine: a string-form async launch ack keeps the row open and says nothing', () => {
  const conn = fakeConn({ subagents: new Set(['t1']) })
  const { events } = run(
    {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Async agent launched (task id ad8330)' }] }
    },
    conn
  )
  assert.deepEqual(only(events, 'subagent-done'), [], 'the ack is not the agent reporting back')
  assert.ok(conn.subagents.has('t1'), 'its <task-notification> still has a row to close')
})

test('handleLine: a failed tool_result closes the row without speaking for the agent', () => {
  const conn = fakeConn({ subagents: new Set(['t1']) })
  const { events } = run(
    {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'Error: permission denied' }] }
    },
    conn
  )
  assert.deepEqual(only(events, 'subagent-done'), [{ kind: 'subagent-done', toolUseId: 't1' }])
  assert.ok(!conn.subagents.has('t1'))
})

test('handleLine: a peer message that merely mentions a task-notification is still the peer talking', () => {
  const conn = fakeConn({ subagents: new Set(['t1']) })
  const { events } = run(
    {
      type: 'user',
      message: {
        content:
          'Another Claude session sent a message:\n' +
          '<cross-session-message from="uds:/tmp/cc-socks/1.sock" from-name="floe-3b" from-mode="bypass">\n' +
          'o <task-notification> do agente assíncrono nunca chega no stdout\n' +
          '</cross-session-message>'
      }
    },
    conn
  )
  assert.deepEqual(only(events, 'peer'), [
    { kind: 'peer', from: 'floe-3b', text: 'o <task-notification> do agente assíncrono nunca chega no stdout' }
  ])
  assert.ok(conn.subagents.has('t1'), 'and it closed nobody\'s row')
})

test('handleLine: result does NOT fire done while an async agent is pending', () => {
  const conn = fakeConn({ subagents: new Set(['t1']) })
  const { events } = run({ type: 'result', is_error: false }, conn)
  assert.deepEqual(only(events, 'done'), [], 'session stays running until the async agent notifies')
})

// The core stuck-session fix: an async agent's <task-notification> only ever lands
// in the CLI transcript (never our stdout). Reading it there must close a held turn.
test('handleTaskLine: transcript notification closes the last held async subagent', () => {
  const { win, events } = fakeWin()
  const conn = fakeConn({ subagents: new Set(['t1']), turnActive: true, heldForSubagentsAt: 1, turnClosed: false })
  const jsonl = JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: '<task-notification>\n<tool-use-id>t1</tool-use-id>\n<status>completed</status>\n</task-notification>' })
  handleTaskLine(win, 'k', conn, jsonl)
  assert.deepEqual(kinds(events), ['subagent-done', 'done'])
  assert.ok(!conn.subagents.has('t1'))
  assert.equal(conn.turnActive, false)
  assert.equal(conn.turnClosed, true)
})

test('handleTaskLine: with another agent still pending, clears the row but withholds done', () => {
  const { win, events } = fakeWin()
  const conn = fakeConn({ subagents: new Set(['t1', 't2']), turnActive: true, heldForSubagentsAt: 1, turnClosed: false })
  handleTaskLine(win, 'k', conn, '<task-notification><tool-use-id>t1</tool-use-id></task-notification>')
  assert.deepEqual(kinds(events), ['subagent-done'])
  assert.ok(conn.subagents.has('t2'))
  assert.equal(conn.turnActive, true, 'turn stays held until t2 also reports')
})

test('handleTaskLine then a resumed stdout result do NOT double-fire done', () => {
  const { win, events } = fakeWin()
  const conn = fakeConn({ subagents: new Set(['t1']), turnActive: true, heldForSubagentsAt: 1, turnClosed: false })
  handleTaskLine(win, 'k', conn, '<task-notification><tool-use-id>t1</tool-use-id></task-notification>')
  // A late resumed result on stdout must be swallowed — turnClosed guards it.
  handleLine(win, 'k', conn, JSON.stringify({ type: 'result', is_error: false }))
  assert.deepEqual(only(events, 'done'), [{ kind: 'done', ok: true }], 'exactly one done')
})

test('handleLine: AskUserQuestion control_request surfaces a question and parks the requestId', () => {
  const conn = fakeConn()
  const { events } = run(
    {
      type: 'control_request',
      request_id: 'r1',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'AskUserQuestion',
        input: { questions: [{ question: 'Q?', options: [{ label: 'A' }] }] }
      }
    },
    conn
  )
  assert.equal(kinds(events).join(), 'question')
  assert.equal((events[0] as { toolUseId: string }).toolUseId, 'r1')
  assert.ok(conn.pendingPerms.has('r1'))
})

test('handleLine: an agent-spawned session answers its own question, never the user', () => {
  addCreatedSession({ id: 'child', worktreePath: '/tmp/wt', title: 'Child' })
  setCreatedSessionSpawnedBy('child', 'parent')
  const written: string[] = []
  const conn = fakeConn({ child: { stdin: { write: (s: string) => written.push(s) } } } as unknown as Partial<Conn>)
  const { win, events } = fakeWin()
  handleLine(
    win,
    'child',
    conn,
    JSON.stringify({
      type: 'control_request',
      request_id: 'r3',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'AskUserQuestion',
        input: { questions: [{ question: 'Q?', options: [{ label: 'A' }] }] }
      }
    })
  )
  assert.deepEqual(kinds(events), [], 'no question card reaches the renderer')
  assert.equal(conn.pendingPerms.size, 0, 'nothing is parked for a user answer')
  const reply = JSON.parse(written[0])
  assert.equal(reply.response.request_id, 'r3')
  assert.equal(reply.response.response.behavior, 'deny')
  assert.match(reply.response.response.message, /decide it yourself/i)
})

test('handleLine: a normal tool control_request surfaces a permission prompt', () => {
  const conn = fakeConn()
  const { events } = run(
    {
      type: 'control_request',
      request_id: 'r2',
      request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'rm -rf x' } }
    },
    conn
  )
  const perm = only(events, 'permission')[0] as { permission: { requestId: string; toolName: string; summary?: string } }
  assert.equal(perm.permission.requestId, 'r2')
  assert.equal(perm.permission.toolName, 'Bash')
  assert.equal(perm.permission.summary, 'rm -rf x')
  assert.ok(conn.pendingPerms.has('r2'))
})

test('handleLine: result ends the turn WITHOUT touching the token gauge', () => {
  // The trap the comment guards: result.usage is cumulative — feeding it to the
  // gauge would push it past 100%. So a result must emit `done` and no `tokens`.
  const ok = run({ type: 'result', is_error: false, usage: { input_tokens: 999999 } })
  assert.deepEqual(ok.events, [{ kind: 'done', ok: true }])
  const bad = run({ type: 'result', is_error: true })
  assert.deepEqual(bad.events, [{ kind: 'done', ok: false }])
})

test('handleLine: an image in a tool_result is surfaced to the transcript', () => {
  const { events } = run({
    type: 'user',
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'x',
          content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }]
        }
      ]
    }
  })
  assert.deepEqual(only(events, 'image'), [{ kind: 'image', mediaType: 'image/png', data: 'AAAA' }])
})

test('watchdogAction: recovers a turn held for an orphaned async subagent', () => {
  const now = 10_000_000
  const held = fakeConn({ turnActive: true, heldForSubagentsAt: now - 700_000, lastActivityAt: now - 700_000 })
  // Silent past HELD_RECOVER_MS while held → the notification is lost, recover.
  assert.equal(watchdogAction(held, now, true), 'recover')
  // Child already gone → recover immediately regardless of how recent activity was.
  const dead = fakeConn({ turnActive: true, heldForSubagentsAt: now - 5_000, lastActivityAt: now - 100 })
  assert.equal(watchdogAction(dead, now, false), 'recover')
  // A live async agent still streaming inline activity is NOT killed.
  const working = fakeConn({ turnActive: true, heldForSubagentsAt: now - 700_000, lastActivityAt: now - 1_000 })
  assert.equal(watchdogAction(working, now, true), 'log-stuck-subagents')
  // No active turn → nothing to do.
  assert.equal(watchdogAction(fakeConn({ turnActive: false }), now, true), 'none')
})

test('watchdogAction: recovers a fresh spawn wedged at startup (no meaningful output)', () => {
  const now = 10_000_000
  // Fresh spawn, turn started >SILENT_RECOVER_MS ago, never produced real output.
  const base = {
    turnActive: true,
    pendingPerms: new Map(),
    turnStartedOnFreshConn: true,
    turnHadMeaningfulOutput: false,
    turnStartedAt: now - 400_000,
    // lastActivityAt kept RECENT on purpose: system/status/requesting bumps it, so
    // recovery must measure from turnStartedAt, not from silence.
    lastActivityAt: now - 1_000
  }
  assert.equal(watchdogAction(fakeConn(base), now, true), 'recover-silent')

  // The turn DID stream real output (assistant/tool_use), then went quiet on a slow
  // API call (lastLineType would be 'system' status) → NOT a startup wedge.
  assert.equal(watchdogAction(fakeConn({ ...base, turnHadMeaningfulOutput: true }), now, true), 'none')

  // Persistent-child turn (not a fresh spawn) with no output → deliberately NOT killed.
  assert.equal(watchdogAction(fakeConn({ ...base, turnStartedOnFreshConn: false }), now, true), 'none')

  // Wedged shape but a prompt is pending (real pause, not a hang) → leave it be.
  assert.equal(watchdogAction(fakeConn({ ...base, pendingPerms: new Map([['r', {}]]) }), now, true), 'none')

  // Not long enough since turn start yet → nothing.
  assert.equal(watchdogAction(fakeConn({ ...base, turnStartedAt: now - 10_000 }), now, true), 'none')
})

test('watchdogAction: recovers a mid-turn stall (talked, then went silent for good)', () => {
  const now = 10_000_000
  // Already produced real output, so the startup-wedge check never fires — this is
  // the shape that used to only log (log-stuck-silent) forever, e.g. the 67-minute
  // "Pondering…" case in agent.log 2026-07-28. Past SILENT_RECOVER_MS_STALLED → recover.
  const stalled = fakeConn({
    turnActive: true,
    pendingPerms: new Map(),
    turnHadMeaningfulOutput: true,
    turnStartedOnFreshConn: false,
    turnStartedAt: now - 2_000_000,
    lastActivityAt: now - 1_300_000
  })
  assert.equal(watchdogAction(stalled, now, true), 'recover-silent')
  // Not silent long enough yet → just the softer log signal.
  assert.equal(watchdogAction(fakeConn({ ...stalled, lastActivityAt: now - 200_000 }), now, true), 'log-stuck-silent')
  // A pending permission/question is a real pause, not a hang → leave it be.
  assert.equal(
    watchdogAction(fakeConn({ ...stalled, pendingPerms: new Map([['r', {}]]) }), now, true),
    'none'
  )
})

// A child in the shape sendToAgent/the watchdog inspects. Defaults to alive.
function fakeChild(over: Record<string, unknown> = {}): Conn['child'] {
  return { exitCode: null, signalCode: null, killed: false, stdin: { destroyed: false, writableEnded: false }, ...over } as unknown as Conn['child']
}

test('isChildDead: catches a zombie whose exitCode Node has not observed yet', () => {
  assert.equal(isChildDead(fakeChild()), false)
  assert.equal(isChildDead(fakeChild({ exitCode: 0 })), true)
  assert.equal(isChildDead(fakeChild({ signalCode: 'SIGTERM' })), true)
  // The bug's shape: reaped by the OS, exitCode still null, but the pipe is gone.
  assert.equal(isChildDead(fakeChild({ killed: true })), true)
  assert.equal(isChildDead(fakeChild({ stdin: { destroyed: true, writableEnded: false } })), true)
  assert.equal(isChildDead(fakeChild({ stdin: { destroyed: false, writableEnded: true } })), true)
})

test('runWatchdogTick: one broken conn cannot stop the other sessions recovering', () => {
  const now = 10_000_000
  const held = { turnActive: true, heldForSubagentsAt: now - 700_000, lastActivityAt: now - 700_000, child: fakeChild() }
  // `win` is undefined (a torn-down window): send() throws inside this key's branch.
  const broken = fakeConn({ ...held, win: undefined as unknown as BrowserWindow })
  const { win, events } = fakeWin()
  const good = fakeConn({ ...held, win })

  runWatchdogTick(
    [
      ['broken', broken],
      ['good', good]
    ],
    now
  )

  // The healthy session was still recovered: turn closed and `done` reached the UI.
  assert.equal(good.turnActive, false)
  assert.deepEqual(kinds(events), ['done'])
})

test('handleLine: turnHadMeaningfulOutput flips true only on non-system lines and stays true', () => {
  const conn = fakeConn({ turnHadMeaningfulOutput: false })
  // system lines (init/status/api_retry) are NOT meaningful — the wedge-at-init shape.
  run({ type: 'system', subtype: 'status' }, conn)
  assert.equal(conn.turnHadMeaningfulOutput, false)
  // Any real turn output flips it true.
  run({ type: 'assistant', message: { role: 'assistant', content: [] } }, conn)
  assert.equal(conn.turnHadMeaningfulOutput, true)
  // A later system/status (slow API before next request) must NOT revert it — the
  // invariant that stops the watchdog killing a turn that already did real work.
  run({ type: 'system', subtype: 'status' }, conn)
  assert.equal(conn.turnHadMeaningfulOutput, true)
})

test('pruneSettled: an answered question leaves the replay, the rest of the turn stays', () => {
  // The stale-card bug: the replay only ever grew, so reopening a panel after
  // answering replayed the question as if it were still open.
  const events: AgentEvent[] = [
    { kind: 'text', text: 'thinking' },
    { kind: 'question', toolUseId: 'req-1', questions: [{ question: 'Q?', options: [{ label: 'A' }] }] },
    { kind: 'permission', permission: { requestId: 'req-2', toolName: 'Bash' } }
  ]
  assert.deepEqual(kinds(pruneSettled(events, 'req-1')), ['text', 'permission'])
  assert.deepEqual(kinds(pruneSettled(events, 'req-2')), ['text', 'question'])
  // An id that settled on another session must not eat this one's card.
  assert.deepEqual(kinds(pruneSettled(events, 'req-9')), ['text', 'question', 'permission'])
})

test('dropSettled: the answered question leaves the live replay snapshot', () => {
  // The codex path answers over JSON-RPC, not the control channel, so this is
  // the only thing that clears its card: without it, leaving the chat and
  // coming back mid-turn replayed the question the model was already answering.
  const { win } = fakeWin()
  markTurnStart('sess-1')
  sendAgentEvent(win, 'sess-1', { kind: 'text', text: 'working' })
  sendAgentEvent(win, 'sess-1', {
    kind: 'question',
    toolUseId: '7',
    questions: [{ question: 'Q?', options: [{ label: 'A' }] }]
  })
  assert.deepEqual(kinds(replaySnapshot('sess-1').events), ['text', 'question'])
  dropSettled('sess-1', '7')
  assert.deepEqual(kinds(replaySnapshot('sess-1').events), ['text'])
})

test('dropSettled: the card is pruned under every name the session answers to', () => {
  // The panel keys itself by `claudeId ?? id` while the conn stays filed under
  // whatever spawned it, so the answer can arrive under a different name than
  // the one the question was recorded under. Pruning one of them left the other
  // replay holding an open card for a question already answered.
  const { win } = fakeWin()
  addCreatedSession({ id: 'floe-id', worktreePath: '/tmp/wt' })
  linkCreatedSession('floe-id', 'claude-id')
  markTurnStart('floe-id')
  sendAgentEvent(win, 'floe-id', {
    kind: 'question',
    toolUseId: 'rq-1',
    questions: [{ question: 'Q?', options: [{ label: 'A' }] }]
  })
  assert.deepEqual(kinds(replaySnapshot('floe-id').events), ['question'])
  // Answered under the panel's name, not the one the replay is filed under.
  dropSettled('claude-id', 'rq-1')
  assert.deepEqual(kinds(replaySnapshot('floe-id').events), [])
})

test('replaySnapshot: the turn is found under every name the session answers to', () => {
  // The chat opened from the launcher is keyed by Floe's id, so its first turn
  // is marked under that — while a chat reopened from the sidebar is keyed by
  // the claudeId. Asking under the name the panel happens to hold used to
  // answer "nothing running", which is how a session went silent mid-turn.
  const { win } = fakeWin()
  addCreatedSession({ id: 'floe-replay', worktreePath: '/tmp/wt' })
  linkCreatedSession('floe-replay', 'claude-replay')
  markTurnStart('floe-replay')
  sendAgentEvent(win, 'floe-replay', { kind: 'text', text: 'working' })

  const snapshot = replaySnapshot('claude-replay')
  assert.equal(snapshot.running, true)
  assert.deepEqual(kinds(snapshot.events), ['text'])
  // Both names travel with it: the panel listens for events under either, or
  // the rest of the turn arrives tagged with a key it filters out.
  assert.deepEqual(snapshot.names?.sort(), ['claude-replay', 'floe-replay'])
})

test('replaySnapshot: a finished turn does not come back as running', () => {
  // The other half of the same lookup: `done` ends the turn under the name it
  // ran under, and an alias must not resurrect it — a chat that re-opened to a
  // typing line for an answer already printed is exactly the reported bug.
  const { win } = fakeWin()
  addCreatedSession({ id: 'floe-ended', worktreePath: '/tmp/wt' })
  linkCreatedSession('floe-ended', 'claude-ended')
  markTurnStart('floe-ended')
  sendAgentEvent(win, 'floe-ended', { kind: 'text', text: 'answered' })
  sendAgentEvent(win, 'floe-ended', { kind: 'done', ok: true })

  assert.equal(replaySnapshot('claude-ended').running, false)
  assert.equal(replaySnapshot('floe-ended').running, false)
})

test('replayInFlight: a stranded conn does not keep a turn alive', () => {
  // The reported bug, as one decision. A session whose panel key flipped
  // mid-turn (Floe id → claudeId) used to get a SECOND claude spawned under the
  // new name, stranding the first conn: nothing writes to it, so no `done` ever
  // clears its replay. Asked under the stranded name, the snapshot answered
  // "running, started 40 minutes ago" forever — an eternal typing line, and a
  // panel that then cut its on-disk transcript at that timestamp and dropped
  // every message written since. The conn is the authority: its turn is over.
  assert.equal(replayInFlight({ running: true }, fakeConn({ turnActive: false })), false)
  // A turn genuinely in flight still is one.
  assert.equal(replayInFlight({ running: true }, fakeConn({ turnActive: true })), true)
  // codex and the local agents keep no conn — `markTurnStart` is the only mark
  // they leave, so there is nothing to contradict it.
  assert.equal(replayInFlight({ running: true }, undefined), true)
  // And `done` still ends it, conn or no conn.
  assert.equal(replayInFlight({ running: false }, undefined), false)
  assert.equal(replayInFlight(undefined, fakeConn({ turnActive: true })), false)
})

test('activeTurnKeys: a runtime with no conn still reports its turn', () => {
  // codex and the local agents keep no conn — `markTurnStart` is the only mark
  // they leave. Built from `conns` alone this list called their turns idle, and
  // both reconcilers (the session list's spinner, the chat's typing line) take
  // it as the authority: they would have closed a turn still running.
  const { win } = fakeWin()
  markTurnStart('codex-sess')
  assert.ok(activeTurnKeys().includes('codex-sess'))
  sendAgentEvent(win, 'codex-sess', { kind: 'done', ok: true })
  assert.ok(!activeTurnKeys().includes('codex-sess'))
})

test('activeTurnKeys stays raw — a query key is in it, on purpose', () => {
  // The set is the authority both reconcilers correct themselves against, and a
  // QueryPanel's `useTranscript` is one of them: it treats "not in this list,
  // and quiet" as proof the turn ended. Hide the qkey here and every query
  // would conclude on its own that it had finished, drop the typing line, and
  // drain its queue over a turn that was still running.
  //
  // The projection is filtered instead, in exactly one place — see
  // useSessionActivity in renderer/src/useRunning.ts.
  const { win } = fakeWin()
  markTurnStart('qsess~codex')
  assert.ok(activeTurnKeys().includes('qsess~codex'))
  sendAgentEvent(win, 'qsess~codex', { kind: 'done', ok: true })
  assert.ok(!activeTurnKeys().includes('qsess~codex'))
})

test('a replay says who is answering, not just what model', () => {
  markTurnStart('routed-sess', { provider: 'codex', effort: 'high', mode: 'plan' })
  const snap = replaySnapshot('routed-sess')
  assert.equal(snap.running, true)
  // A panel opening onto this turn has no other way to know: the picker in the
  // chat still says whatever the SESSION is set to.
  assert.deepEqual(snap.choice, { provider: 'codex', effort: 'high', mode: 'plan' })
})

// ── waitForTurn ─────────────────────────────────────────────────────────────

test('waitForTurn: a parked caller is released with the turn\'s final text', async () => {
  // The MCP send_message(wait) seam: one session asks another a question and
  // blocks on the answer. It is the turn's `done` that hands it over.
  const { win } = fakeWin()
  const conn = fakeConn({ lastAssistantText: 'forty-seven' })
  const parked = waitForTurn('wait-1', 60_000)
  handleLine(win, 'wait-1', conn, JSON.stringify({ type: 'result', is_error: false }))
  assert.equal(await parked, 'forty-seven')
})

test('waitForTurn: a timeout resolves with what exists so far, and stops waiting', async () => {
  // Never resolving would block the caller forever; resolving and then leaving
  // the waiter parked would hand the NEXT turn's `done` to a caller long gone.
  assert.equal(await waitForTurn('wait-2', 5), '', 'no conn, nothing said: empty, not a hang')
  const { win } = fakeWin()
  const conn = fakeConn({ lastAssistantText: 'late' })
  handleLine(win, 'wait-2', conn, JSON.stringify({ type: 'result', is_error: false }))
  // A second wait proves the timed-out one was removed: if it were still parked
  // it would have taken that `done` and this one would never see the next.
  const parked = waitForTurn('wait-2', 60_000)
  handleLine(win, 'wait-2', fakeConn({ lastAssistantText: 'later' }), JSON.stringify({ type: 'result', is_error: false }))
  assert.equal(await parked, 'later')
})

// ── the watchdog's other shapes ─────────────────────────────────────────────

test('runWatchdogTick: logs the two soft shapes and only recovers the wedged one', () => {
  const now = 10_000_000
  const { win, events } = fakeWin()
  // Held on a subagent past HELD_STUCK_MS but still streaming inline activity:
  // shout once, never kill — a live async agent is doing exactly this.
  const held = fakeConn({
    win, child: fakeChild(), turnActive: true, subagents: new Set(['t1']),
    heldForSubagentsAt: now - 120_000, lastActivityAt: now - 1_000, stuckLogged: false
  })
  // Talked, then quiet past SILENT_STUCK_MS but not past recovery: soft signal.
  const quiet = fakeConn({
    win, child: fakeChild(), turnActive: true, pendingPerms: new Map(), turnHadMeaningfulOutput: true,
    turnStartedAt: now - 400_000, lastActivityAt: now - 200_000, stuckLogged: false
  })
  // A fresh spawn that never produced real output: wedged at init, recover.
  const wedged = fakeConn({
    win, child: fakeChild(), turnActive: true, pendingPerms: new Map(), turnStartedOnFreshConn: true,
    turnHadMeaningfulOutput: false, turnStartedAt: now - 400_000, lastActivityAt: now - 1_000
  })

  runWatchdogTick([['held', held], ['quiet', quiet], ['wedged', wedged]], now)

  assert.equal(held.stuckLogged, true)
  assert.equal(held.turnActive, true, 'a held turn that is still talking is left alone')
  assert.equal(quiet.stuckLogged, true)
  assert.equal(quiet.turnActive, true)
  // Only the wedge is surfaced, and as an error — not a silent empty success.
  assert.deepEqual(kinds(events), ['error'])
  assert.match((events[0] as { message: string }).message, /stopped responding/i)
})

test('runWatchdogTick: a second tick does not shout about the same stuck turn twice', () => {
  const now = 10_000_000
  const { win } = fakeWin()
  const conn = fakeConn({
    win, child: fakeChild(), turnActive: true, pendingPerms: new Map(), turnHadMeaningfulOutput: true,
    turnStartedAt: now - 400_000, lastActivityAt: now - 200_000, stuckLogged: false
  })
  runWatchdogTick([['k', conn]], now)
  assert.equal(conn.stuckLogged, true)
  assert.equal(watchdogAction(conn, now, true), 'none', 'already logged — nothing left to say')
})

// ── spawnConn / sendToAgent, against the faked CLI ──────────────────────────

test('sendToAgent: the first send spawns a stream-json CLI and writes the prompt', () => {
  const { win, events, spawn } = startSession('spawn-1', 'do the thing', {
    permissionMode: 'skip', model: 'opus', effort: 'high'
  })
  const args = spawn.args
  assert.equal(spawn.opts.cwd, WT)
  assert.deepEqual(args.slice(0, 7), [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--include-partial-messages', '--verbose'
  ])
  assert.ok(args.includes('--dangerously-skip-permissions'), 'skip mode bypasses the prompts')
  // …but the control channel stays attached even in skip mode, or the CLI
  // auto-dismisses AskUserQuestion within seconds and the model reads it as
  // "the user ignored the question".
  assert.equal(args[args.indexOf('--permission-prompt-tool') + 1], 'stdio')
  assert.equal(args[args.indexOf('--model') + 1], 'opus')
  assert.equal(args[args.indexOf('--effort') + 1], 'high')
  assert.equal(args[args.indexOf('--allowedTools') + 1], 'mcp__floe')
  assert.ok(!args.includes('--resume'), 'a brand-new session has nothing to resume')

  const sent = wrote(spawn.child)
  assert.equal(sent.type, 'user')
  assert.equal(sent.message.content, 'do the thing', 'no attachments → a plain string, not blocks')
  assert.equal(hasActiveTurn('spawn-1'), true)
  assert.equal(readSessionBuffer('spawn-1'), 'user: do the thing')

  endSession(win, 'spawn-1', spawn.child)
  assert.equal(hasActiveTurn('spawn-1'), false)
  assert.deepEqual(kinds(events).slice(-1), ['done'], 'a stop always closes the turn in the UI')
})

test('sendToAgent: attachments travel as content blocks, prompt last', () => {
  const { win, events } = fakeWin()
  const at = spawned.length
  sendToAgent(
    win, 'spawn-att', WT, 'look at these', DEFAULT_OPTS,
    [{ id: 'i1', mediaType: 'image/png', data: 'AAAA' }],
    [
      { id: 'f1', kind: 'pdf', mediaType: 'application/pdf', data: 'JVBERi0=', name: 'spec.pdf' },
      { id: 'f2', kind: 'text', mediaType: 'text/markdown', data: Buffer.from('hi there').toString('base64'), name: 'notes.md' }
    ]
  )
  const blocks = wrote(spawned[at].child).message.content as Array<Record<string, { type?: string; data?: string; media_type?: string }> & { type: string; text?: string }>
  assert.deepEqual(blocks.map((b) => b.type), ['image', 'document', 'document', 'text'])
  assert.equal(blocks[1].source.media_type, 'application/pdf')
  // The API's base64 document source only accepts PDFs, so a text file is
  // decoded on the way out — send it as base64 and the model reads gibberish.
  assert.equal(blocks[2].source.type, 'text')
  assert.equal(blocks[2].source.data, 'hi there')
  assert.equal(blocks[3].text, 'look at these', 'the prompt comes after its attachments')
  assert.deepEqual(kinds(events), ['turn'])
  endSession(win, 'spawn-att', spawned[at].child)
})

test('sendToAgent: a send during a live turn steers it instead of spawning a second CLI', () => {
  const { win, spawn } = startSession('steer-1')
  const at = spawned.length
  sendToAgent(win, 'steer-1', WT, 'actually, stop', DEFAULT_OPTS)
  assert.equal(spawned.length, at, 'one session, one claude — a second would strand the first')
  assert.equal(wrote(spawn.child, 1).message.content, 'actually, stop')
  assert.equal(hasActiveTurn('steer-1'), true, 'the running turn continues; it is not reset')
  // Into the replay, not onto the wire: the panel that typed it already shows
  // it, and until the CLI absorbs it the replay is the only place a panel
  // mounting mid-turn can read what was said.
  assert.deepEqual(kinds(replaySnapshot('steer-1').events), ['steer'])
  assert.equal(readSessionBuffer('steer-1'), 'user: hello\nuser: actually, stop')
  endSession(win, 'steer-1', spawn.child)
})

test('sendToAgent: changing the model retires the child and respawns', () => {
  const { win, spawn } = startSession('opts-1', 'first', { permissionMode: 'default', model: 'sonnet' })
  emit(spawn.child, { type: 'result', is_error: false }) // turn over, so this is not a steer
  const at = spawned.length
  sendToAgent(win, 'opts-1', WT, 'second', { permissionMode: 'default', model: 'opus' })
  assert.deepEqual(spawn.child.signals, ['SIGTERM'], 'the child cannot change its own flags')
  assert.equal(spawned.length, at + 1)
  assert.equal(spawned[at].args[spawned[at].args.indexOf('--model') + 1], 'opus')
  endSession(win, 'opts-1', spawned[at].child)
})

test('sendToAgent: a child that died while idle is dropped, never written to', () => {
  const { win, spawn } = startSession('dead-1')
  emit(spawn.child, { type: 'result', is_error: false })
  // The zombie shape from the spawn-hang report: reaped by the OS, exitCode
  // still null, but the pipe is gone. Writing here hangs the turn forever.
  spawn.child.stdin.destroyed = true
  const at = spawned.length
  sendToAgent(win, 'dead-1', WT, 'again', DEFAULT_OPTS)
  assert.equal(spawned.length, at + 1, 'respawned instead of writing into a dead pipe')
  assert.equal(spawn.child.writes.length, 1, 'and the corpse heard nothing more')
  endSession(win, 'dead-1', spawned[at].child)
})

test('sendToAgent: spawning under a new name retires the child the session ran under', () => {
  // The renderer switches its key from the Floe id to the claudeId the moment
  // the CLI reports it. Without the reap the first child is left alive forever:
  // two claudes for one session, and two conns whose `turnActive` disagree.
  addCreatedSession({ id: 'reap-old', worktreePath: WT })
  const old = startSession('reap-old')
  emit(old.spawn.child, { type: 'system', subtype: 'init', session_id: 'reap-cid' })
  emit(old.spawn.child, { type: 'result', is_error: false })
  addCreatedSession({ id: 'reap-new', worktreePath: WT })
  linkCreatedSession('reap-new', 'reap-cid')

  const next = startSession('reap-new', 'carry on')
  assert.deepEqual(old.spawn.child.signals, ['SIGTERM'])
  assert.equal(hasActiveTurn('reap-old'), false, 'the stale name holds no conn at all now')
  // And the history is not lost — the replacement resumes the CLI's own session.
  assert.equal(next.spawn.args[next.spawn.args.indexOf('--resume') + 1], 'reap-cid')
  endSession(next.win, 'reap-new', next.spawn.child)
})

test('sendToAgent: an answer arriving under an alias reaches the one live conn', () => {
  // A conn stays filed under whatever key spawned it while the panel keys itself
  // by `claudeId ?? id`, so the name a send arrives under is not always the name
  // the child runs under. Missing that spawned a second claude (see the reap).
  addCreatedSession({ id: 'alias-1', worktreePath: WT })
  const { win, spawn } = startSession('alias-1')
  emit(spawn.child, { type: 'system', subtype: 'init', session_id: 'alias-cid' })
  const at = spawned.length
  sendToAgent(win, 'alias-cid', WT, 'under the CLI\'s own name', DEFAULT_OPTS)
  assert.equal(spawned.length, at, 'resolved to the existing conn, not a new child')
  assert.equal(wrote(spawn.child, 1).message.content, 'under the CLI\'s own name')
  endSession(win, 'alias-1', spawn.child)
})

test('stopAgent: a stop arriving under an alias kills the live child', () => {
  // The reported bug: the panel re-keys itself to the claudeId the moment the
  // CLI reports it, mid-turn, while the conn stays filed under the Floe id.
  // `conns.get(key)` alone then missed, Stop returned having killed nothing,
  // and the turn it was meant to cancel kept streaming under "is typing".
  addCreatedSession({ id: 'stop-alias', worktreePath: WT })
  const { win, events, spawn } = startSession('stop-alias')
  emit(spawn.child, { type: 'system', subtype: 'init', session_id: 'stop-alias-cid' })
  stopAgent(win, 'stop-alias-cid')
  assert.deepEqual(spawn.child.signals, ['SIGTERM'], 'the child the panel was watching was killed')
  assert.ok(
    events.some((e) => e.kind === 'done'),
    'and the turn was ended for the panel'
  )
  spawn.child.emit('close', 0)
})

test('sendToAgent: a query gets an empty, strict MCP config — never the global one', () => {
  // A query's key is not a session id, so the token it would carry resolves to
  // nothing; and leaving the token out would let the CLI inherit the globally
  // registered Floe server and come back as `/mcp/global` — the same tools
  // under the wrong identity. It takes both halves to be safe.
  const { win, spawn } = startSession('qparent~codex')
  const args = spawn.args
  assert.ok(args.includes('--strict-mcp-config'), 'the global and project servers must not leak in')
  assert.ok(!args.includes('--allowedTools'), 'nothing to auto-permit: a query holds no floe token')
  assert.deepEqual(JSON.parse(readFileSync(args[args.indexOf('--mcp-config') + 1], 'utf8')), { mcpServers: {} })
  endSession(win, 'qparent~codex', spawn.child)
})

test('spawnConn: a missing claude CLI closes the turn with a legible error', () => {
  const { events, spawn } = startSession('err-1')
  spawn.child.emit('error', new Error('spawn claude ENOENT'))
  assert.deepEqual(only(events, 'error'), [{ kind: 'error', message: 'claude CLI not found' }])
  assert.deepEqual(only(events, 'done'), [{ kind: 'done', ok: false }])
  assert.equal(hasActiveTurn('err-1'), false, 'deregistered, so the next send respawns')
})

test('spawnConn: ENOENT with a missing cwd blames the worktree, not the CLI', () => {
  // The real case is a session routed here from another machine. Blaming the
  // CLI sends the user hunting for a PATH problem that does not exist.
  const { win, events } = fakeWin()
  const at = spawned.length
  const gone = join(HOME, 'not-on-this-machine')
  sendToAgent(win, 'err-2', gone, 'hi', DEFAULT_OPTS)
  spawned[at].child.emit('error', new Error('spawn claude ENOENT'))
  assert.match((only(events, 'error')[0] as { message: string }).message, /belongs to another backend/)
  assert.match((only(events, 'error')[0] as { message: string }).message, /not-on-this-machine/)
})

test('spawnConn: a non-zero close surfaces stderr and ends the turn', () => {
  const { events, spawn } = startSession('close-1')
  spawn.child.stderr.emit('data', 'error: unknown option --effort\n')
  spawn.child.emit('close', 2)
  assert.deepEqual(only(events, 'error'), [{ kind: 'error', message: 'error: unknown option --effort' }])
  assert.deepEqual(only(events, 'done'), [{ kind: 'done', ok: false }])
  assert.equal(hasActiveTurn('close-1'), false)
})

test('spawnConn: a broken stdin pipe is fatal for the conn, never for main', () => {
  // Swallowed, this left the turn "running" forever with no log line and no UI
  // signal — the `close` that was supposed to clean up never came.
  const { events, spawn } = startSession('pipe-1')
  spawn.child.stdin.emit('error', new Error('write EPIPE'))
  assert.match((only(events, 'error')[0] as { message: string }).message, /Send your message again/)
  assert.deepEqual(only(events, 'done'), [{ kind: 'done', ok: false }])
  assert.equal(hasActiveTurn('pipe-1'), false)
})

test('spawnConn: a replaced child\'s late close cannot delete the conn that replaced it', () => {
  // Stop-then-drain: the old process is killed and a new conn spawns at the same
  // key. The old one's late close used to delete that new conn and fire a stale
  // `done`, orphaning the queued turn — "nothing happens".
  const { win, spawn } = startSession('late-1')
  emit(spawn.child, { type: 'result', is_error: false })
  const at = spawned.length
  sendToAgent(win, 'late-1', WT, 'next', { permissionMode: 'plan' }) // options change → respawn
  spawn.child.emit('close', 0) // the retired child, arriving late
  assert.equal(hasActiveTurn('late-1'), true, 'the replacement still owns the key')
  endSession(win, 'late-1', spawned[at].child)
})

// ── ensureTaskWatcher ───────────────────────────────────────────────────────

test('ensureTaskWatcher: an async agent\'s completion is read off the CLI transcript', async () => {
  // The stuck-session bug in full. Under --output-format stream-json the CLI
  // processes the queued `<task-notification>` internally and never echoes it on
  // our stdout, so the launching id is never cleared and the held `result`
  // strands the turn "Thinking…". The notification IS written to the transcript.
  const { win, events, spawn } = startSession('watch-1')
  emit(spawn.child, { type: 'system', subtype: 'init', session_id: 'watch-cid' })

  const dir = join(HOME, '.claude', 'projects', WT.replace(/[^a-zA-Z0-9]/g, '-'))
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'watch-cid.jsonl')
  // A resumed session's file already holds old, done notifications. Reprocessing
  // them would close a row that only just opened, so the watcher starts at EOF.
  const stale = '<task-notification>\n<tool-use-id>a1</tool-use-id>\n<status>completed</status>\n</task-notification>'
  writeFileSync(file, JSON.stringify({ type: 'user', message: { content: stale } }) + '\n')

  emit(spawn.child, {
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'Agent', id: 'a1', input: { subagent_type: 'Explore', description: 'dig' } }] }
  })
  emit(spawn.child, { type: 'result', is_error: false })
  assert.deepEqual(only(events, 'subagent-start').length, 1)
  assert.deepEqual(only(events, 'subagent-done'), [], 'the notification already on disk is not this launch\'s')
  assert.deepEqual(only(events, 'done'), [], 'the turn is held for the async agent')

  // fs.watch needs a turn of the loop to arm before it reports anything.
  await new Promise((r) => setTimeout(r, 100))
  appendFileSync(
    file,
    JSON.stringify({
      type: 'user',
      message: { content: '<task-notification>\n<tool-use-id>a1</tool-use-id>\n<status>completed</status>\n<result>found it</result>\n</task-notification>' }
    }) + '\n'
  )
  await waitFor(() => only(events, 'done').length > 0, 5000, 'the transcript watcher')

  // The agent reports back in its own voice, and the turn closes here — the
  // stdout `result` that would normally do it is never coming.
  assert.deepEqual(only(events, 'subagent-done'), [{ kind: 'subagent-done', toolUseId: 'a1', reply: 'found it' }])
  assert.deepEqual(only(events, 'done'), [{ kind: 'done', ok: true }])
  assert.equal(hasActiveTurn('watch-1'), false)
  assert.match(readSessionBuffer('watch-1'), /agent: found it/)
  endSession(win, 'watch-1', spawn.child)
})

test('ensureTaskWatcher: no transcript on disk yet is survivable, not a throw', () => {
  // The dir only appears once the CLI writes its first turn. The watchdog is the
  // safety net until then; launching an agent must not take the session down.
  const { win, events, spawn } = startSession('watch-2')
  emit(spawn.child, { type: 'system', subtype: 'init', session_id: 'no-such-transcript' })
  emit(spawn.child, {
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'Task', id: 'b1', input: { description: 'dig' } }] }
  })
  assert.deepEqual(only(events, 'subagent-start').length, 1, 'the row still opens')
  endSession(win, 'watch-2', spawn.child)
})

// ── handleLine dispatch, after the split ────────────────────────────────────

test('handleLine: present_decision renders as an artifact, not a tool card', () => {
  const conn = fakeConn()
  const { win, events } = fakeWin()
  handleLine(win, 'k', conn, JSON.stringify(textDelta('picking… ')))
  handleLine(win, 'k', conn, JSON.stringify({
    type: 'assistant',
    message: {
      content: [{
        type: 'tool_use',
        name: 'mcp__floe__present_decision',
        id: 'd1',
        input: {
          title: 'Pick one',
          groups: [{ id: 'g1', label: 'Storage', select: 'single', options: [{ id: 'a', label: 'SQLite' }] }]
        }
      }]
    }
  }))
  // The streamed text is flushed first, so the panel lands in order.
  assert.deepEqual(kinds(events), ['text', 'artifact'])
  assert.deepEqual(only(events, 'tool'), [], 'no duplicate tool chip')
})

test('handleLine: a malformed decision spec falls back to the plain tool card', () => {
  // Nothing may silently disappear: a spec the validator rejects is still a tool
  // the model ran, and the transcript has to say so.
  const { events } = run({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'mcp__floe__present_decision', id: 'd2', input: { nope: true } }] }
  })
  assert.deepEqual(only(events, 'artifact'), [])
  assert.equal((only(events, 'tool')[0] as { name: string }).name, 'mcp__floe__present_decision')
})

test('handleLine: an AskUserQuestion tool_use renders nothing — the control request owns it', () => {
  // It is delivered (and paused on) over the control channel in every mode now,
  // so a card here would be a second, non-interactive copy of the same question.
  const { events } = run({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'AskUserQuestion', id: 'q1', input: { questions: [] } }] }
  })
  assert.deepEqual(kinds(events), [])
})

test('handleLine: an AskUserQuestion with no parsable questions falls back to a permission card', () => {
  // Better a card the user can deny than a CLI blocked on a request with no way
  // to answer it.
  const conn = fakeConn()
  const { events } = run({
    type: 'control_request',
    request_id: 'r9',
    request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions: [] } }
  }, conn)
  assert.deepEqual(kinds(events), ['permission'])
  assert.ok(conn.pendingPerms.has('r9'))
})

test('handleLine: the CLI\'s own description wins over the guessed tool summary', () => {
  const { events } = run({
    type: 'control_request',
    request_id: 'r10',
    request: { subtype: 'can_use_tool', tool_name: 'Bash', description: 'Delete the build output', input: { command: 'rm -rf out' } }
  })
  const perm = only(events, 'permission')[0] as { permission: { summary?: string } }
  assert.equal(perm.permission.summary, 'Delete the build output')
})

test('handleLine: a control_request with no id or wrong subtype is ignored', () => {
  assert.deepEqual(kinds(run({ type: 'control_request', request: { subtype: 'interrupt' } }).events), [])
  assert.deepEqual(kinds(run({ type: 'control_request', request_id: '', request: { subtype: 'can_use_tool' } }).events), [])
})

test('handleLine: an error result surfaces the CLI\'s message once, not twice', () => {
  // "Usage credits are required for this model." arrives as an error result. But
  // when it IS the streamed assistant text it must not render a second time.
  const shown = run({ type: 'result', is_error: true, result: 'Usage credits are required.' }, fakeConn())
  assert.deepEqual(shown.events, [
    { kind: 'error', message: 'Usage credits are required.' },
    { kind: 'done', ok: false }
  ])
  const already = run(
    { type: 'result', is_error: true, result: 'Usage credits are required.' },
    fakeConn({ lastAssistantText: 'Usage credits are required.' })
  )
  assert.deepEqual(already.events, [{ kind: 'done', ok: false }])
})

test('handleLine: an unrecognised task-notification id is logged, never guessed at', () => {
  // A notification that clears no row is exactly how a turn strands "Thinking…".
  const conn = fakeConn({ subagents: new Set(['t1']) })
  const { events } = run(
    { type: 'user', message: { content: '<task-notification>\n<tool-use-id>ghost</tool-use-id>\n<status>completed</status>\n</task-notification>' } },
    conn
  )
  assert.deepEqual(kinds(events), [])
  assert.ok(conn.subagents.has('t1'), 'and it did not close somebody else\'s row')
})

test('handleLine: two agents finishing together both close', () => {
  // Delivered as adjacent blocks in one message. Stopping at the first strands
  // the rest — tracked, running, holding the turn open.
  const conn = fakeConn({ subagents: new Set(['t1', 't2']) })
  const { events } = run({
    type: 'user',
    message: {
      content:
        '<task-notification>\n<tool-use-id>t1</tool-use-id>\n<result>one</result>\n</task-notification>\n' +
        '<task-notification>\n<tool-use-id>t2</tool-use-id>\n<result>two</result>\n</task-notification>'
    }
  }, conn)
  assert.deepEqual(only(events, 'subagent-done'), [
    { kind: 'subagent-done', toolUseId: 't1', reply: 'one' },
    { kind: 'subagent-done', toolUseId: 't2', reply: 'two' }
  ])
  assert.equal(conn.subagents.size, 0)
})

// ── the stranded replay ─────────────────────────────────────────────────────
// The 40-hour typing line. A replay left `running` with nothing behind it is
// invisible to the watchdog above (it walks `conns`, and the whole point is
// that there is no conn), while activeTurnKeys keeps reporting it and
// replaySnapshot keeps handing the dead turn's `startedAt` back on every open.

test('strandedReplayKeys: no live turn behind a running replay is a strand, after its own grace', () => {
  const now = 100_000_000
  const claude = { running: true, startedAt: now - 90_000, choice: { provider: 'claude' } }
  const entries: [string, typeof claude][] = [['stranded', claude]]
  // Claude holds a conn for as long as it works, so a replay without one is
  // over — the grace window only covers the respawn a send performs.
  assert.deepEqual(strandedReplayKeys(entries, () => false, now), ['stranded'])
  assert.deepEqual(strandedReplayKeys(entries, () => true, now), [], 'a live turn is never swept')
  // Inside the grace it is left alone: a send that is respawning right now has
  // a moment where the replay is ahead of its conn.
  assert.deepEqual(strandedReplayKeys(entries, () => false, claude.startedAt + 1_000), [])
  // A finished replay is not a strand — nothing to close.
  assert.deepEqual(strandedReplayKeys([['done', { running: false, startedAt: 0 }]], () => false, now), [])
})

test('strandedReplayKeys: a conn-less runtime is judged by a ceiling, not by the missing conn', () => {
  // codex, opencode and the local agents keep no conn BY DESIGN, so its absence
  // says nothing about them. Sweeping them on Claude's grace would kill a turn
  // three minutes into a legitimate run.
  const now = 100_000_000
  const codex: [string, { running: boolean; startedAt: number; choice: { provider: string } }][] = [
    ['cx', { running: true, startedAt: now - 600_000, choice: { provider: 'codex' } }]
  ]
  assert.deepEqual(strandedReplayKeys(codex, () => false, now), [], 'ten minutes in, still working')
  assert.deepEqual(strandedReplayKeys(codex, () => false, now + 3_600_000), ['cx'], 'past the ceiling, released')
})

test('sendToAgent: a child that died MID-TURN takes its turn down with it', () => {
  // The reported bug, end to end. The panel re-keys itself to the claudeId the
  // moment the CLI reports one, so the next send arrives under a name the conn
  // is not filed under — it resolves to the same child, which by then is a
  // zombie. Dropping that conn silently (what this used to do) left the replay
  // under the OLD name saying `running` with nobody able to end it: the
  // watchdog cannot see a replay, and the late `close` is dropped by isCurrent.
  addCreatedSession({ id: 'zombie-1', worktreePath: WT })
  const { win, events, spawn } = startSession('zombie-1')
  emit(spawn.child, { type: 'system', subtype: 'init', session_id: 'zombie-cid' })
  assert.ok(activeTurnKeys().includes('zombie-1'), 'the turn is genuinely in flight')

  // Mid-turn death, the zombie shape: reaped by the OS, exit unobserved, pipe
  // gone. No `close` is ever emitted for it.
  spawn.child.stdin.destroyed = true
  const at = spawned.length
  sendToAgent(win, 'zombie-cid', WT, 'still there?', DEFAULT_OPTS)
  assert.equal(spawned.length, at + 1, 'respawned rather than writing into the corpse')

  assert.ok(!activeTurnKeys().includes('zombie-1'), 'the dead turn is no longer reported as in flight')
  assert.ok(events.some((e) => e.kind === 'done'), 'and the panel was told, so the typing line comes off')
  // The one the user actually sees: reopening the chat must not be handed the
  // dead turn's clock. Before the fix this answered with the strand's
  // `startedAt` — the 40 hours — and cut the transcript there.
  const snapshot = replaySnapshot('zombie-cid')
  assert.equal(snapshot.running, true, 'the NEW turn is the one in flight')
  assert.equal(snapshot.startedAt, replaySnapshot('zombie-1').startedAt, 'timed from the send just made')
  endSession(win, 'zombie-cid', spawned[at].child)
})

test('runReplaySweep: a strand nothing else can reach is released, and said out loud', () => {
  // The safety net for every shape not enumerated above, and the only cover the
  // conn-less runtimes have at all. The user has been watching a spinner that
  // was lying to them, so this one speaks rather than closing quietly.
  const { win, events } = fakeWin()
  markTurnStart('sweep-1', { provider: 'claude', mode: 'default' }, win)
  assert.ok(activeTurnKeys().includes('sweep-1'))

  runReplaySweep(Date.now() + 30_000)
  assert.ok(activeTurnKeys().includes('sweep-1'), 'inside the grace, left alone')

  runReplaySweep(Date.now() + 120_000)
  assert.ok(!activeTurnKeys().includes('sweep-1'), 'past it, released')
  assert.deepEqual(kinds(events).slice(-2), ['error', 'done'])
  assert.equal(replaySnapshot('sweep-1').running, false, 'and reopening the chat sees a finished turn')
})

test('runReplaySweep: a live turn is never swept, however long it runs', () => {
  // The other half. A turn CAN legitimately run for hours (a long Bash, an
  // agent out on a big job), and a sweep that closed it would be the same bug
  // pointing the other way: the answer still streaming into a panel that has
  // already been told the turn ended.
  addCreatedSession({ id: 'longrun-1', worktreePath: WT })
  const { win, events, spawn } = startSession('longrun-1')
  runReplaySweep(Date.now() + 48 * 3_600_000)
  assert.ok(activeTurnKeys().includes('longrun-1'), 'two days into a live turn, still running')
  assert.ok(!events.some((e) => e.kind === 'done'))
  endSession(win, 'longrun-1', spawn.child)
})

test('runReplaySweep: a strand beside a working alias is closed quietly', () => {
  // One session answers to two names and a panel listens for BOTH, so a `done`
  // sent under the stranded name would take the typing line off the turn that
  // is genuinely in flight under the other one. Closing the replay is enough:
  // it is all replaySnapshot and activeTurnKeys read.
  addCreatedSession({ id: 'twin-old', worktreePath: WT })
  linkCreatedSession('twin-old', 'twin-cid')
  const { win, events } = fakeWin()
  markTurnStart('twin-old', { provider: 'claude', mode: 'default' }, win)
  // The live half, under the name the panel now holds.
  const live = startSession('twin-cid', 'the real turn')

  runReplaySweep(Date.now() + 120_000)
  assert.ok(!activeTurnKeys().includes('twin-old'), 'the strand is gone')
  assert.ok(activeTurnKeys().includes('twin-cid'), 'and the live turn is untouched')
  assert.ok(!events.some((e) => e.kind === 'done'), 'nothing that would clear the live spinner was sent')
  endSession(live.win, 'twin-cid', live.spawn.child)
})
