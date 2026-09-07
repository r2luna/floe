import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TranscriptLine } from './claudeStats.ts'

// The module resolves ~/.claude at import time, so HOME has to point at a
// tmpdir before the import runs — hence the dynamic import.
const HOME = mkdtempSync(join(tmpdir(), 'floe-claudestats-'))
process.env.HOME = HOME
const { claudeStats, streaks, summarize, summarizeTranscripts } = await import('./claudeStats.ts')

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

/* --- the transcript fallback ---------------------------------------------- */

const usage = (input: number, output: number, read = 0, write = 0) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: read,
  cache_creation_input_tokens: write
})

const say = (over: Partial<TranscriptLine> = {}): TranscriptLine => ({
  type: 'assistant',
  timestamp: '2026-08-25T12:00:00.000Z',
  sessionId: 's1',
  uuid: crypto.randomUUID(),
  ...over
})

test('one response written as several lines is counted once', () => {
  // What the CLI actually writes: the text block, then a line per tool call,
  // each repeating the request's usage as the response streams.
  const stats = summarizeTranscripts(
    [
      say({ requestId: 'req_1', message: { model: 'claude-opus-5', usage: usage(2, 3, 100, 50) } }),
      say({ requestId: 'req_1', message: { model: 'claude-opus-5', usage: usage(2, 3, 100, 50) } }),
      say({ requestId: 'req_1', message: { model: 'claude-opus-5', usage: usage(2, 400, 100, 50) } })
    ],
    '2026-08-25'
  )
  // The finished reading, not the sum of the three: 2 + 400 + 100 + 50.
  assert.equal(stats.tokens.total, 552)
  assert.equal(stats.tokens.output, 400)
})

test('lines with no requestId stand alone', () => {
  const stats = summarizeTranscripts(
    [
      say({ uuid: 'a', message: { usage: usage(1, 1) } }),
      say({ uuid: 'b', message: { usage: usage(1, 1) } })
    ],
    '2026-08-25'
  )
  assert.equal(stats.tokens.total, 4)
})

test('the favourite model is the one that processed the most, never <synthetic>', () => {
  const stats = summarizeTranscripts(
    [
      say({ requestId: 'r1', message: { model: 'claude-opus-5', usage: usage(0, 10) } }),
      say({ requestId: 'r2', message: { model: 'claude-fable-5', usage: usage(0, 5) } }),
      // The CLI stamps its own error notices with this. It is not a model.
      say({ requestId: 'r3', message: { model: '<synthetic>', usage: usage(0, 9999) } })
    ],
    '2026-08-25'
  )
  assert.equal(stats.favoriteModel, 'claude-opus-5')
})

test('days, sessions and span come from the lines that carry no usage too', () => {
  const stats = summarizeTranscripts(
    [
      say({ type: 'user', timestamp: '2026-08-24T09:00:00.000Z', sessionId: 's1' }),
      say({ timestamp: '2026-08-24T10:00:00.000Z', sessionId: 's1' }),
      say({ type: 'user', timestamp: '2026-08-25T09:00:00.000Z', sessionId: 's2' }),
      // Not a message — a summary or meta line the CLI also writes.
      say({ type: 'summary', timestamp: '2026-08-25T09:30:00.000Z', sessionId: 's3' })
    ],
    '2026-08-25'
  )
  assert.equal(stats.activeDays, 2)
  assert.equal(stats.messages, 3)
  assert.equal(stats.sessions, 2) // s3 had no message, so it is not a session
  assert.equal(stats.spanDays, 2)
  assert.equal(stats.currentStreak, 2)
  assert.equal(stats.longestSessionMs, 3_600_000) // s1, 09:00 → 10:00
})

test('nothing at all rolls up to zeros, not a crash', () => {
  const stats = summarizeTranscripts([], '2026-08-25')
  assert.deepEqual(stats.days, [])
  assert.equal(stats.sessions, 0)
  assert.equal(stats.spanDays, 0)
  assert.equal(stats.tokens.total, 0)
  assert.equal(stats.favoriteModel, undefined)
})

/* --- reading ~/.claude ----------------------------------------------------- */

const write = (rel: string, body: string): void => {
  const path = join(HOME, '.claude', rel)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, body)
}

const jsonl = (...lines: object[]): string => lines.map((l) => JSON.stringify(l)).join('\n') + '\n'

test('a fresh install says so instead of drawing a heatmap of zeros', async () => {
  const stats = await claudeStats()
  assert.equal(stats.error, 'No stats yet')
  assert.deepEqual(stats.days, [])
  assert.equal(stats.sessions, 0)
})

test('with no cache the transcripts are counted, across projects and files', async () => {
  write(
    'projects/-Users-r-floe/a.jsonl',
    jsonl(
      { type: 'user', timestamp: '2026-08-24T12:00:00.000Z', sessionId: 's1', uuid: 'u1' },
      {
        type: 'assistant',
        timestamp: '2026-08-24T12:00:01.000Z',
        sessionId: 's1',
        requestId: 'req_1',
        message: { model: 'claude-opus-5', usage: { input_tokens: 5, output_tokens: 7 } }
      },
      // The same request written again as it streamed — must not double count.
      {
        type: 'assistant',
        timestamp: '2026-08-24T12:00:02.000Z',
        sessionId: 's1',
        requestId: 'req_1',
        message: { model: 'claude-opus-5', usage: { input_tokens: 5, output_tokens: 7 } }
      }
    ) + '{"type":"assistant","timestamp":' // a live session's half-written tail
  )
  write(
    'projects/-Users-r-other/b.jsonl',
    jsonl({
      type: 'assistant',
      timestamp: '2026-08-25T12:00:00.000Z',
      sessionId: 's2',
      uuid: 'u9',
      message: { model: 'claude-fable-5', usage: { input_tokens: 1, output_tokens: 1 } }
    })
  )
  // Not a transcript, and not a project directory: both are skipped.
  write('projects/-Users-r-other/notes.md', 'hello')
  write('projects/stray.txt', 'hello')

  const stats = await claudeStats()
  assert.equal(stats.error, undefined)
  assert.equal(stats.messages, 4)
  assert.equal(stats.sessions, 2)
  assert.equal(stats.activeDays, 2)
  assert.equal(stats.tokens.total, 14) // 5 + 7 once, plus 1 + 1
  assert.equal(stats.favoriteModel, 'claude-opus-5')
  assert.equal(stats.busiestDay?.messages, 3)
})

test('the cache the CLI writes wins over the transcripts', async () => {
  write(
    'stats-cache.json',
    JSON.stringify({
      dailyActivity: [{ date: '2026-08-24', messageCount: 999, sessionCount: 1 }],
      totalSessions: 42,
      totalMessages: 999
    })
  )
  const stats = await claudeStats()
  assert.equal(stats.sessions, 42)
  assert.equal(stats.messages, 999)
})

test('an unreadable cache falls through to the transcripts', async () => {
  write('stats-cache.json', 'not json')
  const stats = await claudeStats()
  assert.equal(stats.sessions, 2)
  assert.equal(stats.messages, 4)
})
