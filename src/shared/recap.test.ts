import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AWAY_MS, awayFor, recapLine, shouldRecap } from './recap.ts'

test('the gap reads in minutes, then in hours', () => {
  assert.equal(awayFor(6 * 60_000), '6m')
  assert.equal(awayFor(59 * 60_000), '59m')
  assert.equal(awayFor(60 * 60_000), '1h')
  assert.equal(awayFor(64 * 60_000), '1h 4m')
  assert.equal(awayFor(180 * 60_000), '3h')
})

test('a recap is owed only once all three hold', () => {
  const away = AWAY_MS + 1
  assert.equal(shouldRecap({ awayMs: away, moved: true }), true)
  // Back too soon: you never lost the thread.
  assert.equal(shouldRecap({ awayMs: AWAY_MS - 1, moved: true }), false)
  // Nothing happened while you were gone — there is no story to tell.
  assert.equal(shouldRecap({ awayMs: away, moved: false }), false)
  // Still working: any summary written now is out of date by the time it lands.
  assert.equal(shouldRecap({ awayMs: away, moved: true, busy: true }), false)
})

test('the five-minute floor is inclusive', () => {
  assert.equal(shouldRecap({ awayMs: AWAY_MS, moved: true }), true)
})

test('the line carries the gap and the summary, and never the word recap', () => {
  assert.equal(
    recapLine('  Cut v0.32.1,\n  gate green. ', 18 * 60_000),
    '(18m away) — Cut v0.32.1, gate green.'
  )
})

test('an empty summary makes no line at all', () => {
  assert.equal(recapLine('   \n ', AWAY_MS), '')
})

test('a recap asked for by hand carries no gap', () => {
  assert.equal(recapLine('Cut v0.32.1, gate green.', 0), 'Cut v0.32.1, gate green.')
  assert.equal(recapLine('Cut v0.32.1.', AWAY_MS - 1), 'Cut v0.32.1.')
  assert.equal(recapLine('Cut v0.32.1.', AWAY_MS), '(5m away) — Cut v0.32.1.')
})
