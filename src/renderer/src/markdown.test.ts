import assert from 'node:assert/strict'
import test from 'node:test'
import { continueList, renderMarkdown, tokenizeMarkdown, trimBlankEdges } from './markdown.ts'

const flat = (s: string) =>
  tokenizeMarkdown(s)
    .map((t) => t.text)
    .join('')

const classOf = (s: string, needle: string) =>
  tokenizeMarkdown(s).find((t) => t.text.includes(needle))?.cls

/* --- the invariant the caret depends on ---------------------------------- */

test('tokenizing never changes the text', () => {
  const samples = [
    '',
    'plain',
    '# heading\n\n- one\n- two',
    '```ts\nconst x = 1\n```',
    '**bold** and *em* and `code` and [a](b)',
    '> quote\n>\n> more',
    '1. first\n2. second',
    '---',
    'trailing spaces   \n\n\n',
    'unclosed ** and * and ` and [',
    '*.tsx globs and 2 * 3 = 6'
  ]
  for (const s of samples) assert.equal(flat(s), s, JSON.stringify(s))
})

/* --- colouring ------------------------------------------------------------ */

test('block markers are coloured apart from their content', () => {
  assert.equal(classOf('# title', '# '), 'md-marker')
  assert.equal(classOf('# title', 'title'), 'md-head')
  assert.equal(classOf('> said', 'said'), 'md-quote')
  assert.equal(classOf('- item', '- '), 'md-marker')
  assert.equal(classOf('3. item', '3. '), 'md-marker')
})

test('inline spans are coloured, longest match first', () => {
  assert.equal(classOf('a **b** c', '**b**'), 'md-bold')
  assert.equal(classOf('a *b* c', '*b*'), 'md-em')
  assert.equal(classOf('a `b` c', '`b`'), 'md-code')
  assert.equal(classOf('a [b](c) d', '[b](c)'), 'md-link')
})

test('a fenced block colours its body as code, not as markdown', () => {
  const tokens = tokenizeMarkdown('```\n# not a heading\n```')
  assert.equal(tokens.find((t) => t.text === '# not a heading')?.cls, 'md-code')
})

test('a fence only closes on the same character and length', () => {
  const tokens = tokenizeMarkdown('```\n~~~\nstill code\n```')
  assert.equal(tokens.find((t) => t.text === 'still code')?.cls, 'md-code')
})

/* --- list continuation ---------------------------------------------------- */

test('a bullet repeats itself', () => {
  const r = continueList('- one', 5)
  assert.deepEqual(r, { value: '- one\n- ', cursor: 8 })
})

test('a number increments', () => {
  const r = continueList('1. one', 6)
  assert.equal(r?.value, '1. one\n2. ')
})

test('numbering keeps the delimiter style', () => {
  assert.equal(continueList('3) three', 8)?.value, '3) three\n4) ')
})

test('indentation is carried to the next item', () => {
  assert.equal(continueList('  - deep', 8)?.value, '  - deep\n  - ')
})

test('an empty item ends the list instead of repeating', () => {
  const r = continueList('- one\n- ', 8)
  assert.deepEqual(r, { value: '- one\n', cursor: 6 })
})

test('a non-list line is left to the caller', () => {
  assert.equal(continueList('plain text', 10), null)
  assert.equal(continueList('', 0), null)
})

test('continuing mid-document splices rather than appends', () => {
  const r = continueList('- one\ntail', 5)
  assert.equal(r?.value, '- one\n- \ntail')
  assert.equal(r?.cursor, 8)
})

test('a fenced block loses its blank edges, not its indentation', () => {
  assert.equal(trimBlankEdges('\n\nbrew uninstall gemini-cli\n  \n'), 'brew uninstall gemini-cli')
  assert.equal(trimBlankEdges('  indented\n    more\n'), '  indented\n    more')
  // A blank line in the middle is part of the script.
  assert.equal(trimBlankEdges('a\n\nb'), 'a\n\nb')
})

/* --- rendering (the file panel's view, markers dropped) ------------------- */

test('rendering is 1:1 with the source lines — the numbers must stay true', () => {
  const src = '# h\n\n- a\n\n```ts\ncode\n```\n'
  assert.equal(renderMarkdown(src).length, src.split('\n').length)
})

test('a rendered line drops the markers it draws', () => {
  const [line] = renderMarkdown('**bold** and `code` and [text](http://x) and *em*')
  assert.deepEqual(
    line.spans.map((s) => [s.text, s.cls]),
    [
      ['bold', 'md-bold'],
      [' and ', ''],
      ['code', 'md-code'],
      [' and ', ''],
      ['text', 'md-link'],
      [' and ', ''],
      ['em', 'md-em']
    ]
  )
})

test('shape per line: heading level, list marker and depth, quote, rule', () => {
  const [h] = renderMarkdown('### Stack')
  assert.equal(h.kind, 'heading')
  assert.equal(h.level, 3)
  assert.equal(h.spans[0].text, 'Stack')

  const [bullet, numbered, nested] = renderMarkdown('- a\n2. b\n    - c')
  // An unordered item carries no marker text: the dot is a CSS shape.
  assert.deepEqual([bullet.kind, bullet.marker, bullet.depth], ['list', '', 0])
  assert.deepEqual([numbered.marker, numbered.depth], ['2.', 0])
  assert.equal(nested.depth, 2)

  assert.equal(renderMarkdown('> quoted')[0].kind, 'quote')
  assert.equal(renderMarkdown('---')[0].kind, 'rule')
})

test('a fence turns off inline rendering until it closes', () => {
  const lines = renderMarkdown('```bash\n**not bold** - not a list\n```\n**bold**')
  assert.deepEqual(lines.map((l) => l.kind), ['fence', 'code', 'fence', 'text'])
  // The opening fence shows its language; the code line stays literal.
  assert.equal(lines[0].spans[0].text, 'bash')
  assert.equal(lines[1].spans[0].text, '**not bold** - not a list')
  assert.equal(lines[3].spans[0].cls, 'md-bold')
})

test('a table becomes cells, and every row of the block shares one layout', () => {
  const [head, rule, body] = renderMarkdown(
    '| Keys | Action |\n|---|---:|\n| ⌘K | open the palette |'
  )
  assert.equal(head.kind, 'table')
  assert.deepEqual(
    head.cells?.map((cell) => cell[0].text),
    ['Keys', 'Action']
  )
  assert.equal(head.head, true)

  // The |---| row draws the header's underline; it holds no cells of its own.
  assert.equal(rule.rule, true)
  assert.equal(rule.cells, undefined)

  // Shared column weights are what line the rows up, and `---:` right-aligns.
  assert.deepEqual(body.cols, head.cols)
  assert.deepEqual(body.aligns, ['left', 'right'])
  assert.equal(body.head, false)
})
