import { useEffect, useRef, useState } from 'react'
import type { AgentEventEnvelope, NotifySoundId } from '../../shared/types'
import { playDoneSound } from './sounds'

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

export interface SessionActivity {
  /** Sessions with a turn in flight, right now. */
  busy: Set<string>
  /** Sessions whose turn ended while you were looking somewhere else. */
  unread: Set<string>
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

  useEffect(
    () =>
      window.floe.agent.onEvent(({ key, event }: AgentEventEnvelope) => {
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

  useEffect(() => writeUnread(unread), [unread])

  return { busy, unread }
}
