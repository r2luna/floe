import type { Effort, PermissionMode, Query } from './types.ts'
import { isQueryKey, queryKey } from './queries.ts'

// The list transforms behind a session's queries. Kept pure and separate from
// sessionStore for the same reason threadComments.ts is: the semantics that
// actually matter — reopening the same harness twice is one query, closing one
// records HOW it closed — are testable with no filesystem and no electron.

/**
 * Open the query for this harness, or bring the one already open back.
 *
 * Reopening is not a second query. One harness is one side conversation per
 * session: the panel is titled by the harness, the key IS the harness, and two
 * entries under one key would leave whichever the list found second holding a
 * transcript the first one is also streaming into.
 *
 * A CLOSED one reopens in place — with its outcome cleared, because it is open
 * again — so the transcript it left behind is still its own.
 */
export function openQuery(
  list: Query[],
  q: {
    sessionId: string
    harness: string
    model?: string
    effort?: Effort
    mode: PermissionMode
    openedBy?: 'user' | 'agent'
    at?: number
  }
): Query[] {
  const id = queryKey(q.sessionId, q.harness)
  const at = q.at ?? Date.now()
  const found = list.find((x) => x.id === id)
  const next: Query = {
    ...found,
    id,
    sessionId: q.sessionId,
    harness: q.harness,
    model: q.model,
    effort: q.effort,
    mode: q.mode,
    openedAt: found?.openedAt ?? at,
    openedBy: q.openedBy ?? found?.openedBy,
    closedAt: undefined,
    outcome: undefined
  }
  return found ? list.map((x) => (x.id === id ? next : x)) : [...list, next]
}

/**
 * Mark a query as closed, and how.
 *
 * The entry stays. It is what draws the folded merge block and the dead discard
 * line in the chat, and it is what `reopen` reads — a closed query still owns
 * its transcript on disk. Dropping it is `dropQuery`, and only the caller that
 * has already cleaned up the transcript should be doing that.
 */
export function closeQuery(
  list: Query[],
  id: string,
  outcome: 'merged' | 'discarded',
  at = Date.now()
): Query[] {
  return list.map((q) => (q.id === id ? { ...q, closedAt: at, outcome } : q))
}

export function dropQuery(list: Query[], id: string): Query[] {
  return list.filter((q) => q.id !== id)
}

/** Record the CLI id this query's turn just reported, keeping the old trail. */
export function linkQuery(list: Query[], id: string, claudeId: string, cap = 20): Query[] {
  return list.map((q) => {
    if (q.id !== id || q.claudeId === claudeId) return q
    const past = q.claudeId
      ? [...(q.pastClaudeIds ?? []).filter((x) => x !== q.claudeId), q.claudeId].slice(-cap)
      : q.pastClaudeIds
    return { ...q, claudeId, pastClaudeIds: past }
  })
}

export const openQueries = (list: Query[]): Query[] => list.filter((q) => !q.closedAt)

// A query arrives from the renderer over IPC and is written into sessions.json,
// the store the whole app reads on every session switch — so this is a trust
// boundary and gets a shape check, exactly as isValidComment is one.
//
// The `id` is checked against the key its two halves make rather than merely
// being non-empty: every transform above keys on it, and an entry whose id does
// not match its own sessionId+harness is one that `openQuery` would never find
// again — a duplicate that can be created and then never closed.
export function isValidQuery(q: unknown): q is Query {
  if (!q || typeof q !== 'object') return false
  const x = q as Record<string, unknown>
  const str = (v: unknown): boolean => typeof v === 'string' && v.length > 0
  if (!str(x.sessionId) || !str(x.harness) || !str(x.id)) return false
  if (x.id !== queryKey(x.sessionId as string, x.harness as string)) return false
  if (!isQueryKey(x.id as string)) return false
  if (!str(x.mode)) return false
  if (!Number.isFinite(x.openedAt)) return false
  if (x.closedAt !== undefined && !Number.isFinite(x.closedAt)) return false
  if (x.outcome !== undefined && x.outcome !== 'merged' && x.outcome !== 'discarded') return false
  return true
}
