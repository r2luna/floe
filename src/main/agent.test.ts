import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import type { AgentEvent, AgentRunOptions } from '../shared/types'
import type { Conn } from './agent.ts'

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
      "export const app = { getPath: () => '/tmp' };",
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
  dropSettled
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
  await new Promise((r) => setTimeout(r, 80))
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

test('a replay says who is answering, not just what model', () => {
  markTurnStart('routed-sess', { provider: 'codex', effort: 'high', mode: 'plan' })
  const snap = replaySnapshot('routed-sess')
  assert.equal(snap.running, true)
  // A panel opening onto this turn has no other way to know: the picker in the
  // chat still says whatever the SESSION is set to.
  assert.deepEqual(snap.choice, { provider: 'codex', effort: 'high', mode: 'plan' })
})
