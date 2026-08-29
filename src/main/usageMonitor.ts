import { homedir } from 'node:os'
import { getClaudeInfo } from './claudeInfo'
import type { UsageStats, UsageWindow } from '../shared/types'

// Reads Claude's account usage on demand. The probe spawns a throwaway `claude`
// (up to ~20s), so it must never run merely because a Floe window opened.
// Callers that explicitly request a refresh can reuse this module and its cache.
//
// The /usage text looks like:
//   You are currently using your subscription to power your Claude Code usage
//
//   Current session: 10% used · resets Jun 13 at 1am (America/Denver)
//   Current week (all models): 2% used · resets Jun 15 at 10pm (America/Denver)
//   Current week (Sonnet only): 0% used
//
// We map "session" → 5h window, "week (all models)" → week, and (if a plan ever
// reports it) "month" → month. The "Sonnet only" line is ignored. The parser is
// deliberately tolerant: if nothing matches it returns {} and the UI hides.

let cwd = homedir()
let inFlight = false

// Where to run the probe. Usage is global, but using the active worktree keeps
// the probe's transient session file local to a real project dir.
export function setUsageProbeCwd(path: string | undefined): void {
  if (path) cwd = path
}

export function parseUsage(text: string | undefined): UsageStats {
  if (!text) return {}
  const stats: UsageStats = {}
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    // "Current <label>: NN% used[ · resets <when>]"
    const m = line.match(/^current\s+(.+?):\s*(\d+)%\s*used(?:\s*·\s*resets\s+(.+))?$/i)
    if (!m) continue
    const label = m[1].toLowerCase()
    const window: UsageWindow = { pct: Number(m[2]), resetsAt: m[3]?.trim() || undefined }
    if (label.includes('sonnet') || label.includes('opus') || label.includes('haiku')) continue // model-specific breakdowns
    if (label.includes('session')) stats.session ??= window
    else if (label.includes('month')) stats.month ??= window
    else if (label.includes('week')) stats.week ??= window
  }
  return stats
}

// The last probe's result, so a reader that must not spawn a 20s `claude` (the
// Fleet snapshot, on an SSE tick) can still show the limits. `{}` until the
// first refresh lands.
let last: UsageStats = {}
export function lastUsage(): UsageStats {
  return last
}

async function refresh(): Promise<UsageStats> {
  if (inFlight) return {}
  inFlight = true
  try {
    const info = await getClaudeInfo(cwd)
    const stats = parseUsage(info.usageText)
    last = stats
    return stats
  } finally {
    inFlight = false
  }
}

// Invoked by the renderer (ipc 'stats:refreshUsage') for an on-demand update.
export function refreshUsageNow(): Promise<UsageStats> {
  return refresh()
}
