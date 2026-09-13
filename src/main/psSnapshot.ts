import { execFile } from 'node:child_process'

// One shared, short-lived cache over `ps -A`. Both the topbar memory widget and
// every running command's memory poller sample on the same ~2s cadence; without
// the cache each poller spawns its own full process-table scan. Concurrent and
// near-simultaneous callers now share a single spawn. Windows has no `ps`, so
// the snapshot is empty there.

export interface PsRow {
  pid: number
  ppid: number
  pgid: number
  rssBytes: number
}

// Shorter than the 2s poll interval, so every tick still sees fresh data.
// Overridable alongside FLOE_MEM_INTERVAL_MS, for the same test.
const TTL = Number(process.env.FLOE_PS_TTL_MS) || 1500

let cache: { at: number; promise: Promise<PsRow[]> } | undefined

export function snapshotProcesses(): Promise<PsRow[]> {
  const now = Date.now()
  if (cache && now - cache.at < TTL) return cache.promise
  const promise = new Promise<PsRow[]>((resolve) => {
    if (process.platform === 'win32') return resolve([])
    execFile('ps', ['-A', '-o', 'pid=,ppid=,pgid=,rss='], (err, stdout) => {
      if (err) return resolve([])
      const rows: PsRow[] = []
      for (const line of stdout.split('\n')) {
        const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$/)
        if (m) {
          rows.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), rssBytes: Number(m[4]) * 1024 })
        }
      }
      resolve(rows)
    })
  })
  cache = { at: now, promise }
  return promise
}
