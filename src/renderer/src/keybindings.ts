// User keybindings, layered on top of the built-in keymap.
//
// keys.ts stays a pure function with no state — that is what makes the default
// map testable. Anything a user changes lives here instead, as a plain
// `commandId -> chord` map, and the app asks this module first before falling
// back to the defaults.
//
// An override ADDS a way to reach a command; it does not remove the built-in
// one. Removing a default would mean encoding the whole default map as data
// rather than as code, and the thing people actually want from a rebind is
// "let me press this instead", not "take the old one away".

import type { KeyInput, Resolved } from './keys.ts'

/** A chord, normalised: modifiers in a fixed order, then the key, lowercased. */
export type Chord = string

const MODS: [keyof KeyInput, string][] = [
  ['ctrl', 'ctrl'],
  ['alt', 'alt'],
  ['shift', 'shift'],
  ['meta', 'meta']
]

/**
 * The chord a key press makes, or null when it isn't one.
 *
 * A bare letter is never a chord. Without that rule the first rebind would
 * shadow a letter everywhere, including inside the composer, and there would be
 * no way to type it again.
 */
export function chordOf(e: KeyInput): Chord | null {
  const key = e.key.toLowerCase()
  // Modifier keys held alone are a chord in progress, not a chord.
  if (['meta', 'control', 'shift', 'alt', 'dead'].includes(key)) return null
  const held = MODS.filter(([flag]) => e[flag])
  if (!held.length) return null
  return [...held.map(([, name]) => name), key].join('+')
}

const GLYPH: Record<string, string> = {
  ctrl: '⌃',
  alt: '⌥',
  shift: '⇧',
  meta: '⌘',
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→',
  enter: '↵',
  escape: 'Esc',
  ' ': 'Space',
  backspace: '⌫',
  tab: '⇥'
}

/** `meta+shift+p` → `⌘⇧P`. The order is the one printed on a Mac keyboard. */
export function formatChord(chord: Chord): string {
  const parts = chord.split('+')
  const key = parts[parts.length - 1]
  const mods = parts.slice(0, -1)
  const order = ['ctrl', 'alt', 'shift', 'meta']
  const glyphs = order.filter((m) => mods.includes(m)).map((m) => GLYPH[m])
  return glyphs.join('') + (GLYPH[key] ?? key.toUpperCase())
}

export type Overrides = Record<string, Chord>

const KEY = 'rookery.keybindings'

export function loadOverrides(): Overrides {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    // Anything that isn't a flat string map is discarded rather than trusted —
    // a bad value here would break every key press in the app.
    if (!parsed || typeof parsed !== 'object') return {}
    const out: Overrides = {}
    for (const [id, chord] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof chord === 'string' && chord) out[id] = chord
    }
    return out
  } catch {
    return {}
  }
}

export function saveOverrides(overrides: Overrides): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(overrides))
  } catch {
    /* no storage — the binding lasts as long as the window does */
  }
}

/**
 * The command a press maps to under these overrides, or null.
 *
 * Last one wins when two commands claim the same chord: an object cannot hold
 * the same key twice, so this is the later assignment in the map, which is also
 * the more recent rebind.
 */
export function resolveOverride(e: KeyInput, overrides: Overrides): Resolved | null {
  const chord = chordOf(e)
  if (!chord) return null
  for (const [id, bound] of Object.entries(overrides)) {
    if (bound === chord) return { id }
  }
  return null
}
