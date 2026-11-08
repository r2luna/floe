// Editor themes Floe ships — `[appearance] theme = "monokai-pro"` and the rest.
//
// Each one is written as an Omarchy colors.toml table and worn through the same
// pipeline (omarchyPalette.ts): the theme supplies the hues, Floe keeps its own
// surface→text steps. Values come from each theme's VS Code (or terminal) port.

import { resolveOmarchyPalette, type OmarchyPalette } from './omarchyPalette.ts'

const RAW = {
  // Monokai Pro, the default filter. Sidebar under the editor, yellow accent.
  'monokai-pro': {
    mode: 'dark',
    background: '#2d2a2e',
    dark_background: '#221f22',
    foreground: '#fcfcfa',
    accent: '#ffd866',
    muted: '#727072',
    selection: '#5b595c',
    color0: '#403e41',
    red: '#ff6188',
    green: '#a9dc76',
    yellow: '#ffd866',
    blue: '#fc9867',
    magenta: '#ab9df2',
    cyan: '#78dce8'
  },
  // Base16 Tomorrow — the light scheme.
  tomorrow: {
    mode: 'light',
    background: '#ffffff',
    foreground: '#4d4d4c',
    bright_foreground: '#1d1f21',
    accent: '#4271ae',
    muted: '#8e908c',
    selection: '#d6d6d6',
    red: '#c82829',
    green: '#718c00',
    yellow: '#eab700',
    blue: '#4271ae',
    magenta: '#8959a8',
    cyan: '#3e999f'
  },
  // Base16 Tomorrow Night — the dark one.
  'tomorrow-night': {
    mode: 'dark',
    background: '#1d1f21',
    foreground: '#c5c8c6',
    bright_foreground: '#ffffff',
    accent: '#81a2be',
    muted: '#969896',
    selection: '#373b41',
    red: '#cc6666',
    green: '#b5bd68',
    yellow: '#f0c674',
    blue: '#81a2be',
    magenta: '#b294bb',
    cyan: '#8abeb7'
  },
  // Vesper. Near-monochrome; the ANSI set is its terminal port's.
  vesper: {
    mode: 'dark',
    background: '#101010',
    foreground: '#ffffff',
    accent: '#ffc799',
    muted: '#7e7e7e',
    selection: '#3a3a3a',
    red: '#f5a191',
    green: '#90b99f',
    yellow: '#e6b99d',
    blue: '#aca1cf',
    magenta: '#e29eca',
    cyan: '#ea83a5',
    bright_red: '#ff8080',
    bright_green: '#99ffe4',
    bright_yellow: '#ffc799',
    bright_blue: '#b9aeda',
    bright_magenta: '#ecaad6',
    bright_cyan: '#f591b2'
  },
  // Rosé Pine, the main variant.
  'rose-pine': {
    mode: 'dark',
    background: '#191724',
    foreground: '#e0def4',
    accent: '#ebbcba',
    muted: '#6e6a86',
    selection: '#403d52',
    color0: '#26233a',
    red: '#eb6f92',
    green: '#31748f',
    yellow: '#f6c177',
    blue: '#9ccfd8',
    magenta: '#c4a7e7',
    cyan: '#ebbcba'
  },
  // Forest Night — github.com/ForrestKnight/forest-night-theme.
  'forest-night': {
    mode: 'dark',
    background: '#1a2125',
    foreground: '#c9d1d9',
    bright_foreground: '#ffffff',
    accent: '#9b59b6',
    muted: '#4a5568',
    selection: '#3a4a55',
    red: '#e91e63',
    green: '#8fbc8f',
    yellow: '#f39c12',
    blue: '#4ecdc4',
    magenta: '#9b59b6',
    cyan: '#4ecdc4',
    bright_red: '#e91e63',
    bright_green: '#8fbc8f',
    bright_yellow: '#f39c12',
    bright_blue: '#66d9ef',
    bright_magenta: '#9b59b6',
    bright_cyan: '#4ecdc4'
  }
} as const

export type BuiltinThemeId = keyof typeof RAW

export const BUILTIN_THEMES = Object.keys(RAW) as BuiltinThemeId[]

// What `[appearance] dark-theme` and `light-theme` accept. `floe` is the app's
// own palette for that mode; the rest are the shipped themes drawn for it.
const ofMode = (mode: 'dark' | 'light'): BuiltinThemeId[] =>
  BUILTIN_THEMES.filter((id) => RAW[id].mode === mode)
export const DARK_THEMES = ['floe', ...ofMode('dark')] as const
export const LIGHT_THEMES = ['floe', ...ofMode('light')] as const

/** The palette for a shipped theme, or null when `theme` is not one. */
export function builtinPalette(theme: string): OmarchyPalette | null {
  const raw = (RAW as Record<string, Record<string, string>>)[theme]
  return raw ? resolveOmarchyPalette(raw) : null
}
