// What the board did without being asked, above the nanny's chat.
//
// The nanny SAYS what happened; this is the record that it happened. They are
// not the same thing and must not look the same: her transcript is a
// conversation — she summarises, she is asked things out of order, her turn can
// fail — and none of that is allowed to be the only trace of a merge that
// landed on your base branch.
//
// So a row here has no nick, a rule down its left edge, and the verb first. And
// the one action the board takes that changes code outside a worktree carries
// its own way back out, on the row that did it.

import { useCallback, useEffect, useState } from 'react'
import type { BoardEvent } from '../../shared/colony'
import type { OpenFn } from './panels'
import { reason } from './ipcError'

/** How many rows the strip shows before it asks to be scrolled. */
const SHOWN = 40

/**
 * The three tones a row can carry.
 *
 * `land` is the only green: something is on base now that was not before.
 * `stop` is the accent, which everywhere else in this app means "this needs
 * you" — and a refused merge, a stopped lane and a card handed to a stage
 * nobody has are all exactly that. Everything else is plain, because a board
 * that shouted about every card passing a stage would be a board nobody reads.
 */
function toneOf(kind: BoardEvent['kind']): 'land' | 'stop' | undefined {
  if (kind === 'merged') return 'land'
  if (kind === 'refused' || kind === 'stopped' || kind === 'lost') return 'stop'
  return undefined
}

const VERB: Record<BoardEvent['kind'], string> = {
  passed: 'passed',
  merged: 'merged',
  refused: 'refused',
  released: 'released',
  stopped: 'stopped',
  lost: 'lost',
  cleaned: 'cleaned up'
}

const clock = (at: number): string =>
  new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })

export function ColonyLog({
  project,
  onEnterWorktree,
  onOpen
}: {
  project?: string
  /** How a row goes to the branch it is about. */
  onEnterWorktree?: (path: string, launcher?: boolean) => 'chat' | 'launcher' | 'none'
  /** The panel opener every panel body gets — how a row puts the diff on screen. */
  onOpen?: OpenFn
}) {
  const [events, setEvents] = useState<BoardEvent[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  // A refusal belongs on the row that was refused, not in a toast somewhere
  // else. "base has moved on since that merge" is only an answer while you can
  // still see which merge it is about.
  const [failed, setFailed] = useState<{ id: string; message: string } | null>(null)

  const load = useCallback((): void => {
    if (!project) return setEvents([])
    void window.floe.colony
      .events(project)
      .then(setEvents)
      .catch(() => setEvents([]))
  }, [project])

  useEffect(() => {
    load()
    // The board moves while nobody is looking at it — that is the entire point
    // of this panel — so the same push that repaints the board reloads the log.
    return window.floe.colony.onEvent((e) => {
      if (e.project === project) load()
    })
  }, [project, load])

  const act = (id: string, run: () => Promise<{ ok: boolean; message?: string }>): void => {
    setBusy(id)
    setFailed(null)
    void run()
      .then((r) => {
        if (!r.ok) setFailed({ id, message: r.message ?? 'That did not work.' })
        // No optimistic patch: main pushes `colony:event` on success and the
        // reload above is what redraws. One source for what the board says.
        load()
      })
      .catch((err: unknown) => setFailed({ id, message: reason(err) }))
      .finally(() => setBusy(null))
  }

  /**
   * Go to the branch a row is about.
   *
   * `enterWorktree` and not a new mechanism: it is the same move the worktree
   * list makes, so it brings the branch's own conversation back with it rather
   * than dropping you on an empty column.
   */
  const goTo = (event: BoardEvent, alsoChanges = false): void => {
    if (!event.worktreePath) return
    onEnterWorktree?.(event.worktreePath)
    // After the worktree has been entered, or the changes panel would open
    // against the branch you were on a moment ago.
    if (alsoChanges) setTimeout(() => onOpen?.({ kind: 'changes' }), 80)
  }

  if (!project) return null
  const shown = events.slice(Math.max(0, events.length - SHOWN))

  return (
    <div className="clog">
      <div className="clog-head">
        <span className="clog-title">board log</span>
        <span className="clog-sub">
          {shown.length ? `${shown.length} since you were last here` : 'nothing has happened on its own yet'}
        </span>
      </div>
      <div className="clog-body">
        {shown.map((event) => (
          <div key={event.id} className="clog-row" data-tone={toneOf(event.kind)}>
            <span className="clog-time">{clock(event.at)}</span>
            <span className="clog-text">
              <span className="clog-verb">{VERB[event.kind]}</span> ·{' '}
              <b>{event.taskName}</b> {event.text}
              {/* The way back out, on the row that did it. Only the actions that
                  are real — a dead link here would be worse than none, because
                  this is the panel whose whole job is being trustworthy. */}
              {event.kind === 'merged' && !event.undoneAt && event.baseBefore && (
                <span className="clog-acts">
                  <button
                    className="clog-act"
                    disabled={busy === event.id}
                    onClick={() => act(event.id, () => window.floe.colony.undoMerge(event.id))}
                  >
                    {busy === event.id ? 'putting it back…' : `undo — put ${event.base ?? 'base'} back`}
                  </button>
                </span>
              )}
              {event.kind === 'merged' && event.undoneAt && (
                <span className="clog-acts">
                  <span className="clog-done">undone at {clock(event.undoneAt)}</span>
                </span>
              )}
              {event.kind === 'refused' && (
                <span className="clog-acts">
                  <button
                    className="clog-act"
                    disabled={busy === event.id}
                    onClick={() => act(event.id, () => window.floe.colony.mergeTask(event.task))}
                  >
                    {busy === event.id ? 'merging…' : 'try the merge again'}
                  </button>
                  {/* The reason a merge refuses is almost always something left
                      uncommitted in the lane's tree, and the changes panel is
                      where you see it. Deliberately NOT offered on a merged row:
                      after a merge the branch and base agree, so that panel
                      would open empty and read as "nothing landed". */}
                  {event.worktreePath && (
                    <button className="clog-act" onClick={() => goTo(event, true)}>
                      show what is uncommitted
                    </button>
                  )}
                </span>
              )}
              {event.kind === 'released' && (
                <span className="clog-acts">
                  {/* The way out of an automatic release. A park, not an undo —
                      the tree stays, because cutting it was the expensive part
                      and a lane may already have run in it. */}
                  <button
                    className="clog-act"
                    disabled={busy === event.id}
                    onClick={() =>
                      act(event.id, () =>
                        window.floe.colony.hold(event.task).then(() => ({ ok: true }))
                      )
                    }
                  >
                    {busy === event.id ? 'holding…' : 'hold it again'}
                  </button>
                </span>
              )}
              {/* Every row that has a tree behind it can take you there. Last,
                  so the action specific to the row reads first. */}
              {event.worktreePath && event.kind !== 'refused' && (
                <span className="clog-acts">
                  <button className="clog-act" onClick={() => goTo(event)}>
                    go to {event.branch ?? 'the worktree'}
                  </button>
                </span>
              )}
              {failed?.id === event.id && <span className="clog-failed">{failed.message}</span>}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
