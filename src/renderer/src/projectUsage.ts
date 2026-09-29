// How many times you have switched to each project, so "Switch project…" can
// put the ones you use most at the top.
//
// Kept in localStorage, beside the unread marks: the order is only useful if it
// survives a restart. Keyed by project path, which is the id the palette uses.

const KEY = 'floe.projectUsage'

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
let counts: Record<string, number> | null = null

/** One more switch to this project. */
export function noteProjectUse(path: string): void {
  const next = { ...(counts ??= load()) }
  next[path] = (next[path] ?? 0) + 1
  counts = next
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    /* quota or private mode — the order is a convenience, never a requirement */
  }
}

/**
 * Most used first. Stable, so projects with the same count keep the order they
 * were given in — the user's own arrangement from projects.json.
 */
export function byUsage<T>(items: readonly T[], pathOf: (item: T) => string): T[] {
  const c = (counts ??= load())
  return [...items].sort((a, b) => (c[pathOf(b)] ?? 0) - (c[pathOf(a)] ?? 0))
}

/** For tests: forget every count. */
export function resetProjectUsage(): void {
  counts = {}
}
