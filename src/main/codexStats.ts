import { open, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ClaudeStats } from '../shared/types'
import { streaks } from './claudeStats'

// Codex's lifetime history, in the same shape as Claude's.
//
// Same shape on purpose: the account panel already draws one of these, so
// giving the second runtime an identical answer means a second renderer never
// has to exist. What differs is where the facts come from — Claude keeps a
// rolled-up cache, codex keeps the raw rollouts:
//
//   ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl
//
// The path alone answers "how many sessions, on which days" — no file is
// opened for that. Tokens and the model need the file, but only its tail: a
// rollout's `token_count` is cumulative, so the LAST one is the session total.
//
// ponytail: the heatmap counts SESSIONS per day, where Claude's counts
// messages — counting messages here would mean reading 210MB instead of the
// last 200KB of each file. Both answer "how busy was that day"; only the
// absolute numbers differ, and they were never comparable across runtimes.

const SESSIONS = join(homedir(), '.codex', 'sessions')

/** Only the end of a rollout is needed: the last token_count is the total. */
const TAIL_BYTES = 200_000

/** Every rollout file, with the day its path says it belongs to. */
async function rollouts(): Promise<{ path: string; date: string }[]> {
  const out: { path: string; date: string }[] = []
  const dirs = async (p: string): Promise<string[]> => {
    try {
      return (await readdir(p, { withFileTypes: true }))
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
    } catch {
      return []
    }
  }
  for (const year of await dirs(SESSIONS)) {
    for (const month of await dirs(join(SESSIONS, year))) {
      for (const day of await dirs(join(SESSIONS, year, month))) {
        const dir = join(SESSIONS, year, month, day)
        let names: string[] = []
        try {
          names = await readdir(dir)
        } catch {
          continue
        }
        for (const name of names) {
          if (name.endsWith('.jsonl')) out.push({ path: join(dir, name), date: `${year}-${month}-${day}` })
        }
      }
    }
  }
  return out
}

/** The session's totals and which model ran it, from the tail of its rollout. */
async function readTail(
  path: string
): Promise<{ model?: string; tokens: { input: number; output: number; cacheRead: number; cacheWrite: number } }> {
  const empty = { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    const size = (await stat(path)).size
    handle = await open(path, 'r')
    const start = Math.max(0, size - TAIL_BYTES)
    const buffer = Buffer.alloc(Math.min(size, TAIL_BYTES))
    await handle.read(buffer, 0, buffer.length, start)
    const tail = buffer.toString('utf8')

    let model: string | undefined
    let usage: Record<string, number> | undefined
    for (const line of tail.split('\n')) {
      // Cheap string tests first: parsing every line of every rollout is the
      // difference between 0.2s and several seconds.
      if (line.includes('"token_count"')) {
        try {
          const payload = (JSON.parse(line) as { payload?: { info?: { total_token_usage?: Record<string, number> } } })
            .payload
          if (payload?.info?.total_token_usage) usage = payload.info.total_token_usage
        } catch {
          /* a torn line at the tail boundary */
        }
      } else if (!model && line.includes('"turn_context"')) {
        try {
          model = (JSON.parse(line) as { payload?: { model?: string } }).payload?.model
        } catch {
          /* same */
        }
      }
    }
    return {
      model,
      tokens: {
        input: usage?.input_tokens ?? 0,
        output: usage?.output_tokens ?? 0,
        cacheRead: usage?.cached_input_tokens ?? 0,
        cacheWrite: usage?.cache_write_input_tokens ?? 0
      }
    }
  } catch {
    return empty
  } finally {
    await handle?.close().catch(() => {})
  }
}

/** Today in the local timezone, as YYYY-MM-DD — the rollout paths' own format. */
const localToday = (): string => {
  const now = new Date()
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10)
}

export async function codexStats(): Promise<ClaudeStats | undefined> {
  const files = await rollouts()
  if (!files.length) return undefined

  const perDay = new Map<string, number>()
  for (const f of files) perDay.set(f.date, (perDay.get(f.date) ?? 0) + 1)

  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  const byModel = new Map<string, number>()
  const tails = await Promise.all(files.map((f) => readTail(f.path)))
  for (const t of tails) {
    tokens.input += t.tokens.input
    tokens.output += t.tokens.output
    tokens.cacheRead += t.tokens.cacheRead
    tokens.cacheWrite += t.tokens.cacheWrite
    if (t.model) byModel.set(t.model, (byModel.get(t.model) ?? 0) + 1)
  }
  tokens.total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite

  const days = [...perDay.entries()]
    .map(([date, messages]) => ({ date, messages }))
    .sort((a, b) => a.date.localeCompare(b.date))
  const busiest = days.reduce<{ date: string; messages: number } | undefined>(
    (best, d) => (!best || d.messages > best.messages ? d : best),
    undefined
  )
  // Favourite = the model that ran the most sessions. Codex records the model
  // per turn, not per token, so sessions is the honest unit here.
  const favouriteModel = [...byModel.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
  const today = localToday()
  const run = streaks(days.map((d) => d.date), today)
  const first = days[0]?.date
  const span = first
    ? Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) / 86_400_000) + 1
    : days.length

  return {
    days,
    activeDays: days.length,
    spanDays: span,
    sessions: files.length,
    // Codex does not count messages without reading every rollout in full; the
    // number it can answer cheaply is sessions, which the panel already shows.
    messages: 0,
    longestSessionMs: 0,
    longestStreak: run.longest,
    currentStreak: run.current,
    busiestDay: busiest,
    favoriteModel: favouriteModel,
    tokens
  }
}
