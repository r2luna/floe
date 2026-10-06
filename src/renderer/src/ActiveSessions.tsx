// The `active` panel: a switcher between the chats you are working on, across
// every project on every attached machine.
//
// Rows never move on their own. Favourites sit on top; they and the rest share
// one shape — project A→Z, then worktree, then chats in creation order. What a
// chat is doing is shown by its mark alone — see activeStore.ts for who is on
// the list.
import { Fragment, useState, useSyncExternalStore, type ReactNode } from 'react'
import { backendLabel, currentBackend, LOCAL } from './backends'
import { Spinner } from './Spinner'
import { markAll } from './findMark'
import { IconBookmark, IconGitBranch } from './icons'
import { RowMenu, type MenuAction } from './RowMenu'
import { useActiveSessions } from './useActiveSessions'
import { arrange, isFavorite, keysOf, leave, updateActive, type ActiveGroup } from './activeStore'
import { isUnread, subscribeUnread, unreadMarks } from './unreadStore'
import type { ActiveSession } from '../../shared/types'

/**
 * Which panel key this session's chat opens under.
 *
 * The sidebar's rule, and it has to be the same one: a chat panel is keyed by
 * `claudeId ?? id` (see enterWorktree), so a row that handed over the Floe id
 * alone would open a SECOND panel for a conversation already on screen.
 */
export const sessionKeyOf = (s: ActiveSession): string => s.claudeId ?? s.sessionId

/** Waiting on you, working, unread, seen — the sidebar's marks, in that order. */
function Mark({ session }: { session: ActiveSession }): ReactNode {
  if (session.needsYou)
    return (
      <span className="mark-ask" title="waiting for your answer">
        ?
      </span>
    )
  if (session.running) return <Spinner />
  const ids = [session.sessionId, session.claudeId].filter(Boolean) as string[]
  if (isUnread(ids)) return <span className="dot dot-unread" title="done, unread" />
  return <span className="dot" />
}

export function ActiveSessionsList({
  openSession,
  onJump,
  onCommand,
  find
}: {
  /** The session key the lane currently has open, so the row can say so. */
  openSession?: string
  onJump: (session: ActiveSession) => void
  onCommand?: (id: string) => void
  find?: string
}): ReactNode {
  const { rows, membership, loading, offline, reload } = useActiveSessions()
  // The marks re-render the list; the value itself is read inside Mark.
  useSyncExternalStore(subscribeUnread, unreadMarks)
  const [menu, setMenu] = useState<{ x: number; y: number; row: HTMLElement } | null>(null)

  if (loading && !rows.length) return <p className="empty">Loading…</p>
  const { favorites, groups } = arrange(rows, membership)
  if (!favorites.length && !groups.length && !offline.length)
    return <p className="empty">No chats yet — send a message and it shows up here.</p>

  const here = currentBackend()
  const isOpen = (s: ActiveSession): boolean =>
    !!openSession &&
    (s.backend ?? LOCAL) === here &&
    (s.sessionId === openSession || s.claudeId === openSession)

  const row = (s: ActiveSession): ReactNode => {
    const keys = keysOf(s)
    const fav = isFavorite(membership, s)
    return (
      <button
        className="ax"
        key={keys[0]}
        title={`${s.worktreePath} · ${s.title}`}
        // What `f`, `x` and the row menu read — see activeRow in registry.ts.
        data-active-key={keys[0]}
        data-active-keys={keys.join(' ')}
        data-active-fav={fav ? 'on' : undefined}
        data-open={isOpen(s) || undefined}
        onClick={() => onJump(s)}
        // Focus first: the menu's commands act on the row the cursor is on.
        onContextMenu={(e) => {
          e.preventDefault()
          const el = e.currentTarget as HTMLElement
          el.focus()
          setMenu({ x: e.clientX, y: e.clientY, row: el })
        }}
      >
        <Mark session={s} />
        <span className="ax-name">{markAll(s.title, find)}</span>
        {fav && (
          <span className="skill-fav ax-fav" title="Favourite">
            <IconBookmark size={11} />
          </span>
        )}
        {/* Hover only, and a span rather than a button: `x` is the keyboard
            way, and a button here would be a second cursor stop per row. */}
        <span
          className="ax-x"
          title="Remove from the list (x)"
          onClick={(e) => {
            e.stopPropagation()
            updateActive((st) => leave(st, keys))
          }}
        >
          ×
        </span>
      </button>
    )
  }

  const group = (g: ActiveGroup): ReactNode => (
    <div className="ax-project" key={g.key}>
      <div className="ax-head">
        <span>{markAll(g.project, find)}</span>
        {g.backend !== LOCAL && <span className="sx-host">{backendLabel(g.backend)}</span>}
      </div>
      {g.worktrees.map((w) => (
        <Fragment key={w.key}>
          <div className="ax-wt">
            <IconGitBranch size={10} />
            <span className="ax-branch">{markAll(w.branch, find)}</span>
            {w.main && <span className="ax-main">main</span>}
          </div>
          {w.rows.map(row)}
        </Fragment>
      ))}
    </div>
  )

  const items: MenuAction[] = [
    { label: 'Open', keys: '⏎', run: () => menu?.row.click() },
    {
      label: menu?.row.dataset.activeFav === 'on' ? 'Unfavourite' : 'Favourite',
      keys: 'f',
      run: () => onCommand?.('active.favorite')
    },
    { label: 'Remove from the list', keys: 'x', run: () => onCommand?.('active.remove') }
  ]

  return (
    <div className="ax-list">
      {favorites.length > 0 && (
        <div className="ax-group" data-fav>
          <div className="group-label">FAVORITES</div>
          {favorites.map(group)}
        </div>
      )}
      {groups.map(group)}
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
      {menu && (
        <RowMenu
          at={menu}
          items={items}
          onClose={() => {
            const back = menu.row
            setMenu(null)
            if (back.isConnected) back.focus()
          }}
        />
      )}
    </div>
  )
}
