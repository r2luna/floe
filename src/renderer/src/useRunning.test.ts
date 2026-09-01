import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reconcileBusy } from './useRunning.ts'

const NOW = 1_000_000

test('a session the server says is idle stops spinning', () => {
  // The bug this exists for: a `done` that never arrived left the key in `busy`
  // forever, so the row spun for an hour after the chat had finished.
  const prev = new Set(['stale'])
  const next = reconcileBusy(prev, [], new Map([['stale', NOW - 60_000]]), NOW)
  assert.deepEqual([...next], [])
})

test('a turn that started since the poll left keeps its spinner', () => {
  const prev = new Set(['fresh'])
  const next = reconcileBusy(prev, [], new Map([['fresh', NOW - 500]]), NOW)
  assert.deepEqual([...next], ['fresh'])
})

test('a running session the renderer never heard about is picked up', () => {
  // What a reload looks like: the set starts empty and the turns did not stop.
  const next = reconcileBusy(new Set(), ['live'], new Map(), NOW)
  assert.deepEqual([...next], ['live'])
})

test('an unchanged set is returned by identity, so the list does not re-render', () => {
  const prev = new Set(['a', 'b'])
  assert.equal(reconcileBusy(prev, ['a', 'b'], new Map(), NOW), prev)
})

test('a key with no event ever recorded is not held', () => {
  const prev = new Set(['ghost'])
  assert.deepEqual([...reconcileBusy(prev, [], new Map(), NOW)], [])
})
