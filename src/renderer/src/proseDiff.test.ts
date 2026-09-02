import assert from 'node:assert/strict'
import test from 'node:test'
import { diffSides, parseUnifiedDiff } from './diff.ts'
import { renderMarkdown, type MdLine } from './markdown.ts'
import { proseRows, type ProseRow } from './proseDiff.ts'

/** The whole pipeline the panel runs: patch → rows → rendered document. */
function review(patch: string): ProseRow[] {
  const { rows } = parseUnifiedDiff(patch)
  const sides = diffSides(rows)
  return proseRows(rows, sides, renderMarkdown(sides.newCode), renderMarkdown(sides.oldCode))
}

const textOf = (line: MdLine): string => line.spans.map((s) => s.text).join('')

const spansWith = (row: ProseRow, cls: string): string[] =>
  row.line.spans.filter((s) => s.cls.split(' ').includes(cls)).map((s) => s.text)

/** What the row shows once the old words are taken out again. */
const newTextOf = (row: ProseRow): string =>
  row.line.spans
    .filter((s) => !s.cls.split(' ').includes('md-cut'))
    .map((s) => s.text)
    .join('')

// Built from a list so the leading space on a context line — including a blank
// one, which is ' ' and not '' in a real patch — stays visible.
const PATCH = [
  'diff --git a/notes.md b/notes.md',
  '--- a/notes.md',
  '+++ b/notes.md',
  '@@ -1,13 +1,13 @@',
  ' # Notes',
  ' ',
  '-The mood is hopeful today.',
  '+The mood is playful today.',
  ' ',
  ' They walked out carrying:',
  ' ',
  '-- one field easel,',
  '+- one well-traveled field easel,',
  '+- three oatmeal cookies,',
  ' - two tin cups,',
  ' ',
  '-He painted from memory until the light faded.',
  '-',
  '-See the [field notes](/drafts) for the rest.',
  '+See the [field notes](/reviews) for the rest.'
].join('\n')

test('a line whose words changed is one row, not two', () => {
  const rows = review(PATCH)
  const mod = rows.filter((r) => r.kind === 'mod')
  const swap = mod.find((r) => newTextOf(r).includes('playful'))
  assert.ok(swap, 'the reworded sentence came back as a mod row')
  assert.deepEqual(spansWith(swap, 'md-cut'), ['hopeful '])
  assert.deepEqual(spansWith(swap, 'md-new'), ['playful'])
  assert.equal(newTextOf(swap), 'The mood is playful today.')
  assert.equal(swap.oldNo, 3)
  assert.equal(swap.newNo, 3)
})

test('a marked row still reads as the new file', () => {
  for (const row of review(PATCH)) {
    if (row.kind !== 'mod') continue
    assert.ok(newTextOf(row).length > 0)
    assert.ok(!newTextOf(row).includes('hopeful'), 'the old words are only in the cuts')
  }
})

test('an inserted line stays its own row, in file order', () => {
  const rows = review(PATCH)
  const list = rows.filter((r) => r.line.kind === 'list')
  assert.deepEqual(
    list.map((r) => `${r.kind}:${newTextOf(r)}`),
    ['mod:one well-traveled field easel,', 'add:three oatmeal cookies,', 'ctx:two tin cups,']
  )
})

test('the list item that only gained a word marks just that word', () => {
  const easel = review(PATCH).find((r) => newTextOf(r).includes('easel'))
  assert.ok(easel)
  assert.equal(easel.kind, 'mod')
  assert.deepEqual(spansWith(easel, 'md-new'), ['well-traveled '])
  assert.deepEqual(spansWith(easel, 'md-cut'), [])
})

test('a removed line with no replacement stays removed', () => {
  const gone = review(PATCH).filter((r) => r.kind === 'del' && textOf(r.line).trim())
  assert.deepEqual(
    gone.map((r) => textOf(r.line)),
    ['He painted from memory until the light faded.']
  )
})

test('a moved link destination is reported, not spelled out in the prose', () => {
  const link = review(PATCH).find((r) => r.relink)
  assert.ok(link, 'the changed destination was noticed')
  assert.deepEqual(link.relink, { from: '/drafts', to: '/reviews' })
  // The URL is not in the rendered text, so nothing there may be marked.
  assert.deepEqual(spansWith(link, 'md-cut'), [])
  assert.deepEqual(spansWith(link, 'md-new'), [])
  assert.deepEqual(spansWith(link, 'md-relink'), ['field notes'])
})

test('unchanged lines come through as context, rendered', () => {
  const rows = review(PATCH)
  const heading = rows[0]
  assert.equal(heading.kind, 'ctx')
  assert.equal(heading.line.kind, 'heading')
  assert.equal(textOf(heading.line), 'Notes', 'the marker is dropped, as everywhere else')
  assert.equal(heading.oldNo, 1)
  assert.equal(heading.newNo, 1)
})

test('a retitled heading pairs even though it shares no words', () => {
  const rows = review(`@@ -1,1 +1,1 @@
-# A Happy Accident
+# The Sketch in the Spruce
`)
  assert.deepEqual(
    rows.map((r) => r.kind),
    ['mod']
  )
  assert.deepEqual(spansWith(rows[0], 'md-cut'), ['A Happy Accident '])
  assert.deepEqual(spansWith(rows[0], 'md-new'), ['The Sketch in the Spruce'])
})

test('a table row keeps the two-line shape it can express', () => {
  // Cells are a grid, not a line of spans, so there is nowhere to put a word
  // mark — the row says so by staying a delete and an add.
  const rows = review(`@@ -1,3 +1,3 @@
 | a | b |
 | --- | --- |
-| one | two |
+| one | three |
`)
  assert.deepEqual(
    rows.map((r) => r.kind),
    ['ctx', 'ctx', 'del', 'add']
  )
})

test('a hunk header is not a row of the document', () => {
  assert.ok(review(PATCH).every((r) => r.line.kind !== undefined))
  assert.equal(
    review(PATCH).filter((r) => textOf(r.line).startsWith('@@')).length,
    0
  )
})
