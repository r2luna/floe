import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendScrollback, newScrollback, MAX_BUFFER } from './terminalBuffer.ts'

const ENTER = '\x1b[?1049h'
const LEAVE = '\x1b[?1049l'

test('an exited TUI leaves nothing behind in the scrollback', () => {
  const sb = newScrollback()
  appendScrollback(sb, 'prompt$ nvim\r\n')
  appendScrollback(sb, ENTER + 'nvim frames'.repeat(100))
  appendScrollback(sb, 'more frames' + LEAVE + 'prompt$ ')
  assert.equal(sb.buffer, 'prompt$ nvim\r\nprompt$ ')
  assert.equal(sb.altDepth, 0)
})

test('a live TUI keeps its frames, starting at the enter sequence', () => {
  const sb = newScrollback()
  appendScrollback(sb, 'prompt$ nvim\r\n' + ENTER + 'frame')
  assert.equal(sb.altDepth, 1)
  assert.ok(sb.buffer.includes(ENTER))
  assert.ok(sb.buffer.endsWith('frame'))
})

test('nesting only drops the segment once the outermost TUI exits', () => {
  const sb = newScrollback()
  appendScrollback(sb, 'shell' + ENTER + 'nvim' + ENTER + 'lazygit' + LEAVE + 'nvim again')
  assert.equal(sb.altDepth, 1)
  appendScrollback(sb, LEAVE + '$ ')
  assert.equal(sb.buffer, 'shell$ ')
})

test('two TUI runs in one chunk both vanish', () => {
  const sb = newScrollback()
  appendScrollback(sb, `a${ENTER}xxx${LEAVE}b${ENTER}yyy${LEAVE}c`)
  assert.equal(sb.buffer, 'abc')
})

test('a leave with no enter (its start scrolled out) is harmless', () => {
  const sb = newScrollback()
  appendScrollback(sb, 'tail of a frame' + LEAVE + '$ ')
  assert.equal(sb.buffer, 'tail of a frame' + LEAVE + '$ ')
})

test('truncation keeps the live TUI window anchored', () => {
  const sb = newScrollback()
  appendScrollback(sb, 'x'.repeat(MAX_BUFFER))
  appendScrollback(sb, ENTER + 'frame')
  appendScrollback(sb, LEAVE + '$ ')
  // The enter sequence survived the window slide, so the frames still got cut.
  assert.ok(!sb.buffer.includes('frame'))
  assert.ok(sb.buffer.endsWith('$ '))
  assert.ok(sb.buffer.length <= MAX_BUFFER)
})
