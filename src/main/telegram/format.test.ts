import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  chunk,
  doneMessages,
  errorMessage,
  parseCommand,
  permissionMessage,
  questionMessage,
  sessionLabel
} from './format.ts'

const s = { id: 'a', title: 'Fix login', worktreePath: '/Users/me/code/floe/.worktrees/telegram' }

test('a session is labelled by its repo, its worktree and its title', () => {
  assert.equal(sessionLabel(s), 'floe/telegram · Fix login')
  assert.equal(sessionLabel({ ...s, title: '', worktreePath: '/Users/me/code/floe' }), 'floe · Untitled')
})

test('short text is one part', () => {
  assert.deepEqual(chunk('  hello  '), ['hello'])
  assert.deepEqual(chunk(''), [])
})

test('long text splits at a line break when one is close', () => {
  const text = 'a'.repeat(60) + '\n' + 'b'.repeat(30)
  assert.deepEqual(chunk(text, 80), ['a'.repeat(60), 'b'.repeat(30)])
})

test('long text with no break splits hard at the limit', () => {
  assert.deepEqual(chunk('x'.repeat(25), 10), ['x'.repeat(10), 'x'.repeat(10), 'x'.repeat(5)])
})

test('past the part limit the START is dropped, and says so', () => {
  const parts = chunk('x'.repeat(50), 10, 2)
  assert.equal(parts.length, 2)
  assert.match(parts[0], /^\(3 earlier parts omitted\)/)
  assert.equal(parts[1], 'x'.repeat(10))
  assert.match(chunk('x'.repeat(30), 10, 2)[0], /^\(1 earlier part omitted\)/)
})

test('a finished turn heads its first part with the label', () => {
  assert.deepEqual(doneMessages('L', 'done it', true), ['✅ L\n\ndone it'])
  assert.deepEqual(doneMessages('L', '', false), ['⏹ L (stopped)\n\n(no text in the final message)'])
})

test('errors, permissions and questions read as one message each', () => {
  assert.equal(errorMessage('L', 'boom'), '⚠️ L\n\nboom')
  assert.equal(permissionMessage('L', { requestId: 'r', toolName: 'Bash', summary: 'rm -rf x' }), '🔐 L\n\nWants to run Bash: rm -rf x')
  assert.equal(permissionMessage('L', { requestId: 'r', toolName: 'Write' }), '🔐 L\n\nWants to run Write')
  const one = questionMessage('L', [{ question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }])
  assert.equal(one, '❓ L\n\nWhich?\n  1. A\n  2. B\n\nTap an option or reply with text.')
  const open = questionMessage('L', [{ question: 'Why?', options: [] }])
  assert.match(open, /Why\?\n\nReply with your answer\.$/)
})

test('commands parse with or without the bot name and an argument', () => {
  assert.deepEqual(parseCommand('/sessions'), { name: 'sessions', arg: '' })
  assert.deepEqual(parseCommand('/pair@floe_bot 123456'), { name: 'pair', arg: '123456' })
  assert.deepEqual(parseCommand('/Start  42 '), { name: 'start', arg: '42' })
  assert.equal(parseCommand('hello /sessions'), null)
})
