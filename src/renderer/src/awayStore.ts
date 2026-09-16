// When you last left each chat, and whether anything happened after you did.
//
// The recap needs both, and neither is anywhere else: the unread mark says a
// turn ended somewhere you were not looking, but not WHEN you stopped looking,
// and it is cleared the moment you open the chat — which is exactly the moment
// the recap has to make its decision.
//
// A module store rather than React state for the same reason unreadStore.ts is
// one: the writers never meet. The agent stream stamps activity from
// useRunning's single global subscription; the panel stamps leaving from its
// own effect.
//
// In memory only, deliberately. A stamp that survived a quit would claim you
// were away for fourteen hours, and the answer to "what happened while you were
// asleep" is nothing — the app was not running either.

import type { RecapChance } from '../../shared/recap'

/** The last time the agent said anything in a session, by key. */
const lastEventAt = new Map<string, number>()

/** The last time a session stopped being the one you were looking at, by key. */
const leftAt = new Map<string, number>()

/** The agent stream spoke for this session — see useRunning.ts. */
export function noteActivity(key: string, now = Date.now()): void {
  lastEventAt.set(key, now)
}

/** You stopped looking at this chat. Every name it answers to, since events arrive under either. */
export function noteLeft(keys: readonly string[], now = Date.now()): void {
  for (const key of keys) leftAt.set(key, now)
}

/**
 * What the recap rule needs to know about a chat you just opened.
 *
 * `moved` is measured against the moment you LEFT rather than against the
 * unread mark, so it still answers for a session you left mid-turn: the turn
 * ended while you were away either way, and the mark by then is already gone.
 */
export function awayChance(keys: readonly string[], now = Date.now()): RecapChance {
  let left = 0
  let last = 0
  for (const key of keys) {
    left = Math.max(left, leftAt.get(key) ?? 0)
    last = Math.max(last, lastEventAt.get(key) ?? 0)
  }
  // Never left it: this is the first time the chat has been open in this run,
  // and there is no gap to recap.
  if (!left) return { awayMs: 0, moved: false }
  return { awayMs: now - left, moved: last > left }
}

/**
 * The gap has been recapped. One line per time away, no matter how many times
 * the chat is opened in between — coming back, glancing at another panel and
 * coming back again is still one return, and a second copy of the same sentence
 * is the app repeating itself. The next one is owed only after you leave again.
 */
export function consumeAway(keys: readonly string[]): void {
  for (const key of keys) leftAt.delete(key)
}

/** Test seam — the maps outlive any one component, so a test has to clear them. */
export function forgetAway(): void {
  lastEventAt.clear()
  leftAt.clear()
}
