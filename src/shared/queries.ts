// The name a query answers to.
//
// A query is a side conversation opened off a session — `@codex analisa isso`
// while Claude is mid-turn — and the insight that makes it cheap is that the
// whole main process is already indexed by a plain string: the conns, the
// active turns, the threads, the handoff watermarks, the replays, the seq
// counters, the turn log. None of them care what the string MEANS.
//
// So a query is just another agent key. `sess~codex` runs beside `sess` with no
// structure anywhere changing shape, and `useTranscript(worktreePath, qkey)` in
// the renderer gives the panel streaming, "is typing", the queue, stop and
// replay for free.
//
// The separator has to be a character that cannot occur inside a session id.
// Floe mints UUIDs and `claude:<uuid>`; the CLI mints UUIDs. `~` appears in
// neither, and it is not a shell or path metacharacter in the places these keys
// are written to disk (the turn log names a file after the key).

export const QUERY_SEP = '~'

/** What the query off `sessionId` answering as `harness` is called. */
export function queryKey(sessionId: string, harness: string): string {
  return `${sessionId}${QUERY_SEP}${harness}`
}

/**
 * The session and harness behind a query key, or null for anything else.
 *
 * Split at the LAST separator, so the parent side is whatever came before it.
 * A key with more than one is not something this app can mint — a query cannot
 * open a query (see turn.ts) — but reading it as "the last segment is the
 * harness" is the reading that degrades safely if one ever appears.
 */
export function parseQueryKey(key: string): { sessionId: string; harness: string } | null {
  const at = key.lastIndexOf(QUERY_SEP)
  if (at <= 0) return null
  const sessionId = key.slice(0, at)
  const harness = key.slice(at + 1)
  // Slug-shaped, like the handle that named it (shared/mentions.ts). Anything
  // else is a session id that happens to hold a `~`, not a query.
  if (!sessionId || !/^[a-z0-9][a-z0-9-]*$/.test(harness)) return null
  return { sessionId, harness }
}

export function isQueryKey(key: string): boolean {
  return parseQueryKey(key) !== null
}

/** The session a key belongs to: itself, or the parent it was opened from. */
export function parentKeyOf(key: string): string {
  return parseQueryKey(key)?.sessionId ?? key
}
