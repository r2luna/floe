import { test } from 'node:test'
import assert from 'node:assert/strict'
import { liveReducer, type LiveState } from './transcriptState.ts'
import type { TranscriptItem } from '../../main/claudeSessions.ts'

const empty: LiveState = { live: [], tail: null }

const start = (id: string, type: string, harness = 'claude'): TranscriptItem => ({
  role: 'subagent',
  toolUseId: id,
  agentType: type,
  summary: `${type} work`,
  harness,
  running: true,
  at: 1000
})

/** Fold a list of actions, the way the panel folds a stream of events. */
const run = (...actions: Parameters<typeof liveReducer>[1][]): LiveState =>
  actions.reduce(liveReducer, empty)

const rows = (s: LiveState): TranscriptItem[] => s.live.filter((i) => i.role === 'subagent')

test('three agents launched in one turn are three rows, in launch order', () => {
  const s = run(
    { type: 'push', item: start('t1', 'Explore') },
    { type: 'push', item: start('t2', 'general-purpose') },
    { type: 'push', item: start('t3', 'Explore') }
  )
  assert.deepEqual(rows(s).map((r) => r.toolUseId), ['t1', 't2', 't3'])
  assert.ok(rows(s).every((r) => r.running))
})

test('progress patches its own row and no other', () => {
  const s = run(
    { type: 'push', item: start('t1', 'Explore') },
    { type: 'push', item: start('t2', 'general-purpose') },
    { type: 'agent', toolUseId: 't2', patch: { agentTokens: 4200, lastTool: 'Edit' } }
  )
  assert.equal(rows(s).length, 2, 'a progress event must never append a row')
  assert.deepEqual([rows(s)[0].lastTool, rows(s)[0].agentTokens], [undefined, undefined])
  assert.deepEqual([rows(s)[1].lastTool, rows(s)[1].agentTokens], ['Edit', 4200])
})

test('progress without a tool keeps the tool the row is already showing', () => {
  const s = run(
    { type: 'push', item: start('t1', 'Explore') },
    { type: 'agent', toolUseId: 't1', patch: { agentTokens: 100, lastTool: 'Grep' } },
    { type: 'agent', toolUseId: 't1', patch: { agentTokens: 900, lastTool: undefined } }
  )
  assert.deepEqual([rows(s)[0].lastTool, rows(s)[0].agentTokens], ['Grep', 900])
})

test('done closes the row, drops the tool and keeps the codex reply', () => {
  const s = run(
    { type: 'push', item: start('c1', 'codex', 'codex') },
    { type: 'agent', toolUseId: 'c1', patch: { agentTokens: 1800, lastTool: 'shell' } },
    { type: 'agent', toolUseId: 'c1', patch: { running: false, lastTool: '', text: 'o guard vaza', ms: 22_000 } }
  )
  const [row] = rows(s)
  assert.deepEqual(
    [row.running, row.lastTool, row.text, row.ms, row.agentTokens],
    [false, '', 'o guard vaza', 22_000, 1800]
  )
})

test('an unknown tool_use id changes nothing', () => {
  const s = run(
    { type: 'push', item: start('t1', 'Explore') },
    { type: 'agent', toolUseId: 'ghost', patch: { running: false } }
  )
  assert.ok(rows(s)[0].running)
})

test('the same agent id twice patches the row still open', () => {
  const s = run(
    { type: 'push', item: start('t1', 'Explore') },
    { type: 'agent', toolUseId: 't1', patch: { running: false, ms: 1000 } },
    { type: 'push', item: start('t1', 'Explore') },
    { type: 'agent', toolUseId: 't1', patch: { lastTool: 'Read' } }
  )
  assert.deepEqual(rows(s).map((r) => [r.running, r.lastTool]), [[false, undefined], [true, 'Read']])
})

test('the turn ending stops every row still pulsing', () => {
  const s = run(
    { type: 'push', item: start('t1', 'Explore') },
    { type: 'push', item: start('t2', 'general-purpose') },
    { type: 'agent', toolUseId: 't1', patch: { running: false, ms: 500 } },
    { type: 'text', item: { role: 'assistant', text: 'pronto' } },
    { type: 'finish', ms: 60_000, tokens: 120_000 }
  )
  assert.deepEqual(rows(s).map((r) => r.running), [false, false])
  // The turn's own numbers land on the assistant line, never on an agent row.
  const said = s.live.find((i) => i.role === 'assistant')
  assert.deepEqual([said?.ms, said?.contextTokens], [60_000, 120_000])
  assert.ok(rows(s).every((r) => r.contextTokens === undefined))
})

test('a subagent row settles the streaming tail, so it lands where it was launched', () => {
  const s = run(
    { type: 'text', item: { role: 'assistant', text: 'vou abrir três frentes' } },
    { type: 'push', item: start('t1', 'Explore') }
  )
  assert.deepEqual(s.live.map((i) => i.role), ['assistant', 'subagent'])
  assert.equal(s.tail, null)
})
