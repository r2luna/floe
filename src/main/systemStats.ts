import { app, type BrowserWindow } from 'electron'
import { execFile } from 'node:child_process'
import { getSessionPids } from './agent'
import { getTerminalPids } from './terminal'
import { getCommandPids } from './commandRunner'
import type { MemoryStats } from '../shared/types'

// Pushes a combined memory figure to the renderer's topbar widget every few
// seconds. The total is:
//   • the Electron app itself — main + every renderer/GPU/utility process, via
//     app.getAppMetrics() (workingSetSize, reported in KB); plus
//   • the spawned process trees we don't own through Electron — the `claude`
//     sessions, terminal PTYs and command runners — summed from a single `ps`
//     snapshot by walking each root PID's descendants.
// Those roots are distinct from Electron's own processes, so there's no double
// counting. Windows has no `ps`, so only the app figure is reported there.

const MEM_INTERVAL = 2000

let memTimer: ReturnType<typeof setInterval> | undefined
let lastTotal: number | undefined

interface PsRow {
  pid: number
  ppid: number
  rssBytes: number
}

// One `ps` snapshot of the whole process table. Resolves [] on Windows or error.
function snapshotProcesses(): Promise<PsRow[]> {
  return new Promise((resolve) => {
    if (process.platform === 'win32') return resolve([])
    execFile('ps', ['-A', '-o', 'pid=,ppid=,rss='], (err, stdout) => {
      if (err) return resolve([])
      const rows: PsRow[] = []
      for (const line of stdout.split('\n')) {
        const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)$/)
        if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), rssBytes: Number(m[3]) * 1024 })
      }
      resolve(rows)
    })
  })
}

// Sum the RSS of each root PID and all of its descendants, counting every
// process at most once (a child of two roots, or a root that is itself a
// descendant of another root, is not added twice).
function sumTreeRss(rows: PsRow[], rootPids: number[]): number {
  const childrenOf = new Map<number, number[]>()
  const rssOf = new Map<number, number>()
  for (const r of rows) {
    rssOf.set(r.pid, r.rssBytes)
    const arr = childrenOf.get(r.ppid)
    if (arr) arr.push(r.pid)
    else childrenOf.set(r.ppid, [r.pid])
  }
  const seen = new Set<number>()
  const stack = [...rootPids]
  let total = 0
  while (stack.length) {
    const pid = stack.pop()!
    if (seen.has(pid)) continue
    seen.add(pid)
    total += rssOf.get(pid) ?? 0
    const kids = childrenOf.get(pid)
    if (kids) stack.push(...kids)
  }
  return total
}

// Resident memory of the Electron app's own processes (KB → bytes).
function appMemoryBytes(): number {
  let total = 0
  for (const m of app.getAppMetrics()) total += (m.memory?.workingSetSize ?? 0) * 1024
  return total
}

// `send` only pushes when the total CHANGED, which is right for the steady
// state and useless to a renderer that just mounted: it has no value at all and
// would wait for the number to happen to move. Subscribing is a race the
// subscriber always loses, so late arrivals pull instead — same shape as
// refreshUsage. Used by the `stats:getMemory` handler.
export async function sampleMemory(): Promise<MemoryStats> {
  const roots = [...getSessionPids(), ...getTerminalPids(), ...getCommandPids()]
  const rows = roots.length ? await snapshotProcesses() : []
  return { totalBytes: appMemoryBytes() + sumTreeRss(rows, roots) }
}

function send(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  void sampleMemory().then((stats) => {
    if (win.isDestroyed() || stats.totalBytes === lastTotal) return
    lastTotal = stats.totalBytes
    win.webContents.send('stats:memory', stats)
  })
}

export function startMemoryStats(win: BrowserWindow): void {
  stopMemoryStats()
  lastTotal = undefined
  send(win) // sample immediately so the widget shows a value right away
  memTimer = setInterval(() => send(win), MEM_INTERVAL)
}

export function stopMemoryStats(): void {
  if (memTimer) clearInterval(memTimer)
  memTimer = undefined
}
