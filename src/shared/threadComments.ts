import type { ThreadComment } from './types.ts'

// The list transforms behind a session's anchored notes. Kept pure and separate
// from sessionStore so the semantics that actually matter can be tested without
// a filesystem or an electron `app` — the store just reads, calls one of these,
// and writes.

// Add a note, or replace one that already carries the same id. Replace rather
// than append: the composer re-saves the same note while the user edits it, and
// appending would leave a trail of stale duplicates all anchored to one passage.
export function upsertComment(list: ThreadComment[], c: ThreadComment): ThreadComment[] {
  return [...list.filter((x) => x.id !== c.id), c]
}

export function dropComment(list: ThreadComment[], id: string): ThreadComment[] {
  return list.filter((c) => c.id !== id)
}

// Stamp the named notes as sent. Everything stays in the list — this is the one
// place the thread review deliberately diverges from submitReview() and
// submitPlanReview(), which both clear their pending list once it's been sent.
// Here the note remains anchored as the visible record of the review.
export function stampSent(list: ThreadComment[], ids: string[], at: number): ThreadComment[] {
  if (ids.length === 0) return list
  const target = new Set(ids)
  return list.map((c) => (target.has(c.id) ? { ...c, sentAt: at } : c))
}

// A note arrives from the renderer over IPC and is written straight into
// sessions.json — the store the whole app reads on every session switch — so
// this is a trust boundary and gets a shape check.
//
// Two failures make it worth rejecting rather than repairing. A note with no
// `id` slips past `upsertComment`'s filter, appends, and can then never be
// removed: every transform above keys on the id. And unbounded `body`/`quote`
// let one session bloat the file for all of them. A malformed note means a
// renderer bug, and quietly storing a patched-up version would hide it.
const MAX_TEXT = 20_000

export function isValidComment(c: unknown): c is ThreadComment {
  if (!c || typeof c !== 'object') return false
  const x = c as Record<string, unknown>
  const text = (v: unknown, min: number): boolean =>
    typeof v === 'string' && v.length >= min && v.length <= MAX_TEXT
  const offset = (v: unknown): boolean => Number.isInteger(v) && (v as number) >= 0
  return (
    text(x.id, 1) &&
    text(x.sessionKey, 1) &&
    offset(x.itemIndex) &&
    offset(x.start) &&
    offset(x.end) &&
    (x.start as number) <= (x.end as number) &&
    text(x.body, 1) &&
    text(x.quote, 0) &&
    (x.sentAt === undefined || Number.isFinite(x.sentAt))
  )
}

// Whether a note still points at the text it was written about. The transcript
// is append-only so this normally holds, but a note taken mid-stream can be
// anchored to a block that was still growing. When it drifts the caller shows
// the note unattached instead of highlighting the wrong passage.
export function anchorHolds(c: ThreadComment, blockText: string): boolean {
  return blockText.slice(c.start, c.end) === c.quote
}
