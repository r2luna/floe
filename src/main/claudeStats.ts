import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ClaudeStats } from '../shared/types'

// Lifetime stats for the account — what the CLI's own `/stats` view shows.
//
// `/stats` is TUI-only (headless it answers with /usage instead), but the data
// behind it is not: Claude Code keeps a rolled-up cache at
// ~/.claude/stats-cache.json and recomputes it as sessions end. Reading that is
// the whole implementation — walking 5k session transcripts to recount what the
// CLI already counted would be slower and would still disagree with the TUI.
//
// ponytail: read-only and all-time. Range switching (7d/30d) and the per-model
// tab exist in the TUI; add them when someone asks, from the same file.

const CACHE = join(homedir(), '.claude', 'stats-cache.json')

/** The shape we read. Everything else in the file is ignored. */
interface Cache {
  dailyActivity?: { date: string; messageCount: number; sessionCount: number }[]
  modelUsage?: Record<
    string,
    {
      inputTokens?: number
      outputTokens?: number
      cacheReadInputTokens?: number
      cacheCreationInputTokens?: number
    }
  >
  totalSessions?: number
  totalMessages?: number
  longestSession?: { duration?: number }
  firstSessionDate?: string
}

const DAY_MS = 86_400_000

/** Days between two YYYY-MM-DD dates. UTC, so DST can't produce a half day. */
const daysBetween = (a: string, b: string): number =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS)

/**
 * Longest and current run of consecutive active days.
 *
 * `today` is passed in rather than read from the clock so the current streak is
 * testable — and so "current" means current for the caller's day, not the
 * process's.
 */
export function streaks(dates: string[], today: string): { longest: number; current: number } {
  if (!dates.length) return { longest: 0, current: 0 }
  const sorted = [...dates].sort()
  let longest = 1
  let run = 1
  for (let i = 1; i < sorted.length; i++) {
    run = daysBetween(sorted[i - 1], sorted[i]) === 1 ? run + 1 : 1
    if (run > longest) longest = run
  }
  // The run only counts as current when it reaches today or yesterday: a streak
  // that ended a week ago is history, and calling it current would be a lie
  // that grows more wrong every day the app stays open.
  const gap = daysBetween(sorted[sorted.length - 1], today)
  return { longest, current: gap <= 1 ? run : 0 }
}

export function summarize(cache: Cache, today: string): ClaudeStats {
  const days = (cache.dailyActivity ?? [])
    .filter((d) => d?.date && d.messageCount > 0)
    .map((d) => ({ date: d.date, messages: d.messageCount }))
    .sort((a, b) => a.date.localeCompare(b.date))

  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  let favoriteModel: string | undefined
  let favoriteTokens = 0
  for (const [model, use] of Object.entries(cache.modelUsage ?? {})) {
    const input = use.inputTokens ?? 0
    const output = use.outputTokens ?? 0
    const read = use.cacheReadInputTokens ?? 0
    const write = use.cacheCreationInputTokens ?? 0
    tokens.input += input
    tokens.output += output
    tokens.cacheRead += read
    tokens.cacheWrite += write
    // "Favorite" is by what the model actually processed, cache included —
    // ranking on input alone would crown whichever model happened to run
    // without a warm cache.
    const all = input + output + read + write
    if (all > favoriteTokens) {
      favoriteTokens = all
      favoriteModel = model
    }
  }
  tokens.total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite

  const busiest = days.reduce<{ date: string; messages: number } | undefined>(
    (best, d) => (!best || d.messages > best.messages ? d : best),
    undefined
  )
  const first = cache.firstSessionDate?.slice(0, 10) ?? days[0]?.date
  const run = streaks(
    days.map((d) => d.date),
    today
  )

  return {
    days,
    activeDays: days.length,
    // Every day since the first session, whether or not it was worked — the
    // denominator of "173/248".
    spanDays: first ? daysBetween(first, today) + 1 : days.length,
    sessions: cache.totalSessions ?? 0,
    messages: cache.totalMessages ?? 0,
    longestSessionMs: cache.longestSession?.duration ?? 0,
    busiestDay: busiest,
    favoriteModel,
    tokens,
    longestStreak: run.longest,
    currentStreak: run.current
  }
}

/** Today in the local timezone, as YYYY-MM-DD — the cache's own date format. */
const localToday = (): string => {
  const now = new Date()
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10)
}

export async function claudeStats(): Promise<ClaudeStats> {
  try {
    const cache = JSON.parse(await readFile(CACHE, 'utf8')) as Cache
    return summarize(cache, localToday())
  } catch (e) {
    // No cache yet is the normal state on a fresh install, not a failure worth
    // a red panel — the message says which it is.
    const message = (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'No stats yet' : String(e)
    return {
      days: [],
      activeDays: 0,
      spanDays: 0,
      sessions: 0,
      messages: 0,
      longestSessionMs: 0,
      longestStreak: 0,
      currentStreak: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      error: message
    }
  }
}
