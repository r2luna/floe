import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isAway, lastSeenAt, markAway, markSeen } from './presence.ts'

test('away once nobody has pinged for the threshold', () => {
  markSeen(1000)
  assert.equal(lastSeenAt(), 1000)
  assert.equal(isAway(500, 1400), false)
  assert.equal(isAway(500, 1500), true)
})

test('a message from Telegram counts as away straight away', () => {
  markSeen(1000)
  markAway()
  assert.equal(lastSeenAt(), 0)
  assert.equal(isAway(60_000, 1001), true)
})
