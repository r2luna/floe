import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  OMARCHY_CSS_VARS,
  mix,
  omarchyCssVars,
  omarchyPanelFill,
  omarchyXtermTheme,
  resolveOmarchyPalette
} from './omarchyPalette.ts'

// Omarchy's shipped gruvbox, verbatim.
const GRUVBOX = {
  mode: 'dark',
  accent: '#7daea3',
  selection: '#504945',
  muted: '#665c54',
  background: '#282828',
  dark_background: '#1e1e1e',
  foreground: '#d4be98',
  bright_foreground: '#d4be98',
  red: '#ea6962',
  yellow: '#d8a657',
  green: '#a9b665',
  cyan: '#89b482',
  blue: '#7daea3',
  magenta: '#d3869b',
  bright_red: '#ea6962',
  bright_yellow: '#d8a657',
  bright_green: '#a9b665',
  bright_cyan: '#89b482',
  bright_blue: '#7daea3',
  bright_magenta: '#d3869b'
}

test('mix rounds per channel the way Omarchy does', () => {
  assert.equal(mix('#000000', '#ffffff', 50), '#808080')
  assert.equal(mix('#282828', '#000000', 25), '#1e1e1e')
  assert.equal(mix('#123456', '#abcdef', 0), '#123456')
})

test('a semantic colors.toml resolves as written', () => {
  const p = resolveOmarchyPalette(GRUVBOX)
  assert.equal(p?.mode, 'dark')
  assert.equal(p?.colors.accent, '#7daea3')
  assert.equal(p?.colors.dark_background, '#1e1e1e')
  assert.equal(p?.colors.selection, '#504945')
})

test('no background or foreground means no palette', () => {
  assert.equal(resolveOmarchyPalette({ background: '#000000' }), null)
  assert.equal(resolveOmarchyPalette({ foreground: '#ffffff' }), null)
  // Not hex: Floe mixes these, so an rgb() or a name is as good as absent.
  assert.equal(resolveOmarchyPalette({ background: 'black', foreground: '#ffffff' }), null)
})

test('an ANSI-only theme falls back through the legacy names', () => {
  const p = resolveOmarchyPalette({
    color0: '#1A1B26',
    color1: '#f7768e',
    color4: '#7aa2f7',
    color7: '#c0caf5',
    color8: '#565f89',
    color12: '#89b4fa',
    color15: '#ffffff',
    purple: '#bb9af7'
  })
  assert.ok(p)
  assert.equal(p.colors.background, '#1a1b26')
  assert.equal(p.colors.foreground, '#c0caf5')
  assert.equal(p.colors.red, '#f7768e')
  assert.equal(p.colors.magenta, '#bb9af7')
  assert.equal(p.colors.bright_blue, '#89b4fa')
  assert.equal(p.colors.bright_foreground, '#ffffff')
  assert.equal(p.colors.muted, '#565f89')
  assert.equal(p.colors.selection, '#565f89')
  // Missing everywhere: the accent borrows blue, a hue the foreground, a
  // bright hue is its base lifted 20% toward white, the dark background 25% down.
  assert.equal(p.colors.accent, '#7aa2f7')
  assert.equal(p.colors.green, '#c0caf5')
  assert.equal(p.colors.bright_red, mix('#f7768e', '#ffffff', 20))
  assert.equal(p.colors.dark_background, mix('#1a1b26', '#000000', 25))
})

test('the short bg/fg spellings count', () => {
  const p = resolveOmarchyPalette({ bg: '#101010', fg: '#eeeeee', dark_bg: '#050505', bright_fg: '#ffffff' })
  assert.equal(p?.colors.dark_background, '#050505')
  assert.equal(p?.colors.bright_foreground, '#ffffff')
  assert.equal(p?.colors.selection, '#101010')
})

test('mode: key, then theme_type, then light.mode, then luminance', () => {
  const base = { background: '#ffffff', foreground: '#000000' }
  assert.equal(resolveOmarchyPalette({ ...base, mode: 'dark' })?.mode, 'dark')
  assert.equal(resolveOmarchyPalette({ ...base, theme_type: 'dark' })?.mode, 'dark')
  assert.equal(resolveOmarchyPalette({ background: '#000000', foreground: '#ffffff' }, true)?.mode, 'light')
  assert.equal(resolveOmarchyPalette(base)?.mode, 'light')
  assert.equal(resolveOmarchyPalette({ background: '#202020', foreground: '#ffffff' })?.mode, 'dark')
})

test('dark stacks the window below the panel; light stacks it above', () => {
  const dark = omarchyCssVars(resolveOmarchyPalette(GRUVBOX)!)
  assert.equal(dark['--bg'], '#1e1e1e')
  assert.equal(dark['--panel-rgb'], '40 40 40')
  assert.equal(dark['--accent'], '#7daea3')
  assert.equal(dark['--find-hit'], '#d8a65740')

  const flexoki = resolveOmarchyPalette({ mode: 'light', background: '#FFFCF0', foreground: '#100F0F', yellow: '#D0A215' })!
  const light = omarchyCssVars(flexoki)
  assert.equal(light['--bg'], '#fffcf0')
  assert.equal(light['--panel-focused-rgb'], '255 252 240')
  assert.equal(light['--panel-rgb'], mix('#fffcf0', '#100f0f', 3).slice(1).match(/../g)!.map((h) => parseInt(h, 16)).join(' '))
  assert.equal(light['--text-strong'], mix('#100f0f', '#000000', 50))
  assert.equal(light['--find-hit'], '#d0a21599')
  assert.equal(omarchyPanelFill(flexoki), mix('#fffcf0', '#100f0f', 3))
})

test('every token the mapping sets is listed for clearing', () => {
  assert.deepEqual(OMARCHY_CSS_VARS, Object.keys(omarchyCssVars(resolveOmarchyPalette(GRUVBOX)!)))
})

test('the terminal takes the alacritty mapping', () => {
  const p = resolveOmarchyPalette(GRUVBOX)!
  const t = omarchyXtermTheme(p)
  assert.equal(t.black, '#282828')
  assert.equal(t.brightBlack, '#665c54')
  assert.equal(t.white, '#d4be98')
  assert.equal(t.cursor, '#d4be98')
  assert.equal(t.selectionBackground, '#504945')
  assert.equal(omarchyPanelFill(p), '#282828')
})
