import { test } from 'node:test'
import assert from 'node:assert/strict'
import { busyOf, isFull, parseHandoff, rowsOf } from './colony.ts'
import type { BoardColumn, ColonyTask } from './colony.ts'

const task = (id: string): ColonyTask => ({
  id,
  project: '/p',
  name: id,
  kind: 'feat',
  brief: '',
  stage: 'coder',
  status: 'working',
  passes: 0,
  createdAt: 0,
  updatedAt: 0,
  visits: []
})

const column = (over: Partial<BoardColumn> = {}): BoardColumn => ({
  name: 'coder',
  skill: 'colony-implement',
  cap: 2,
  blocked: [],
  working: [],
  holding: [],
  settled: [],
  ...over
})

test('the hand-off line moves the card, in every shape a model writes it', () => {
  assert.deepEqual(parseHandoff('done.\n\nCOLONY: pass'), { verdict: 'pass' })
  // Bullets, bold and backticks are wrappers, not meaning.
  assert.deepEqual(parseHandoff('- **COLONY: pass**'), { verdict: 'pass' })
  assert.deepEqual(parseHandoff('COLONY: stop — the branch is already merged'), {
    verdict: 'stop',
    why: 'the branch is already merged'
  })
  assert.deepEqual(parseHandoff('COLONY: return specifier — the acceptance criteria are empty'), {
    verdict: 'return',
    lane: 'specifier',
    why: 'the acceptance criteria are empty'
  })
  // A hyphen is what you get when the model does not reach for an em dash.
  assert.deepEqual(parseHandoff('COLONY: return coder - the tests do not compile'), {
    verdict: 'return',
    lane: 'coder',
    why: 'the tests do not compile'
  })
})

test('a lane name with a hyphen survives — the separator is a dash with space around it', () => {
  // `code-review` is one name. Splitting on the hyphen inside it would return
  // the card to a lane called `code`, which nobody has, and park it as a
  // question instead of moving it.
  assert.deepEqual(parseHandoff('COLONY: return code-review — the gate never ran'), {
    verdict: 'return',
    lane: 'code-review',
    why: 'the gate never ran'
  })
  // And a return with no punctuation still names its lane and keeps its reason.
  assert.deepEqual(parseHandoff('COLONY: return coder the tests do not compile'), {
    verdict: 'return',
    lane: 'coder',
    why: 'the tests do not compile'
  })
  assert.deepEqual(parseHandoff('COLONY: return specifier'), {
    verdict: 'return',
    lane: 'specifier',
    why: ''
  })
})

test('the LAST line wins — a lane that quotes the contract still gets its own verdict', () => {
  const text = ['You end with one of:', '  COLONY: pass', '', 'I could not build it.', 'COLONY: stop — no toolchain'].join('\n')
  assert.deepEqual(parseHandoff(text), { verdict: 'stop', why: 'no toolchain' })
})

test('no line is null, not a pass — the caller has to tell the two apart', () => {
  assert.equal(parseHandoff('all done, tests are green'), null)
  assert.equal(parseHandoff(''), null)
})

test('holding costs no spot, so a full stage never freezes the one behind it', () => {
  const full = column({ working: [task('a')], blocked: [task('b')], holding: [task('c'), task('d')] })
  assert.equal(busyOf(full), 2)
  assert.equal(isFull(full), true)
  // Four tasks in the column, two of them free.
  assert.equal(rowsOf(full).length, 4)
})

test('the two ends have no cap, so nothing is ever full there', () => {
  const inbox = column({ name: 'inbox', cap: undefined, holding: [task('a'), task('b'), task('c')] })
  assert.equal(isFull(inbox), false)
})

test('the bands are drawn in the order the column reads: asking, working, then the queue', () => {
  const mixed = column({ blocked: [task('ask')], working: [task('run')], holding: [task('wait')] })
  assert.deepEqual(
    rowsOf(mixed).map((r) => [r.task.id, r.status]),
    [
      ['ask', 'blocked'],
      ['run', 'working'],
      ['wait', 'holding']
    ]
  )
})
