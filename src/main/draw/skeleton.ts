// Skeleton → complete Excalidraw element.
//
// The agent writes only what carries meaning: a rectangle at a position with a
// label, an arrow between two ids. This expands one of those into an element the
// Excalidraw model accepts as-is — every default filled, a seed, a version, a
// bound text child for a label, real point bindings for an arrow.
//
// Why expand HERE and not let the canvas do it: a `.excalidraw` file that only
// renders after Excalidraw's own `restore()` has patched it is not a valid file.
// It would not open on excalidraw.com, and Floe's whole premise is that the
// drawing is a file in the worktree, readable by anything.
//
// Deliberately dependency-free (and React-free): this runs in the main process,
// which must never pull the canvas package into its graph.

import { randomBytes, randomInt } from 'node:crypto'
import type { DrawElement, DrawSkeleton } from '../../shared/types'

// Excalidraw's own id alphabet (nanoid's default), so an id Floe minted is
// indistinguishable from one the canvas minted.
const ID_ALPHABET = 'useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict'

export function newId(): string {
  const bytes = randomBytes(21)
  let out = ''
  for (const b of bytes) out += ID_ALPHABET[b % ID_ALPHABET.length]
  return out
}

const nonce = (): number => randomInt(0, 2 ** 31)

// Excalidraw's own defaults, and the reason a skeleton can be three fields long.
const DEFAULT_STROKE = '#1e1e1e'
const DEFAULT_BG = 'transparent'
const FONT_SIZE = 20
const LINE_HEIGHT = 1.25
// The Excalidraw model's font ids: 5 = Excalifont (the hand-drawn default).
const FONT_FAMILY = 5
// How far a bound arrow stops short of the shape it points at.
const ARROW_GAP = 4

/**
 * Roughly how wide `text` renders at `fontSize`.
 *
 * Deliberately generous. Excalifont's real advance widths are not knowable from
 * the main process, and the two errors are not symmetric: an oversized text box
 * is invisible, while an undersized one clips the word — which is what you see
 * first when you open the drawing.
 */
function textWidth(text: string, fontSize = FONT_SIZE): number {
  const longest = text.split('\n').reduce((n, line) => Math.max(n, line.length), 0)
  return Math.max(fontSize, Math.round(longest * fontSize * 0.68))
}

function textHeight(text: string, fontSize = FONT_SIZE): number {
  return Math.round(text.split('\n').length * fontSize * LINE_HEIGHT)
}

/** The fields every element type shares, defaulted. */
function base(id: string, type: string, now: number): DrawElement {
  return {
    id,
    type,
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    angle: 0,
    strokeColor: DEFAULT_STROKE,
    backgroundColor: DEFAULT_BG,
    fillStyle: 'solid',
    strokeWidth: 2,
    strokeStyle: 'solid',
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    // Null is legal and means "not yet placed in the scene's order" — Excalidraw
    // assigns one from the array order on load. Inventing a fractional index
    // here would be guessing at neighbours we cannot see.
    index: null,
    roundness: null,
    seed: nonce(),
    version: 1,
    versionNonce: nonce(),
    isDeleted: false,
    boundElements: null,
    updated: now,
    link: null,
    locked: false
  }
}

interface Box {
  x: number
  y: number
  width: number
  height: number
}

const boxOf = (el: DrawElement): Box => ({
  x: Number(el.x ?? 0),
  y: Number(el.y ?? 0),
  width: Number(el.width ?? 0),
  height: Number(el.height ?? 0)
})

const centerOf = (b: Box): [number, number] => [b.x + b.width / 2, b.y + b.height / 2]

/**
 * Where the segment between two box centres leaves `box`, pushed out by `gap`.
 *
 * The rectangle bound is used even for an ellipse or a diamond: Excalidraw
 * recomputes a bound arrow's endpoints itself the moment either shape moves, so
 * this only has to be right enough to look right before anyone touches it.
 */
function edgePoint(box: Box, toward: [number, number], gap: number): [number, number] {
  const [cx, cy] = centerOf(box)
  const dx = toward[0] - cx
  const dy = toward[1] - cy
  if (dx === 0 && dy === 0) return [cx, cy]
  const halfW = box.width / 2
  const halfH = box.height / 2
  // Scale the direction until it hits whichever side it reaches first.
  const scale = Math.min(
    dx === 0 ? Infinity : halfW / Math.abs(dx),
    dy === 0 ? Infinity : halfH / Math.abs(dy)
  )
  const len = Math.hypot(dx, dy)
  const out = (scale * len + gap) / len
  return [cx + dx * out, cy + dy * out]
}

/**
 * The scene, indexed by id, as the expansion reads it.
 *
 * Elements created earlier in the SAME call are in here too, so one
 * `draw_elements` can lay out three boxes and the arrows between them.
 */
type Index = Map<string, DrawElement>

export class UnknownTargetError extends Error {
  // A plain field, not a parameter property: these files run under Node's
  // strip-only TypeScript, which has no way to emit the assignment.
  readonly missing: string
  constructor(missing: string) {
    super(
      `no element with id "${missing}" in this drawing — draw the shape first, or fix the id (list them with read_drawing)`
    )
    this.name = 'UnknownTargetError'
    this.missing = missing
  }
}

/**
 * Expand skeletons into complete elements, ready to be merged into a scene.
 *
 * Returns EVERY element the write touches, which is more than one per skeleton:
 * a `label` adds a bound text child, and an arrow bumps the two shapes it binds
 * to (they have to list it in `boundElements`, or the arrow won't follow when
 * the shape moves). All of them come back as upserts — see DrawDelta.
 *
 * Throws UnknownTargetError when an arrow names a shape that is nowhere in the
 * scene. A silently unbound arrow looks exactly like a bug to whoever opens the
 * drawing, so the agent is told which id was wrong and rewrites the call.
 */
export function expandSkeletons(
  skeletons: DrawSkeleton[],
  scene: DrawElement[],
  now: number = Date.now()
): DrawElement[] {
  const index: Index = new Map(scene.map((el) => [el.id, el]))
  // Written elements, in insertion order, keyed so a second skeleton in the same
  // call can amend one (an arrow adding itself to a shape's boundElements).
  const out = new Map<string, DrawElement>()

  const put = (el: DrawElement): void => {
    out.set(el.id, el)
    index.set(el.id, el)
  }

  /** The current state of an element: freshly written, else on disk. */
  const look = (id: string): DrawElement | undefined => out.get(id) ?? index.get(id)

  /**
   * Record that `childId` is bound to `containerId`.
   *
   * An element already in the scene is re-emitted with a bumped `version`, since
   * that is the only way a change reaches disk — see mergeElements.
   */
  const bind = (containerId: string, child: { id: string; type: 'arrow' | 'text' }): void => {
    const el = look(containerId)
    if (!el) throw new UnknownTargetError(containerId)
    const existing = (el.boundElements as Array<{ id: string; type: string }> | null) ?? []
    if (existing.some((b) => b.id === child.id)) return
    const touched = out.has(containerId)
    put({
      ...el,
      boundElements: [...existing, child],
      // A brand-new element from this same call is still at version 1 and has
      // not been written anywhere yet — bumping it would be counting an edit
      // that never happened.
      version: touched ? el.version : el.version + 1,
      versionNonce: nonce(),
      updated: now
    })
  }

  const shapes = skeletons.filter((s) => s.type !== 'arrow' && s.type !== 'line')
  const links = skeletons.filter((s) => s.type === 'arrow' || s.type === 'line')

  // Shapes first, so the arrows in the same call can bind to them.
  for (const s of shapes) {
    const id = s.id ?? newId()
    const isText = s.type === 'text'
    const content = isText ? (s.text ?? s.label ?? '') : undefined
    const width = s.width ?? (isText ? textWidth(content ?? '') : s.type === 'frame' ? 400 : 200)
    const height = s.height ?? (isText ? textHeight(content ?? '') : s.type === 'frame' ? 300 : 100)

    const el: DrawElement = {
      ...base(id, s.type, now),
      x: s.x ?? 0,
      y: s.y ?? 0,
      width,
      height,
      strokeColor: s.strokeColor ?? DEFAULT_STROKE,
      backgroundColor: s.backgroundColor ?? DEFAULT_BG
    }

    if (isText) {
      Object.assign(el, {
        text: content,
        originalText: content,
        fontSize: FONT_SIZE,
        fontFamily: FONT_FAMILY,
        textAlign: 'left',
        verticalAlign: 'top',
        containerId: null,
        autoResize: true,
        lineHeight: LINE_HEIGHT
      })
    } else if (s.type === 'frame') {
      // A frame's caption is its `name`, not a bound text child.
      Object.assign(el, { name: s.label ?? s.text ?? null, roundness: null })
    } else {
      // Rounded corners are the Excalidraw default for a rectangle-ish shape.
      Object.assign(el, { roundness: { type: 3 } })
    }
    put(el)

    // A label on a shape is a text element bound INSIDE it — same as typing into
    // the shape on the canvas, so it moves and resizes with its container.
    if (!isText && s.type !== 'frame' && s.label) {
      put(labelFor(s.label, el, now))
      bind(id, { id: labelIdOf(el), type: 'text' })
    }
  }

  // Then the connectors, which need both endpoints to exist.
  for (const s of links) {
    const id = s.id ?? newId()
    const from = s.start ? look(s.start) : undefined
    const to = s.end ? look(s.end) : undefined
    if (s.start && !from) throw new UnknownTargetError(s.start)
    if (s.end && !to) throw new UnknownTargetError(s.end)

    let start: [number, number]
    let end: [number, number]
    if (from && to) {
      const a = boxOf(from)
      const b = boxOf(to)
      start = edgePoint(a, centerOf(b), ARROW_GAP)
      end = edgePoint(b, centerOf(a), ARROW_GAP)
    } else {
      // A free-floating connector: the skeleton's own geometry is all there is.
      start = [s.x ?? 0, s.y ?? 0]
      end = [(s.x ?? 0) + (s.width ?? 100), (s.y ?? 0) + (s.height ?? 0)]
    }

    const el: DrawElement = {
      ...base(id, s.type, now),
      x: start[0],
      y: start[1],
      width: Math.abs(end[0] - start[0]),
      height: Math.abs(end[1] - start[1]),
      strokeColor: s.strokeColor ?? DEFAULT_STROKE,
      backgroundColor: s.backgroundColor ?? DEFAULT_BG,
      // Points are LOCAL to x/y, which is why the first one is always the origin.
      points: [
        [0, 0],
        [end[0] - start[0], end[1] - start[1]]
      ],
      lastCommittedPoint: null,
      startBinding: from ? { elementId: from.id, focus: 0, gap: ARROW_GAP } : null,
      endBinding: to ? { elementId: to.id, focus: 0, gap: ARROW_GAP } : null,
      startArrowhead: null,
      endArrowhead: s.type === 'arrow' ? 'arrow' : null,
      roundness: { type: 2 }
    }
    if (s.type === 'arrow') el.elbowed = false
    put(el)

    // The binding is two-sided: without the entry on the shape, dragging the
    // shape leaves the arrow behind.
    if (from) bind(from.id, { id, type: 'arrow' })
    if (to) bind(to.id, { id, type: 'arrow' })

    if (s.label) {
      put(labelFor(s.label, el, now))
      bind(id, { id: labelIdOf(el), type: 'text' })
    }
  }

  return [...out.values()]
}

// A container's label has a derived id so the second write of the same skeleton
// amends the same text element instead of stacking a new one on top of it.
const labelIdOf = (container: DrawElement): string => `${container.id}-label`

/** The bound text child that draws a shape's (or an arrow's) caption. */
function labelFor(text: string, container: DrawElement, now: number): DrawElement {
  const linear = container.type === 'arrow' || container.type === 'line'
  // A shape wraps its caption, so the caption is capped by the shape. An arrow
  // does not: its `width` is the span between two boxes and clamping to it
  // turns "enqueue" into "que" on any arrow that runs mostly vertically.
  const width = linear ? textWidth(text) : Math.min(textWidth(text), Math.max(20, Number(container.width) - 16))
  const height = textHeight(text)
  const box = boxOf(container)
  // An arrow's own box is not its extent — x/y is where it STARTS and its
  // points go from there, possibly leftwards or upwards. The midpoint has to
  // come off the points, or a right-to-left arrow labels itself into thin air.
  const [cx, cy] = linear ? linearMidpoint(container) : centerOf(box)
  return {
    ...base(labelIdOf(container), 'text', now),
    // Centred on the container. Excalidraw re-lays bound text out itself on the
    // first edit; this only has to be right before anyone touches it.
    x: cx - width / 2,
    y: cy - height / 2,
    width,
    height,
    text,
    originalText: text,
    fontSize: FONT_SIZE,
    fontFamily: FONT_FAMILY,
    textAlign: 'center',
    verticalAlign: 'middle',
    containerId: container.id,
    autoResize: false,
    lineHeight: LINE_HEIGHT,
    strokeColor: DEFAULT_STROKE
  }
}

/** The middle of a linear element, in scene coordinates. */
function linearMidpoint(el: DrawElement): [number, number] {
  const points = (el.points as Array<[number, number]> | undefined) ?? []
  const last = points[points.length - 1] ?? [0, 0]
  return [Number(el.x ?? 0) + last[0] / 2, Number(el.y ?? 0) + last[1] / 2]
}

/**
 * Mark elements deleted, as upserts.
 *
 * Erasing is not a separate operation in the write contract — a removal is an
 * element with `isDeleted` and a bumped `version`, so it competes with a
 * concurrent edit by the same rule everything else does. Ids that are not in the
 * scene (or already gone) are skipped rather than refused: erasing twice is not
 * an error, it is the same outcome.
 */
export function eraseElements(scene: DrawElement[], ids: string[], now: number = Date.now()): DrawElement[] {
  const wanted = new Set(ids)
  return scene
    .filter((el) => wanted.has(el.id) && !el.isDeleted)
    .map((el) => ({ ...el, isDeleted: true, version: el.version + 1, versionNonce: nonce(), updated: now }))
}

/**
 * Reposition (and optionally resize) elements, as upserts.
 *
 * A move is not a skeleton: re-expanding would throw away everything the user
 * drew into the element — its stroke, its label's own edits, a freedraw's
 * points. This copies the element and changes four numbers.
 *
 * A moved shape's bound arrows are NOT recomputed here: Excalidraw does that
 * from the bindings when the scene loads, and duplicating the geometry would be
 * a second, drifting implementation of it.
 */
export function moveElements(
  scene: DrawElement[],
  moves: Array<{ id: string; x: number; y: number; width?: number; height?: number }>,
  now: number = Date.now()
): DrawElement[] {
  const byId = new Map(scene.map((el) => [el.id, el]))
  return moves.map((m) => {
    const el = byId.get(m.id)
    if (!el) throw new UnknownTargetError(m.id)
    return {
      ...el,
      x: m.x,
      y: m.y,
      width: m.width ?? el.width,
      height: m.height ?? el.height,
      version: el.version + 1,
      versionNonce: nonce(),
      updated: now
    }
  })
}
