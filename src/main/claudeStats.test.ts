import { test } from 'node:test'
import assert from 'node:assert/strict'
import { streaks, summarize } from './claudeStats.ts'

test('a streak that runs up to today is the current one', () => {
  const r = streaks(['2026-08-23', '2026-08-24', '2026-08-25'], '2026-08-25')
  assert.deepEqual(r, { longest: 3, current: 3 })
})

test('yesterday still counts — the day is not over', () => {
  assert.equal(streaks(['2026-08-24', '2026-08-25'], '2026-08-26').current, 2)
})

test('a streak that ended last week is history, not current', () => {
  const r = streaks(['2026-08-01', '2026-08-02', '2026-08-03'], '2026-08-20')
  assert.deepEqual(r, { longest: 3, current: 0 })
})

test('gaps break the run and the longest one wins', () => {
  const days = ['2026-01-01', '2026-01-02', '2026-01-05', '2026-01-06', '2026-01-07']
  assert.equal(streaks(days, '2026-01-20').longest, 3)
})

test('no activity at all', () => {
  assert.deepEqual(streaks([], '2026-08-25'), { longest: 0, current: 0 })
})

// The shape of ~/.claude/stats-cache.json, trimmed to the fields we read.
test('summarizes the cache the CLI writes', () => {
  const stats = summarize(
    {
      dailyActivity: [
        { date: '2026-08-24', messageCount: 100, sessionCount: 2 },
        { date: '2026-08-25', messageCount: 400, sessionCount: 8 },
        // Days with no messages are not activity, whatever else they carry.
        { date: '2026-08-20', messageCount: 0, sessionCount: 0 }
      ],
      modelUsage: {
        'claude-opus-5': { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 900 },
        'claude-haiku-4-5-20251001': { inputTokens: 5, outputTokens: 5 }
      },
      totalSessions: 5508,
      totalMessages: 545_418,
      longestSession: { duration: 1_675_006_094 },
      firstSessionDate: '2026-08-16T01:48:53.137Z'
    },
    '2026-08-25'
  )

  assert.equal(stats.activeDays, 2)
  assert.equal(stats.spanDays, 10) // Aug 16 → Aug 25, inclusive
  assert.equal(stats.busiestDay?.date, '2026-08-25')
  // Ranked on everything the model processed, cache included.
  assert.equal(stats.favoriteModel, 'claude-opus-5')
  assert.equal(stats.tokens.total, 940)
  assert.equal(stats.currentStreak, 2)
  assert.equal(stats.sessions, 5508)
})

test('a missing or unreadable cache is not an error state', () => {
  const stats = summarize({}, '2026-08-25')
  assert.deepEqual(stats.days, [])
  assert.equal(stats.activeDays, 0)
  assert.equal(stats.longestStreak, 0)
})
