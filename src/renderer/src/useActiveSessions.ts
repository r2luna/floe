// The `active` panel's data: the most recent sessions across every project on
// every attached machine, in one list.
//
// Same shape as the projects union (backends.ts) and for the same reason — a
// machine that is down must not hold the panel blank — but with a step the
// project list does not need: each machine answers with its OWN top `limit`, and
// those answers are merged and re-sliced here. That is correct without any
// coordination, because a machine's own top ten is always a superset of whatever
// it contributes to the global top ten.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { backendIds, backendLabel, currentBackend, recentSessionsOn } from './backends.ts'
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

export interface ActiveSessions {
  rows: ActiveSession[]
  /** Only this machine being slow blanks the panel — see the projects union. */
  loading: boolean
  offline: OfflineBackend[]
  reload: () => void
}

/** Newest first, then cut. The cut is what makes it "the last ten". */
export function topSessions(rows: ActiveSession[], limit: number): ActiveSession[] {
  return [...rows].sort((a, b) => b.lastActivityAt - a.lastActivityAt).slice(0, Math.max(0, limit))
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

export function useActiveSessions(limit = 10): ActiveSessions {
  const [rows, setRows] = useState<ActiveSession[]>([])
  const [offline, setOffline] = useState<OfflineBackend[]>([])
  const [pending, setPending] = useState<string[]>(() => backendIds())
  // A machine that answers after the next load started is answering an older
  // question. Its rows are still true, but which load they belong to decides
  // whether "pending" and "offline" are still about them.
  const gen = useRef(0)

  const load = useCallback(() => {
    const mine = ++gen.current
    const ids = backendIds()
    setPending(ids)
    for (const id of ids) {
      const late = setTimeout(() => {
        if (gen.current !== mine) return
        setOffline((o) => (o.some((b) => b.id === id) ? o : [...o, { id, label: backendLabel(id) }]))
        setPending((p) => p.filter((x) => x !== id))
      }, SLICE_MS)
      void recentSessionsOn(id, limit)
        .then((slice) => {
          clearTimeout(late)
          if (gen.current !== mine) return
          // A late answer reports the machine back as up — it is the same
          // evidence that took it down, arriving.
          setOffline((o) => o.filter((b) => b.id !== id))
          setRows((prev) => mergeSlice(prev, slice, id))
          setPending((p) => p.filter((x) => x !== id))
        })
        .catch(() => {
          clearTimeout(late)
          if (gen.current !== mine) return
          setOffline((o) =>
            o.some((b) => b.id === id) ? o : [...o, { id, label: backendLabel(id) }]
          )
          // Nothing to merge, but its old rows must go: keeping them would show
          // a machine's sessions as current long after it stopped answering.
          setRows((prev) => prev.filter((s) => s.backend !== id))
          setPending((p) => p.filter((x) => x !== id))
        })
    }
  }, [limit])

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

  return {
    rows: useMemo(() => topSessions(rows, limit), [rows, limit]),
    // The remotes are reported under the list instead, so this machine's
    // sessions are readable while the network is not.
    loading: pending.includes(currentBackend()),
    offline,
    reload: load
  }
}
