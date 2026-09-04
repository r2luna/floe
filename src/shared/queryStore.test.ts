import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  closeQuery,
  dropQuery,
  isValidQuery,
  linkQuery,
  openQueries,
  openQuery
} from './queryStore.ts'
import type { Query } from './types.ts'

const open = (list: Query[], harness = 'codex', at = 1): Query[] =>
  openQuery(list, { sessionId: 'sess', harness, mode: 'plan', at })

test('opening names the query after its two halves', () => {
  const [q] = open([])
  assert.equal(q.id, 'sess~codex')
  assert.equal(q.openedAt, 1)
  assert.equal(q.closedAt, undefined)
})

test('one harness is one query — opening twice does not make two', () => {
  const list = open(open([]), 'codex', 9)
  assert.equal(list.length, 1)
  // The first opening is when this conversation began; the second is the same
  // conversation being brought back.
  assert.equal(list[0].openedAt, 1)
})

test('two harnesses are two queries', () => {
  const list = open(open([]), 'gemini')
  assert.deepEqual(list.map((q) => q.id), ['sess~codex', 'sess~gemini'])
})

test('closing keeps the entry and records how it went', () => {
  const list = closeQuery(open([]), 'sess~codex', 'merged', 5)
  assert.equal(list.length, 1)
  assert.equal(list[0].outcome, 'merged')
  assert.equal(list[0].closedAt, 5)
  assert.deepEqual(openQueries(list), [])
})

test('reopening a closed query clears the outcome, not the history', () => {
  const closed = closeQuery(open([]), 'sess~codex', 'discarded', 5)
  const [q] = open(closed, 'codex', 20)
  assert.equal(q.outcome, undefined)
  assert.equal(q.closedAt, undefined)
  assert.equal(q.openedAt, 1)
})

test('dropping removes it outright', () => {
  assert.deepEqual(dropQuery(open([]), 'sess~codex'), [])
})

test('a forked claude id joins the trail instead of replacing it', () => {
  let list = linkQuery(open([]), 'sess~codex', 'c1')
  assert.equal(list[0].claudeId, 'c1')
  assert.equal(list[0].pastClaudeIds, undefined)
  list = linkQuery(list, 'sess~codex', 'c2')
  assert.equal(list[0].claudeId, 'c2')
  assert.deepEqual(list[0].pastClaudeIds, ['c1'])
  // Re-reporting the same id is not a fork.
  list = linkQuery(list, 'sess~codex', 'c2')
  assert.deepEqual(list[0].pastClaudeIds, ['c1'])
})

test('an entry whose id does not match its halves is rejected', () => {
  const [good] = open([])
  assert.equal(isValidQuery(good), true)
  assert.equal(isValidQuery({ ...good, id: 'sess~gemini' }), false)
  assert.equal(isValidQuery({ ...good, id: 'sess' }), false)
  assert.equal(isValidQuery({ ...good, openedAt: 'now' }), false)
  assert.equal(isValidQuery({ ...good, outcome: 'kept' }), false)
  assert.equal(isValidQuery(null), false)
})
