import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseResetHint, resetsIn } from './resets.ts'

const at = (iso: string): number => Date.parse(iso)

test("reads Claude's dated hint in its own zone", () => {
  // Sep 7 9:59pm MDT (UTC-6) is Sep 8 03:59 UTC.
  const now = at('2026-09-05T12:00:00Z')
  assert.equal(parseResetHint('Sep 7 at 9:59pm (America/Denver)', now), at('2026-09-08T03:59:00Z') / 1000)
})

test('an hour without minutes, and winter time', () => {
  const now = at('2026-01-10T00:00:00Z')
  assert.equal(parseResetHint('Jan 13 at 1am (America/Denver)', now), at('2026-01-13T08:00:00Z') / 1000)
})

test('the year is the one nearest now, so December resets read right in January', () => {
  const now = at('2027-01-01T02:00:00Z')
  assert.equal(parseResetHint('Dec 31 at 10pm (UTC)', now), at('2026-12-31T22:00:00Z') / 1000)
  const late = at('2026-12-30T00:00:00Z')
  assert.equal(parseResetHint('Jan 2 at 1am (UTC)', late), at('2027-01-02T01:00:00Z') / 1000)
})

test('a time without a date is the next time the clock reads it', () => {
  const now = at('2026-09-14T15:00:00Z')
  assert.equal(parseResetHint('2pm (UTC)', now), at('2026-09-15T14:00:00Z') / 1000)
  assert.equal(parseResetHint('4:30pm (UTC)', now), at('2026-09-14T16:30:00Z') / 1000)
})

test('anything unrecognised is undefined, not a guess', () => {
  assert.equal(parseResetHint(undefined), undefined)
  assert.equal(parseResetHint('soon'), undefined)
  assert.equal(parseResetHint('Sep 7 at 9pm (Not/AZone)'), undefined)
  assert.equal(parseResetHint('Foo 7 at 9pm (UTC)'), undefined)
})

test('resetsIn counts down in the two largest units', () => {
  const now = at('2026-09-14T00:00:00Z')
  const s = (iso: string): number => at(iso) / 1000
  assert.equal(resetsIn(s('2026-09-17T04:30:00Z'), now), '3d 4h')
  assert.equal(resetsIn(s('2026-09-16T00:00:00Z'), now), '2d')
  assert.equal(resetsIn(s('2026-09-14T02:13:00Z'), now), '2h 13m')
  assert.equal(resetsIn(s('2026-09-14T05:00:00Z'), now), '5h')
  assert.equal(resetsIn(s('2026-09-14T00:08:00Z'), now), '8m')
  assert.equal(resetsIn(s('2026-09-13T00:00:00Z'), now), 'now')
})
