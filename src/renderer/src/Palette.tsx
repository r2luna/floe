import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { filterItems, splitTitle, type PaletteItem } from './fuzzy'
import { chordFor } from '../../shared/keymap'

/**
 * The command palette: a filtered list you drive entirely from the keyboard.
 *
 * It wears panel chrome — a 34px head, a hairline under it, a hint strip for a
 * foot — with one change: the head is where you type instead of a title. That
 * is what stops the palette from being a surface of its own; switching a
 * project and adding one are the same box in two states (see AddProject, which
 * is built from the same parts).
 *
 * With a `preview` the body splits: the list keeps the left, and the right side
 * explains the row under the cursor. Without one it is a plain list at the
 * narrow width, because half a box of empty space is worse than no pane.
 *
 * It renders into the app root rather than inside a panel on purpose — a
 * `position: fixed` overlay inside a panel would be clipped and sized by that
 * panel's box, and the palette belongs to the window, not to whatever happened
 * to be focused when you opened it.
 */
export function Palette({
  items,
  placeholder,
  value,
  dynamic,
  limit,
  sigil,
  hints,
  preview,
  onPick,
  onClose,
  onRebind
}: {
  items: PaletteItem[]
  placeholder: string
  /**
   * What the box starts with. A rename opens on the current name — editing one
   * character of it must not mean typing the whole thing back.
   */
  value?: string
  /**
   * Most rows to draw. The file list is thousands long, and a palette that
   * renders every one of them stutters on the first keystroke — nobody scrolls
   * past the fold of a fuzzy list anyway, they type another letter.
   */
  limit?: number
  /**
   * An item built from what you typed, offered first. This is how "Create
   * <name>" works: the option IS the query, so it cannot come from a fixed list.
   */
  dynamic?: (query: string) => PaletteItem | null
  /** One glyph at the head of the line, naming what this palette is asking. */
  sigil?: string
  /**
   * The foot, in the app's key-hint voice (`⏎ open · esc close`). Every palette
   * gets one: the same box teaching its keys in one use and hiding them in
   * another is how the shortcuts stayed a secret.
   */
  hints?: string
  /** The right-hand pane, drawn for the row under the cursor. */
  preview?: (item: PaletteItem) => ReactNode
  onPick: (id: string) => void
  onClose: () => void
  /**
   * Rebind the highlighted row. Supplied only by the command palette — the
   * project list has nothing to bind — and its presence is what puts the
   * rebinding chord in the foot.
   */
  onRebind?: (id: string, chord: string) => void
}) {
  const [query, setQuery] = useState(value ?? '')
  const [at, setAt] = useState(0)
  // Recording swallows the whole keyboard: the next chord is the new binding,
  // not a command. Holds the id being rebound so the list can stay on screen.
  const [recording, setRecording] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const results = useMemo(() => {
    const found = filterItems(items, query)
    const made = dynamic?.(query)
    // Built from the query, so it is never filtered — and first, because when
    // you are typing a new name that is what you meant.
    const rows = made ? [{ item: made, hits: [], score: -1 }, ...found] : found
    return limit ? rows.slice(0, limit) : rows
  }, [items, query, dynamic, limit])
  // Typing changes the list under the cursor, so it goes back to the top: the
  // best match for what you have typed so far is the one you meant.
  useEffect(() => setAt(0), [query])

  // Focused with the caret at the end, not selecting what is there: the text is
  // a starting point to edit, and a selection would make the first keystroke
  // throw it away.
  useEffect(() => {
    const el = input.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [])

  // Keep the cursor row in view as it moves past the fold.
  useEffect(() => {
    listRef.current?.children[at]?.scrollIntoView({ block: 'nearest' })
  }, [at])

  const onKeyDown = (e: React.KeyboardEvent) => {
    // While recording, every press is the binding being captured — including
    // the ones that would otherwise close the palette.
    if (recording) {
      e.preventDefault()
      if (e.key === 'Escape') return setRecording(null)
      const chord = chordFor({
        key: e.key,
        meta: e.metaKey,
        ctrl: e.ctrlKey,
        shift: e.shiftKey,
        alt: e.altKey
      })
      // A bare letter is refused rather than accepted: binding one would shadow
      // it everywhere, including in the composer. Keep waiting for a real chord.
      // (The keymap CAN hold bare keys — the defaults are full of them — but they
      // carry an implicit "not typing" that a chord recorded here would not, so
      // this stays a modifier-only capture and the file is where you write one.)
      if (!chord || !chord.includes('+')) return
      onRebind?.(recording, chord)
      setRecording(null)
      return
    }

    // Every key the palette handles is claimed here, so none of them reach the
    // app's global keymap while the palette is open.
    if (e.key === 'Escape') {
      e.preventDefault()
      return onClose()
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      const picked = results[at]
      if (!picked) return
      // ⌘↵ on a row rebinds it instead of running it — the two live one
      // modifier apart because you are already looking at the command you mean.
      if (e.metaKey && onRebind) return setRecording(picked.item.id)
      onPick(picked.item.id)
      return
    }
    // ⌃N/⌃P alongside the arrows: your hands are already on the keys.
    const down = e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')
    const up = e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')
    if (!down && !up) return
    e.preventDefault()
    if (!results.length) return
    // Wraps: at the bottom of a short list, down is a faster way to the top than
    // holding up.
    setAt((i) => (i + (down ? 1 : -1) + results.length) % results.length)
  }

  const here = results[at]?.item

  return (
    <div className="palette-scrim" onPointerDown={onClose}>
      <div className="palette" data-wide={preview ? '' : undefined} onPointerDown={(e) => e.stopPropagation()}>
        <div className="palette-head">
          {sigil && <span className="palette-sigil">{sigil}</span>}
          <input
            ref={input}
            className="palette-input"
            data-recording={recording ? '' : undefined}
            value={recording ? '' : query}
            readOnly={!!recording}
            placeholder={recording ? 'Press a key combination…' : placeholder}
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />
          {/* How many rows are under the query — the one fact the head can add
              without repeating what the list already says. */}
          <span className="palette-count">{results.length}</span>
        </div>

        <div className="palette-split">
          <div className="palette-list" ref={listRef}>
            {results.map(({ item, hits }, i) => (
              <Row
                key={item.id}
                item={item}
                hits={hits}
                at={i === at}
                // Pointer, not click: the input must keep focus, and mousedown
                // would blur it before the click landed.
                onPointerDown={(e) => {
                  e.preventDefault()
                  onPick(item.id)
                }}
                onPointerEnter={() => setAt(i)}
              />
            ))}
            {!results.length && <div className="palette-empty">No matches</div>}
          </div>

          {/* The row under the cursor, explained. Nothing to explain when the
              query matched nothing — an empty pane beside "No matches" would
              read as a pane that failed to load. */}
          {preview && here && <div className="palette-side">{preview(here)}</div>}
        </div>

        {/* The keys that act on the row you are on, so the palette teaches its
            own shortcuts instead of hiding them. */}
        <div className="palette-foot">
          {recording ? (
            <span className="palette-live">Waiting for a key combination · esc cancel</span>
          ) : (
            (hints ?? '⏎ pick · esc close')
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * One row: dim context, then the name at full strength, then whatever the item
 * carries on the right. The two halves come from splitTitle, so a deep path
 * loses its directory to the ellipsis rather than the file name you are reading.
 */
function Row({
  item,
  hits,
  at,
  onPointerDown,
  onPointerEnter
}: {
  item: PaletteItem
  hits: number[]
  at: boolean
  onPointerDown: (e: React.PointerEvent) => void
  onPointerEnter: () => void
}) {
  const { dir, name, dirHits, nameHits } = splitTitle(item.title, hits)
  return (
    <button
      className="palette-row"
      data-at={at || undefined}
      onPointerDown={onPointerDown}
      onPointerEnter={onPointerEnter}
    >
      {/* bdi, because the dim half is drawn rtl so its ellipsis eats the head
          of the path — without the isolation the trailing slash reorders to
          the front and `src/main/` reads as `/src/main`. */}
      {dir && (
        <span className="palette-dir">
          <bdi>{highlight(dir, dirHits)}</bdi>
        </span>
      )}
      <span className="palette-title">{highlight(name, nameHits)}</span>
      {item.detail && <span className="palette-detail">{item.detail}</span>}
      {item.badge && <span className="badge">{item.badge}</span>}
      {item.keys && <span className="palette-keys">{item.keys}</span>}
    </button>
  )
}

/** Mark the characters that matched, so you can see why a row is in the list. */
function highlight(text: string, hits: number[]) {
  if (!hits.length) return text
  const set = new Set(hits)
  return [...text].map((ch, i) =>
    set.has(i) ? (
      <b key={i} className="palette-hit">
        {ch}
      </b>
    ) : (
      ch
    )
  )
}
