// The unread marks on chats, in one module.
//
// A module store rather than React state because the mark now has two writers
// that never meet: the agent stream (a turn ended while you were elsewhere —
// useRunning.ts) and the user (`u` on a row, "read later" — registry.ts). A
// `useState` inside the hook is reachable by neither the command registry nor a
// second mount of the hook, and two copies of a persisted set is two answers.
//
// Kept in localStorage, beside the drafts and the lane: a reply that landed
// before you quit is still unread when you come back, and a chat you put aside
// on purpose is still put aside.

const KEY = 'floe.unread'

// ponytail: 200 keys, oldest dropped. Reading one removes it, so this only
// fills up if you leave 200 sessions unopened.
const MAX = 200

function load(): Set<string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    return new Set(
      Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string') : []
    )
  } catch {
    // No localStorage at all (a plain `node --test` run) or unparseable JSON.
    return new Set()
  }
}

function save(keys: Set<string>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify([...keys].slice(-MAX)))
  } catch {
    /* quota or private mode — a mark is a convenience, never a requirement */
  }
}

// Lazy, and never at module scope: this file is imported by the registry, which
// a plain `node --test` process loads with no localStorage in sight.
let marks: Set<string> | null = null

const listeners = new Set<() => void>()

/**
 * The current set, by identity — the snapshot `useSyncExternalStore` compares.
 *
 * Every mutation below replaces it rather than editing in place, so an
 * unchanged set is the same object and the list does not re-render.
 */
export function unreadMarks(): ReadonlySet<string> {
  return (marks ??= load())
}

export function subscribeUnread(fn: () => void): () => void {
  listeners.add(fn)
  return () => void listeners.delete(fn)
}

function commit(next: Set<string>): void {
  marks = next
  save(next)
  for (const fn of listeners) fn()
}

/**
 * The chat whose mark must survive being open.
 *
 * Marking the chat you are LOOKING AT as unread is the whole "read it later"
 * gesture, and `readOpen` below exists to wipe exactly that — the mark on the
 * open chat. So a hand mark on the open chat is held: `readOpen` skips it until
 * you actually go somewhere else, which is also what makes it survive a remount
 * of the list (same open chat, so the same skip).
 */
let held = new Set<string>()

/** Whether any of a session's names carries a mark — a session has two. */
export function isUnread(keys: readonly string[]): boolean {
  const set = unreadMarks()
  return keys.some((k) => set.has(k))
}

/**
 * Mark unread. `open` says the target is the chat on screen right now, which is
 * what puts the mark on hold — see `held`.
 */
export function markUnread(keys: readonly string[], opts?: { open?: boolean }): void {
  const set = unreadMarks()
  if (opts?.open) held = new Set(keys)
  if (keys.every((k) => set.has(k))) return
  const next = new Set(set)
  for (const k of keys) next.add(k)
  commit(next)
}

/** Clear the mark under every name a session answers to. */
export function markRead(keys: readonly string[]): void {
  const set = unreadMarks()
  if (keys.some((k) => held.has(k))) held = new Set()
  if (!keys.some((k) => set.has(k))) return
  const next = new Set(set)
  for (const k of keys) next.delete(k)
  commit(next)
}

/**
 * Opening a chat IS reading it — the only way to read one.
 *
 * Same as `markRead`, except it respects the hold: the mark you just put on the
 * chat in front of you is not one you failed to read. Going anywhere else drops
 * the hold, so coming back clears the mark the way opening always does.
 */
export function readOpen(keys: readonly string[]): void {
  if (!keys.length) return
  if (keys.some((k) => held.has(k))) return
  held = new Set()
  markRead(keys)
}

/** For tests: forget everything, marks and hold alike. */
export function resetUnread(): void {
  held = new Set()
  commit(new Set())
}
