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
  // Markdown lets every item be written `1.` (or, here, `2.`) — the sequence is
  // the renderer's to work out, and this is the first ordered item.
  assert.deepEqual([numbered.marker, numbered.depth], ['1.', 0])
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

test('an ordered list is renumbered, and its block shares one marker column', () => {
  const lines = renderMarkdown('1. um\n1. dois\n  1. um de dentro\n1. tres')
  assert.deepEqual(
    lines.map((l) => l.marker),
    ['1.', '2.', '1.', '3.']
  )

  // A ten pushes the column out by a character, and every item of the block
  // gets the wider column so the numbers line up on the period.
  const long = renderMarkdown(Array.from({ length: 10 }, () => '1. item').join('\n'))
  assert.equal(long[9].marker, '10.')
  assert.deepEqual(new Set(long.map((l) => l.markerWidth)), new Set([4]))

  // Prose between two lists ends the first one: the second starts at 1 again.
  const split = renderMarkdown('1. um\nprosa\n1. um de novo')
  assert.deepEqual(
    split.map((l) => l.marker),
    ['1.', undefined, '1.']
  )
})

test('front matter is metadata, and only when it closes', () => {
  const withFm = renderMarkdown('---\ntitle: x\n---\n# H')
  assert.deepEqual(
    withFm.map((l) => l.kind),
    ['front', 'front', 'front', 'heading']
  )

  // An opening --- with no partner is a rule on line one, not a block that
  // swallows the document.
  assert.deepEqual(
    renderMarkdown('---\n# H').map((l) => l.kind),
    ['rule', 'heading']
  )
})

test('a task item carries its checkbox, and the brackets are not its text', () => {
  const [open, done] = renderMarkdown('- [ ] abrir\n- [x] fechar')
  assert.deepEqual([open.task, open.spans[0].text], ['open', 'abrir'])
  assert.deepEqual([done.task, done.spans[0].text], ['done', 'fechar'])

  // A bracket that is not a checkbox stays part of the text.
  assert.equal(renderMarkdown('- [nota] resto')[0].task, undefined)
})

test('an indented line under an item continues it; on its own it is code', () => {
  const [item, cont] = renderMarkdown('- item\n  resto do item')
  assert.equal(item.kind, 'list')
  // Continuations line up with the item's TEXT, so they carry its depth and the
  // block's marker column.
  assert.deepEqual([cont.kind, cont.cont, cont.depth, cont.markerWidth], ['text', true, 0, 2])

  // With no list open, four spaces after a blank line are a code block, and the
  // indent that made it code is not part of the code.
  const code = renderMarkdown('parágrafo\n\n    const x = 1')
  assert.deepEqual([code[2].kind, code[2].spans[0].text], ['code', 'const x = 1'])

  // Indented code cannot interrupt a paragraph.
  assert.equal(renderMarkdown('parágrafo\n    ainda o parágrafo')[1].kind, 'text')
})

test('a setext heading is made by the line below it, which then draws nothing', () => {
  const [h1, under, h2] = renderMarkdown('Título\n======\nOutro\n---')
  assert.deepEqual([h1.kind, h1.level], ['heading', 1])
  assert.deepEqual([under.kind, under.spans], ['text', []])
  // `---` under a paragraph is an underline, not a rule.
  assert.deepEqual([h2.kind, h2.level], ['heading', 2])
})

test('a nested quote steps in instead of showing its markers', () => {
  const [one, two] = renderMarkdown('> um\n> > dois')
  assert.deepEqual([one.kind, one.depth, one.spans[0].text], ['quote', 1, 'um'])
  assert.deepEqual([two.depth, two.spans[0].text], [2, 'dois'])
})

test('inline: images, strikethrough, autolinks, footnotes, escapes and nesting', () => {
  const alt = renderMarkdown('![um gato](gato.png)')[0].spans[0]
  assert.deepEqual([alt.text, alt.cls], ['um gato', 'md-img'])

  const [, strike] = renderMarkdown('nada ~~disso~~')[0].spans
  assert.deepEqual([strike.text, strike.cls], ['disso', 'md-del'])

  const auto = renderMarkdown('<https://floe.dev>')[0].spans[0]
  assert.deepEqual([auto.text, auto.cls], ['https://floe.dev', 'md-link'])

  const note = renderMarkdown('nota[^1]')[0].spans[1]
  assert.deepEqual([note.text, note.cls], ['[1]', 'md-note'])

  // A definition is machinery, not prose.
  assert.equal(renderMarkdown('[ref]: https://x.com')[0].spans[0].cls, 'md-def')

  // An escape is the literal character, with the backslash gone.
  assert.deepEqual(
    renderMarkdown('\\*não\\*')[0].spans.map((s) => s.text),
    ['*', 'não', '*']
  )

  // Nesting composes classes rather than replacing them: the bold inside a link
  // is both.
  const nested = renderMarkdown('[um **forte**](http://x)')[0].spans
  assert.deepEqual(
    nested.map((s) => [s.text, s.cls]),
    [
      ['um ', 'md-link'],
      ['forte', 'md-link md-bold']
    ]
  )
})

test('raw HTML is shown as written, not run', () => {
  const [html] = renderMarkdown('<div class="x">oi</div>')
  assert.deepEqual([html.kind, html.spans[0].cls], ['text', 'md-html'])
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

test('an image reference is a chip of its own', () => {
  const out = tokenizeMarkdown('crop [Image #1] please')
  assert.deepEqual(
    out.filter((t) => t.cls === 'md-attach').map((t) => t.text),
    ['[Image #1]']
  )
  // The invariant every tokenizer test here rests on: nothing is lost.
  assert.equal(out.map((t) => t.text).join(''), 'crop [Image #1] please')
})
