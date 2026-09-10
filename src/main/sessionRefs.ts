// Turning `#some-session` into the session it names.
//
// The composer's `#` menu writes a TITLE, because that is what a person knows a
// session by. Nothing downstream can act on a title: the MCP tools take an id,
// and what "ask it" means depends on which harness answers there. This is the
// lookup between the two — see shared/sessionRefs.ts for the block it feeds and
// why the reference expands at all.
//
// Every created session is a candidate, not just this worktree's: the menu
// offers the whole project, so a reference to a session on another branch has
// to resolve or the menu would be writing dead tokens.

import { sessionSlug, type SessionRef } from '../shared/sessionRefs'
import { getAllCreatedSessions, getSessionMeta, type CreatedSession } from './sessionStore'
import { sessionTitle } from './claudeSessions'
import { projectFor } from './config/projectStore'

/** Recency, on the same terms the sidebar uses: last turn, else creation. */
const usedAt = (c: CreatedSession): number => c.usedAt ?? c.createdAt

/**
 * The session a slug names, or null.
 *
 * Two sessions can carry the same title — the menu shows one row for them,
 * because one row is all you can pick. So the tie is broken here, and broken
 * the way the person meant it: one in the project you are writing from beats
 * one somewhere else, and among those, the one used most recently. Guessing is
 * unavoidable at this point; guessing the same way twice is not.
 */
export function resolveSessionRef(slug: string, worktreePath: string): SessionRef | null {
  const project = projectFor(worktreePath)
  const meta = getSessionMeta()
  const found = getAllCreatedSessions()
    .map((c) => ({ c, title: sessionTitle(c, meta) }))
    .filter((m) => sessionSlug(m.title) === slug)
    .sort((a, b) => {
      const near = Number(projectFor(b.c.worktreePath) === project) - Number(projectFor(a.c.worktreePath) === project)
      return near || usedAt(b.c) - usedAt(a.c)
    })[0]
  if (!found) return null
  return {
    id: found.c.id,
    // Absent means Claude — the same reading sessionStore documents for a
    // session opened before the harness was recorded.
    harness: found.c.provider ?? 'claude',
    title: found.title,
    worktreePath: found.c.worktreePath
  }
}
