import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { describeRef, expand, resetRefs, shorten, splitRefs } from './fileRefs.ts'

beforeEach(resetRefs)

test('a reference shortens to its file name and expands back', () => {
  const full = '/Users/me/.config/floe/skills/example.md:7-23'
  assert.equal(shorten(full), 'example.md:7-23')
  assert.equal(expand('look at example.md:7-23 please'), `look at ${full} please`)
})

test('a second file of the same name takes another segment', () => {
  shorten('src/main/index.ts')
  assert.equal(shorten('src/renderer/index.ts'), 'renderer/index.ts')
  assert.equal(expand('#index.ts'), '#src/main/index.ts')
  assert.equal(expand('#renderer/index.ts'), '#src/renderer/index.ts')
})

test('the same reference twice keeps one token', () => {
  assert.equal(shorten('docs/plan.md'), 'plan.md')
  assert.equal(shorten('docs/plan.md'), 'plan.md')
})

test('a token nobody registered is left exactly as typed', () => {
  shorten('docs/plan.md')
  assert.equal(expand('notes.md is mine'), 'notes.md is mine')
})

test('expanding a message with no references is the message', () => {
  assert.equal(expand('just words'), 'just words')
})

test('a file reference is cut out of the text it sits in', () => {
  assert.deepEqual(splitRefs('see docs/plan.md:4 now'), [
    { text: 'see ' },
    { ref: 'docs/plan.md:4' },
    { text: ' now' }
  ])
})

test('the mention mark is dropped — the chip replaces the whole token', () => {
  assert.deepEqual(splitRefs('#src/main/agent.ts'), [{ ref: 'src/main/agent.ts' }])
})

test('a bare file name in prose stays prose', () => {
  assert.deepEqual(splitRefs('read the notes.md file'), [{ text: 'read the notes.md file' }])
})

test('a chip shows the name and the lines, and keeps the path', () => {
  assert.deepEqual(describeRef('/a/b/example.md:7-23'), {
    name: 'example.md',
    lines: '7-23',
    full: '/a/b/example.md:7-23'
  })
  assert.deepEqual(describeRef('src/a.ts'), {
    name: 'a.ts',
    lines: undefined,
    full: 'src/a.ts'
  })
})
