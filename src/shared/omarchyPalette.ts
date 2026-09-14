// Omarchy's desktop palette, and how Floe wears it — `[appearance] theme = "omarchy"`.
//
// Omarchy (omarchy.org) keeps the theme in force at
// `~/.local/state/omarchy/current/theme/colors.toml`: a flat table of semantic
// colours (background, foreground, accent, the ANSI hues). main/omarchyTheme.ts
// reads and watches it; this file is the pure half both sides share.
//
// The palette supplies HUES, Floe keeps its RATIOS. Every grey in the sheet is a
// step between the panel and the text — a border is 9% of the way, dim text 52%
// — and those steps were tuned by eye in index.css. Re-deriving each token along
// Omarchy's own background→foreground line keeps that hierarchy, where mapping
// tokens to Omarchy's few named shades would collapse half of them into one.

export const OMARCHY_COLORS = [
  'background',
  'dark_background',
  'foreground',
  'bright_foreground',
  'accent',
  'muted',
  'selection',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'bright_red',
  'bright_green',
  'bright_yellow',
  'bright_blue',
  'bright_magenta',
  'bright_cyan'
] as const

export type OmarchyColor = (typeof OMARCHY_COLORS)[number]

export interface OmarchyPalette {
  mode: 'dark' | 'light'
  /** Every entry resolved to `#rrggbb` — see resolveOmarchyPalette. */
  colors: Record<OmarchyColor, string>
}

const HEX = /^#[0-9a-f]{6}$/i

const rgb = (hex: string): number[] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))

/** `pct` percent of the way from `a` to `b` — Omarchy's own `mix`, rounded the same way. */
export function mix(a: string, b: string, pct: number): string {
  const from = rgb(a)
  const to = rgb(b)
  const t = pct / 100
  return `#${from
    .map((c, i) => Math.round(c * (1 - t) + to[i] * t).toString(16).padStart(2, '0'))
    .join('')}`
}

/**
 * The file's values, with Omarchy's fallback cascade applied.
 *
 * Mirrors `omarchy-theme-color` for the keys Floe reads, so a theme written
 * before the semantic names (only `color0`…`color15`, or the short `bg`/`fg`)
 * paints the same colours here as it does in the user's terminal. Null when
 * there is no background or foreground to build on: every token is derived
 * from those two.
 */
export function resolveOmarchyPalette(
  raw: Record<string, unknown>,
  lightModeFile = false
): OmarchyPalette | null {
  const v = new Map<string, string>()
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string' && HEX.test(value.trim())) v.set(key, value.trim().toLowerCase())
  }
  const pick = (...keys: string[]): string | undefined =>
    keys.map((k) => v.get(k)).find((x) => x !== undefined)

  const background = pick('background', 'bg', 'color0')
  const foreground = pick('foreground', 'fg', 'color7')
  if (!background || !foreground) return null

  const hue = (name: string, ansi: string, ...more: string[]): string =>
    pick(name, ...more, ansi) ?? foreground
  const red = hue('red', 'color1')
  const green = hue('green', 'color2')
  const yellow = hue('yellow', 'color3')
  const blue = hue('blue', 'color4')
  const magenta = hue('magenta', 'color5', 'purple')
  const cyan = hue('cyan', 'color6')
  const bright = (name: string, ansi: string, base: string, ...more: string[]): string =>
    pick(name, ...more, ansi) ?? mix(base, '#ffffff', 20)

  const colors: Record<OmarchyColor, string> = {
    background,
    dark_background: pick('dark_background', 'dark_bg') ?? mix(background, '#000000', 25),
    foreground,
    bright_foreground: pick('bright_foreground', 'bright_fg', 'color15') ?? foreground,
    // Omarchy has no fallback for the accent — its templates skip a theme that
    // lacks one. Blue is the hue every palette has and the one closest in role.
    accent: pick('accent') ?? blue,
    muted: pick('muted', 'color8', 'dark_foreground', 'dark_fg') ?? foreground,
    selection: pick('selection', 'selection_background', 'color8') ?? background,
    red,
    green,
    yellow,
    blue,
    magenta,
    cyan,
    bright_red: bright('bright_red', 'color9', red),
    bright_green: bright('bright_green', 'color10', green),
    bright_yellow: bright('bright_yellow', 'color11', yellow),
    bright_blue: bright('bright_blue', 'color12', blue),
    bright_magenta: bright('bright_magenta', 'color13', magenta, 'bright_purple'),
    bright_cyan: bright('bright_cyan', 'color14', cyan)
  }
  return { mode: omarchyMode(raw, lightModeFile, background), colors }
}

/** `mode`, then the legacy `theme_type`, then a `light.mode` file, then the background's luminance. */
function omarchyMode(raw: Record<string, unknown>, lightModeFile: boolean, background: string): 'dark' | 'light' {
  for (const key of ['mode', 'theme_type']) {
    const value = raw[key]
    if (value === 'dark' || value === 'light') return value
  }
  if (lightModeFile) return 'light'
  return rgb(background).reduce((a, b) => a + b, 0) > 382 ? 'light' : 'dark'
}

// Percent of the way from the surface to the text, per token — fitted to the
// hand-tuned values in index.css (`:root` and `:root[data-theme='light']`).
// Light runs wider because the same step reads fainter on a bright surface.
const STEPS = {
  dark: { focused: 2, well: 5, lineSoft: 5, line: 9, edge: 21, timeDim: 35, faint: 40, dim: 52, dimmer: 63, dimmest: 71 },
  light: { focused: 0, well: 8, lineSoft: 13, line: 19, edge: 29, timeDim: 50, faint: 53, dim: 69, dimmer: 60, dimmest: 65 }
}

const channels = (hex: string): string => rgb(hex).join(' ')

/**
 * The stylesheet tokens this palette overrides, ready for `style.setProperty`.
 *
 * Only the base tokens: every component rule reads these, so setting them inline
 * on <html> repaints the app without a second stylesheet. The surfaces go out
 * as `-rgb` channels because the glass block re-tints them at an alpha.
 *
 * The two modes stack the surfaces the way index.css does. Dark: the window is
 * the darkest and a panel sits above it. Light: the window is the brightest,
 * a panel is a shade below, and the focused panel comes back up to it.
 */
export function omarchyCssVars(palette: OmarchyPalette): Record<string, string> {
  const c = palette.colors
  const light = palette.mode === 'light'
  const s = STEPS[palette.mode]
  const step = (pct: number): string => mix(c.background, c.foreground, pct)
  return {
    '--bg': light ? c.background : c.dark_background,
    '--panel-rgb': channels(light ? step(3) : c.background),
    '--panel-focused-rgb': channels(step(s.focused)),
    '--well-rgb': channels(step(s.well)),
    '--line': step(s.line),
    '--line-soft': step(s.lineSoft),
    '--edge': step(s.edge),
    '--text': c.foreground,
    '--text-strong': mix(c.foreground, light ? '#000000' : '#ffffff', 50),
    '--dim': step(s.dim),
    '--faint': step(s.faint),
    '--dimmer': step(s.dimmer),
    '--dimmest': step(s.dimmest),
    '--time-dim': step(s.timeDim),
    '--live': c.green,
    '--working': c.blue,
    '--accent': c.accent,
    '--find-hit': `${c.yellow}${light ? '99' : '40'}`
  }
}

/** The names omarchyCssVars sets — what has to be cleared to go back to the sheet. */
export const OMARCHY_CSS_VARS = Object.keys(
  omarchyCssVars({
    mode: 'dark',
    colors: Object.fromEntries(OMARCHY_COLORS.map((k) => [k, '#000000'])) as Record<OmarchyColor, string>
  })
)

/**
 * The terminal's palette under this theme — the same mapping Omarchy's own
 * alacritty template uses, so a shell in Floe matches the one beside it.
 */
export function omarchyXtermTheme(palette: OmarchyPalette): Record<string, string> {
  const c = palette.colors
  return {
    background: '#00000000', // transparent — the panel's own fill shows through
    foreground: c.foreground,
    cursor: c.bright_foreground,
    selectionBackground: c.selection,
    selectionForeground: c.bright_foreground,
    black: c.background,
    red: c.red,
    green: c.green,
    yellow: c.yellow,
    blue: c.blue,
    magenta: c.magenta,
    cyan: c.cyan,
    white: c.foreground,
    brightBlack: c.muted,
    brightRed: c.bright_red,
    brightGreen: c.bright_green,
    brightYellow: c.bright_yellow,
    brightBlue: c.bright_blue,
    brightMagenta: c.bright_magenta,
    brightCyan: c.bright_cyan,
    brightWhite: c.bright_foreground
  }
}

/** The terminal panel's opaque fill, for OSC 11 — the `--panel` omarchyCssVars sets. */
export const omarchyPanelFill = (palette: OmarchyPalette): string =>
  palette.mode === 'light'
    ? mix(palette.colors.background, palette.colors.foreground, 3)
    : palette.colors.background
