import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseUnifiedDiff,
  diffSides,
  commonDir,
  selRange,
  inSelection,
  dragAnchor,
  quoteSelection,
  fileRef,
  appendComment
} from './diff.ts'

const DIFF = `@@ -1,3 +1,4 @@
 ctxA
-old1
+new1
+new2
 ctxB`

test('diffSides reconstructs each side and maps rows to their token line', () => {
  const { rows } = parseUnifiedDiff(DIFF)
  const { newCode, oldCode, map } = diffSides(rows)

  // New side = context + adds, in order; old side = context + dels.
  assert.deepEqual(newCode.split('\n'), ['ctxA', 'new1', 'new2', 'ctxB'])
  assert.deepEqual(oldCode.split('\n'), ['ctxA', 'old1', 'ctxB'])

  // rows: [hunk, ctxA, old1, new1, new2, ctxB]
  assert.equal(map[0], null) // hunk header
  assert.deepEqual(map[1], { side: 'new', line: 0 }) // ctxA → new[0]
  assert.deepEqual(map[2], { side: 'old', line: 1 }) // old1 → old[1]
  assert.deepEqual(map[3], { side: 'new', line: 1 }) // new1 → new[1]
  assert.deepEqual(map[4], { side: 'new', line: 2 }) // new2 → new[2]
  assert.deepEqual(map[5], { side: 'new', line: 3 }) // ctxB → new[3]

  // Each mapped row's text matches the line it points at.
  const sideLines = { new: newCode.split('\n'), old: oldCode.split('\n') }
  rows.forEach((r, i) => {
    const at = map[i]
    if (at) assert.equal(sideLines[at.side][at.line], r.text)
  })
})

test('commonDir trims the directory every path shares', () => {
  assert.equal(commonDir(['a/b/one.ts', 'a/b/two.ts']), 'a/b/')
  assert.equal(commonDir(['a/b/one.ts', 'a/b/c/two.ts']), 'a/b/')
})

test('commonDir splits on slashes, never mid-segment', () => {
  // "panels.tsx" and "parse.ts" share "pa" — that is not a directory.
  assert.equal(commonDir(['src/panels.tsx', 'src/parse.ts']), 'src/')
  assert.equal(commonDir(['apple/x.ts', 'apricot/y.ts']), '')
})

test('commonDir is empty when there is nothing to share', () => {
  assert.equal(commonDir(['a/one.ts', 'b/two.ts']), '')
  assert.equal(commonDir(['one.ts', 'two.ts']), '')
  // A single file has no prefix to factor out — the whole path is its identity.
  assert.equal(commonDir(['a/b/one.ts']), '')
  assert.equal(commonDir([]), '')
})

test('selRange normalises whichever way the selection was dragged', () => {
  assert.deepEqual(selRange({ anchor: 2, head: 6 }), [2, 6])
  assert.deepEqual(selRange({ anchor: 6, head: 2 }), [2, 6], 'extending upward is the same range')
  assert.deepEqual(selRange({ anchor: 3, head: 3 }), [3, 3])
  assert.equal(selRange(null), null)
})

test('a plain gutter press anchors where it landed', () => {
  assert.equal(dragAnchor(null, 4, 9, false), 9)
  assert.equal(dragAnchor({ anchor: 2, head: 3 }, 3, 9, false), 9, 'a new drag replaces the old range')
})

test('shift-clicking the gutter extends what is already open', () => {
  assert.equal(dragAnchor({ anchor: 2, head: 3 }, 3, 9, true), 2)
  assert.equal(dragAnchor(null, 4, 9, true), 4, 'nothing selected yet: extend from the cursor')
  assert.equal(dragAnchor(null, undefined, 9, true), 9, 'no cursor either: one line')
})

test('inSelection covers both ends', () => {
  const s = { anchor: 6, head: 2 }
  assert.equal(inSelection(s, 2), true)
  assert.equal(inSelection(s, 6), true)
  assert.equal(inSelection(s, 4), true)
  assert.equal(inSelection(s, 1), false)
  assert.equal(inSelection(s, 7), false)
  assert.equal(inSelection(null, 3), false)
})

test('quoteSelection keeps the +/- markers and numbers from the right side', () => {
  const { rows } = parseUnifiedDiff(
    ['@@ -10,3 +10,4 @@', ' keep', '-gone', '+added', ' tail'].join('\n')
  )
  const out = quoteSelection(rows, 0, rows.length - 1, 'a/b.ts')
  assert.match(out, /^a\/b\.ts:10-/)
  assert.match(out, /```diff\n keep\n-gone\n\+added\n tail\n```/)
})

test('quoteSelection drops hunk headers but keeps the lines around them', () => {
  const { rows } = parseUnifiedDiff(['@@ -1,1 +1,1 @@', ' one', '@@ -5,1 +5,1 @@', ' two'].join('\n'))
  const out = quoteSelection(rows, 0, rows.length - 1, 'x.ts')
  assert.doesNotMatch(out, /@@/, 'a hunk header is not a line you can comment on')
  assert.match(out, / one\n two/)
})

test('quoteSelection of hunk headers alone has nothing to say', () => {
  const { rows } = parseUnifiedDiff(['@@ -1,1 +1,1 @@', ' one'].join('\n'))
  assert.equal(quoteSelection(rows, 0, 0, 'x.ts'), '')
})

test('appendComment puts each new block after what you already wrote', () => {
  const a = appendComment('', 'BLOCK1\n\n')
  assert.equal(a, 'BLOCK1\n\n')
  const b = appendComment(a + 'my note', 'BLOCK2\n\n')
  assert.equal(b, 'BLOCK1\n\nmy note\n\nBLOCK2\n\n', 'the note stays above the block that followed it')
})

test('appendComment leaves exactly one blank line at the join', () => {
  assert.equal(appendComment('a', 'B'), 'a\n\nB')
  assert.equal(appendComment('a\n', 'B'), 'a\n\nB')
  assert.equal(appendComment('a\n\n\n\n', 'B'), 'a\n\nB')
  assert.equal(appendComment('   \n ', 'B'), 'B', 'blank-only is the same as empty')
})

test('fileRef points at the lines rather than pasting them', () => {
  assert.equal(fileRef('docs/plan.md', 11, 29), 'docs/plan.md:12-30\n\n')
})

test('fileRef names one line when the range is one row', () => {
  assert.equal(fileRef('docs/plan.md', 4, 4), 'docs/plan.md:5\n\n')
})

test('fileRef reads the same selected upwards', () => {
  assert.equal(fileRef('a.md', 9, 2), fileRef('a.md', 2, 9))
})
