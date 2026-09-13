import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { AgentEvent, AgentEventEnvelope, NotifySoundId } from '../../shared/types'
import { isQueryKey } from '../../shared/queries.ts'
import { playDoneSound } from './sounds.ts'
import { markUnread, readOpen, subscribeUnread, unreadMarks } from './unreadStore.ts'
import { subscribeTurns } from './activeTurns.ts'

// How long an event-driven `busy` entry is trusted over the server's answer. A
// poll in flight when a turn starts would otherwise erase the spinner it raced:
// the reply was assembled before the turn existed. Anything quieter than this
// the server knows better than we do.
const GRACE_MS = 5_000

/**
 * The set the next tick should hold: the server's answer, plus the keys whose
 * last event is too recent for a poll that started earlier to have seen.
 *
 * Pure so the race is testable, and used for BOTH live sets. Each was
 * event-driven only, and each had the same hole: an edge that never arrived
 * (a crashed child, a reload mid-turn, an event tagged with the session's other
 * key) left the mark on with nothing to turn it off — a session spinning until
 * the app quit, or a `?` on a question that was answered ten minutes ago.
 */
export function reconcileLive(
  prev: Set<string>,
  serverKeys: string[],
  lastEventAt: Map<string, number>,
  now: number
): Set<string> {
  const next = new Set(serverKeys)
  for (const key of prev) {
    if (next.has(key)) continue
    if (now - (lastEventAt.get(key) ?? 0) < GRACE_MS) next.add(key)
  }
  // Same membership: hand back the old set so the list does not re-render.
  if (next.size === prev.size && [...next].every((k) => prev.has(k))) return prev
  return next
}

export interface SessionActivity {
  /** Sessions with a turn in flight, right now. */
  busy: Set<string>
  /** Sessions blocked on YOU — an unanswered question or permission prompt. */
  waiting: Set<string>
  /** Sessions whose turn ended while you were looking somewhere else — or that
   *  you marked unread yourself. Owned by unreadStore.ts, hence read-only. */
  unread: ReadonlySet<string>
}

// The events that stop the turn until the user answers. Everything else a live
// session emits means it moved past the prompt (the answer went through), so
// any other event clears the flag.
export function isWaitingEvent(kind: AgentEvent['kind']): boolean {
  return kind === 'question' || kind === 'permission'
}

/**
 * What every session is doing, for a list that shows sessions it does not host.
 *
 * The agent stream is global — every session's events pass through it, tagged
 * with the session key — so one subscription answers both questions. Anything
 * that is not the end of a turn means the session is working; `done` and
 * `error` end it, and end it *unread* unless you had that session open.
 *
 * `busy` starts as the live edge, and the sync below is what makes it the whole
 * truth: a session already mid-turn when the app started joins it on the first
 * poll. It is deliberately the ONLY source the rows read — `ClaudeSessionMeta
 * .running` is a snapshot of whenever the list was last read, so a row that
 * ORs it in keeps a spinner on a turn that ended long ago.
 */
export function useSessionActivity(openKeys: readonly string[] = []): SessionActivity {
  const [busy, setBusy] = useState<Set<string>>(() => new Set())
  const [waiting, setWaiting] = useState<Set<string>>(() => new Set())
  // The one set this hook does not own: the user marks chats unread too (`u`,
  // "read later"), from a command that has no way into React state. See
  // unreadStore.ts.
  const unread = useSyncExternalStore(subscribeUnread, unreadMarks)

  // EVERY name the open session answers to, not just the one the panel was
  // opened with: a session has two (Floe's id and the claudeId), the conn is
  // filed under whichever it last spawned with, and a turn that ended under the
  // other name would have marked the chat you are looking at as unread.
  //
  // Read inside the listener rather than resubscribed on every change: which
  // session is open changes as you click around, and tearing the subscription
  // down mid-turn would lose the events that arrive while it is replaced.
  const open = useRef(openKeys)
  open.current = openKeys

  // Which sound a finished turn plays, from `[notifications]` in floe.toml. A
  // ref for the same reason `open` is one: the subscription below must not be
  // torn down when the user changes the pick mid-turn.
  const sound = useRef<NotifySoundId>('off')
  useEffect(() => {
    const load = (): void =>
      void window.floe.config.get().then((c) => (sound.current = c.notifications.sound))
    load()
    return window.floe.config.onChange(load)
  }, [])

  // When each session last said anything, so the reconcile below can tell a
  // spinner that is merely new from one that is stale.
  const lastEventAt = useRef(new Map<string, number>())

  useEffect(
    () =>
      window.floe.agent.onEvent(({ key, event }: AgentEventEnvelope) => {
        // A query's activity is the QUERY panel's business, not the session
        // list's. This is the ONE place the projection is filtered: the raw
        // APIs stay raw, because `useTranscript` uses `agent.active()` as its
        // watchdog and a hidden qkey would make every QueryPanel conclude on
        // its own that the turn had ended, drop "is typing" and drain its queue
        // over a live turn. See the plan's "the filter is the projection's".
        //
        // The unread mark is the concrete leak: a qkey never matches a row in
        // the list (openKeys only ever holds the session's own aliases), so a
        // mark set on one can never be read and hangs there for good.
        if (isQueryKey(key)) return
        lastEventAt.current.set(key, Date.now())
        const live = event.kind !== 'done' && event.kind !== 'error'
        // Any turn ending is the news the sound carries — including the session
        // you are watching, since the window may be behind another app.
        if (!live) playDoneSound(sound.current)
        setBusy((prev) => {
          // Most events are text deltas in a session already known to be
          // working: returning the same Set keeps the list from re-rendering
          // on every token.
          if (prev.has(key) === live) return prev
          const next = new Set(prev)
          if (live) next.add(key)
          else next.delete(key)
          return next
        })
        // Blocked on the user: the spinner would keep turning (the turn IS in
        // flight), but nothing is going to happen until they answer — so the
        // mark must say "you", not "working". Any later event on the session
        // means the answer went through.
        const waits = live && isWaitingEvent(event.kind)
        setWaiting((prev) => {
          if (prev.has(key) === waits) return prev
          const next = new Set(prev)
          if (waits) next.add(key)
          else next.delete(key)
          return next
        })
        // A turn ended somewhere you were not looking.
        if (live || open.current.includes(key)) return
        markUnread([key])
      }),
    []
  )

  // Opening a session IS reading it — including one that goes on answering
  // while you watch, since the mark is only ever set for another session.
  // Under both names: a mark left under the id the panel is NOT keyed by would
  // otherwise sit on the row of the chat that is open in front of you.
  //
  // The one exception is a mark you put there yourself on this very chat, which
  // the store holds until you leave — see `held` in unreadStore.ts.
  const openKey = openKeys.join(' ')
  useEffect(() => readOpen(openKey.split(' ').filter(Boolean)), [openKey])

  // The correction. Both sets are built from events, and an event that never
  // arrives cannot be waited for: ask the main process who is actually working
  // and who is actually blocked on the user, and believe it. Also re-hydrates
  // after a reload, when the sets start empty but the turns did not stop and the
  // open question did not answer itself.
  //
  // The poll itself is shared (activeTurns.ts): the query dock and every open
  // chat correct themselves against the same answer, on the same timer.
  useEffect(
    () =>
      subscribeTurns(({ active, waiting }) => {
        const now = Date.now()
        // Filtered HERE and not in main, for the reason above: `agent.active()`
        // has to keep telling the truth to the panel that asks about itself.
        const own = (list: string[]): string[] => list.filter((k) => !isQueryKey(k))
        if (active) setBusy((prev) => reconcileLive(prev, own(active), lastEventAt.current, now))
        if (waiting) setWaiting((prev) => reconcileLive(prev, own(waiting), lastEventAt.current, now))
      }),
    []
  )

  return { busy, waiting, unread }
}
