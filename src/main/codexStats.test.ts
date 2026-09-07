import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installHook } from './config/hook.test-helper.ts'

// codexStats freezes ~/.codex/sessions at module load, so HOME has to point at
// the fixture before the import runs — and the fixture starts empty so the
// "codex was never used" branch can be asserted before anything is written.
const home = mkdtempSync(join(tmpdir(), 'floe-codexstats-'))
process.env.HOME = home

installHook()
const { codexStats } = await import('./codexStats.ts')

const SESSIONS = join(home, '.codex', 'sessions')

/** One rollout file, at the path whose YYYY/MM/DD is the day it counts for. */
function rollout(date: string, name: string, lines: string[]): string {
  const [year, month, day] = date.split('-')
  const dir = join(SESSIONS, year, month, day)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, name)
  writeFileSync(path, lines.join('\n') + '\n')
  return path
}

const turnContext = (model: string): string => JSON.stringify({ type: 'turn_context', payload: { model } })

const tokenCount = (u: Partial<Record<string, number>>): string =>
  JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: u } } })

test('no rollouts at all is "codex was never used", not an empty stats card', async () => {
  assert.equal(await codexStats(), undefined)
})

test('rollout paths and tails add up to one ClaudeStats', async () => {
  // Two sessions on the 5th, one on the 6th, one on the 9th — a 2-day run, a
  // gap, then a lone day. All safely in the past so the streaks never move.
  rollout('2025-01-05', 'rollout-a.jsonl', [
    turnContext('gpt-5.5'),
    tokenCount({ input_tokens: 100, output_tokens: 10, cached_input_tokens: 5, cache_write_input_tokens: 1 })
  ])
  rollout('2025-01-05', 'rollout-b.jsonl', [
    turnContext('gpt-5.5'),
    // token_count is cumulative, so only the LAST one is the session total.
    tokenCount({ input_tokens: 1, output_tokens: 1 }),
    tokenCount({ input_tokens: 200, output_tokens: 20 })
  ])
  rollout('2025-01-06', 'rollout-c.jsonl', [
    turnContext('gpt-5.1-codex-max'),
    tokenCount({ input_tokens: 300, output_tokens: 30 })
  ])
  // A session codex opened and never used: no model line, no usage line.
  rollout('2025-01-09', 'rollout-d.jsonl', ['{"type":"session_meta","payload":{}}'])
  // Neighbours that are not rollouts must not be counted.
  writeFileSync(join(SESSIONS, '2025', '01', '09', 'notes.txt'), 'ignore me\n')

  const s = await codexStats()
  assert.ok(s)
  assert.equal(s.sessions, 4)
  assert.equal(s.activeDays, 3)
  assert.deepEqual(
    s.days,
    [
      { date: '2025-01-05', messages: 2 },
      { date: '2025-01-06', messages: 1 },
      { date: '2025-01-09', messages: 1 }
    ],
    'the heatmap counts sessions per day, oldest first'
  )
  assert.deepEqual(s.busiestDay, { date: '2025-01-05', messages: 2 })
  assert.equal(s.longestStreak, 2) // the 5th and the 6th
  assert.equal(s.currentStreak, 0) // 2025 is long over
  // Favourite is the model that ran the most SESSIONS, not the most tokens:
  // gpt-5.1-codex-max used more tokens per session and still loses 1–2.
  assert.equal(s.favoriteModel, 'gpt-5.5')
  assert.deepEqual(s.tokens, {
    input: 600,
    output: 60,
    cacheRead: 5,
    cacheWrite: 1,
    total: 666
  })
  // The two numbers codex cannot answer cheaply stay zero rather than lie.
  assert.equal(s.messages, 0)
  assert.equal(s.longestSessionMs, 0)
  // The span is measured from the first active day to today, inclusive.
  const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 10)
  const expected =
    Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse('2025-01-05T00:00:00Z')) / 86_400_000) + 1
  assert.equal(s.spanDays, expected)
})

test('only the tail of a big rollout is read, and torn lines are skipped', async () => {
  // A cumulative total from the head of the file must NOT be counted: the tail
  // window is the whole point of not reading 210MB of rollouts.
  const line = JSON.stringify({ type: 'response_item', payload: { pad: 'x'.repeat(50) } })
  const padding = Array.from({ length: 4000 }, () => line)
  rollout('2025-02-01', 'rollout-big.jsonl', [
    tokenCount({ input_tokens: 999_999, output_tokens: 999_999 }),
    ...padding,
    // A line the tail boundary cut in half — it mentions token_count and does
    // not parse, and must not take the file's totals down with it.
    '{"payload":{"info":{"total_token_usage":{"input_to',
    turnContext('gpt-5.5'),
    tokenCount({ input_tokens: 7, output_tokens: 3 })
  ])
  // A rollout that cannot even be stat'd (dangling symlink) contributes zeros
  // instead of failing the whole report.
  symlinkSync(join(home, 'nope'), join(SESSIONS, '2025', '02', '01', 'rollout-gone.jsonl'))

  const s = await codexStats()
  assert.ok(s)
  const feb = s.days.find((d) => d.date === '2025-02-01')
  assert.deepEqual(feb, { date: '2025-02-01', messages: 2 }, 'the broken symlink still counts as a session')
  // 600 + 7 from the earlier fixtures — the head-of-file 999_999 never lands.
  assert.equal(s.tokens.input, 607)
  assert.equal(s.tokens.output, 63)
})
