import { useEffect, useRef } from 'react'
import { shouldRecap } from '../../shared/recap'
import { awayChance, consumeAway } from './awayStore.ts'

/**
 * Coming back to a chat you left running: ask for one line about what happened.
 *
 * Lives beside useSessionActivity because that is where the open session's
 * every name is already known, and a recap has to be decided under all of them
 * — the turn that ran while you were gone may have ended under the other one.
 *
 * Fires at most once per opening. Everything about whether it is owed is in
 * shared/recap.ts; everything about the gap is in awayStore.ts; this is the
 * wire between them and main.
 */
export function useRecap(
  openKeys: readonly string[],
  worktreePath: string | undefined,
  busy: ReadonlySet<string>
): void {
  // Read at open, never depended on: `busy` changes with every turn in every
  // session, and a recap must not re-fire because some other chat started work.
  const working = useRef(busy)
  working.current = busy

  const openKey = openKeys.join(' ')
  useEffect(() => {
    const keys = openKey.split(' ').filter(Boolean)
    if (!keys.length || !worktreePath) return
    const chance = awayChance(keys)
    const busyNow = keys.some((k) => working.current.has(k))
    if (!shouldRecap({ ...chance, busy: busyNow })) return
    // Spent before the ask, not after: the CLI takes seconds to answer, and a
    // second open in that window would queue a duplicate of a recap that has
    // not even arrived yet.
    consumeAway(keys)
    // Fire and forget. The line arrives as an ordinary agent event when the CLI
    // answers, and a recap that fails is a recap that never happened — main
    // reports nothing and there is nothing here to do about it.
    void window.floe.agent.recap(keys[0], worktreePath, chance.awayMs)
  }, [openKey, worktreePath])
}
