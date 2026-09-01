import { readFile, readdir } from 'node:fs/promises'
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
// The catch is that the CLI only writes that cache once `/stats` has run in the
// TUI. A user who has never opened it has no file, and reading nothing rendered
// a heatmap of zeros that looked like a broken meter. So when the cache is
// missing we count the transcripts ourselves — the same thing codexStats.ts
// does for the other runtime, over ~/.claude/projects/<slug>/<session>.jsonl.
//
// ponytail: read-only and all-time. Range switching (7d/30d) and the per-model
// tab exist in the TUI; add them when someone asks, from the same file.

const CACHE = join(homedir(), '.claude', 'stats-cache.json')
const TRANSCRIPTS = join(homedir(), '.claude', 'projects')

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

/**
 * The local calendar day a moment fell on, as YYYY-MM-DD — the cache's own
 * date format, and the one the renderer walks to lay the heatmap out. A
 * transcript stamps UTC, so slicing the ISO string would push an evening
 * message west of Greenwich onto tomorrow's square.
 */
const localDay = (ms: number): string =>
  new Date(ms - new Date(ms).getTimezoneOffset() * 60_000).toISOString().slice(0, 10)

const localToday = (): string => localDay(Date.now())

/* --- the fallback: count the transcripts ---------------------------------- */

/** One transcript line, trimmed to the fields the roll-up reads. */
export interface TranscriptLine {
  type?: string
  timestamp?: string
  sessionId?: string
  /** One API response spans several lines (text, then each tool call). */
  requestId?: string
  uuid?: string
  message?: {
    model?: string
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_read_input_tokens?: number
      cache_creation_input_tokens?: number
    }
  }
}

const KINDS = new Set(['user', 'assistant'])

/**
 * Roll the raw transcript lines up into the same shape the cache produces.
 *
 * The one trap here is double counting. A single API response is written as
 * several lines — the text block, then one per tool call — and every one of
 * them repeats that request's `usage`, growing as the response streams. Summing
 * line by line inflated the total by ~60%. So tokens are banked per requestId,
 * keeping the largest reading, which is the finished one.
 */
export function summarizeTranscripts(lines: TranscriptLine[], today: string): ClaudeStats {
  const perDay = new Map<string, number>()
  const spans = new Map<string, { first: number; last: number }>()
  const requests = new Map<string, { total: number; model?: string; tokens: number[] }>()

  for (const line of lines) {
    if (!line.type || !KINDS.has(line.type)) continue
    const at = line.timestamp ? Date.parse(line.timestamp) : NaN
    if (!Number.isNaN(at)) {
      const date = localDay(at)
      perDay.set(date, (perDay.get(date) ?? 0) + 1)
      if (line.sessionId) {
        const span = spans.get(line.sessionId)
        if (!span) spans.set(line.sessionId, { first: at, last: at })
        else {
          if (at < span.first) span.first = at
          if (at > span.last) span.last = at
        }
      }
    }

    const use = line.message?.usage
    if (!use) continue
    const tokens = [
      use.input_tokens ?? 0,
      use.output_tokens ?? 0,
      use.cache_read_input_tokens ?? 0,
      use.cache_creation_input_tokens ?? 0
    ]
    const total = tokens[0] + tokens[1] + tokens[2] + tokens[3]
    // A line with no requestId stands alone, so its uuid is its own bucket.
    const key = line.requestId ?? line.uuid
    if (!key) continue
    const seen = requests.get(key)
    if (!seen || total > seen.total) requests.set(key, { total, model: line.message?.model, tokens })
  }

  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  const byModel = new Map<string, number>()
  for (const r of requests.values()) {
    tokens.input += r.tokens[0]
    tokens.output += r.tokens[1]
    tokens.cacheRead += r.tokens[2]
    tokens.cacheWrite += r.tokens[3]
    // `<synthetic>` is what the CLI stamps on its own error notices. It is not
    // a model and must never win the ranking.
    if (r.model && r.model !== '<synthetic>') byModel.set(r.model, (byModel.get(r.model) ?? 0) + r.total)
  }
  tokens.total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite

  const days = [...perDay.entries()]
    .map(([date, messages]) => ({ date, messages }))
    .sort((a, b) => a.date.localeCompare(b.date))
  const busiest = days.reduce<{ date: string; messages: number } | undefined>(
    (best, d) => (!best || d.messages > best.messages ? d : best),
    undefined
  )
  const run = streaks(
    days.map((d) => d.date),
    today
  )
  const first = days[0]?.date

  return {
    days,
    activeDays: days.length,
    spanDays: first ? daysBetween(first, today) + 1 : 0,
    sessions: spans.size,
    messages: [...perDay.values()].reduce((a, b) => a + b, 0),
    // First to last message. A resumed session spans the days between, so this
    // is wall clock, not time spent typing — same as the number the CLI shows.
    longestSessionMs: [...spans.values()].reduce((max, s) => Math.max(max, s.last - s.first), 0),
    busiestDay: busiest,
    favoriteModel: [...byModel.entries()].sort((a, b) => b[1] - a[1])[0]?.[0],
    tokens,
    longestStreak: run.longest,
    currentStreak: run.current
  }
}

/**
 * Every transcript line under ~/.claude/projects.
 *
 * Whole-file reads and a parse per line: 218MB across 238 files takes ~0.5s,
 * and the cheap string tests that would shave 60ms off it cost more in
 * fragility than they save. A torn or non-JSON line is skipped, not fatal —
 * the newest transcript is one the CLI is still appending to.
 */
async function readTranscripts(): Promise<TranscriptLine[]> {
  let slugs: string[] = []
  try {
    slugs = (await readdir(TRANSCRIPTS, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  } catch {
    return []
  }

  const perProject = await Promise.all(
    slugs.map(async (slug) => {
      const dir = join(TRANSCRIPTS, slug)
      let names: string[] = []
      try {
        names = (await readdir(dir)).filter((n) => n.endsWith('.jsonl'))
      } catch {
        return []
      }
      const files = await Promise.all(
        names.map(async (name) => {
          const out: TranscriptLine[] = []
          try {
            for (const line of (await readFile(join(dir, name), 'utf8')).split('\n')) {
              if (!line) continue
              try {
                out.push(JSON.parse(line) as TranscriptLine)
              } catch {
                /* a half-written line at the end of a live session */
              }
            }
          } catch {
            /* deleted between the readdir and the read */
          }
          return out
        })
      )
      return files.flat()
    })
  )
  return perProject.flat()
}

/** Nothing to show — the message says whether that is normal or a failure. */
const nothing = (error: string): ClaudeStats => ({
  days: [],
  activeDays: 0,
  spanDays: 0,
  sessions: 0,
  messages: 0,
  longestSessionMs: 0,
  longestStreak: 0,
  currentStreak: 0,
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  error
})

export async function claudeStats(): Promise<ClaudeStats> {
  const today = localToday()
  try {
    return summarize(JSON.parse(await readFile(CACHE, 'utf8')) as Cache, today)
  } catch {
    // Missing or unreadable, it makes no difference: the transcripts are the
    // same facts before the CLI rolled them up.
  }

  const lines = await readTranscripts()
  // No cache and no transcripts is a fresh install, not a failure worth a red
  // panel — but the panel has to say so instead of drawing zeros.
  return lines.length ? summarizeTranscripts(lines, today) : nothing('No stats yet')
}
