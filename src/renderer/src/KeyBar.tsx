import { useEffect, useRef, useState } from 'react'
import { CTRL_KEYS, TERM_KEYS, ctrlByte, type Key } from './keyBytes'

/**
 * The keys a phone keyboard does not have, as chips above it.
 *
 * Narrow mode only, and only because the hardware forces it: Esc, Tab and Ctrl
 * are most of how a shell is driven and no on-screen keyboard offers them, so
 * without this the terminal panel is something you can read and not use. Every
 * chip is a key that already exists — nothing here is reachable only by touch,
 * which is why the bar registers no command and adds no MCP tool. On a keyboard
 * you press the key.
 *
 * Two sets, by what has focus: a terminal takes bytes on its pty, everything
 * else takes the chord the app already binds.
 */
export function KeyBar({
  termId,
  onChord,
  chordLabels = {}
}: {
  /** The pty under the focused panel, or null when it hosts none. */
  termId: string | null
  /** Runs one entry of APP_KEYS — a key press, or a command. */
  onChord: (chord: AppKey) => void
  /**
   * What a command's binding is CALLED, by command id. A chip that opens the
   * palette should say the key that does the same thing — and say the user's
   * key if they rebound it, rather than teaching one the app no longer has.
   */
  chordLabels?: Record<string, string>
}) {
  // Ctrl is a toggle here, not a hold: there is no key to hold down. Armed, it
  // eats the NEXT keystroke — from this bar or from the system keyboard — and
  // sends it as a control byte instead.
  const [armed, setArmed] = useState(false)
  const armedRef = useRef(armed)
  armedRef.current = armed

  useEffect(() => {
    if (!armed || !termId) return

    const fire = (char: string): boolean => {
      const byte = ctrlByte(char)
      if (!byte) return false
      void window.floe.terminal.write(termId, byte)
      setArmed(false)
      return true
    }

    // Capture, at the document, so xterm's own handler on the textarea below
    // never sees the key — it would send the plain character alongside ours.
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') return setArmed(false)
      if (e.key.length !== 1) return
      if (fire(e.key)) {
        e.preventDefault()
        e.stopPropagation()
      }
    }
    // Android's keyboards report a composing keyCode 229 and `key:
    // 'Unidentified'` for ordinary letters, so keydown alone would arm the
    // modifier and then drop every letter it was armed for. beforeinput carries
    // the character those events are missing.
    const onBeforeInput = (e: InputEvent): void => {
      if (!armedRef.current || !e.data || e.data.length !== 1) return
      if (fire(e.data)) e.preventDefault()
    }

    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('beforeinput', onBeforeInput, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('beforeinput', onBeforeInput, true)
    }
  }, [armed, termId])

  // Disarming on the way out: a modifier left armed on a panel you have left is
  // a keystroke that will go somewhere surprising later.
  useEffect(() => setArmed(false), [termId])

  const send = (data: string): void => {
    if (!termId) return
    if (armed) {
      const byte = data.length === 1 ? ctrlByte(data) : null
      setArmed(false)
      if (byte) return void window.floe.terminal.write(termId, byte)
    }
    void window.floe.terminal.write(termId, data)
  }

  const keys: Key[] = termId ? [...TERM_KEYS, ...CTRL_KEYS] : []

  return (
    <div
      className="keybar"
      // The bar must never take focus: the keystroke it is about to send has to
      // land in the panel, and a chip that stole focus first would send it into
      // the chip. mousedown is where the browser moves focus, including from a
      // tap — so that is what is cancelled, rather than the tap itself.
      onMouseDown={(e) => e.preventDefault()}
    >
      {termId ? (
        <>
          <button
            className="key key-w"
            data-armed={armed || undefined}
            aria-pressed={armed}
            onClick={() => setArmed((on) => !on)}
          >
            ctrl
          </button>
          {keys.map((key) => (
            <button
              key={key.label}
              className="key"
              data-wide={key.wide || undefined}
              onClick={() => send(key.data)}
            >
              {key.label}
            </button>
          ))}
        </>
      ) : (
        APP_KEYS.map((key) => (
          <button
            key={key.label}
            className="key"
            data-wide={key.wide || undefined}
            onClick={() => onChord(key)}
          >
            {(key.command && chordLabels[key.command]) || key.label}
          </button>
        ))
      )}
    </div>
  )
}

/**
 * Away from a terminal the same three things are missing: Esc and Tab, the
 * composer's newline (Shift+Enter, which an on-screen Enter cannot be), and a
 * way in to the palette — whose binding holds a modifier no phone keyboard has.
 *
 * The palette entry names a COMMAND rather than a key, and it is the only one
 * that does. The others are keys, and dispatching them is honest: the composer
 * and the keymap should see a tap exactly as they see a press. The palette's
 * binding is a super chord, and faking those modifiers to reach a command we
 * can simply run would be a longer road to the same place — and the wrong one
 * the day the user rebinds it.
 */
export type AppKey = {
  label: string
  key?: string
  command?: string
  shift?: boolean
  wide?: boolean
}

export const APP_KEYS: AppKey[] = [
  { label: 'cmds', command: 'palette.commands', wide: true },
  { label: 'esc', key: 'Escape', wide: true },
  { label: 'tab', key: 'Tab', wide: true },
  { label: '↑', key: 'ArrowUp' },
  { label: '↓', key: 'ArrowDown' },
  { label: '⇧⏎', key: 'Enter', shift: true, wide: true }
]
