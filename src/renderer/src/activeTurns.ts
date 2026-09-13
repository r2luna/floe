// One poll of "who is working" for every hook that asks.
//
// Three hooks correct their event-driven state against main's answer — the
// session list's spinners (useRunning), the query dock (useQueries) and a
// chat's own "is typing" line (useTranscript) — and each ran its own 4s timer
// against the same two IPC calls. One timer here, while anything is listening;
// every subscriber gets the same snapshot, and a subscriber that mounts
// mid-interval gets a fresh one at once rather than waiting out the tick.

export interface TurnSnapshot {
  /** Keys with a turn in flight, or null when main did not answer. */
  active: string[] | null
  /** Keys blocked on the user, or null when main did not answer. */
  waiting: string[] | null
}

type Listener = (snapshot: TurnSnapshot) => void

/** The cadence a spinner tolerates: a stale mark is gone before it is noticed. */
const POLL_MS = 4_000

const listeners = new Set<Listener>()
let timer: ReturnType<typeof setInterval> | undefined
let inFlight: Promise<TurnSnapshot> | null = null

/**
 * Ask main now. One request at a time: a second caller while one is out gets
 * the same answer, which is also what makes a burst of mounts cost one call.
 */
export function refreshTurns(): Promise<TurnSnapshot> {
  if (inFlight) return inFlight
  inFlight = Promise.all([
    window.floe.agent.active().catch(() => null),
    window.floe.agent.waiting().catch(() => null)
  ])
    .then(([active, waiting]) => {
      const snapshot = { active, waiting }
      for (const listener of listeners) listener(snapshot)
      return snapshot
    })
    .finally(() => {
      inFlight = null
    })
  return inFlight
}

// A window that was hidden may have missed the whole end of a turn.
const onVisible = (): void => {
  if (!document.hidden) void refreshTurns()
}

/**
 * Hear every answer from now on, starting with one asked for right away.
 * The timer exists only while someone listens: an idle window polls nothing.
 */
export function subscribeTurns(listener: Listener): () => void {
  listeners.add(listener)
  if (listeners.size === 1) {
    timer = setInterval(() => void refreshTurns(), POLL_MS)
    document.addEventListener('visibilitychange', onVisible)
  }
  void refreshTurns()
  return () => {
    listeners.delete(listener)
    if (listeners.size) return
    clearInterval(timer)
    timer = undefined
    document.removeEventListener('visibilitychange', onVisible)
  }
}

/** Whether the shared timer is running — for the test, which must leave none behind. */
export function turnsPolling(): boolean {
  return timer !== undefined
}
