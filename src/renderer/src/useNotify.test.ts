import assert from 'node:assert/strict'
import test from 'node:test'
import { shouldNotify } from './useNotify.ts'

test('a session you are not looking at is announced once per wait', () => {
  const told = new Set<string>()
  assert.equal(shouldNotify('s2', ['s1', 'c1'], true, told), true)
  told.add('s2')
  assert.equal(shouldNotify('s2', ['s1', 'c1'], true, told), false, 'the poll re-sends the prompt; the user was told')
})

test('the open chat is exempt while the window is in front, and not otherwise', () => {
  assert.equal(shouldNotify('c1', ['s1', 'c1'], true, new Set()), false, 'the prompt is already on screen')
  assert.equal(shouldNotify('c1', ['s1', 'c1'], false, new Set()), true, 'another app is in front')
})
