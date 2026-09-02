import type { UsageStats, UsageWindow } from '../shared/types'

// Turning Claude's `/usage` text into windows. Split out from usageMonitor.ts
// only so it can be tested: that module reaches for claudeInfo, which spawns,
// and a parser test should not need a process.
//
// The text looks like:
//   You are currently using your subscription to power your Claude Code usage
//
//   Current session: 10% used · resets Jun 13 at 1am (America/Denver)
//   Current week (all models): 2% used · resets Jun 15 at 10pm (America/Denver)
//   Current week (Sonnet only): 0% used
//
// "session" → the 5h window, "week (all models)" → the week, and (if a plan
// ever reports it) "month". Any other parenthesised line is one model's slice
// of the same allowance, not a limit of its own. Deliberately tolerant: if
// nothing matches it returns {} and the UI hides.

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
    // The qualifier in brackets says whose number this is. "(all models)" is
    // the window itself; anything else is one model's share of it. Testing for
    // a list of model names instead meant each new one — Fable was the one
    // that did it — could take the week's slot by printing first.
    const qualifier = label.match(/\(([^)]*)\)/)?.[1]
    if (qualifier && qualifier !== 'all models') continue
    if (label.includes('session')) stats.session ??= window
    else if (label.includes('month')) stats.month ??= window
    else if (label.includes('week')) stats.week ??= window
  }
  return stats
}
