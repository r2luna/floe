import type { FileAttachment, ImageAttachment } from '../../shared/types'
import type { ModelChoice } from './models'

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
   * What the transcript shows, when it differs from what is sent — a message
   * that opens with `@codex` is addressed to codex, and the address is not part
   * of what codex is being asked to do.
   */
  shown?: string
  /**
   * Who answers this one message, when it named someone. Held per item because
   * a queue can hold messages for two different harnesses at once, and the
   * composer's current pick by the time the queue drains says nothing about
   * what each of them asked for.
   */
  choice?: ModelChoice
  /**
   * What the picker said when this was typed — the fallback for a line that
   * named nobody. Kept on the item because the panel that drains it may not be
   * the panel that queued it: switching chats unmounts the panel, and the one
   * that comes back starts with the default choice, which in a codex query
   * would hand the message to Claude.
   */
  picked?: ModelChoice
  /** What was dropped or pasted with it — it waits in the queue too. */
  images?: ImageAttachment[]
  files?: FileAttachment[]
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
/**
 * Two messages go out together only if they were addressed to the same place.
 *
 * Undefined is the session's own choice — two of those match, and one of those
 * never matches a routed one.
 */
const sameTarget = (a?: ModelChoice, b?: ModelChoice): boolean =>
  (a?.provider ?? '') === (b?.provider ?? '') &&
  (a?.model ?? '') === (b?.model ?? '') &&
  (a?.effort ?? '') === (b?.effort ?? '') &&
  // The mode too: two lines to the same model, one in plan and one in bypass,
  // are not one message. Merging them would run the second under a permission
  // it was never given.
  (a?.mode ?? '') === (b?.mode ?? '')

export function takeBatch(queued: readonly Queued[]): {
  text: string
  shown: string
  choice?: ModelChoice
  picked?: ModelChoice
  images: ImageAttachment[]
  files: FileAttachment[]
  rest: Queued[]
} | null {
  if (!queued.length) return null
  let take = 1
  // Linked, and not addressed somewhere else. A line that named nobody joins
  // the run it was linked to — that is what linking means, and it is how
  // `@codex revisa isso` + `e isso também` stays one errand. A line that named
  // a DIFFERENT harness is not a continuation: the handles are already off the
  // text, so joining them would send both to Ollama under a line that says
  // Gemini. Two targets, two turns.
  while (
    take < queued.length &&
    queued[take].linked &&
    (!queued[take].choice || sameTarget(queued[take].choice, queued[0].choice))
  )
    take++
  const batch = queued.slice(0, take)
  return {
    text: batch.map((q) => q.text).join('\n\n'),
    shown: batch.map((q) => q.shown ?? q.text).join('\n\n'),
    // The first item's, since a linked run is one message: the lines after it
    // said "and this too", not "and ask someone else".
    choice: batch[0].choice,
    picked: batch[0].picked,
    images: batch.flatMap((q) => q.images ?? []),
    files: batch.flatMap((q) => q.files ?? []),
    rest: queued.slice(take)
  }
}

