import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reconcileLive } from './useRunning.ts'

const NOW = 1_000_000

test('a session the server says is idle stops spinning', () => {
  // The bug this exists for: a `done` that never arrived left the key in `busy`
  // forever, so the row spun for an hour after the chat had finished.
  const prev = new Set(['stale'])
  const next = reconcileLive(prev, [], new Map([['stale', NOW - 60_000]]), NOW)
  assert.deepEqual([...next], [])
})

test('a turn that started since the poll left keeps its spinner', () => {
  const prev = new Set(['fresh'])
  const next = reconcileLive(prev, [], new Map([['fresh', NOW - 500]]), NOW)
  assert.deepEqual([...next], ['fresh'])
})

test('a running session the renderer never heard about is picked up', () => {
  // What a reload looks like: the set starts empty and the turns did not stop.
  const next = reconcileLive(new Set(), ['live'], new Map(), NOW)
  assert.deepEqual([...next], ['live'])
})

test('an unchanged set is returned by identity, so the list does not re-render', () => {
  const prev = new Set(['a', 'b'])
  assert.equal(reconcileLive(prev, ['a', 'b'], new Map(), NOW), prev)
})

test('a key with no event ever recorded is not held', () => {
  const prev = new Set(['ghost'])
  assert.deepEqual([...reconcileLive(prev, [], new Map(), NOW)], [])
})

test('a question the server says was answered stops showing the ?', () => {
  // The reported bug: the answer went through, but the event that would have
  // cleared the mark never reached this set — so the row asked forever.
  const prev = new Set(['answered'])
  const next = reconcileLive(prev, [], new Map([['answered', NOW - 60_000]]), NOW)
  assert.deepEqual([...next], [])
})

test('a question that just arrived is not erased by a poll that predates it', () => {
  const prev = new Set(['asking'])
  assert.deepEqual([...reconcileLive(prev, [], new Map([['asking', NOW - 500]]), NOW)], ['asking'])
})
