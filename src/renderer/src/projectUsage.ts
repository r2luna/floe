// When you last switched to each project, so "Switch project…" can put the
// ones you used most recently at the top.
//
// Kept in localStorage, beside the unread marks: the order is only useful if it
// survives a restart. Keyed by project path, which is the id the palette uses.
// The value is a sequence number, not a clock reading: higher means more
// recent, and two switches in the same millisecond still order correctly.

const KEY = 'floe.projectRecent'

function load(): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, number> = {}
    for (const [k, v] of Object.entries(parsed)) if (typeof v === 'number') out[k] = v
    return out
  } catch {
    // No localStorage at all (a plain `node --test` run) or unparseable JSON.
    return {}
  }
}

// Lazy, for the same reason as unreadStore.ts: a `node --test` process has no
// localStorage at import time.
let seen: Record<string, number> | null = null

/** This project is now the most recently used one. */
export function noteProjectUse(path: string): void {
  const prev = (seen ??= load())
  const next = { ...prev, [path]: Math.max(0, ...Object.values(prev)) + 1 }
  seen = next
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    /* quota or private mode — the order is a convenience, never a requirement */
  }
}

/**
 * Most recently used first. Stable, so projects never switched to keep the
 * order they were given in — the user's own arrangement from projects.json.
 */
export function byUsage<T>(items: readonly T[], pathOf: (item: T) => string): T[] {
  const s = (seen ??= load())
  return [...items].sort((a, b) => (s[pathOf(b)] ?? 0) - (s[pathOf(a)] ?? 0))
}

/** For tests: forget every switch. */
export function resetProjectUsage(): void {
  seen = {}
}
