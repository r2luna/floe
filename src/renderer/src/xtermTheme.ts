// The palette every xterm in the app is built with, in one place.
//
// Two panels host a terminal now — the shell and a command's output — and a
// second copy of these values would drift the day one of them is tuned. xterm
// needs concrete values at construction, which is why they are literals here
// rather than read from the CSS variables: reading computed styles at mount
// would tie the shell's palette to whatever had painted first.

export const XTERM_THEME_DARK = {
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

// Same hues as the dark palette, re-lit for a white panel — the dark values'
// light tones (foreground, brightBlack, the pastel ANSI colours) sit at
// L*80-90 and all but vanish on `--bg: #ffffff`. Every colour here is pulled
// down to the L*30-55 band `index.css` already uses for light-theme text
// (--text, --dim, --live, --working) so the same terminal reads on either
// background.
export const XTERM_THEME_LIGHT = {
  background: '#00000000',
  foreground: '#3d434e',
  cursor: '#3d434e',
  selectionBackground: '#c7d5f099',
  black: '#1b1e25',
  red: '#a8433a',
  green: '#2f7d52',
  yellow: '#8a6a1f',
  blue: '#3a64a8',
  magenta: '#a13f92',
  cyan: '#1f7a7a',
  white: '#3d434e',
  brightBlack: '#767c88',
  brightRed: '#c0554a',
  brightGreen: '#3f9a68',
  brightYellow: '#a8841f',
  brightBlue: '#4d7ac2',
  brightMagenta: '#b854a8',
  brightCyan: '#2f9494',
  brightWhite: '#1b1e25'
}

// The solid colour to answer OSC 11 with. The theme background above is
// transparent so the panel shows through, but a program asking "what colour is
// the background?" must not be told "none": xterm's own answer is the
// transparent fill, which every program reads as black.
export const SOLID_BG_DARK = '#141519'
export const SOLID_BG_LIGHT = '#ffffff'

// Floe's own mode, set by appearance.ts whenever light/dark resolves — kept
// apart from `override` below so an Omarchy palette can come and go without
// losing track of which base palette to fall back to.
let dark = true
// Set only while `theme = "omarchy"` is worn (see appearance.ts); every live
// terminal is re-tinted when it comes or goes.
let override: { theme: Record<string, string>; solidBg: string } | null = null
const watchers = new Set<() => void>()

function base(): { theme: Record<string, string>; solidBg: string } {
  return dark ? { theme: XTERM_THEME_DARK, solidBg: SOLID_BG_DARK } : { theme: XTERM_THEME_LIGHT, solidBg: SOLID_BG_LIGHT }
}

export const xtermTheme = (): Record<string, string> => (override ?? base()).theme
export const xtermSolidBg = (): string => (override ?? base()).solidBg

/** Swap the palette — null goes back to Floe's own (light or dark, per `setXtermMode`). */
export function setXtermTheme(next: { theme: Record<string, string>; solidBg: string } | null): void {
  override = next
  for (const w of watchers) w()
}

/** Tell the base palette which mode Floe resolved to, independent of any Omarchy override. */
export function setXtermMode(isDark: boolean): void {
  if (dark === isDark) return
  dark = isDark
  if (!override) for (const w of watchers) w()
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


