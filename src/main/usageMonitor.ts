import { homedir } from 'node:os'
import { getClaudeInfo } from './claudeInfo'
import { parseUsage } from './usageText'
import type { UsageStats } from '../shared/types'

// Reads Claude's account usage on demand. The probe spawns a throwaway `claude`
// (up to ~20s), so it must never run merely because a Floe window opened.
// Callers that explicitly request a refresh can reuse this module and its cache.
// The text it comes back with is parsed in usageText.ts.

let cwd = homedir()
let inFlight = false

// Where to run the probe. Usage is global, but using the active worktree keeps
// the probe's transient session file local to a real project dir.
export function setUsageProbeCwd(path: string | undefined): void {
  if (path) cwd = path
}

// The last probe's result, so a reader that must not spawn a 20s `claude` (the
// Fleet snapshot, on an SSE tick) can still show the limits. `{}` until the
// first refresh lands.
let last: UsageStats = {}
export function lastUsage(): UsageStats {
  return last
}

async function refresh(): Promise<UsageStats> {
  // A probe already running means the answer is seconds away, but the caller
  // asked now. Handing back the last reading beats handing back nothing: the
  // renderer drops an empty result, so `{}` here blanked the row for anyone
  // who opened the account panel while a refresh was in flight.
  if (inFlight) return last
  inFlight = true
  try {
    const info = await getClaudeInfo(cwd)
    const stats = parseUsage(info.usageText)
    // A probe that timed out or could not spawn parses to {}. One bad spawn
    // should not erase a good number that is still roughly true.
    if (stats.session || stats.week || stats.month) last = stats
    return last
  } finally {
    inFlight = false
  }
}

// Invoked by the renderer (ipc 'stats:refreshUsage') for an on-demand update.
export function refreshUsageNow(): Promise<UsageStats> {
  return refresh()
}
