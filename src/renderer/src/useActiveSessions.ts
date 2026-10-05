// The `active` panel's data: every attached machine's candidates for the list,
// in one union, plus the membership that decides which of them show.
//
// Same shape as the projects union (backends.ts) and for the same reason — a
// machine that is down must not hold the panel blank. Each machine answers with
// its own candidates (sessionIndex.activeSessions) and the answers are merged
// here; which rows show and where is activeStore.ts's business.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import {
  activeSessionsOn,
  backendIds,
  backendLabel,
  backendState,
  currentBackend,
  recentSessionsOn
} from './backends.ts'
import {
  activeState,
  expire,
  idsFor,
  prune,
  seed,
  subscribeActive,
  updateActive,
  type ActiveState
} from './activeStore.ts'
import type { ActiveSession } from '../../shared/types'

/** How long one machine gets to answer. The projects union's number, its reason. */
const SLICE_MS = 8000

/**
 * How often the list re-reads while the panel is open.
 *
 * `sessions:changed` fires on the writes the app knows about, but the two things
 * this panel exists to show are not writes at all — a turn ending and a question
 * being asked both only change what `recent_sessions` computes. So the panel
 * polls, at the cadence a glance tolerates: six seconds is faster than you can
 * notice a row is stale and slow enough that ten transcript reads per machine
 * cost nothing.
 */
const POLL_MS = 6000

/** A machine that did not answer — named rather than counted, so retry means something. */
export interface OfflineBackend {
  id: string
  label: string
}

/**
 * Does a failed read mean the machine is down?
 *
 * Only the socket decides. A machine whose socket is open DID answer — it
 * answered with an error, which is what a channel it does not have looks like
 * when the desktop is newer than the daemon. Reporting that as "offline" tells
 * the user the network is gone when the machine is right there, and the panel
 * has no other way to say "incomplete", so the false report wins the row.
 */
export const unreachable = (state: 'connecting' | 'open' | 'closed'): boolean => state !== 'open'

export interface ActiveSessions {
  /** Every candidate from every machine — not yet filtered by membership. */
  rows: ActiveSession[]
  membership: ActiveState
  /** Only this machine being slow blanks the panel — see the projects union. */
  loading: boolean
  offline: OfflineBackend[]
  reload: () => void
}

/**
 * Splice one machine's answer into the union.
 *
 * Its own rows are replaced wholesale — a session that ended, or was deleted,
 * has to leave the list — and every other machine's are left exactly as they
 * were, which is the whole point of merging rather than assigning.
 */
export function mergeSlice(
  prev: ActiveSession[],
  slice: ActiveSession[],
  backend: string
): ActiveSession[] {
  return [...prev.filter((s) => s.backend !== backend), ...slice.map((s) => ({ ...s, backend }))]
}

/**
 * The last answer, kept outside the hook.
 *
 * The panel is unmounted and remounted by things that have nothing to do with
 * it — a lane switch, a chat opening beside it — and a hook that starts empty
 * turns each of those into a blank list and a "Loading…" flash, on a list the
 * app was already holding. Kept here, a remount paints the last answer at once
 * and the load in flight updates it in place.
 */
let lastRows: ActiveSession[] = []
let lastOffline: OfflineBackend[] = []

/** How many rows a daemon too old for `sessions:active` is asked for instead. */
const FALLBACK_LIMIT = 50

/**
 * One machine's candidates. A daemon older than this desktop has no
 * `sessions:active`; it gets the old recent-sessions read, and `full: false`
 * says the answer cannot tell a closed chat from one it just did not list.
 */
async function candidatesOn(id: string, ids: string[]): Promise<{ slice: ActiveSession[]; full: boolean }> {
  try {
    return { slice: await activeSessionsOn(id, ids), full: true }
  } catch (err) {
    if (unreachable(backendState(id))) throw err
    return { slice: await recentSessionsOn(id, FALLBACK_LIMIT), full: false }
  }
}

export function useActiveSessions(): ActiveSessions {
  const membership = useSyncExternalStore(subscribeActive, activeState)
  const [rows, setRows] = useState<ActiveSession[]>(lastRows)
  const [offline, setOffline] = useState<OfflineBackend[]>(lastOffline)
  const [pending, setPending] = useState<string[]>(() => backendIds())
  // One load at a time. `sessions:changed` arrives in bursts — a turn ending
  // writes several times in a row — and each load walks every project on every
  // machine, so overlapping them buys nothing and lands their answers
  // interleaved, which is the list rebuilding itself two or three times for one
  // event. A load that arrives while one is running is remembered, not run.
  const busy = useRef(false)
  const queued = useRef(false)
  const loadRef = useRef<() => void>(() => {})
  // A machine that answers after the next load started is answering an older
  // question. Its rows are still true, but which load they belong to decides
  // whether "pending" and "offline" are still about them.
  const gen = useRef(0)
  // The machines whose 24h sweep this mount already ran. The sweep only runs
  // on rows that are not on screen: at mount for the machines whose rows are
  // cached (that is the moment before they are painted), and on the first
  // answer for the rest (nothing of theirs was painted before it).
  const swept = useRef(new Set<string>())
  useLayoutEffect(() => {
    const now = Date.now()
    for (const id of new Set(lastRows.map((s) => s.backend ?? ''))) {
      if (!id) continue
      const mine = lastRows.filter((s) => s.backend === id)
      updateActive((st) => expire(st, id, mine, now))
      swept.current.add(id)
    }
  }, [])

  const load = useCallback(() => {
    if (busy.current) {
      queued.current = true
      return
    }
    const mine = ++gen.current
    const ids = backendIds()
    setPending(ids)
    busy.current = true
    // Per load, not a counter on the hook: a machine that times out and then
    // answers anyway must not close the load twice.
    const left = new Set(ids)
    const finish = (id: string): void => {
      if (!left.delete(id) || left.size) return
      busy.current = false
      if (!queued.current) return
      queued.current = false
      loadRef.current()
    }
    for (const id of ids) {
      const late = setTimeout(() => {
        finish(id)
        if (gen.current !== mine) return
        setOffline((o) => (o.some((b) => b.id === id) ? o : [...o, { id, label: backendLabel(id) }]))
        setPending((p) => p.filter((x) => x !== id))
      }, SLICE_MS)
      const asked = idsFor(activeState(), id)
      void candidatesOn(id, asked)
        .then(({ slice, full }) => {
          clearTimeout(late)
          finish(id)
          if (gen.current !== mine) return
          const tagged = slice.map((s) => ({ ...s, backend: id }))
          const first = !swept.current.has(id)
          swept.current.add(id)
          updateActive((st) => {
            let next = seed(st, id, tagged)
            if (full) next = prune(next, id, asked, tagged)
            return first ? expire(next, id, tagged) : next
          })
          // A late answer reports the machine back as up — it is the same
          // evidence that took it down, arriving.
          setOffline((o) => o.filter((b) => b.id !== id))
          setRows((prev) => mergeSlice(prev, slice, id))
          setPending((p) => p.filter((x) => x !== id))
        })
        .catch((err) => {
          clearTimeout(late)
          finish(id)
          if (gen.current !== mine) return
          // An error from a machine that is still connected is a bug or a
          // version skew, not an outage: it goes to the console, not the panel.
          if (unreachable(backendState(id)))
            setOffline((o) =>
              o.some((b) => b.id === id) ? o : [...o, { id, label: backendLabel(id) }]
            )
          else console.debug('[active]', id, err)
          // Nothing to merge, but its old rows must go: keeping them would show
          // a machine's sessions as current long after it stopped answering.
          setRows((prev) => prev.filter((s) => s.backend !== id))
          setPending((p) => p.filter((x) => x !== id))
        })
    }
    // Nothing to wait for — no machines attached at all.
    if (!left.size) busy.current = false
  }, [])
  loadRef.current = load

  useEffect(() => {
    load()
    const timer = setInterval(load, POLL_MS)
    // Not the poll's business: a session created or closed anywhere should show
    // up now, not up to six seconds from now.
    // Events fan in from every attached machine (see the preload router), so
    // this fires for a session created on any of them, not just this one.
    const off = window.floe.claude.onSessionsChanged(load)
    return () => {
      clearInterval(timer)
      off()
    }
  }, [load])

  // The cache is what a remount reads, so it is written wherever the state is.
  useEffect(() => {
    lastRows = rows
    lastOffline = offline
  }, [rows, offline])

  return {
    rows,
    membership,
    // The remotes are reported under the list instead, so this machine's
    // sessions are readable while the network is not.
    loading: pending.includes(currentBackend()),
    offline,
    reload: load
  }
}
