import { useEffect, useMemo, useRef, useState } from 'react'
import { filterItems, type PaletteItem } from './fuzzy'
import { chordOf, formatChord, type Chord } from './keybindings'

/**
 * The command palette: a filtered list you drive entirely from the keyboard.
 *
 * It renders into the app root rather than inside a panel on purpose — a
 * `position: fixed` overlay inside a panel would be clipped and sized by that
 * panel's box, and the palette belongs to the window, not to whatever happened
 * to be focused when you opened it.
 */
export function Palette({
  items,
  placeholder,
  dynamic,
  onPick,
  onClose,
  onRebind
}: {
  items: PaletteItem[]
  placeholder: string
  /**
   * An item built from what you typed, offered first. This is how "Create
   * <name>" works: the option IS the query, so it cannot come from a fixed list.
   */
  dynamic?: (query: string) => PaletteItem | null
  onPick: (id: string) => void
  onClose: () => void
  /**
   * Rebind the highlighted row. Supplied only by the command palette — the
   * project list has nothing to bind — and its presence is what puts the
   * "Change Keybinding…" action in the footer.
   */
  onRebind?: (id: string, chord: Chord) => void
}) {
  const [query, setQuery] = useState('')
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
    return made ? [{ item: made, hits: [], score: -1 }, ...found] : found
  }, [items, query, dynamic])
  // Typing changes the list under the cursor, so it goes back to the top: the
  // best match for what you have typed so far is the one you meant.
  useEffect(() => setAt(0), [query])

  useEffect(() => input.current?.focus(), [])

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
      const chord = chordOf({
        key: e.key,
        meta: e.metaKey,
        ctrl: e.ctrlKey,
        shift: e.shiftKey,
        alt: e.altKey
      })
      // A bare letter is refused rather than accepted: binding one would shadow
      // it everywhere, including in the composer. Keep waiting for a real chord.
      if (!chord) return
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

  return (
    <div className="palette-scrim" onPointerDown={onClose}>
      <div className="palette" onPointerDown={(e) => e.stopPropagation()}>
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
        <div className="palette-list" ref={listRef}>
          {results.map(({ item, hits }, i) => (
            <button
              key={item.id}
              className="palette-row"
              data-at={i === at || undefined}
              // Pointer, not click: the input must keep focus, and mousedown
              // would blur it before the click landed.
              onPointerDown={(e) => {
                e.preventDefault()
                onPick(item.id)
              }}
              onPointerEnter={() => setAt(i)}
            >
              <span className="palette-title">{highlight(item.title, hits)}</span>
              {item.detail && <span className="palette-detail">{item.detail}</span>}
              {item.keys && <span className="palette-keys">{item.keys}</span>}
            </button>
          ))}
          {!results.length && <div className="palette-empty">No matches</div>}
        </div>

        {/* The actions available on the highlighted row, named with the keys
            that perform them — so the palette teaches its own shortcuts
            instead of hiding them. */}
        {onRebind && (
          <div className="palette-foot">
            {recording ? (
              <span className="palette-action palette-action-live">
                Waiting for a key combination
                <kbd>Esc</kbd>
              </span>
            ) : (
              <>
                <span className="palette-action">
                  Change Keybinding…
                  <kbd>{formatChord('meta+enter')}</kbd>
                </span>
                <span className="palette-action">
                  Run
                  <kbd>{formatChord('enter')}</kbd>
                </span>
              </>
            )}
          </div>
        )}
      </div>
    </div>
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
