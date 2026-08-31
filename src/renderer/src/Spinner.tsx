import { useSyncExternalStore } from 'react'

/**
 * The app's one in-flight mark.
 *
 * Status in Floe is said on two channels, and they never overlap: MOTION means
 * something is running, COLOUR means how it ended. That split exists because
 * colour was already spoken for — green is "the session you have open" and the
 * accent is "a reply you have not read" — so a green dot for "running" lost
 * every fight it was in, and a stopped run looked exactly like a finished one.
 *
 * So anything working turns, everywhere: a session in the sidebar, the runtime
 * mid-answer, a subagent, a merge step, a command. Same glyph, same tempo, same
 * blue — five places you learn once.
 */
export const SPIN_FRAMES = '⠋⠙⠹⠸⠼⠴⠦⠧'
const SPIN_MS = 90

// Motion is the whole point of this mark, so with it turned off the glyph
// stands still rather than being swapped for something else: the shape still
// says "working", it just says it without moving.
const spinStill =
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * One clock for every spinner on screen.
 *
 * Five working sessions are a column you read straight down, and five separate
 * intervals would drift out of phase within seconds — which reads as noise,
 * not as five things working. So they share a frame counter. The interval only
 * exists while something is subscribed: an idle window costs nothing.
 */
const subs = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | undefined
let frame = 0

function subscribe(onFrame: () => void): () => void {
  if (spinStill) return () => {}
  subs.add(onFrame)
  timer ??= setInterval(() => {
    frame = (frame + 1) % SPIN_FRAMES.length
    for (const fn of subs) fn()
  }, SPIN_MS)
  return () => {
    subs.delete(onFrame)
    if (!subs.size && timer !== undefined) {
      clearInterval(timer)
      timer = undefined
    }
  }
}

const getFrame = (): number => frame
const getStill = (): number => 0

/**
 * `className` lets a caller hand the spinner the box its site already reserved
 * — the merge rail's node, say — so the mark lands where the static one did
 * and nothing shifts when a step starts.
 */
export function Spinner({ className, title }: { className?: string; title?: string }) {
  const i = useSyncExternalStore(subscribe, getFrame, getStill)
  return (
    <span className={className ? `spin ${className}` : 'spin'} title={title ?? 'working'}>
      {SPIN_FRAMES[i]}
    </span>
  )
}
