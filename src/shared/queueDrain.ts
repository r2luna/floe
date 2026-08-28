import type { QueuedMessage } from './types.ts'

// What to send at one turn boundary and what stays queued. The head always
// fires; any contiguous run of items the user linked to it rides along in the
// same turn, merged into one user message. Everything after the run waits for
// its own boundary.
export interface DrainStep {
  text: string
  images: NonNullable<QueuedMessage['images']>
  files: NonNullable<QueuedMessage['files']>
  modelOverride?: string
  rest: QueuedMessage[]
}

export function takeLinkedGroup(queue: QueuedMessage[]): DrainStep | null {
  if (queue.length === 0) return null
  const [head, ...tail] = queue
  let n = 0
  while (n < tail.length && tail[n].linked) n++
  const group = [head, ...tail.slice(0, n)]
  return {
    text: group.map((g) => g.text).join('\n\n'),
    images: group.flatMap((g) => g.images ?? []),
    files: group.flatMap((g) => g.files ?? []),
    modelOverride: head.modelOverride,
    rest: tail.slice(n)
  }
}
