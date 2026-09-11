// The `active` panel: every machine's most recent sessions in one list, so
// "which of these is waiting on me" is a question you ask once instead of once
// per project.
//
// The sidebar answers it for the worktree you are in; this answers it for
// everything you are not — including the machines you are not attached to.
import type { ReactNode } from 'react'
import { backendLabel, LOCAL } from './backends'
import { Spinner } from './Spinner'
import { markAll } from './findMark'
import { useActiveSessions } from './useActiveSessions'
import type { ActiveSession } from '../../shared/types'

/** How many rows the panel asks each machine for, and keeps after the merge. */
export const ACTIVE_LIMIT = 10

/**
 * Status first, recency inside it.
 *
 * Sorting by the clock alone answers "what happened last", which is not the
 * question — a session that has been blocked on you for twenty minutes belongs
 * above one that printed a line five seconds ago. The rows arrive newest-first,
 * so partitioning keeps that order inside each band for free.
 */
export function bandsOf(rows: ActiveSession[]): Array<{ label: string; rows: ActiveSession[]; ask?: boolean }> {
  const ask = rows.filter((s) => s.needsYou)
  const work = rows.filter((s) => !s.needsYou && s.running)
  const idle = rows.filter((s) => !s.needsYou && !s.running)
  return [
    { label: 'NEEDS YOU', rows: ask, ask: true },
    { label: 'WORKING', rows: work },
    { label: 'IDLE', rows: idle }
  ].filter((b) => b.rows.length > 0)
}

/**
 * Which panel key this session's chat opens under.
 *
 * The sidebar's rule, and it has to be the same one: a chat panel is keyed by
 * `claudeId ?? id` (see enterWorktree), so a row that handed over the Floe id
 * alone would open a SECOND panel for a conversation already on screen.
 */
export const sessionKeyOf = (s: ActiveSession): string => s.claudeId ?? s.sessionId

/** The sidebar's three marks, on a row that had to cross a machine to get here. */
function Mark({ session }: { session: ActiveSession }): ReactNode {
  if (session.needsYou)
    return (
      <span className="mark-ask" title="waiting for your answer">
        ?
      </span>
    )
  if (session.running) return <Spinner />
  return <span className="dot" />
}

function ago(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000))
  if (s < 60) return 'now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

export function ActiveSessionsList({
  openSession,
  onJump,
  find
}: {
  /** The session key the lane currently has open, so the row can say so. */
  openSession?: string
  onJump: (session: ActiveSession) => void
  find?: string
}): ReactNode {
  const { rows, loading, offline, reload } = useActiveSessions(ACTIVE_LIMIT)

  if (loading && !rows.length) return <p className="empty">Loading…</p>
  if (!rows.length && !offline.length) return <p className="empty">No sessions yet.</p>

  return (
    <>
      {bandsOf(rows).map((band) => (
        <div className="group" key={band.label}>
          <div className="group-label" data-ask={band.ask || undefined}>
            {band.label} <span className="group-n">{band.rows.length}</span>
          </div>
          {band.rows.map((s) => (
            <button
              className="sx"
              // A session id is unique per machine, not across them.
              key={`${s.backend ?? LOCAL}:${s.sessionId}`}
              title={`${s.worktreePath} · ${s.title}`}
              data-active={(sessionKeyOf(s) === openSession) || undefined}
              onClick={() => onJump(s)}
            >
              <span className="sx-top">
                <Mark session={s} />
                <span className="sx-name">{markAll(s.title, find)}</span>
                <span className="sx-age">{ago(s.lastActivityAt)}</span>
              </span>
              <span className="sx-bot">
                <span className="sx-where">
                  {markAll(s.projectName, find)} <span className="sx-sep">/</span>{' '}
                  {markAll(s.branch, find)}
                </span>
                {/* Local is the default and gets no badge — naming this machine
                    on every row answers nothing. The projects list's rule. */}
                {s.backend && s.backend !== LOCAL && (
                  <span className="sx-host">{backendLabel(s.backend)}</span>
                )}
              </span>
            </button>
          ))}
        </div>
      ))}
      {/* A machine that did not answer is named rather than counted: with one
          remote down the question is which one, and the list above is already
          usable. Same treatment the projects panel gives it. */}
      {offline.length > 0 && (
        <div className="remote-notes">
          {offline.map((b) => (
            <div className="remote-note" key={b.id}>
              <span className="remote-off">○</span>
              <span className="row-name">{b.label}</span>
              <span className="remote-why">offline</span>
              <button className="chip" onClick={() => reload()}>
                retry
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  )
}
