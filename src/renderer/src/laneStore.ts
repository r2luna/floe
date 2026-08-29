import type { Lane, Panel } from './lane'

// Remembering the lane — both halves of "leave it as I left it".
//
//  - PER SESSION: the panels a session opened (its terminal, its changes, the
//    diff it was showing) belong to that session, not to the window. Switching
//    to another session puts its own set back, and coming back restores yours.
//  - ACROSS RESTARTS: the whole thing is written to localStorage on every
//    change, so quitting is just the last change and launching resumes from it.
//
// localStorage rather than the main process because that is already where this
// renderer keeps its preferences (models.ts, keybindings.ts), and because a lane
// is a property of the window you are looking at.
//
// ponytail: localStorage commits to disk lazily, so a SIGKILL (not a quit — a
// kill) loses the last few seconds of changes and the app comes back a step
// behind. Verified: closing the window normally restores everything. If crash
// fidelity ever matters, move `save` behind an IPC call that writes
// <userData>/lane.json, which is durable the moment it returns.

const KEY = 'floe.lane'
const VERSION = 1

// Panels left of the session belong to the window (which project, which
// worktree); panels right of it are what the session opened. Only the latter
// are remembered per session — see KINDS.order, where the session sits at 30.
const SESSION_ORDER = 30

// ponytail: newest 30 sessions. Unbounded, this grows a panel list per session
// forever; a real cap belongs here rather than in a cleanup task nobody runs.
const MAX_SESSIONS = 30

export interface LaneMemory {
  version: number
  /** The lane as it was last seen — what a relaunch restores. */
  lane: Lane
  /** Panels each session had open, keyed by session id, oldest first. */
  bySession: Record<string, Panel[]>
  /**
   * Where the app was. The lane's panels draw themselves from these two — a
   * restored chat with no worktree selected would show its changes panel empty
   * and open its terminal in the wrong directory.
   */
  project?: string
  worktree?: string
}

/** The session a lane is showing, or null when it is showing none. */
export function sessionKeyOf(lane: Lane): string | null {
  return lane.panels.find((p) => p.session)?.session?.id ?? null
}

/** The panels the session opened: everything to the right of the session slot. */
export function scopedOf(lane: Lane): Panel[] {
  return lane.panels.filter((p) => (p.order ?? 0) > SESSION_ORDER)
}

/**
 * Swap in another session's panels, keeping the window's own (projects,
 * worktrees, the session itself) exactly where they are.
 *
 * Focus follows the surviving part of the lane: restoring a set that is shorter
 * than the one it replaced must not leave the focus pointing past the end.
 */
export function withScoped(lane: Lane, scoped: Panel[]): Lane {
  const kept = lane.panels.filter((p) => (p.order ?? 0) <= SESSION_ORDER)
  const focused = lane.panels[lane.focus]
  const panels = [...kept, ...scoped]
  // Stay on the same panel if it survived; otherwise fall back to the session,
  // which is the one panel a session switch is always about.
  const at = focused ? panels.findIndex((p) => p.id === focused.id) : -1
  const session = panels.findIndex((p) => p.session)
  return { panels, focus: Math.max(0, at !== -1 ? at : session) }
}

/**
 * What is safe to write down.
 *
 * `firstPrompt` is the one field that must never survive a reload: it is the
 * opening message a brand-new chat sends when it mounts, so persisting it would
 * re-send that message every time the app started.
 */
export function persistable(panels: Panel[]): Panel[] {
  return panels.map(({ firstPrompt: _p, firstChoice: _c, ...rest }) => rest)
}

/** Keep the newest N sessions; the rest are older than anyone's memory. */
function prune(bySession: Record<string, Panel[]>): Record<string, Panel[]> {
  const keys = Object.keys(bySession)
  if (keys.length <= MAX_SESSIONS) return bySession
  // Insertion order is recency: writing a session re-inserts it at the end
  // (see remember), so the oldest keys are the ones at the front.
  return Object.fromEntries(keys.slice(keys.length - MAX_SESSIONS).map((k) => [k, bySession[k]]))
}

/** Record one session's panels, moving it to the most-recent end. */
export function remember(
  bySession: Record<string, Panel[]>,
  key: string,
  panels: Panel[]
): Record<string, Panel[]> {
  const next = { ...bySession }
  delete next[key] // re-insert at the end so key order stays recency order
  next[key] = persistable(panels)
  return prune(next)
}

/** A lane is only usable if it still looks like one. Anything else is discarded. */
function valid(value: unknown): value is LaneMemory {
  const m = value as LaneMemory | null
  return (
    !!m &&
    m.version === VERSION &&
    !!m.lane &&
    Array.isArray(m.lane.panels) &&
    m.lane.panels.every((p) => p && typeof p.id === 'string' && typeof p.kind === 'string') &&
    typeof m.lane.focus === 'number'
  )
}

export function load(): LaneMemory | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (!valid(parsed)) return null
    return { ...parsed, bySession: parsed.bySession ?? {} }
  } catch {
    // A corrupt lane is not worth a broken launch — start fresh.
    return null
  }
}

export function save(memory: Omit<LaneMemory, 'version'>): void {
  try {
    const lane = { ...memory.lane, panels: persistable(memory.lane.panels) }
    localStorage.setItem(KEY, JSON.stringify({ version: VERSION, ...memory, lane }))
  } catch {
    /* private mode, or quota — the lane is a convenience, never a requirement */
  }
}
