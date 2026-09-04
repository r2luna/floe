import assert from 'node:assert/strict'
import test from 'node:test'
import { applyTrigger, refBefore, triggerAt } from './trigger.ts'

test('a trigger at the very start counts', () => {
  assert.deepEqual(triggerAt('/', 1), { char: '/', query: '', start: 0 })
  assert.deepEqual(triggerAt('/dep', 4), { char: '/', query: 'dep', start: 0 })
  assert.deepEqual(triggerAt('#raf', 4), { char: '#', query: 'raf', start: 0 })
  assert.deepEqual(triggerAt('@cod', 4), { char: '@', query: 'cod', start: 0 })
})

test('a trigger after a space counts', () => {
  assert.deepEqual(triggerAt('run /dep', 8), { char: '/', query: 'dep', start: 4 })
  assert.deepEqual(triggerAt('ask #ses', 8), { char: '#', query: 'ses', start: 4 })
})

test('a trigger mid-word does not', () => {
  // This is the whole point: a path and an issue ref must not open a menu.
  assert.equal(triggerAt('src/main', 8), null)
  assert.equal(triggerAt('user#host', 9), null)
  // The one that matters most for '@': an address is not a handle.
  assert.equal(triggerAt('rafael@lunardelli.me', 20), null)
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

/* --- erasing a reference -------------------------------------------------- */

// The composer's own answer, standing in for the sessions and file paths the
// real one knows about.
const isRef = (token: string): boolean =>
  ['#Composer.tsx', '#docs/notes.md:12-30', '#a-session', 'src/main/index.ts'].includes(token)

test('backspace at the end of a reference takes the whole thing', () => {
  const text = 'look at #Composer.tsx'
  assert.deepEqual(refBefore(text, text.length, isRef), { start: 8, end: text.length })
})

test('the mark goes with it — the chip includes its #', () => {
  const text = '#a-session'
  const cut = refBefore(text, text.length, isRef)
  assert.equal(text.slice(cut!.start, cut!.end), '#a-session')
})

test('a reference with a line range is still one thing', () => {
  const text = 'see #docs/notes.md:12-30'
  assert.deepEqual(refBefore(text, text.length, isRef), { start: 4, end: text.length })
})

test('an ordinary word is not a reference, whatever it is shaped like', () => {
  assert.equal(refBefore('just some words', 15, isRef), null)
  assert.equal(refBefore('#unknown', 8, isRef), null)
})

test('inside the token, backspace is still backspace', () => {
  // Mid-token the user is editing text, and eating the whole reference would
  // make the key mean two different things.
  const text = 'look at #Composer.tsx'
  assert.equal(refBefore(text, text.length - 4, isRef), null)
})

test('a reference glued to a word is not one', () => {
  assert.equal(refBefore('x#Composer.tsx', 14, isRef), null)
})

test('nothing before the caret is nothing to erase', () => {
  assert.equal(refBefore('', 0, isRef), null)
  assert.equal(refBefore('hi ', 3, isRef), null)
})
