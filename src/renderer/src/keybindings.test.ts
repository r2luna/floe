import assert from 'node:assert/strict'
import test from 'node:test'
import { chordOf, formatChord, resolveOverride } from './keybindings.ts'

test('a bare key is not a chord', () => {
  // The rule that keeps a rebind from eating a letter you still need to type.
  assert.equal(chordOf({ key: 'p' }), null)
  assert.equal(chordOf({ key: 'Escape' }), null)
})

test('a modifier held alone is not a chord yet', () => {
  assert.equal(chordOf({ key: 'Meta', meta: true }), null)
  assert.equal(chordOf({ key: 'Shift', shift: true }), null)
})

test('modifiers normalise to one order whatever the press', () => {
  assert.equal(chordOf({ key: 'P', meta: true, shift: true }), 'shift+meta+p')
  assert.equal(chordOf({ key: 'p', shift: true, meta: true }), 'shift+meta+p')
})

test('a chord formats the way the keyboard prints it', () => {
  assert.equal(formatChord('shift+meta+p'), '⇧⌘P')
  assert.equal(formatChord('ctrl+l'), '⌃L')
  assert.equal(formatChord('meta+enter'), '⌘↵')
  assert.equal(formatChord('meta+arrowdown'), '⌘↓')
})

test('an override resolves to its command', () => {
  const overrides = { 'panel.close': 'ctrl+w' }
  assert.deepEqual(resolveOverride({ key: 'w', ctrl: true }, overrides), { id: 'panel.close' })
})

test('an unbound chord resolves to nothing', () => {
  assert.equal(resolveOverride({ key: 'q', ctrl: true }, { 'panel.close': 'ctrl+w' }), null)
  assert.equal(resolveOverride({ key: 'w' }, { 'panel.close': 'ctrl+w' }), null)
})

test('a raw DOM event shape resolves to nothing', () => {
  // DOM uses metaKey/ctrlKey; passing one straight in must not half-match and
  // silently fire the wrong command. This bit us once already.
  const raw = { key: 'w', metaKey: true, ctrlKey: true } as unknown as Parameters<
    typeof resolveOverride
  >[0]
  assert.equal(resolveOverride(raw, { 'panel.close': 'ctrl+w' }), null)
})
