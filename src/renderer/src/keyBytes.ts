/**
 * The bytes a key puts on a PTY's wire.
 *
 * A phone keyboard has no Esc, no Tab and no Ctrl, which is most of what a
 * shell is driven by — the terminal panel is unusable on a phone without a
 * surrogate for them. Nothing here is a new capability: these are the exact
 * bytes the physical keys send, which is why the bar that taps them needs no
 * command and no MCP tool of its own. It is a keyboard, not an action.
 */

export type Key = {
  /** What the chip says. Text, not a glyph: ⎋ and ↹ are tofu in our face. */
  label: string
  /** What goes to the PTY. */
  data: string
  /** Wider chip — for the words, not the single characters. */
  wide?: boolean
}

/**
 * Ctrl + a key, as one byte.
 *
 * ^A…^Z is the letter with its top three bits cleared, and the run continues
 * past Z through `@ [ \ ] ^ _` — which is where ^[ (escape) and ^\ (quit) come
 * from. `?` is the odd one out: it maps to DEL rather than into that block.
 */
export function ctrlByte(key: string): string | null {
  if (key.length !== 1) return null
  if (key === '?') return '\x7f'
  const code = key.toUpperCase().charCodeAt(0)
  // @ A-Z [ \ ] ^ _ — 0x40 to 0x5f, which clears to 0x00 to 0x1f.
  if (code >= 0x40 && code <= 0x5f) return String.fromCharCode(code - 0x40)
  // Space is ^@ — NUL — by the same rule, spelled out because 0x20 is not in
  // the block above.
  if (key === ' ') return '\x00'
  return null
}

/**
 * The terminal row. Ordered by what a hand reaches for: the two keys the phone
 * simply does not have, then the modifier, then the arrows (history and a TUI's
 * whole navigation), then the punctuation that is two taps deep on a phone
 * keyboard and constant in a shell.
 */
export const TERM_KEYS: Key[] = [
  { label: 'esc', data: '\x1b', wide: true },
  { label: 'tab', data: '\t', wide: true },
  { label: '↑', data: '\x1b[A' },
  { label: '↓', data: '\x1b[B' },
  { label: '←', data: '\x1b[D' },
  { label: '→', data: '\x1b[C' },
  { label: '|', data: '|' },
  { label: '~', data: '~' },
  { label: '/', data: '/' },
  { label: '-', data: '-' }
]

/**
 * The combos worth their own chip. Sticky ctrl reaches every other one, but
 * these four are half of all shell use and asking for two taps each — plus a
 * keystroke the on-screen keyboard has to deliver — is asking for the one that
 * cancels a runaway process to be the slowest thing on screen.
 */
export const CTRL_KEYS: Key[] = [
  { label: '^C', data: '\x03', wide: true },
  { label: '^D', data: '\x04', wide: true },
  { label: '^R', data: '\x12', wide: true },
  { label: '^Z', data: '\x1a', wide: true }
]
