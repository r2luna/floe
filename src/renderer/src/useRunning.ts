import { useEffect, useRef, useState } from 'react'
import type { AgentEvent, AgentEventEnvelope, NotifySoundId } from '../../shared/types'
import { playDoneSound } from './sounds.ts'

// Sessions with an answer you have not seen. Kept in the same store as the
// drafts and the lane — a reply that landed before you quit is still unread
// when you come back, or the mark would only live as long as the window.
const KEY = 'floe.unread'

// ponytail: 200 keys, oldest dropped. Reading one removes it, so this only
// fills up if you leave 200 sessions unopened.
const MAX = 200

function readUnread(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string') : []
  } catch {
    return []
  }
}

function writeUnread(keys: Set<string>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify([...keys].slice(-MAX)))
  } catch {
    /* quota or private mode — a mark is a convenience, never a requirement */
  }
}

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
  /** Sessions whose turn ended while you were looking somewhere else. */
  unread: Set<string>
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
 * `busy` is only the live edge: a session already mid-turn when the app started
 * is not in it until its next event, which is what `ClaudeSessionMeta.running`
 * (read from disk with the list) is for.
 */
export function useSessionActivity(openKey?: string | null): SessionActivity {
  const [busy, setBusy] = useState<Set<string>>(() => new Set())
  const [waiting, setWaiting] = useState<Set<string>>(() => new Set())
  const [unread, setUnread] = useState<Set<string>>(() => new Set(readUnread()))

  // Read inside the listener rather than resubscribed on every change: which
  // session is open changes as you click around, and tearing the subscription
  // down mid-turn would lose the events that arrive while it is replaced.
  const open = useRef(openKey)
  open.current = openKey

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
        if (live || key === open.current) return
        setUnread((prev) => (prev.has(key) ? prev : new Set(prev).add(key)))
      }),
    []
  )

  // Opening a session IS reading it — including one that goes on answering
  // while you watch, since the mark is only ever set for another session.
  useEffect(() => {
    if (!openKey) return
    setUnread((prev) => {
      if (!prev.has(openKey)) return prev
      const next = new Set(prev)
      next.delete(openKey)
      return next
    })
  }, [openKey])

  // The correction. Both sets are built from events, and an event that never
  // arrives cannot be waited for: ask the main process who is actually working
  // and who is actually blocked on the user, and believe it. Also re-hydrates
  // after a reload, when the sets start empty but the turns did not stop and the
  // open question did not answer itself.
  useEffect(() => {
    let stopped = false
    const sync = async (): Promise<void> => {
      const [keys, asking] = await Promise.all([
        window.floe.agent.active().catch(() => null),
        window.floe.agent.waiting().catch(() => null)
      ])
      if (stopped) return
      const now = Date.now()
      if (keys) setBusy((prev) => reconcileLive(prev, keys, lastEventAt.current, now))
      if (asking) setWaiting((prev) => reconcileLive(prev, asking, lastEventAt.current, now))
    }
    void sync()
    const timer = setInterval(() => void sync(), 4_000)
    // A window that was hidden may have missed the whole end of a turn.
    const onVisible = (): void => {
      if (!document.hidden) void sync()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      stopped = true
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  useEffect(() => writeUnread(unread), [unread])

  return { busy, waiting, unread }
}
