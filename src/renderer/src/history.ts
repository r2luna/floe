// What you've already sent, oldest first — the ↑/↓ history in the composer.
//
// One list per worktree, keyed by its path: a branch is one piece of work, and
// the line you reach for is the one you typed on this branch, not the one from
// whichever project you had open before it. A worktree path separates project
// and branch in a single key, so that is the key.

const KEY = 'floe.history'

// ponytail: 100 entries per worktree, across at most 40 worktrees, in
// localStorage. Move it to the store if it ever has to survive a cleared
// browser profile.
const MAX = 100
const MAX_SCOPES = 40

type Histories = Record<string, string[]>

/**
 * Every list, by worktree path.
 *
 * The pre-scope shape was a flat array of strings; it is dropped on sight
 * rather than migrated, because there is no worktree to file it under.
 */
function read(): Histories {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>)
        .filter(([, v]) => Array.isArray(v))
        .map(([k, v]) => [k, (v as unknown[]).filter((s): s is string => typeof s === 'string')])
    )
  } catch {
    return {}
  }
}

/**
 * What ↑ walks in `scope`.
 *
 * Without a scope there is no history — same rule as a draft with no key: there
 * is nowhere to file the text, and picking somewhere would hand it to whichever
 * composer opened next.
 */
export function readHistory(scope?: string): string[] {
  if (!scope) return []
  return read()[scope] ?? []
}

/** Append, oldest first. Exported for the test; `pushHistory` is the real door. */
export function push(list: string[], text: string): string[] {
  const entry = text.trim()
  // Nothing to recall in an empty message, and repeating the last one only
  // makes you press ↑ twice to get past it.
  if (!entry || entry === list[list.length - 1]) return list
  return [...list, entry].slice(-MAX)
}

/** Append to one worktree's list. Exported for the test; `pushHistory` is the real door. */
export function put(all: Histories, scope: string, text: string): Histories {
  const list = push(all[scope] ?? [], text)
  // Nothing was added — don't write, and don't let a blank ⏎ count as touching
  // this worktree.
  if (!list.length || list === all[scope]) return all
  // The touched worktree is re-inserted rather than updated in place, so it
  // becomes the newest key and eviction takes the one untouched for longest.
  const rest = { ...all }
  delete rest[scope]
  const keys = Object.keys(rest)
  for (const old of keys.slice(0, Math.max(0, keys.length + 1 - MAX_SCOPES))) delete rest[old]
  return { ...rest, [scope]: list }
}

export function pushHistory(text: string, scope?: string): void {
  if (!scope) return
  try {
    localStorage.setItem(KEY, JSON.stringify(put(read(), scope, text)))
  } catch {
    /* quota or private mode — history is a convenience, never a requirement */
  }
}
