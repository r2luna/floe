import { takeBatch, type Queued } from './queue.ts'

// The type-while-busy queue, per session, outside any panel.
//
// A module store rather than React state because the chat panel does not
// outlive a session switch: it is keyed `chat:<session id>` (App.tsx), so
// opening another chat unmounts it and mounts a new one. A queue held in the
// panel's own `useState` left with the panel — the message was never sent and
// never seen again, with nothing to say which. Filed under the session key, it
// is still there when the panel comes back, and the panel that comes back is
// what drains it.
//
// The boundary lock lives here for the same reason. Two panels can watch one
// session (a second window, a lane opened from the dock), and both see the
// turn end. One delivery per boundary is a rule about the SESSION, so the lock
// that enforces it cannot be a ref inside either panel.
//
// Memory only, the same deal a pasted attachment gets (drafts.ts): a relaunch
// loses it, a switch does not.

const EMPTY: readonly Queued[] = Object.freeze([])

const queues = new Map<string, readonly Queued[]>()
const draining = new Set<string>()
const listeners = new Set<() => void>()

/**
 * The queue under `key`, by identity — the snapshot `useSyncExternalStore`
 * compares. Every write replaces the array, so an unchanged queue is the same
 * object and the panel does not re-render.
 */
export function queueOf(key: string): readonly Queued[] {
  return queues.get(key) ?? EMPTY
}

export function subscribeQueue(fn: () => void): () => void {
  listeners.add(fn)
  return () => void listeners.delete(fn)
}

/** Replace the queue under `key`. An empty result drops the entry. */
export function updateQueue(
  key: string,
  fn: (prev: readonly Queued[]) => readonly Queued[]
): void {
  const prev = queueOf(key)
  const next = fn(prev)
  if (next === prev) return
  if (next.length) queues.set(key, next)
  else queues.delete(key)
  for (const l of listeners) l()
}

/**
 * What goes out at this boundary, or nothing.
 *
 * Nothing when the queue is empty, and nothing when this boundary has already
 * been claimed — by this panel on an earlier render, or by another panel on
 * the same session. The claim holds until `releaseBoundary`, which the turn
 * starting is what calls.
 */
export function claimBatch(key: string): ReturnType<typeof takeBatch> {
  if (draining.has(key)) return null
  const batch = takeBatch(queueOf(key))
  if (!batch) return null
  draining.add(key)
  updateQueue(key, () => batch.rest)
  return batch
}

/** The boundary is over: a turn started, or the delivery failed to start one. */
export function releaseBoundary(key: string): void {
  draining.delete(key)
}

/** For tests: forget every queue and every claim. */
export function resetQueues(): void {
  queues.clear()
  draining.clear()
  for (const l of listeners) l()
}
