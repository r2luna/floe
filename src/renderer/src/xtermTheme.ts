// The palette every xterm in the app is built with, in one place.
//
// Two panels host a terminal now — the shell and a command's output — and a
// second copy of these values would drift the day one of them is tuned. xterm
// needs concrete values at construction, which is why they are literals here
// rather than read from the CSS variables: reading computed styles at mount
// would tie the shell's palette to whatever had painted first.

export const XTERM_THEME = {
  background: '#00000000', // transparent — the panel's own fill shows through
  foreground: '#c9ccd2',
  cursor: '#c9ccd2',
  selectionBackground: '#35496e88',
  black: '#22252c',
  red: '#c07a72',
  green: '#6ea86e',
  yellow: '#c9a05f',
  blue: '#7f9fd8',
  magenta: '#c07fb8',
  cyan: '#6fc3c3',
  white: '#c9ccd2',
  brightBlack: '#6d7280',
  brightRed: '#d3948c',
  brightGreen: '#8cc48c',
  brightYellow: '#dcbb7f',
  brightBlue: '#9db8e4',
  brightMagenta: '#d29ac9',
  brightCyan: '#8fd6d6',
  brightWhite: '#e8eaee'
}

// The solid colour to answer OSC 11 with. The theme background above is
// transparent so the panel shows through, but a program asking "what colour is
// the background?" must not be told "none": xterm's own answer is the
// transparent fill, which every program reads as black.
export const SOLID_BG = '#141519'

// The palette in force. Only `theme = "omarchy"` moves it off the literals
// above (see appearance.ts); every live terminal is re-tinted when it does.
let current: { theme: Record<string, string>; solidBg: string } = { theme: XTERM_THEME, solidBg: SOLID_BG }
const watchers = new Set<() => void>()

export const xtermTheme = (): Record<string, string> => current.theme
export const xtermSolidBg = (): string => current.solidBg

/** Swap the palette — null goes back to Floe's own. */
export function setXtermTheme(next: { theme: Record<string, string>; solidBg: string } | null): void {
  current = next ?? { theme: XTERM_THEME, solidBg: SOLID_BG }
  for (const w of watchers) w()
}

/** Call `cb` whenever the palette changes; returns the unsubscribe. */
export function onXtermTheme(cb: () => void): () => void {
  watchers.add(cb)
  return () => void watchers.delete(cb)
}

// xterm's OSC colour replies use 16-bit channels — `rgb:rrrr/gggg/bbbb`. A plain
// hex answer is not the format the query asks for and programs ignore it.
export const rgbChannels = (hex: string): string =>
  [1, 3, 5]
    .map((i) => {
      const b = hex.slice(i, i + 2)
      return b + b
    })
    .join('/')


