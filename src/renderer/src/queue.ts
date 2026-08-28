// The type-while-busy queue.
//
// The model is never asked to pull from a queue: this is a client-side buffer
// that the UI flushes at the turn boundary. Keeping the rule here, away from
// React, is what makes it testable — the part that goes wrong is not the state
// plumbing, it is deciding how much of the queue a boundary releases.

/** A message typed while the model was busy, waiting for the turn to end. */
export interface Queued {
  id: string
  text: string
  /**
   * Merge with the item above instead of taking its own turn. A run of linked
   * items becomes one user message — for when three lines are really one
   * thought you happened to type in pieces.
   */
  linked: boolean
}

/**
 * How much of the queue goes out at the next boundary.
 *
 * One message per turn, except that a contiguous run of linked items is one
 * thought typed in pieces and goes out as a single message. The `linked` flag
 * on the FIRST item is ignored — there is nothing above it in this batch to
 * link to.
 */
export function takeBatch(queued: Queued[]): { text: string; rest: Queued[] } | null {
  if (!queued.length) return null
  let take = 1
  while (take < queued.length && queued[take].linked) take++
  return {
    text: queued
      .slice(0, take)
      .map((q) => q.text)
      .join('\n\n'),
    rest: queued.slice(take)
  }
}

