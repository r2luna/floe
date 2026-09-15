// When a usage window resets. Codex hands over a unix timestamp, Claude's
// `/usage` prints a wall-clock hint in a named zone ("Sep 7 at 9:59pm
// (America/Denver)"), so the hint is turned into the same timestamp and both
// render through `resetsIn`.

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

/** Minutes the zone is ahead of UTC at `ms`. */
function zoneOffset(ms: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric'
  }).formatToParts(ms)
  const n = (type: string): number => Number(parts.find((p) => p.type === type)?.value)
  const wall = Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'))
  return Math.round((wall - Math.floor(ms / 60_000) * 60_000) / 60_000)
}

/** The UTC instant a wall-clock time in `timeZone` names. */
function fromWall(y: number, mo: number, d: number, h: number, mi: number, timeZone: string): number {
  const guess = Date.UTC(y, mo, d, h, mi)
  const first = guess - zoneOffset(guess, timeZone) * 60_000
  // A second pass settles the hours either side of a DST switch.
  return guess - zoneOffset(first, timeZone) * 60_000
}

/**
 * "Sep 7 at 9:59pm (America/Denver)" → unix seconds. The year is not printed,
 * so it is the one that puts the reset nearest `now`. A hint without a date
 * ("1am (…)") is the next time the clock reads that. Anything else → undefined.
 */
export function parseResetHint(hint: string | undefined, now = Date.now()): number | undefined {
  const m = hint
    ?.trim()
    .match(/^(?:([a-z]{3})[a-z]*\s+(\d{1,2})(?:,\s*\d{4})?\s+at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^)]+)\)$/i)
  if (!m) return undefined
  const [, mon, day, hour, min, ampm, zone] = m
  const h = (Number(hour) % 12) + (ampm.toLowerCase() === 'pm' ? 12 : 0)
  const mi = Number(min ?? 0)
  try {
    const here = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: 'numeric', day: 'numeric' })
      .formatToParts(now)
    const part = (type: string): number => Number(here.find((p) => p.type === type)?.value)
    if (!mon) {
      const today = fromWall(part('year'), part('month') - 1, part('day'), h, mi, zone)
      return Math.floor((today > now ? today : today + 86_400_000) / 1000)
    }
    const mo = MONTHS.indexOf(mon.toLowerCase())
    if (mo < 0) return undefined
    const candidates = [-1, 0, 1].map((dy) => fromWall(part('year') + dy, mo, Number(day), h, mi, zone))
    const best = candidates.reduce((a, b) => (Math.abs(b - now) < Math.abs(a - now) ? b : a))
    return Math.floor(best / 1000)
  } catch {
    return undefined // an unknown zone name
  }
}

/** "3d 4h", "2h 13m", "8m" until `resetsAt` (unix seconds). "now" once passed. */
export function resetsIn(resetsAt: number, now = Date.now()): string {
  const mins = Math.ceil((resetsAt * 1000 - now) / 60_000)
  if (mins <= 0) return 'now'
  const d = Math.floor(mins / 1440)
  const h = Math.floor((mins % 1440) / 60)
  const m = mins % 60
  if (d) return h ? `${d}d ${h}h` : `${d}d`
  if (h) return m ? `${h}h ${m}m` : `${h}h`
  return `${m}m`
}
