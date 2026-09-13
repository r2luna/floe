// The desktop notification for a session that is blocked on you.
//
// The done sound (useRunning.ts) says "a turn ended" for every session, on
// screen or not. This is the other kind of news — a question or a permission
// prompt — which goes nowhere until you act. It fires only for a session you
// are not looking at, or when the window is not the one in front, because a
// prompt already on screen does not need announcing.
//
// Main draws the notification (`notify:show`) and, on click, raises the window
// and sends the session key back over `notification:click`; App opens it.

import { useEffect, useRef } from 'react'
import type { AgentEventEnvelope } from '../../shared/types'
import { isQueryKey } from '../../shared/queries.ts'
import { isWaitingEvent } from './useRunning.ts'

export interface NeedsYouSubject {
  /** The session's title — the notification's headline. */
  title: string
  /** "project/branch", when known. */
  where?: string
}

/**
 * Whether this waiting edge deserves a notification. Pure, for the test.
 *
 * Once per wait: a permission prompt re-sent on every poll would otherwise be a
 * notification per poll. The session you have open is exempt while the window
 * is focused — the prompt is already in front of you.
 */
export function shouldNotify(
  key: string,
  openKeys: readonly string[],
  windowFocused: boolean,
  told: ReadonlySet<string>
): boolean {
  if (told.has(key)) return false
  return !openKeys.includes(key) || !windowFocused
}

export function useNeedsYouNotifier(opts: {
  /** Every name the open chat answers to. */
  openKeys: readonly string[]
  /** How to name the session, when the list has it. */
  describe: (key: string) => NeedsYouSubject | undefined
}): void {
  // Read at event time, not resubscribed on change — which chat is open moves
  // all day, and tearing the subscription down would drop the events between.
  const latest = useRef(opts)
  latest.current = opts
  // The sessions already announced for the wait they are in. Any other event
  // on the key means the answer went through, and the next wait is news again.
  const told = useRef(new Set<string>())

  useEffect(
    () =>
      window.floe.agent.onEvent(({ key, event }: AgentEventEnvelope) => {
        if (isQueryKey(key)) return
        if (!isWaitingEvent(event.kind)) {
          told.current.delete(key)
          return
        }
        if (!shouldNotify(key, latest.current.openKeys, document.hasFocus(), told.current)) return
        told.current.add(key)
        const who = latest.current.describe(key)
        const what = event.kind === 'question' ? 'asked you a question' : 'is asking for permission'
        void window.floe.notify({
          title: who?.title ?? 'A session needs you',
          body: who?.where ? `${what} · ${who.where}` : what,
          sessionId: key
        })
      }),
    []
  )
}
