/**
 * The recap: one line telling you what happened in a session while you were
 * not looking at it.
 *
 * Claude Code has the same idea behind `/recap` — it greets you with a summary
 * when you come back after a while away. Floe borrows the name and the prompt
 * (the CLI generates the text; see main/recap.ts) but owns the TIMING, because
 * Floe is the one that knows when you actually left a session: the CLI only
 * sees a process that kept running.
 *
 * This module is the part with no I/O in it — when a recap is owed, and what
 * the line reads like — so the rule is testable without spawning anything.
 */

/**
 * How long you have to be gone before coming back earns a recap.
 *
 * Five minutes, matching the CLI. Shorter and it fires on the walk back from
 * the kitchen, when you still remember what you asked for and the line is one
 * more thing to read past.
 */
export const AWAY_MS = 5 * 60_000

/** The gap, in words: `18m`, `1h 4m`. Coarse on purpose — it is context, not a stopwatch. */
export function awayFor(ms: number): string {
  const mins = Math.round(ms / 60_000)
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  const rest = mins % 60
  return rest ? `${hours}h ${rest}m` : `${hours}h`
}

export interface RecapChance {
  /** How long the session went unwatched. */
  awayMs: number
  /** Whether the agent actually said anything in that window. */
  moved: boolean
  /** A turn still running: the recap would describe a story that is still moving. */
  busy?: boolean
}

/**
 * Three things have to hold, and each one on its own is a reason not to bother:
 * you were gone long enough to have lost the thread, something happened while
 * you were, and it has stopped happening.
 */
export function shouldRecap({ awayMs, moved, busy }: RecapChance): boolean {
  if (busy) return false
  if (!moved) return false
  return awayMs >= AWAY_MS
}

/**
 * The transcript line: `(18m away) — <what happened>`.
 *
 * The Log heads it with `* recap`, the same shape as every other line about the
 * conversation rather than in it, so this half never repeats the word.
 *
 * The gap is dropped when there was not one — asking for a recap by hand is not
 * coming back from anywhere, and `(0m away)` would be a stamp on a fact that
 * has no time in it.
 */
export function recapLine(text: string, awayMs: number): string {
  const said = text.trim().replace(/\s+/g, ' ')
  if (!said) return ''
  if (awayMs < AWAY_MS) return said
  return `(${awayFor(awayMs)} away) — ${said}`
}
