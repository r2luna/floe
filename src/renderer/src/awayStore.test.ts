import { test } from 'node:test'
import assert from 'node:assert/strict'
import { awayChance, consumeAway, forgetAway, noteActivity, noteLeft } from './awayStore.ts'

const T0 = 1_700_000_000_000
const MIN = 60_000

test('a chat never left has no gap to recap', () => {
  forgetAway()
  noteActivity('sess', T0)
  assert.deepEqual(awayChance(['sess'], T0 + 60 * MIN), { awayMs: 0, moved: false })
})

test('the gap runs from when you left, and movement is anything after it', () => {
  forgetAway()
  noteLeft(['sess'], T0)
  noteActivity('sess', T0 + 3 * MIN)
  assert.deepEqual(awayChance(['sess'], T0 + 18 * MIN), { awayMs: 18 * MIN, moved: true })
})

test('activity before you left is not news', () => {
  forgetAway()
  noteActivity('sess', T0 - MIN)
  noteLeft(['sess'], T0)
  assert.deepEqual(awayChance(['sess'], T0 + 18 * MIN), { awayMs: 18 * MIN, moved: false })
})

test("a session's two names are one session", () => {
  forgetAway()
  noteLeft(['floe-id', 'claude-id'], T0)
  // The turn ended under the claudeId, which is not the key the panel opened with.
  noteActivity('claude-id', T0 + 2 * MIN)
  assert.deepEqual(awayChance(['floe-id', 'claude-id'], T0 + 9 * MIN), {
    awayMs: 9 * MIN,
    moved: true
  })
})

test('leaving twice counts from the last time', () => {
  forgetAway()
  noteLeft(['sess'], T0)
  noteLeft(['sess'], T0 + 30 * MIN)
  assert.equal(awayChance(['sess'], T0 + 36 * MIN).awayMs, 6 * MIN)
})

test('one recap per time away, however often you open the chat', () => {
  forgetAway()
  noteLeft(['sess'], T0)
  noteActivity('sess', T0 + 2 * MIN)
  assert.equal(awayChance(['sess'], T0 + 18 * MIN).moved, true)

  consumeAway(['sess'])
  // Back again a minute later: same return, nothing new to say.
  assert.deepEqual(awayChance(['sess'], T0 + 19 * MIN), { awayMs: 0, moved: false })

  // Actually leaving again starts a new gap, and earns a new line.
  noteLeft(['sess'], T0 + 20 * MIN)
  noteActivity('sess', T0 + 25 * MIN)
  assert.deepEqual(awayChance(['sess'], T0 + 40 * MIN), { awayMs: 20 * MIN, moved: true })
})
