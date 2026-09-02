import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseUsage } from './usageText.ts'

// Verbatim from `claude -p '/usage'`, trimmed to the block the parser reads.
const REAL = `You are currently using your subscription to power your Claude Code usage

Current session: 3% used · resets Sep 1 at 10:29pm (America/Denver)
Current week (all models): 7% used · resets Sep 7 at 9:59pm (America/Denver)
Current week (Fable): 5% used · resets Sep 7 at 9:59pm (America/Denver)

What's contributing to your limits usage?

Last 24h · 4063 requests · 89 sessions
  55% of your usage was while 4+ sessions ran in parallel`

test('reads the session and week windows out of the CLI text', () => {
  const stats = parseUsage(REAL)
  assert.equal(stats.session?.pct, 3)
  assert.equal(stats.week?.pct, 7)
  assert.equal(stats.week?.resetsAt, 'Sep 7 at 9:59pm (America/Denver)')
  assert.equal(stats.month, undefined)
})

test("a model's own line never takes the window's slot", () => {
  // The regression: the filter listed model names, so Fable was not recognised
  // as a breakdown and won `week` whenever it printed above "(all models)".
  const stats = parseUsage(
    ['Current week (Fable): 5% used', 'Current week (all models): 7% used'].join('\n')
  )
  assert.equal(stats.week?.pct, 7)
})

test('an unknown future model is a breakdown too', () => {
  assert.equal(parseUsage('Current week (Something-9): 88% used').week, undefined)
})

test('a monthly limit is read when a plan reports one', () => {
  assert.equal(parseUsage('Current month: 42% used').month?.pct, 42)
})

test('a window with no reset time is still a window', () => {
  const stats = parseUsage('Current session: 10% used')
  assert.equal(stats.session?.pct, 10)
  assert.equal(stats.session?.resetsAt, undefined)
})

test('prose the CLI happens to print is not a limit', () => {
  assert.deepEqual(parseUsage('You are currently using your subscription'), {})
  assert.deepEqual(parseUsage(undefined), {})
})
