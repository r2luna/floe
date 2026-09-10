import type { Lane, Panel } from './lane'

// Remembering the lane — both halves of "leave it as I left it".
//
//  - PER SESSION: the panels a session opened (its terminal, its changes, the
//    diff it was showing) belong to that session, not to the window. Switching
//    to another session puts its own set back, and coming back restores yours.
//  - PER WORKTREE: which session you were in. A branch is where conversations
//    live, so returning to one has to return to the conversation, not to a
//    branch with an empty column beside it.
//  - PER PROJECT: which worktree you were on. Switching project is the same
//    move one level up — it restores the branch, which restores the session,
//    which restores its panels.
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

/**
 * The checklists that belong to the PROJECT, not to a session.
 *
 * They sit right of the session by `order` — beside `changes`, which is where
 * you read them — but a session switch must not take them away: each is keyed
 * by project root precisely so the work carries on while you are elsewhere, and
 * a flow you cannot see is a flow you cannot answer. The setup checklist makes
 * this unmissable: its one human step is "open the chat", so filing it under
 * the session would close it on the very click that goes to answer it.
 */
const PROJECT_PANELS = new Set(['merge', 'remove', 'setup'])

/**
 * Rail panels that show ONE project's work rather than the window's.
 *
 * The colony board is the case: its tasks, its stages and its nanny are all
 * keyed by repo root, so a board carried into another project would either sit
 * empty or — worse — read as that project's while showing nothing of it. It
 * sits left of the session (order 20) and so survives `withoutProject` on
 * position alone, which is exactly what has to stop.
 *
 * Unlike PROJECT_PANELS these are remembered rather than dropped: which of them
 * a project had open is filed under its root, so leaving hides the board and
 * coming back puts it up again.
 */
const PROJECT_RAIL = new Set(['colony'])

/** Whether a panel is one the session opened, and so travels with it. */
function sessionOwns(panel: Panel): boolean {
  return (panel.order ?? 0) > SESSION_ORDER && !PROJECT_PANELS.has(panel.kind)
}

// ponytail: newest 30 sessions. Unbounded, this grows a panel list per session
// forever; a real cap belongs here rather than in a cleanup task nobody runs.
const MAX_SESSIONS = 30

/** Same ceiling, for the two path-keyed maps: a branch or a project you last
 *  touched hundreds of switches ago is not a place you are coming back to. */
const MAX_PLACES = 100

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
  /** The worktree each project was last left on, keyed by project path. */
  byProject: Record<string, string>
  /**
   * The project-bound rail panels each project was left showing (PROJECT_RAIL),
   * keyed by project path. An empty array is a real answer — you closed the
   * board — and is why this is not derived from "has any task".
   */
  railByProject: Record<string, string[]>
  /**
   * The session each worktree was last left showing, keyed by worktree path.
   * `null` is a real answer — it means the launcher, i.e. you closed the chat
   * and left the branch empty — and must not be confused with "never been
   * here", which is a missing key and gets the launcher for a different reason.
   */
  byWorktree: Record<string, string | null>
}

/**
 * The session a lane is showing, or null when it is showing none.
 *
 * The panel in the session SLOT, not merely the first one carrying a session: a
 * query panel carries one too — its own key, `sess~codex` — and it is not the
 * session the lane is showing. Read the other way, opening a query registered
 * as a session SWITCH, and the swap that follows one restored the (empty) panel
 * set for the query's key over the lane that had just gained it. The panel
 * appeared and vanished in the same tick.
 *
 * `!sessionOwns` is the test because it is already the line between "the
 * session" and "what the session opened": the chat sits at the slot's own
 * order, everything past it belongs to the chat rather than being it.
 */
export function sessionKeyOf(lane: Lane): string | null {
  return lane.panels.find((p) => p.session && !sessionOwns(p))?.session?.id ?? null
}

/** The panels the session opened: everything to the right of the session slot,
 *  minus the project's own checklists — see PROJECT_PANELS. */
export function scopedOf(lane: Lane): Panel[] {
  return lane.panels.filter(sessionOwns)
}

/**
 * Swap in another session's panels, keeping the window's own (projects,
 * worktrees, the session itself) exactly where they are.
 *
 * Focus follows the surviving part of the lane: restoring a set that is shorter
 * than the one it replaced must not leave the focus pointing past the end.
 */
export function withScoped(lane: Lane, scoped: Panel[]): Lane {
  const kept = lane.panels.filter((p) => !sessionOwns(p))
  const focused = lane.panels[lane.focus]
  // Deduped by id: a set remembered before a panel became project-owned still
  // names it, and appending it beside the copy already kept would put the same
  // panel in the lane twice.
  const keptIds = new Set(kept.map((p) => p.id))
  // Sorted by `order`, not merely concatenated. Concatenation was right while
  // "kept" meant strictly left-of-the-session: now a project checklist (41) is
  // kept too, and appending the restored set behind it would put `changes` (40)
  // to the RIGHT of it. Every other path into the lane keeps it ordered — see
  // open() — and a lane that is sorted everywhere except here is a lane whose
  // panels move when you switch session. Sort is stable, so panels sharing an
  // order keep the sides they were on.
  const panels = [...kept, ...scoped.filter((p) => !keptIds.has(p.id))].sort(
    (a, b) => (a.order ?? 0) - (b.order ?? 0)
  )
  // Stay on the same panel if it survived; otherwise fall back to the session,
  // which is the one panel a session switch is always about.
  const at = focused ? panels.findIndex((p) => p.id === focused.id) : -1
  const session = panels.findIndex((p) => p.session)
  return { panels, focus: Math.max(0, at !== -1 ? at : session) }
}

/**
 * The lane stripped back to the window's own panels — what a PROJECT switch
 * leaves standing.
 *
 * Everything from the session slot rightwards describes the project you are
 * leaving: its chat, its changes, its commands, its checklists. Carrying them
 * into another project shows you the wrong repo's work (a commands panel still
 * listing the branch you left is the plainest case), so they go. The projects
 * list and the worktree list stay — they are how you got here, and the switch
 * is a step towards a branch in the new project.
 */
export function withoutProject(lane: Lane): Lane {
  const panels = lane.panels.filter(
    (p) => (p.order ?? 0) < SESSION_ORDER && !PROJECT_RAIL.has(p.kind)
  )
  return { panels, focus: Math.min(lane.focus, Math.max(0, panels.length - 1)) }
}

/** The project-bound rail panels a lane has open, in lane order — see PROJECT_RAIL. */
export function projectRailOf(lane: Lane): string[] {
  return lane.panels.filter((p) => PROJECT_RAIL.has(p.kind)).map((p) => p.kind)
}

/** Record which project-bound rail panels a project was left showing. */
export function rememberRail(
  railByProject: Record<string, string[]>,
  project: string,
  kinds: string[]
): Record<string, string[]> {
  return rememberIn(railByProject, project, kinds, MAX_PLACES)
}

/**
 * What is safe to write down.
 *
 * `firstPrompt` is the one field that must never survive a reload: it is the
 * opening message a brand-new chat sends when it mounts, so persisting it would
 * re-send that message every time the app started. Its attachments go with it —
 * and base64 images have no business in localStorage anyway.
 */
export function persistable(panels: Panel[]): Panel[] {
  return panels
    // A checklist outlives neither the app nor its flow: the flows live in the
    // hooks, so a restored `setup` (or merge, or remove) panel comes back with
    // nothing in it and greets the next launch with an empty state taking up a
    // column. What is worth remembering is the work, and there is none.
    .filter((p) => !PROJECT_PANELS.has(p.kind))
    .map(({ firstPrompt: _p, firstChoice: _c, firstAttached: _a, ...rest }) => rest)
}

/**
 * Write `value` under `key`, keeping only the newest `max` entries.
 *
 * Key order IS recency order: the delete-then-set is what re-inserts a touched
 * key at the end, so dropping from the front drops the least recently used.
 * One function for all three maps — panels, worktrees, sessions — because the
 * ageing rule is the same and three copies of it would be three chances to
 * forget the delete.
 */
export function rememberIn<T>(
  map: Record<string, T>,
  key: string,
  value: T,
  max: number
): Record<string, T> {
  const next = { ...map }
  delete next[key]
  next[key] = value
  const keys = Object.keys(next)
  if (keys.length <= max) return next
  return Object.fromEntries(keys.slice(keys.length - max).map((k) => [k, next[k]]))
}

/** Record one session's panels, moving it to the most-recent end. */
export function remember(
  bySession: Record<string, Panel[]>,
  key: string,
  panels: Panel[]
): Record<string, Panel[]> {
  return rememberIn(bySession, key, persistable(panels), MAX_SESSIONS)
}

/** Record which worktree a project was last left on. */
export function rememberWorktree(
  byProject: Record<string, string>,
  project: string,
  worktree: string
): Record<string, string> {
  return rememberIn(byProject, project, worktree, MAX_PLACES)
}

/** Record which session a worktree was last left showing — null for the launcher. */
export function rememberSession(
  byWorktree: Record<string, string | null>,
  worktree: string,
  session: string | null
): Record<string, string | null> {
  return rememberIn(byWorktree, worktree, session, MAX_PLACES)
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
    // Each map defaulted on read rather than on write: a lane saved before it
    // existed is still a good lane, and refusing it would cost the user the
    // whole layout to gain one empty object.
    return {
      ...parsed,
      bySession: parsed.bySession ?? {},
      byProject: parsed.byProject ?? {},
      railByProject: parsed.railByProject ?? {},
      byWorktree: parsed.byWorktree ?? {}
    }
  } catch {
    // A corrupt lane is not worth a broken launch — start fresh.
    return null
  }
}

export function save(memory: Omit<LaneMemory, 'version'>): void {
  try {
    const panels = persistable(memory.lane.panels)
    // Clamped, because persisting drops panels: a focus that pointed at the
    // checklist — or past it — would come back on the next launch aimed at
    // nothing, and the first arrow key would jump somewhere arbitrary.
    const focus = Math.min(memory.lane.focus, Math.max(0, panels.length - 1))
    const lane = { ...memory.lane, panels, focus }
    localStorage.setItem(KEY, JSON.stringify({ version: VERSION, ...memory, lane }))
  } catch {
    /* private mode, or quota — the lane is a convenience, never a requirement */
  }
}
