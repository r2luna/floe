import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BUILTIN_THEMES, builtinPalette } from './builtinThemes.ts'

test('every shipped theme resolves to a full palette', () => {
  for (const id of BUILTIN_THEMES) {
    const palette = builtinPalette(id)
    assert.ok(palette, id)
    for (const value of Object.values(palette.colors)) assert.match(value, /^#[0-9a-f]{6}$/, id)
  }
})

test('tomorrow is light, the rest dark', () => {
  for (const id of BUILTIN_THEMES) assert.equal(builtinPalette(id)?.mode, id === 'tomorrow' ? 'light' : 'dark', id)
})

test('unknown names have no palette', () => {
  for (const id of ['system', 'dark', 'light', 'omarchy', 'nope']) assert.equal(builtinPalette(id), null)
})

