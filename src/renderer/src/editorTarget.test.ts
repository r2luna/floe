import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { editSub, editTarget } from './editorTarget.ts'

test('line 1 is implicit, so the panel id is just the path', () => {
  assert.equal(editSub('src/a.ts'), 'src/a.ts')
  assert.equal(editSub('src/a.ts', 1), 'src/a.ts')
  assert.equal(editSub('src/a.ts', 42), 'src/a.ts:42')
})

test('round-trips a file and its line', () => {
  assert.deepEqual(editTarget(editSub('src/a.ts', 42)), { path: 'src/a.ts', line: 42 })
  assert.deepEqual(editTarget(editSub('src/a.ts')), { path: 'src/a.ts' })
})

test('a path that ends in a colon-number is read as a line, not a filename', () => {
  // The cost of the compact form: a file literally named `a:12` opens `a` at
  // line 12. Worth it — the alternative is a second field on every panel.
  assert.deepEqual(editTarget('a:12'), { path: 'a', line: 12 })
  assert.deepEqual(editTarget('weird:name.ts'), { path: 'weird:name.ts' })
})

test('an empty sub is a path of nothing, not a crash', () => {
  assert.deepEqual(editTarget(), { path: '' })
  assert.deepEqual(editTarget(''), { path: '' })
})
