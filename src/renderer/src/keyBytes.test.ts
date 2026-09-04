import assert from 'node:assert/strict'
import test from 'node:test'
import { CTRL_KEYS, TERM_KEYS, ctrlByte } from './keyBytes.ts'

test('ctrl clears the top bits of a letter, in either case', () => {
  assert.equal(ctrlByte('c'), '\x03')
  assert.equal(ctrlByte('C'), '\x03')
  assert.equal(ctrlByte('a'), '\x01')
  assert.equal(ctrlByte('z'), '\x1a')
})

test('the run continues past Z, which is where ^[ and ^\\ come from', () => {
  assert.equal(ctrlByte('['), '\x1b', 'escape')
  assert.equal(ctrlByte('\\'), '\x1c', 'quit')
  assert.equal(ctrlByte('@'), '\x00')
  assert.equal(ctrlByte('_'), '\x1f')
})

test('the two that are not in the block', () => {
  assert.equal(ctrlByte(' '), '\x00', 'space is ^@')
  assert.equal(ctrlByte('?'), '\x7f', 'delete, not 0x1f-something')
})

test('anything that is not one key sends nothing', () => {
  assert.equal(ctrlByte(''), null)
  assert.equal(ctrlByte('Enter'), null)
  assert.equal(ctrlByte('ArrowUp'), null)
  assert.equal(ctrlByte('1'), null, 'digits are not in the block')
})

test('the chips a hand taps agree with the combos they stand for', () => {
  for (const key of CTRL_KEYS) {
    assert.equal(key.data, ctrlByte(key.label[1]), `${key.label} is ctrl+${key.label[1]}`)
  }
})

test('the arrows are the escape sequences a TUI reads', () => {
  const arrow = (label: string): string | undefined => TERM_KEYS.find((k) => k.label === label)?.data
  assert.equal(arrow('↑'), '\x1b[A')
  assert.equal(arrow('↓'), '\x1b[B')
  assert.equal(arrow('←'), '\x1b[D')
  assert.equal(arrow('→'), '\x1b[C')
})
