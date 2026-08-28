import assert from 'node:assert/strict'
import test from 'node:test'
import { applyTrigger, triggerAt } from './trigger.ts'

test('a trigger at the very start counts', () => {
  assert.deepEqual(triggerAt('/', 1), { char: '/', query: '', start: 0 })
  assert.deepEqual(triggerAt('/dep', 4), { char: '/', query: 'dep', start: 0 })
  assert.deepEqual(triggerAt('#raf', 4), { char: '#', query: 'raf', start: 0 })
})

test('a trigger after a space counts', () => {
  assert.deepEqual(triggerAt('run /dep', 8), { char: '/', query: 'dep', start: 4 })
  assert.deepEqual(triggerAt('ask #ses', 8), { char: '#', query: 'ses', start: 4 })
})

test('a trigger mid-word does not', () => {
  // This is the whole point: a path and an issue ref must not open a menu.
  assert.equal(triggerAt('src/main', 8), null)
  assert.equal(triggerAt('user#host', 9), null)
  assert.equal(triggerAt('a/b/c', 5), null)
})

test('a space after the trigger closes it', () => {
  // Past the token you are writing prose again; a menu still filtering on it
  // would be showing results for something you already finished typing.
  assert.equal(triggerAt('/deploy now', 11), null)
  assert.equal(triggerAt('#rafael hi', 10), null)
})

test('a newline is a word boundary too', () => {
  assert.deepEqual(triggerAt('line one\n/dep', 13), { char: '/', query: 'dep', start: 9 })
})

test('the caret decides, not the end of the text', () => {
  // Caret right after the slash, with more text ahead of it.
  assert.deepEqual(triggerAt('/dep loy', 4), { char: '/', query: 'dep', start: 0 })
})

test('no trigger in ordinary text', () => {
  assert.equal(triggerAt('hello world', 11), null)
  assert.equal(triggerAt('', 0), null)
})

test('applying a trigger replaces the token and leaves a space', () => {
  const t = triggerAt('run /dep', 8)!
  assert.deepEqual(applyTrigger('run /dep', t, 8, '/deploy'), {
    text: 'run /deploy ',
    caret: 12
  })
})

test('applying keeps whatever followed the caret', () => {
  const t = triggerAt('/dep tail', 4)!
  const out = applyTrigger('/dep tail', t, 4, '/deploy')
  assert.equal(out.text, '/deploy  tail', 'the tail survives, untouched')
  assert.equal(out.caret, 8, 'and the caret sits after the inserted space')
})
