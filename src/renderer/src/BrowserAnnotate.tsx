import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import type { BrowserCapture } from '../../shared/types'
import {
  annotationFileName,
  annotationSummary,
  badgeAt,
  elementAt,
  flatScale,
  hintLabels,
  markLine,
  rectOf,
  TOOL_KEYS,
  TOOLS,
  type Delivery,
  type Mark,
  type Point,
  type Tool
} from './annotate'
import { useBrowserCover } from './browserCover'

const MARK_COLOR = '#e5484d'
/** A drag shorter than this was a click that wobbled, not a shape. */
const MIN_DRAG = 4

/** Mid-drag: the shape as it stands, drawn exactly as the finished mark will be. */
function draftFrom(tool: Tool, points: Point[]): Mark | null {
  const first = points[0]
  const last = points[points.length - 1]
  if (tool === 'box') return { kind: 'box', note: '', rect: rectOf(first, last) }
  if (tool === 'arrow') return { kind: 'arrow', note: '', from: first, to: last }
  if (tool === 'pen') return { kind: 'pen', note: '', points }
  return null
}

function dragged(points: Point[]): boolean {
  const first = points[0]
  return points.some((p) => Math.hypot(p.x - first.x, p.y - first.y) >= MIN_DRAG)
}

function MarkShape({ mark, n }: { mark: Mark; n?: number }): React.JSX.Element {
  const badge = badgeAt(mark)
  return (
    <g className="annotate-mark">
      {mark.kind === 'element' && (
        <rect x={mark.element.x} y={mark.element.y} width={mark.element.width} height={mark.element.height} />
      )}
      {mark.kind === 'box' && (
        <rect x={mark.rect.x} y={mark.rect.y} width={mark.rect.width} height={mark.rect.height} />
      )}
      {mark.kind === 'arrow' && (
        <line x1={mark.from.x} y1={mark.from.y} x2={mark.to.x} y2={mark.to.y} markerEnd="url(#annotate-head)" />
      )}
      {mark.kind === 'pen' && <polyline points={mark.points.map((p) => `${p.x},${p.y}`).join(' ')} />}
      {mark.kind === 'text' && (
        <text className="annotate-text" x={mark.at.x + 14} y={mark.at.y + 4}>
          {mark.note}
        </text>
      )}
      {n !== undefined && (
        <>
          <circle cx={badge.x} cy={badge.y} r={9} />
          <text className="annotate-num" x={badge.x} y={badge.y + 4}>
            {n}
          </text>
        </>
      )}
    </g>
  )
}

/** The same picture on a canvas, because a flat PNG is what an agent can read. */
function paintMark(ctx: CanvasRenderingContext2D, mark: Mark, n: number): void {
  ctx.strokeStyle = MARK_COLOR
  ctx.fillStyle = MARK_COLOR
  ctx.lineWidth = 2
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  if (mark.kind === 'element') {
    const { x, y, width, height } = mark.element
    ctx.strokeRect(x, y, width, height)
  } else if (mark.kind === 'box') {
    ctx.strokeRect(mark.rect.x, mark.rect.y, mark.rect.width, mark.rect.height)
  } else if (mark.kind === 'arrow') {
    const { from, to } = mark
    const angle = Math.atan2(to.y - from.y, to.x - from.x)
    ctx.beginPath()
    ctx.moveTo(from.x, from.y)
    ctx.lineTo(to.x, to.y)
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(to.x, to.y)
    ctx.lineTo(to.x - 12 * Math.cos(angle - 0.45), to.y - 12 * Math.sin(angle - 0.45))
    ctx.lineTo(to.x - 12 * Math.cos(angle + 0.45), to.y - 12 * Math.sin(angle + 0.45))
    ctx.closePath()
    ctx.fill()
  } else if (mark.kind === 'pen') {
    ctx.beginPath()
    mark.points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)))
    ctx.stroke()
  } else {
    ctx.font = '700 14px ui-sans-serif, system-ui, sans-serif'
    ctx.textAlign = 'left'
    ctx.textBaseline = 'alphabetic'
    ctx.fillText(mark.note, mark.at.x + 14, mark.at.y + 4)
  }
  const badge = badgeAt(mark)
  ctx.beginPath()
  ctx.arc(badge.x, badge.y, 9, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = '#ffffff'
  ctx.font = '700 11px ui-monospace, Menlo, monospace'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(String(n), badge.x, badge.y)
}

/** The capture with its marks burned in, sized for the agent. */
async function flatten(capture: BrowserCapture, marks: Mark[]): Promise<string> {
  const image = new Image()
  image.src = `data:${capture.mimeType};base64,${capture.data}`
  await image.decode()
  const scale = flatScale(capture, image.naturalWidth)
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(capture.width * scale)
  canvas.height = Math.round(capture.height * scale)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('No canvas context')
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
  ctx.scale(scale, scale)
  marks.forEach((mark, i) => paintMark(ctx, mark, i + 1))
  const url = canvas.toDataURL('image/png')
  return url.slice(url.indexOf(',') + 1)
}

/**
 * The page, frozen, with marks on top.
 *
 * A capture rather than an overlay because the native page view paints above all
 * of Floe's HTML, so nothing can be drawn over the live page from here. Mounting
 * this takes the view off screen; marks are in the capture's CSS pixels, which
 * the SVG's viewBox maps to the panel at any size.
 */
export function BrowserAnnotate({
  capture,
  startTool = 'element',
  onSend,
  onDiscard
}: {
  capture: BrowserCapture
  startTool?: Tool
  onSend: (delivery: Delivery) => void
  onDiscard: () => void
}): React.JSX.Element {
  useBrowserCover()
  const root = useRef<HTMLDivElement>(null)
  const stage = useRef<SVGSVGElement>(null)
  const [tool, setTool] = useState<Tool>(startTool)
  const [marks, setMarks] = useState<Mark[]>([])
  // The row whose description has the caret. The text itself lives on the mark,
  // so every row stays editable and nothing has to be merged back at send time.
  const [noting, setNoting] = useState<number | null>(null)
  const descriptions = useRef<(HTMLInputElement | null)[]>([])
  const describeNewest = useRef(false)
  const [prefix, setPrefix] = useState('')
  const [drag, setDrag] = useState<Point[] | null>(null)
  const [error, setError] = useState('')

  const targets = useMemo(() => capture.elements.filter((el) => el.interactive), [capture.elements])
  const hints = useMemo(() => {
    const labels = hintLabels(targets.length)
    return labels.map((label, i) => ({ label, element: targets[i] }))
  }, [targets])
  const hinting = tool === 'element' && noting === null
  const shownHints = hinting ? hints.filter((hint) => hint.label.startsWith(prefix)) : []
  const frozenAt = useMemo(() => new Date(capture.capturedAt).toLocaleTimeString(), [capture.capturedAt])

  useEffect(() => {
    root.current?.focus()
  }, [])

  // A new mark asks for its description straight away.
  useEffect(() => {
    if (!describeNewest.current) return
    describeNewest.current = false
    descriptions.current[marks.length - 1]?.focus()
  }, [marks.length])

  const place = (mark: Mark): void => {
    describeNewest.current = true
    setMarks((list) => [...list, mark])
    setPrefix('')
  }

  const describe = (target: Mark, note: string): void =>
    setMarks((list) => list.map((mark) => (mark === target ? { ...mark, note } : mark)))

  /** Leaving a row. Text with no words is not a mark: it would burn a number onto nothing. */
  const leave = (target: Mark): void => {
    setNoting(null)
    if (target.kind === 'text') setMarks((list) => list.filter((mark) => mark !== target || mark.note))
  }

  /** Back to the drawing keys. Blurring the row is what saves it. */
  const finishDescribing = (): void => root.current?.focus()

  const undo = (): void => {
    finishDescribing()
    setMarks((list) => list.slice(0, -1))
  }

  const send = (): void => {
    setError('')
    const sent = marks.filter((mark) => mark.kind !== 'text' || mark.note)
    flatten(capture, sent)
      .then((data) =>
        onSend({
          image: {
            id: `annotate-${capture.capturedAt}`,
            mediaType: 'image/png',
            data,
            name: annotationFileName(capture.url)
          },
          summary: annotationSummary(capture, sent)
        })
      )
      .catch((e: Error) => setError(e.message))
  }

  const pressHint = (key: string): boolean => {
    const next = prefix + key
    const hit = hints.find((hint) => hint.label === next)
    if (hit) {
      place({ kind: 'element', note: '', element: hit.element })
      return true
    }
    if (!hints.some((hint) => hint.label.startsWith(next))) return false
    setPrefix(next)
    return true
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    // A chip reached with Tab presses itself. Only the surface's own keys are ours.
    if (e.target instanceof HTMLButtonElement && (e.key === 'Enter' || e.key === ' ')) return
    const key = e.key.toLowerCase()
    if (e.key === 'Escape') {
      if (prefix) setPrefix('')
      else onDiscard()
    } else if (e.key === 'Enter') {
      send()
    } else if (hinting && prefix) {
      pressHint(key)
    } else if (key in TOOL_KEYS) {
      setTool(TOOL_KEYS[key])
    } else if (key === 'u') {
      undo()
    } else if (hinting) {
      pressHint(key)
    } else {
      return
    }
    e.preventDefault()
    e.stopPropagation()
  }

  /** A screen position in the capture's own pixels, whatever the panel's size. */
  const pointOf = (e: PointerEvent<SVGSVGElement>): Point => {
    const matrix = stage.current?.getScreenCTM()?.inverse()
    if (!matrix) return { x: 0, y: 0 }
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(matrix)
    return { x: Math.round(p.x), y: Math.round(p.y) }
  }

  const onPointerDown = (e: PointerEvent<SVGSVGElement>): void => {
    e.preventDefault()
    if (noting !== null) finishDescribing()
    const p = pointOf(e)
    if (tool === 'element') {
      const element = elementAt(capture.elements, p)
      if (element) place({ kind: 'element', note: '', element })
    } else if (tool === 'text') {
      place({ kind: 'text', note: '', at: p })
    } else {
      e.currentTarget.setPointerCapture(e.pointerId)
      setDrag([p])
    }
  }

  const onPointerMove = (e: PointerEvent<SVGSVGElement>): void => {
    if (!drag) return
    const p = pointOf(e)
    setDrag(tool === 'pen' ? [...drag, p] : [drag[0], p])
  }

  const onPointerUp = (): void => {
    if (!drag) return
    const mark = draftFrom(tool, drag)
    setDrag(null)
    if (mark && dragged(drag)) place(mark)
    else root.current?.focus()
  }

  const inFlight = drag ? draftFrom(tool, drag) : null

  return (
    <div
      ref={root}
      className="browser-annotate"
      tabIndex={-1}
      aria-label="Annotate browser page"
      onKeyDown={onKeyDown}
    >
      <svg
        ref={stage}
        className="annotate-stage"
        data-tool={tool}
        viewBox={`0 0 ${capture.width} ${capture.height}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        <defs>
          <marker id="annotate-head" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto">
            <path d="M0 0 L8 4 L0 8 Z" fill={MARK_COLOR} />
          </marker>
        </defs>
        <image href={`data:${capture.mimeType};base64,${capture.data}`} width={capture.width} height={capture.height} />
        {marks.map((mark, i) => (
          <MarkShape key={i} mark={mark} n={i + 1} />
        ))}
        {inFlight && <MarkShape mark={inFlight} />}
        {shownHints.map(({ label, element }) => (
          <g key={label} className="annotate-hint" data-hint={label}>
            <rect x={element.x} y={element.y} width={22} height={14} />
            <text x={element.x + 11} y={element.y + 11}>
              {label}
            </text>
          </g>
        ))}
      </svg>
      {marks.length > 0 && (
        <ol className="annotate-notes">
          {marks.map((mark, i) => (
            <li key={i} data-current={noting === i || undefined}>
              <span className="annotate-note-n">{i + 1}</span>
              <span className="annotate-note-el">
                {markLine({ ...mark, note: '' }, i + 1, capture.elements).replace(/^\d+\. /, '')}
              </span>
              <input
                ref={(el) => {
                  descriptions.current[i] = el
                }}
                aria-label={`Description for mark ${i + 1}`}
                placeholder={mark.kind === 'text' ? 'Text to draw' : 'Add a description…'}
                value={mark.note}
                onFocus={() => setNoting(i)}
                onBlur={() => leave(mark)}
                onChange={(e) => describe(mark, e.currentTarget.value)}
                onKeyDown={(e) => {
                  e.stopPropagation()
                  // Both keep what was typed: a row is edited in place, never thrown away.
                  if (e.key === 'Enter' || e.key === 'Escape') finishDescribing()
                }}
              />
            </li>
          ))}
        </ol>
      )}
      <div className="annotate-tools" role="toolbar" aria-label="Annotate tools">
        {TOOLS.map(({ tool: t, key, label }) => (
          <button
            key={t}
            type="button"
            className="annotate-chip"
            data-on={tool === t || undefined}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              finishDescribing()
              setTool(t)
            }}
          >
            <kbd>{key}</kbd>
            {label}
          </button>
        ))}
        <button
          type="button"
          className="annotate-chip"
          onMouseDown={(e) => e.preventDefault()}
          onClick={undo}
        >
          <kbd>u</kbd>undo
        </button>
      </div>
      {error && <div className="browser-error">Could not send this capture: {error}</div>}
      <div className="annotate-foot">
        <span className="annotate-url" title={capture.url}>
          {capture.url}
        </span>
        <span className="annotate-frozen">frozen {frozenAt}</span>
        <button type="button" className="annotate-chip" onMouseDown={(e) => e.preventDefault()} onClick={onDiscard}>
          <kbd>esc</kbd>discard
        </button>
        <button
          type="button"
          className="annotate-chip"
          data-on
          onMouseDown={(e) => e.preventDefault()}
          onClick={send}
        >
          {noting === null && <kbd>⏎</kbd>}
          send to composer
        </button>
      </div>
    </div>
  )
}
