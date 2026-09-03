import { test } from 'node:test'
import assert from 'node:assert/strict'
import { liveReducer, type LiveState } from './transcriptState.ts'
import type { TranscriptItem } from '../../main/claudeSessions.ts'

const empty: LiveState = { base: [], live: [], tail: null }

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

const rows = (s: LiveState): TranscriptItem[] =>
  [...s.base, ...s.live].filter((i) => i.role === 'subagent')

/** The transcript as the panel shows it: what was on disk, then what streamed. */
const shown = (s: LiveState): TranscriptItem[] => [...s.base, ...s.live]

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

test('done closes the row and drops the tool it was on', () => {
  const s = run(
    { type: 'push', item: start('c1', 'codex', 'codex') },
    { type: 'agent', toolUseId: 'c1', patch: { agentTokens: 1800, lastTool: 'shell' } },
    { type: 'agent', toolUseId: 'c1', patch: { running: false, lastTool: '', ms: 22_000 } }
  )
  const [row] = rows(s)
  assert.deepEqual([row.running, row.lastTool, row.ms, row.agentTokens], [false, '', 22_000, 1800])
})

test('what an agent reports back is a message from the agent, not a field on its row', () => {
  const s = run(
    { type: 'push', item: start('t1', 'Explore') },
    { type: 'agent', toolUseId: 't1', patch: { running: false, lastTool: '' } },
    { type: 'agent-reply', toolUseId: 't1', text: 'o guard vaza' }
  )
  assert.equal(rows(s)[0].text, undefined, 'the report is not tucked under the launch line')
  const said = s.live[s.live.length - 1]
  assert.deepEqual(
    [said.role, said.from, said.text],
    ['assistant', 'explore-t1', 'o guard vaza'],
    'it speaks in the channel under its own nick'
  )
})

test('two agents of the same type report under two different nicks', () => {
  const s = run(
    { type: 'push', item: start('t1', 'Explore') },
    { type: 'push', item: start('t2', 'Explore') },
    { type: 'agent-reply', toolUseId: 't1', text: 'primeiro' },
    { type: 'agent-reply', toolUseId: 't2', text: 'segundo' }
  )
  const said = s.live.filter((i) => i.from)
  assert.deepEqual(said.map((i) => [i.from, i.text]), [
    ['explore-t1', 'primeiro'],
    ['explore-t2', 'segundo']
  ])
})

test('a reply whose launch this panel never saw still speaks, under a bare agent nick', () => {
  const s = run({ type: 'agent-reply', toolUseId: 'ghost', text: 'quem sou eu' })
  assert.deepEqual(
    s.live.map((i) => [i.role, i.from, i.text]),
    [['assistant', 'agent', 'quem sou eu']],
    'never under the model nick — that is the misattribution this exists to stop'
  )
})

test("the turn's cost never lands on an agent's report", () => {
  const s = run(
    { type: 'push', item: start('t1', 'Explore') },
    { type: 'text', item: { role: 'assistant', text: 'já volto' } },
    { type: 'agent-reply', toolUseId: 't1', text: 'achei' },
    { type: 'finish', ms: 42_000, tokens: 90_000 }
  )
  const report = s.live[s.live.length - 1]
  assert.deepEqual([report.from, report.ms, report.contextTokens], ['explore-t1', undefined, undefined])
  const answer = s.live[1]
  assert.deepEqual([answer.ms, answer.contextTokens], [42_000, 90_000], "the parent's own line carries it")
})

test('a reply settles the streaming tail, so it lands where it was said', () => {
  const s = run(
    { type: 'push', item: start('t1', 'Explore') },
    { type: 'text', item: { role: 'assistant', text: 'enquanto isso…' } },
    { type: 'agent-reply', toolUseId: 't1', text: 'achei' }
  )
  assert.equal(s.tail, null)
  assert.deepEqual(
    s.live.map((i) => [i.role, i.from ?? null]),
    [
      ['subagent', null],
      ['assistant', null],
      ['assistant', 'explore-t1']
    ]
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

// --- a panel that opens in the middle of a turn -----------------------------
// The CLI writes each assistant message to the JSONL as it closes, so a Task
// launched early in a turn is ALREADY on disk when the panel opens. Everything
// that closes it — and the report it comes back with — arrives afterwards, as
// live events naming it by tool_use id.

test('a row read off disk is not opened a second time by the replayed launch', () => {
  const s = run(
    { type: 'load', items: [{ role: 'user', text: 'mapeia' }, start('t1', 'Explore')] },
    { type: 'push', item: start('t1', 'Explore') }
  )
  assert.equal(rows(s).length, 1, 'one agent, one row')
})

test('the report closes the row that came off disk, and speaks for it', () => {
  const s = run(
    { type: 'load', items: [start('t1', 'Explore')] },
    { type: 'push', item: start('t1', 'Explore') },
    { type: 'agent', toolUseId: 't1', patch: { running: false, lastTool: '' } },
    { type: 'agent-reply', toolUseId: 't1', text: 'achei' }
  )
  assert.equal(rows(s).length, 1)
  assert.equal(rows(s)[0].running, false, 'the disk row closes — nothing else ever would')
  const said = shown(s)[shown(s).length - 1]
  assert.deepEqual([said.from, said.text], ['explore-t1', 'achei'], 'named after the row on disk')
})

test('a turn ending stops a row left running on disk', () => {
  const s = run(
    { type: 'load', items: [start('t1', 'Explore')] },
    { type: 'finish', ms: 1000, tokens: 100 }
  )
  assert.equal(rows(s)[0].running, false)
})

test('a launch that streamed before the disk read lands is not loaded twice', () => {
  const s = run(
    { type: 'push', item: start('t1', 'Explore') },
    { type: 'load', items: [{ role: 'user', text: 'mapeia' }, start('t1', 'Explore')] }
  )
  assert.equal(rows(s).length, 1)
  assert.deepEqual(shown(s).map((i) => i.role), ['user', 'subagent'])
})


// --- the turn in flight is on disk too --------------------------------------
// The CLI keeps writing the running turn to the JSONL, so the read a panel does
// on open already holds part of what the replay is about to stream. Without a
// mark saying where the live copy starts, both were shown: the same answer
// twice, the second one still growing.

const turn = (at: number): TranscriptItem[] => [
  { role: 'user', text: 'testa a jail', at: at - 10 },
  { role: 'assistant', text: 'CLAUDE_CODE_OAUTH_TOKEN confirmado', at: at + 1000 },
  { role: 'tool', name: 'Bash', summary: 'security find-generic-password', at: at + 2000 }
]

test('the disk copy of the turn in flight is dropped when the replay lands after it', () => {
  const s = run(
    { type: 'load', items: turn(5000) },
    { type: 'live-since', at: 5000 },
    { type: 'text', item: { role: 'assistant', text: 'CLAUDE_CODE_OAUTH_TOKEN confirmado' } }
  )
  assert.deepEqual(shown(s).map((i) => i.role), ['user'], 'only what you said stays on disk')
  assert.equal(s.tail?.text, 'CLAUDE_CODE_OAUTH_TOKEN confirmado')
})

test('the disk copy is dropped when the read lands after the replay', () => {
  const s = run(
    { type: 'live-since', at: 5000 },
    { type: 'text', item: { role: 'assistant', text: 'CLAUDE_CODE_OAUTH_TOKEN confirmado' } },
    { type: 'settle' },
    { type: 'load', items: turn(5000) }
  )
  assert.deepEqual(shown(s).map((i) => i.role), ['user', 'assistant'])
  assert.equal(shown(s).filter((i) => i.role === 'assistant').length, 1, 'said once')
})

test('everything said before the turn began is still read off disk', () => {
  const s = run(
    {
      type: 'load',
      items: [
        { role: 'user', text: 'e antes?', at: 1000 },
        { role: 'assistant', text: 'antes disso', at: 2000 },
        ...turn(5000)
      ]
    },
    { type: 'live-since', at: 5000 }
  )
  assert.deepEqual(shown(s).map((i) => i.text), ['e antes?', 'antes disso', 'testa a jail'])
})

test('what you put into the running turn survives the cut', () => {
  const s = run(
    {
      type: 'load',
      items: [
        { role: 'user', text: 'olha isso', at: 6000 },
        { role: 'image', mediaType: 'image/png', data: 'x', at: 6000 },
        { role: 'tool', name: 'deploy', summary: '/deploy', by: 'user', at: 6000 },
        { role: 'user', from: 'pinguim', text: 'peer line', at: 6000 },
        { role: 'assistant', text: 'já respondi isso', at: 6500 }
      ]
    },
    { type: 'live-since', at: 5000 }
  )
  assert.deepEqual(shown(s).map((i) => i.role), ['user', 'image', 'tool'])
})

test('a load with no turn in flight is left alone', () => {
  const s = run({ type: 'load', items: turn(5000) })
  assert.equal(shown(s).length, 3)
})

// --- a message typed into the running turn (a steer) -------------------------
// The CLI does not echo it as a user line: it queues it, folds it into the turn,
// and writes what it absorbed as an `attachment` line — whenever the tool call
// in flight ends. Until then the replay carries it, so both copies can reach a
// panel and only one may be shown.

test('the steer replayed into a panel that already read its disk copy is said once', () => {
  const s = run(
    { type: 'load', items: [{ role: 'user', text: 'e o token?', at: 6000 }] },
    { type: 'live-since', at: 5000 },
    { type: 'push', item: { role: 'user', text: 'e o token?', at: 5500 } }
  )
  assert.deepEqual(shown(s).map((i) => i.text), ['e o token?'])
})

test('the disk copy landing after the replay is dropped too', () => {
  const s = run(
    { type: 'live-since', at: 5000 },
    { type: 'push', item: { role: 'user', text: 'e o token?', at: 5500 } },
    { type: 'load', items: [{ role: 'user', text: 'e o token?', at: 6000 }] }
  )
  assert.deepEqual(shown(s).map((i) => i.text), ['e o token?'])
})

test('the same line typed twice into one turn is two lines', () => {
  const s = run(
    {
      type: 'load',
      items: [
        { role: 'user', text: 'anda', at: 6000 },
        { role: 'user', text: 'anda', at: 6500 }
      ]
    },
    { type: 'live-since', at: 5000 },
    { type: 'push', item: { role: 'user', text: 'anda', at: 5500 } },
    { type: 'push', item: { role: 'user', text: 'anda', at: 5900 } }
  )
  assert.deepEqual(shown(s).map((i) => i.text), ['anda', 'anda'])
})

test('a line said before the turn is never taken for a steer', () => {
  const s = run(
    { type: 'load', items: [{ role: 'user', text: 'anda', at: 1000 }] },
    { type: 'live-since', at: 5000 },
    { type: 'push', item: { role: 'user', text: 'anda', at: 5500 } }
  )
  assert.deepEqual(shown(s).map((i) => [i.text, i.at]), [['anda', 1000], ['anda', 5500]])
})
