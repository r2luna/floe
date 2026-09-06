import { test } from 'node:test'
import assert from 'node:assert/strict'
import { describeRef, splitRefs } from './fileRefs.ts'

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

test('a chip shows the whole path and the lines, not just the file name', () => {
  assert.deepEqual(describeRef('/a/b/example.md:7-23'), {
    path: '/a/b/example.md',
    lines: '7-23',
    full: '/a/b/example.md:7-23'
  })
  assert.deepEqual(describeRef('src/a.ts'), {
    path: 'src/a.ts',
    lines: undefined,
    full: 'src/a.ts'
  })
})
