import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Latest } from './useWorktrees.ts'

test('only the newest fetch may write: an older ticket is stale once a newer one is taken', () => {
  const latest = new Latest()
  const first = latest.next()
  assert.equal(latest.is(first), true)
  // The user switched project again while the first fetch was in flight. Its
  // answer, whenever it lands, must not replace the list of the project on screen.
  const second = latest.next()
  assert.equal(latest.is(first), false)
  assert.equal(latest.is(second), true)
})
