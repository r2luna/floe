// Which chats the `active` panel shows, and in what order.
//
// The panel is a switcher between the chats you are working on, so its rows
// must stay where they are: position comes from the project and the creation
// order, never from activity or status. The state lives in the mark.
//
// Membership is the user's, not the machine's, so it lives here in the renderer
// — localStorage, beside the lane and the unread marks (see laneStore.ts) — and
// the main process only answers with candidates (sessionIndex.activeSessions).
//
//  - A chat JOINS when you send to it (useTranscript's send).
//  - It LEAVES when it is closed (the machine stops returning it), when you
//    remove it (× or `x`), or after 24h idle. The idle sweep runs only while the
//    panel is off screen, so a row never vanishes in front of you.
//  - A favourite (`f`) never expires. It sits on top, in the same tree.
//  - A chat waiting on you shows whether or not it is a member.
//
// Keys are `${backend}:${id}` — a session id is unique per machine, not across
// them — and a session answers to two ids (Floe's and the claudeId), so a row
// matches a key under either.
import type { ActiveSession } from '../../shared/types'

const KEY = 'floe.active'

/** A chat with no activity for this long leaves the list (favourites excepted). */
export const IDLE_MS = 24 * 60 * 60_000

export interface ActiveState {
  /** Member key → when it last joined (ms). */
  members: Record<string, number>
  /** Starred keys, in starring order. */
  favorites: string[]
  /** Machines whose first answer already seeded the list. */
  seeded: string[]
}

const EMPTY: ActiveState = { members: {}, favorites: [], seeded: [] }

/** Every key a row answers to: Floe's id first, then the CLI's. */
export function keysOf(s: ActiveSession): string[] {
  const b = s.backend ?? 'local'
  return s.claudeId && s.claudeId !== s.sessionId
    ? [`${b}:${s.sessionId}`, `${b}:${s.claudeId}`]
    : [`${b}:${s.sessionId}`]
}

const backendOfKey = (key: string): string => key.slice(0, key.indexOf(':'))
const idOfKey = (key: string): string => key.slice(key.indexOf(':') + 1)

export const isMember = (st: ActiveState, s: ActiveSession): boolean =>
  keysOf(s).some((k) => k in st.members)

export const isFavorite = (st: ActiveState, s: ActiveSession): boolean =>
  keysOf(s).some((k) => st.favorites.includes(k))

/** You sent to it, or created it. */
export function join(st: ActiveState, key: string, now = Date.now()): ActiveState {
  return { ...st, members: { ...st.members, [key]: now } }
}

/** Off the list and off the favourites, under every name it has. */
export function leave(st: ActiveState, keys: readonly string[]): ActiveState {
  const members = { ...st.members }
  for (const k of keys) delete members[k]
  return { ...st, members, favorites: st.favorites.filter((k) => !keys.includes(k)) }
}

/**
 * Star or unstar. A star is also membership, so unstarring puts the row back in
 * its project group instead of taking it off the list.
 */
export function toggleFavorite(st: ActiveState, keys: readonly string[], now = Date.now()): ActiveState {
  if (keys.some((k) => st.favorites.includes(k)))
    return { ...st, favorites: st.favorites.filter((k) => !keys.includes(k)) }
  return { ...join(st, keys[0], now), favorites: [...st.favorites, keys[0]] }
}

/**
 * First answer from a machine: everything it touched in the last day joins, so
 * the panel does not open empty the first time.
 */
export function seed(st: ActiveState, backend: string, rows: ActiveSession[], now = Date.now()): ActiveState {
  if (st.seeded.includes(backend)) return st
  const members = { ...st.members }
  for (const s of rows)
    if (now - s.lastActivityAt < IDLE_MS && !keysOf(s).some((k) => k in members))
      members[keysOf(s)[0]] = s.lastActivityAt
  return { ...st, members, seeded: [...st.seeded, backend] }
}

/**
 * The 24h sweep, for one machine's members. A member's last activity is the
 * later of when it joined and what the machine last reported; a running turn is
 * activity now.
 */
export function expire(st: ActiveState, backend: string, rows: ActiveSession[], now = Date.now()): ActiveState {
  const seen = new Map<string, number>()
  for (const s of rows) for (const k of keysOf(s)) seen.set(k, s.running ? now : s.lastActivityAt)
  const members = { ...st.members }
  let changed = false
  for (const [k, at] of Object.entries(st.members)) {
    if (backendOfKey(k) !== backend || st.favorites.includes(k)) continue
    if (now - Math.max(at, seen.get(k) ?? 0) < IDLE_MS) continue
    delete members[k]
    changed = true
  }
  return changed ? { ...st, members } : st
}

/** The ids to ask one machine for: its members and favourites, by any name. */
export function idsFor(st: ActiveState, backend: string): string[] {
  const keys = new Set([...Object.keys(st.members), ...st.favorites])
  return [...keys].filter((k) => backendOfKey(k) === backend).map(idOfKey)
}

/**
 * A chat that was asked for by id and did not come back was closed: it leaves.
 * `asked` is the id list the answer was for — a key that joined while the
 * request was in flight was not part of the question.
 */
export function prune(st: ActiveState, backend: string, asked: readonly string[], rows: ActiveSession[]): ActiveState {
  const found = new Set(rows.flatMap(keysOf))
  const gone = asked.map((id) => `${backend}:${id}`).filter((k) => !found.has(k))
  return gone.length ? leave(st, gone) : st
}

/** One worktree's chats, under a header of its own. */
export interface ActiveWorktree {
  key: string
  branch: string
  /** The project's own checkout, which the header labels "main". */
  main: boolean
  rows: ActiveSession[]
}

export interface ActiveGroup {
  key: string
  project: string
  backend: string
  worktrees: ActiveWorktree[]
}

/** Favourites and the rest, both as the same project → worktree → chat tree. */
export interface ActiveLayout {
  favorites: ActiveGroup[]
  groups: ActiveGroup[]
}

/** A worktree that is not the project's own checkout — its branch is worth naming. */
export const onWorktree = (s: ActiveSession): boolean => s.worktreePath !== s.projectPath

/**
 * One row per session. A project registered at another project's worktree
 * lists that repo's worktrees too, so the same chat arrives under both; the
 * project whose folder holds the worktree is the one it belongs to.
 */
function dedupe(rows: ActiveSession[]): ActiveSession[] {
  const owns = (s: ActiveSession): boolean =>
    s.worktreePath === s.projectPath || s.worktreePath.startsWith(s.projectPath + '/')
  const out = new Map<string, ActiveSession>()
  for (const s of rows) {
    const k = keysOf(s)[0]
    const had = out.get(k)
    if (!had || (!owns(had) && owns(s))) out.set(k, s)
  }
  return [...out.values()]
}

/**
 * Projects A→Z; inside each, the main checkout first and the other worktrees
 * A→Z by branch; inside each worktree, chats in creation order. Every worktree
 * gets its header even when it is the only one, so a second worktree joining
 * adds a header instead of reshaping the group.
 */
function tree(rows: ActiveSession[]): ActiveGroup[] {
  const groups = new Map<string, ActiveGroup>()
  for (const s of rows) {
    const backend = s.backend ?? 'local'
    const key = `${backend}:${s.projectPath}`
    const g = groups.get(key) ?? { key, project: s.projectName, backend, worktrees: [] }
    groups.set(key, g)
    const wkey = `${key}:${s.worktreePath}`
    let w = g.worktrees.find((x) => x.key === wkey)
    if (!w) {
      w = { key: wkey, branch: s.branch, main: !onWorktree(s), rows: [] }
      g.worktrees.push(w)
    }
    w.rows.push(s)
  }
  const created = (s: ActiveSession): number => s.createdAt ?? 0
  const out = [...groups.values()].sort(
    (a, b) => a.project.localeCompare(b.project) || a.backend.localeCompare(b.backend)
  )
  for (const g of out) {
    g.worktrees.sort((a, b) => Number(b.main) - Number(a.main) || a.branch.localeCompare(b.branch))
    for (const w of g.worktrees)
      w.rows.sort((a, b) => created(a) - created(b) || a.sessionId.localeCompare(b.sessionId))
  }
  return out
}

/**
 * Favourites first, then everything else, both as the same tree. A favourite
 * leaves the lower tree, so it never shows twice. Nothing here reads the clock
 * or the status.
 */
export function arrange(all: ActiveSession[], st: ActiveState): ActiveLayout {
  const rows = dedupe(all)
  const favorites = rows.filter((s) => isFavorite(st, s))
  const rest = rows.filter((s) => !favorites.includes(s) && (s.needsYou || isMember(st, s)))
  return { favorites: tree(favorites), groups: tree(rest) }
}

// --- the store -----------------------------------------------------------------

function load(): ActiveState | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw == null) return null
    const p = JSON.parse(raw) as Partial<ActiveState>
    return {
      members: p.members && typeof p.members === 'object' ? p.members : {},
      favorites: Array.isArray(p.favorites) ? p.favorites.filter((k) => typeof k === 'string') : [],
      seeded: Array.isArray(p.seeded) ? p.seeded.filter((k) => typeof k === 'string') : []
    }
  } catch {
    // No localStorage (a plain `node --test` run) or unparseable JSON.
    return null
  }
}

function save(st: ActiveState): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(st))
  } catch {
    /* quota or private mode — the list rebuilds from the next sends */
  }
}

// Lazy, never at module scope: the registry imports this, and a `node --test`
// process has no localStorage.
let state: ActiveState | null = null
const listeners = new Set<() => void>()

export function activeState(): ActiveState {
  return (state ??= load() ?? EMPTY)
}

export function subscribeActive(fn: () => void): () => void {
  listeners.add(fn)
  return () => void listeners.delete(fn)
}

/** Apply a change; an unchanged state (same object) writes nothing. */
export function updateActive(fn: (st: ActiveState) => ActiveState): void {
  const prev = activeState()
  const next = fn(prev)
  if (next === prev) return
  state = next
  save(next)
  for (const l of listeners) l()
}

/** For tests: forget everything. */
export function resetActive(): void {
  state = null
}
