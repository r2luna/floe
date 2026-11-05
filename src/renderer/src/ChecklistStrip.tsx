import { useSyncExternalStore } from 'react'
import { checklistOpen, type ChecklistItem } from '../../shared/checklist'
import { isChecklistFolded, subscribeChecklistFold, toggleChecklistFold } from './checklistFold'
import { Spinner } from './Spinner'

// The agent's to-do list, pinned between the transcript and the composer: the
// transcript scrolls and the work it describes should not. Shown while there is
// anything left to do. A list finished in full leaves when the turn ends, and its
// updates stay in the transcript as ordinary tool rows.

/** How many rows a long list shows, so it can never push the chat off the panel. */
const WINDOW = 6

function Box({ item, running }: { item: ChecklistItem; running: boolean }) {
  return (
    <span className="cl-box" data-status={item.status}>
      {item.status === 'completed' && (
        <svg viewBox="0 0 10 10" aria-hidden>
          <path d="M1.5 5.5 4 8l4.5-6" />
        </svg>
      )}
      {item.status === 'in_progress' && running && <Spinner />}
      {item.status === 'cancelled' && <span className="cl-dash" />}
    </span>
  )
}

/** The rows on screen: the whole list, or a window that keeps the live step in view. */
function visibleRows(items: readonly ChecklistItem[]): { rows: readonly ChecklistItem[]; hidden: number } {
  if (items.length <= WINDOW) return { rows: items, hidden: 0 }
  const live = items.findIndex((item) => item.status === 'in_progress' || item.status === 'pending')
  const from = Math.min(Math.max(0, (live === -1 ? items.length : live) - 1), items.length - WINDOW)
  return { rows: items.slice(from, from + WINDOW), hidden: items.length - WINDOW }
}

export function ChecklistStrip({ items, running }: { items: readonly ChecklistItem[]; running: boolean }) {
  const folded = useSyncExternalStore(subscribeChecklistFold, isChecklistFolded)
  if (!items.length || (!running && !checklistOpen(items))) return null

  const done = items.filter((item) => item.status === 'completed').length
  const live = items.find((item) => item.status === 'in_progress')
  const next = items.find((item) => item.status === 'pending')
  const line = !running
    ? 'stopped'
    : live
      ? (live.active ?? live.text)
      : next
        ? `next: ${next.text}`
        : 'done'
  const { rows, hidden } = visibleRows(items)

  return (
    <div className="cl" data-checklist>
      <button
        className="cl-head"
        tabIndex={-1}
        aria-expanded={!folded}
        title="Fold or open the checklist"
        // The composer keeps the focus: folding this is not leaving what you were typing.
        onMouseDown={(event) => event.preventDefault()}
        onClick={toggleChecklistFold}
      >
        <span className="cl-mark">{folded ? '▸' : '▾'}</span>
        <span className="cl-segs" aria-hidden>
          {items.map((item, index) => (
            <span className="cl-seg" data-status={running ? item.status : stillStatus(item)} key={index} />
          ))}
        </span>
        <span className="cl-count">
          {done}/{items.length}
        </span>
        {(folded || !running) && <span className="cl-now">{line}</span>}
      </button>
      {!folded && (
        <ul className="cl-list">
          {rows.map((item, index) => (
            <li className="cl-item" data-status={item.status} key={item.id ?? `${index}:${item.text}`}>
              <Box item={item} running={running} />
              <span className="cl-text">
                {item.status === 'in_progress' ? (item.active ?? item.text) : item.text}
              </span>
            </li>
          ))}
          {hidden > 0 && <li className="cl-more">+{hidden} more</li>}
        </ul>
      )}
    </div>
  )
}

/** Motion means running: a stopped turn's live step stops pulsing and reads as pending. */
const stillStatus = (item: ChecklistItem): string =>
  item.status === 'in_progress' ? 'pending' : item.status
