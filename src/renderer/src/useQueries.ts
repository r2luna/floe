import { useEffect, useMemo, useRef, useState } from 'react'
import type { AgentEventEnvelope, Query } from '../../shared/types'
import { dockRows, namesOf, type QueryRow } from './queryDock.ts'

/** How often the active-key list is re-read. The events below move a row the
 *  instant it changes; this is what catches a turn that was already running
 *  before the chat was opened — which is the whole case the dock exists for. */
const POLL_MS = 4_000

/**
 * The queries this chat has open, live — the dock's rows.
 *
 * Its own subscription rather than a field on `useSessionActivity`, for that
 * hook's own reason: it owns the unread marks and persists them, and it
 * deliberately drops query keys from everything it reports (see
 * docs/queries.md, "Activity"). What the dock needs is the opposite — the raw
 * truth about keys that hook filters out — and it keeps nothing.
 *
 * The list is re-read from main rather than assembled here, because a query is
 * born on four doors and only one of them is the composer in front of you.
 */
export function useQueries(session?: { id: string; worktreePath: string }): QueryRow[] {
  const [queries, setQueries] = useState<Query[]>([])
  const [active, setActive] = useState<ReadonlySet<string>>(() => new Set())
  const [live, setLive] = useState<Map<string, { tool?: string; at: number }>>(() => new Map())

  const sessionId = session?.id

  // Who is open. `query:opened` and `query:closed` are the two edges — an agent
  // can open one over `send_message` or on a followup timer, and merge or
  // discard it the same way, neither of which is a turn of this chat's own.
  useEffect(() => {
    if (!sessionId) {
      setQueries([])
      return
    }
    let alive = true
    const load = (): void => {
      void window.floe.query
        .list(sessionId)
        .catch(() => [] as Query[])
        .then((all) => alive && setQueries(all))
    }
    load()
    const offOpened = window.floe.query.onOpened(load)
    const offClosed = window.floe.query.onClosed(load)
    return () => {
      alive = false
      offOpened()
      offClosed()
    }
  }, [sessionId])

  // Which of them are working. Polled as well as streamed: the panel may be
  // opened onto a turn that started long before it mounted, and an event stream
  // only ever tells you what happened since you started listening.
  useEffect(() => {
    if (!sessionId) return
    let alive = true
    const read = (): void => {
      void window.floe.agent
        .active()
        .catch(() => [] as string[])
        .then((keys) => alive && setActive(new Set(keys)))
    }
    read()
    const timer = setInterval(read, POLL_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [sessionId])

  // What each one is on. Only tool calls move a row, so a query streaming a
  // long answer does not re-render the dock on every token; the turn's start is
  // carried across tools so the clock does not restart with each one.
  const seen = useRef(new Set<string>())
  seen.current = useMemo(() => new Set(queries.flatMap(namesOf)), [queries])
  useEffect(
    () =>
      window.floe.agent.onEvent(({ key, event }: AgentEventEnvelope) => {
        if (!seen.current.has(key)) return
        const done = event.kind === 'done' || event.kind === 'error'
        // The end of a turn drops the key from BOTH sources, or the poll's copy
        // would keep the spinner on for up to four seconds after the answer
        // landed. The poll is the corrective, never the faster of the two.
        if (done)
          setActive((prev) => {
            if (!prev.has(key)) return prev
            const next = new Set(prev)
            next.delete(key)
            return next
          })
        setLive((prev) => {
          if (done) {
            if (!prev.has(key)) return prev
            const next = new Map(prev)
            next.delete(key)
            return next
          }
          const was = prev.get(key)
          const tool = event.kind === 'tool' ? event.name : was?.tool
          if (was && was.tool === tool) return prev
          return new Map(prev).set(key, { tool, at: was?.at ?? Date.now() })
        })
      }),
    []
  )

  return useMemo(() => dockRows(queries, active, live), [queries, active, live])
}
