import { useLayoutEffect, useMemo, useRef } from 'react'
import { Spinner } from './Spinner'
import { Log, TailEntry, TypingMeter } from './panels'
import { useTranscript } from './useTranscript'
import { answeringWho, lastSpeaker, whoOf } from './speakers'
import { speakerKey } from './models'
import { nickColor } from './nickColor'
import { DEFAULT_MODE } from '../../shared/modes'

/**
 * What one subagent is doing, live, beside the chat that set it running.
 *
 * A lane is an ordinary session, so this is `useTranscript` pointed at its key —
 * the same hook the chat and the query panel use, and the reason none of the
 * streaming, replay or "is typing" is written twice.
 *
 * What it does NOT have is a composer, and that is the whole design. The parent
 * owns this conversation: it wrote the brief, it gets the report back, and it
 * decides whether to say anything else (`send_message`). A second person typing
 * into a lane mid-turn is how you get two turns in one session, which is the one
 * thing the queue exists to prevent. Typing at it is still one keystroke away —
 * `⏎` on the row opens the lane as a full chat, composer and all.
 */
export function LanePanel({
  session,
  title,
  onOpen
}: {
  /** The subagent's session key — `claudeId ?? id`, the same one the sidebar uses. */
  session: { id: string; worktreePath: string }
  /** The lane's name: the deliverable its parent handed it. */
  title: string
  /** Promote to a full chat — the read-only panel's one way out. */
  onOpen?: () => void
}) {
  const { items, tail, loading, error, running, tokens, startedAt } = useTranscript(
    session.worktreePath,
    session.id
  )

  const bodyRef = useRef<HTMLDivElement>(null)
  // Always following, unlike the chat's conditional stick: you open a lane to
  // watch it work, and a panel that stopped at the line you were reading when
  // you opened it would be showing you the past.
  const pinned = useRef(true)
  useLayoutEffect(() => {
    const el = bodyRef.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [items, tail, running])

  const who = 'agent'
  const pending = useMemo(
    () => answeringWho(items, tail, { provider: who, model: '', effort: 'medium', mode: DEFAULT_MODE }),
    [items, tail]
  )

  return (
    <div className="query-panel lane-panel">
      {/* Who this is and whether it is still going. The chip row a query wears
          says which harness answers; a lane's question is narrower — it is
          always work, and the only thing you came to find out is whether it is
          still moving. */}
      <div className="lane-head">
        {running ? <Spinner /> : <span className="ag-dot">◇</span>}
        <span className="lane-title">{title}</span>
        {running && <TypingMeter startedAt={startedAt} tokens={tokens} />}
      </div>

      <div
        className="chat query-body"
        ref={bodyRef}
        onScroll={() => {
          const el = bodyRef.current
          if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 24
        }}
      >
        {loading && <div className="irc-sys">Reading the lane…</div>}
        {error && (
          <div className="irc-sys" data-error>
            <span className="irc-star">***</span> {error}
          </div>
        )}
        {!loading && !error && !items.length && !tail && (
          <div className="irc-sys">
            <span className="irc-star">***</span> Nothing yet.
          </div>
        )}
        <Log items={items} cwd={session.worktreePath} pending={pending} />
        {tail && (
          <TailEntry item={tail} isNew={lastSpeaker(items, pending) !== speakerKey(whoOf(tail))} />
        )}
        {running && (
          <div className="irc-typing" data-live aria-live="polite">
            <span className="irc-nick" style={{ color: nickColor(who) }}>
              {title}
            </span>{' '}
            is typing
            <Spinner />
            <TypingMeter startedAt={startedAt} tokens={tokens} />
          </div>
        )}
      </div>

      {/* The one edge this panel has. Same band as the query's actions, because
          it is the same kind of thing: what you can do to the conversation you
          are looking at, at the weight of the header. */}
      <div className="query-acts">
        <button className="query-act" onClick={onOpen}>
          open as chat
        </button>
      </div>
    </div>
  )
}
