import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { PaletteItem } from './fuzzy'
import type { Trigger } from './trigger'
import { Composer } from './Composer'
import { Spinner } from './Spinner'
import { Log, TailEntry, TypingMeter } from './panels'
import { useTranscript } from './useTranscript'
import { answeringWho, lastSpeaker, whoOf } from './speakers'
import { speakerKey } from './models'
import { nickColor } from './nickColor'
import { DEFAULT_MODE } from '../../shared/modes'
import { parseQueryKey } from '../../shared/queries'

// The panel a query runs in.
//
// Almost none of this is new. A query is another agent key (shared/queries.ts),
// so `useTranscript(worktreePath, qkey)` hands over streaming, the "is typing"
// line, the queue, stop and the mid-turn replay exactly as the chat gets them —
// the same hook, pointed at a different string. What is actually different is
// small and all of it is here:
//
//  - no `@`. Who you are talking to IS the panel the cursor is in, so a handle
//    would be addressing the harness that is already answering. It only means
//    something in the main chat.
//  - no ⌘L. There is no previous message of yours to join onto.
//  - `plan`, always, said in the head as `ro`. See main/queries.ts.
//  - the three actions across the foot: merge, peek, discard.

export function QueryPanel({
  session,
  harness,
  menuItems,
  onCommand
}: {
  /** `id` is the QUERY key — `sess~codex`. See shared/queries.ts. */
  session: { id: string; worktreePath: string }
  /** Who answers here. The panel's `sub`, and half of its key. */
  harness: string
  menuItems?: (trigger: Trigger) => PaletteItem[]
  /**
   * Run a command by id — what the action chips dispatch.
   *
   * A chip must not contain behaviour: it runs the very command the key runs,
   * so the two cannot drift. Same rule as everywhere else in the app; see the
   * note at the top of commands.ts.
   */
  onCommand?: (id: string) => void
}) {
  const [text, setText] = useState('')
  const who = harness || parseQueryKey(session.id)?.harness || 'query'
  const {
    items,
    tail,
    loading,
    error,
    running,
    tokens,
    startedAt,
    queued,
    send,
    stop
  } = useTranscript(session.worktreePath, session.id)

  const bodyRef = useRef<HTMLDivElement>(null)
  // Follow the stream while you are at the end of it, and stop following the
  // moment you scroll up to re-read something. Same rule as the chat's, at a
  // fraction of the size: this panel is narrow and never paginates, so there is
  // no window to page backwards through.
  const pinned = useRef(true)
  const stick = (): void => {
    const el = bodyRef.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }
  useLayoutEffect(stick, [items, tail, running, queued])

  // Focus the composer when the panel arrives. A query opened by an agent puts
  // itself on screen, so this is also what makes it typeable without a click.
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    rootRef.current?.querySelector<HTMLTextAreaElement>('.composer-input')?.focus()
  }, [session.id])

  // One identity, or the Composer's pin effect re-runs on every render.
  const pin = useMemo(
    () => ({ provider: who, model: '', effort: 'medium' as const, mode: 'plan' as const }),
    [who]
  )

  const pending = useMemo(
    () => answeringWho(items, tail, { provider: who, model: '', effort: 'medium', mode: DEFAULT_MODE }),
    [items, tail, who]
  )

  return (
    <div className="query-panel" ref={rootRef} data-harness={who}>
      <div className="chat query-body" ref={bodyRef} onScroll={() => {
        const el = bodyRef.current
        if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 24
      }}>
        {loading && <div className="irc-sys">Reading the query…</div>}
        {error && (
          <div className="irc-sys" data-error>
            <span className="irc-star">***</span> {error}
          </div>
        )}
        {!loading && !error && !items.length && !tail && (
          <div className="irc-sys">
            <span className="irc-star">***</span> Nothing asked yet.
          </div>
        )}
        <Log items={items} cwd={session.worktreePath} pending={pending} />
        {tail && (
          <TailEntry item={tail} isNew={lastSpeaker(items, pending) !== speakerKey(whoOf(tail))} />
        )}
        {running && (
          <div className="irc-typing" data-live aria-live="polite">
            <span className="irc-nick" style={{ color: nickColor(who) }}>
              {who}
            </span>{' '}
            is typing
            <Spinner />
            <TypingMeter startedAt={startedAt} tokens={tokens} />
          </div>
        )}
        {queued.map((q) => (
          <div className="irc-queued" key={q.id}>
            <span className="irc-queued-mark">⟳</span>
            <span className="irc-queued-text">{q.shown ?? q.text}</span>
          </div>
        ))}
      </div>

      {/* The three ways this ends, as a band across the panel rather than three
          buttons parked in it — the same hairline, height and 11px column the
          header and the composer use, so the panel reads as one object with
          three edges instead of a box with widgets inside.
          Every one dispatches a command id rather than doing the work here: the
          band and the binding must be the same action, or the palette and the
          keyboard drift from the button. */}
      <div className="query-acts">
        <button className="query-act" onClick={() => onCommand?.('query.merge')}>
          merge <kbd>⌘⇧M</kbd>
        </button>
        <button className="query-act" onClick={() => onCommand?.('query.peek')}>
          peek <kbd>⌘⇧G</kbd>
        </button>
        <button className="query-act" data-tone="danger" onClick={() => onCommand?.('query.discard')}>
          discard <kbd>⌘⇧D</kbd>
        </button>
      </div>

      <Composer
        value={text}
        onChange={setText}
        historyKey={session.worktreePath}
        onSend={(choice, attached, message) => {
          pinned.current = true
          // No handle read here, on purpose: the panel IS the address. A line
          // opening with `@codex` inside the codex query is text, not routing.
          // `message` is the text with its collapsed pastes put back — see
          // pastes.ts. What is sent is never the rail.
          send(message ?? text, choice, attached?.images, attached?.files)
          setText('')
        }}
        // The mode is not the user's to change here — a query is read-only by
        // construction (D1/R5) — so it is pinned AND locked: the chip says
        // `plan` and the menu offers nothing else.
        pinned={pin}
        modeLocked
        onStop={running ? stop : undefined}
        placeholder={running ? 'Type while it works…' : 'Ask…'}
        menuItems={menuItems}
      />
    </div>
  )
}
