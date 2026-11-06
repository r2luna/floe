// The logic of browser annotate: what a mark is, what it points at, and the text
// that travels with the image. No DOM here, so `node --test` can reach all of it;
// BrowserAnnotate.tsx is the surface on top.
import type { BrowserCapture, BrowserElement, ImageAttachment } from '../../shared/types'
import { insertImageRef } from './attachments.ts'

export type Point = { x: number; y: number }
export type Rect = Point & { width: number; height: number }

type Noted = { note: string }
export type Mark = Noted &
  (
    | { kind: 'element'; element: BrowserElement }
    | { kind: 'box'; rect: Rect }
    | { kind: 'arrow'; from: Point; to: Point }
    | { kind: 'pen'; points: Point[] }
    | { kind: 'text'; at: Point }
  )

export type Tool = 'element' | 'box' | 'arrow' | 'pen' | 'text'

export const TOOLS: { tool: Tool; key: string; label: string }[] = [
  { tool: 'element', key: 'f', label: 'element' },
  { tool: 'box', key: 'b', label: 'box' },
  { tool: 'arrow', key: 'a', label: 'arrow' },
  { tool: 'pen', key: 'p', label: 'pen' },
  { tool: 'text', key: 't', label: 'text' }
]

/** A tool key is never the first letter of a hint, so the two cannot collide. */
export const TOOL_KEYS: Record<string, Tool> = { f: 'element', b: 'box', a: 'arrow', p: 'pen', t: 'text' }

const HINT_FIRST = 'sdghjklqwerzxcvnmoiy'
const HINT_SECOND = 'asdfghjkl'

/** Two letters each, home row first. Asks for more than exist and gets them all. */
export function hintLabels(count: number): string[] {
  const labels: string[] = []
  for (const first of HINT_FIRST) {
    for (const second of HINT_SECOND) {
      if (labels.length === count) return labels
      labels.push(first + second)
    }
  }
  return labels
}

const within = (r: Rect, p: Point): boolean =>
  p.x >= r.x && p.y >= r.y && p.x <= r.x + r.width && p.y <= r.y + r.height

const smallest = (elements: BrowserElement[]): BrowserElement | undefined =>
  elements.reduce<BrowserElement | undefined>(
    (best, el) => (!best || el.width * el.height < best.width * best.height ? el : best),
    undefined
  )

/** The most specific element under a point. */
export function elementAt(elements: BrowserElement[], p: Point): BrowserElement | undefined {
  return smallest(elements.filter((el) => within(el, p)))
}

/** The most specific element holding the whole rectangle. */
export function elementAround(elements: BrowserElement[], r: Rect): BrowserElement | undefined {
  return smallest(
    elements.filter((el) => within(el, r) && within(el, { x: r.x + r.width, y: r.y + r.height }))
  )
}

/** How much of an element a hand-drawn shape must cover to count as around it. */
const ENCLOSED = 0.7

const coverage = (el: Rect, r: Rect): number => {
  const width = Math.min(el.x + el.width, r.x + r.width) - Math.max(el.x, r.x)
  const height = Math.min(el.y + el.height, r.y + r.height) - Math.max(el.y, r.y)
  return width > 0 && height > 0 ? (width * height) / (el.width * el.height) : 0
}

/**
 * The largest element the rectangle mostly covers: what a circle around it means.
 * Mostly, because a shape drawn by hand clips the thing it was drawn around.
 */
export function elementWithin(elements: BrowserElement[], r: Rect): BrowserElement | undefined {
  return elements
    .filter((el) => coverage(el, r) >= ENCLOSED)
    .reduce<BrowserElement | undefined>(
      (best, el) => (!best || el.width * el.height > best.width * best.height ? el : best),
      undefined
    )
}

/** The rectangle two drag corners span, whichever way the drag went. */
export function rectOf(a: Point, b: Point): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) }
}

export function markBounds(mark: Mark): Rect {
  switch (mark.kind) {
    case 'element':
      return mark.element
    case 'box':
      return mark.rect
    case 'arrow':
      return rectOf(mark.from, mark.to)
    case 'text':
      return { ...mark.at, width: 0, height: 0 }
    case 'pen': {
      const xs = mark.points.map((p) => p.x)
      const ys = mark.points.map((p) => p.y)
      const x = Math.min(...xs)
      const y = Math.min(...ys)
      return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y }
    }
  }
}

/** Where a mark's number sits. An arrow is read from its tail, so it goes there. */
export function badgeAt(mark: Mark): Point {
  if (mark.kind === 'arrow') return mark.from
  if (mark.kind === 'pen') return mark.points[0]
  return markBounds(mark)
}

/**
 * The element a mark points at. An arrow means its tip. A shape means what it
 * encloses, and only when it encloses nothing, what it sits inside.
 */
export function targetOf(mark: Mark, elements: BrowserElement[]): BrowserElement | undefined {
  if (mark.kind === 'element') return mark.element
  if (mark.kind === 'arrow') return elementAt(elements, mark.to)
  if (mark.kind === 'text') return elementAt(elements, mark.at)
  const bounds = markBounds(mark)
  return elementWithin(elements, bounds) ?? elementAround(elements, bounds)
}

function describe(mark: Mark, elements: BrowserElement[]): string {
  const target = targetOf(mark, elements)
  if (target) return target.label ? `${target.selector} "${target.label}"` : target.selector
  const r = markBounds(mark)
  const size = r.width || r.height ? ` ${Math.round(r.width)}×${Math.round(r.height)}` : ''
  return `area ${Math.round(r.x)},${Math.round(r.y)}${size}`
}

/** One mark as the agent reads it. The note list on screen shows the same words. */
export function markLine(mark: Mark, n: number, elements: BrowserElement[]): string {
  const what = describe(mark, elements)
  return mark.note ? `${n}. ${what}: ${mark.note}` : `${n}. ${what}`
}

/**
 * The text that rides with the image, after its `image NN` token.
 *
 * Half the feature rather than a caption: opencode and the local models cannot
 * see images at all, and an agent that can still needs a selector to search for.
 */
export function annotationSummary(capture: BrowserCapture, marks: Mark[]): string {
  const head = `${capture.url} at ${capture.width}×${capture.height}`
  return [head, ...marks.map((mark, i) => markLine(mark, i + 1, capture.elements))].join('\n')
}

/** The draft with the nth image's token and its summary added, caret after them. */
export function addAnnotation(
  draft: string,
  n: number,
  summary: string
): { text: string; caret: number } {
  const lead = draft && !draft.endsWith('\n') ? `${draft}\n` : draft
  const put = insertImageRef(lead, lead.length, n)
  const text = `${put.text} ${summary}\n`
  return { text, caret: text.length }
}

/** `localhost-5173-checkout.png`: the chip should say which page it was. */
export function annotationFileName(url: string): string {
  let name = 'page'
  try {
    const { host, pathname, protocol } = new URL(url)
    if (protocol !== 'about:') name = `${host}${pathname}`.replace(/[^a-z\d.]+/gi, '-').replace(/^-+|-+$/g, '') || 'page'
  } catch {
    // about:blank and friends keep the generic name.
  }
  return `${name}.png`
}

/** A flat image larger than this on its long edge costs tokens and adds nothing. */
const MAX_IMAGE_EDGE = 1568

/** Canvas pixels per CSS pixel: as sharp as the capture, up to the ceiling. */
export function flatScale(capture: { width: number; height: number }, naturalWidth: number): number {
  const native = naturalWidth / Math.max(1, capture.width)
  return Math.min(native, MAX_IMAGE_EDGE / Math.max(capture.width, capture.height, 1))
}

/* --- who asks for the surface -------------------------------------------- */

// The registry runs at App level and the capture belongs to the panel, three
// layers down. Same door browserCover.ts uses for the same distance.
const requests = new Set<(tool?: Tool) => void>()

export function requestAnnotate(tool?: Tool): void {
  for (const listener of requests) listener(tool)
}

export function onAnnotateRequest(listener: (tool?: Tool) => void): () => void {
  requests.add(listener)
  return () => requests.delete(listener)
}

/* --- the way into a composer --------------------------------------------- */

export type Delivery = { image: ImageAttachment; summary: string }
export type Delivered = 'composer' | 'waiting' | 'nowhere'
type Door = (delivery: Delivery) => void

/** Exported for the test; `composerInbox` below is the real one. */
export function createInbox(): {
  open: (key: string, door: Door) => () => void
  deliver: (key: string, delivery: Delivery) => Delivered
} {
  const doors = new Map<string, Door>()
  const waiting = new Map<string, Delivery[]>()
  return {
    open(key, door) {
      doors.set(key, door)
      const held = waiting.get(key) ?? []
      waiting.delete(key)
      for (const delivery of held) door(delivery)
      return () => {
        if (doors.get(key) === door) doors.delete(key)
      }
    },
    deliver(key, delivery) {
      // No session yet means the launcher, which files its draft by branch.
      const name = key || [...doors.keys()].find((door) => door.startsWith('branch:'))
      if (!name) return 'nowhere'
      const door = doors.get(name)
      if (door) {
        door(delivery)
        return 'composer'
      }
      // Its chat is off screen. Handing this to whichever composer IS showing
      // would put the page in front of an agent that never saw it.
      waiting.set(name, [...(waiting.get(name) ?? []), delivery])
      return 'waiting'
    }
  }
}

export const composerInbox = createInbox()
