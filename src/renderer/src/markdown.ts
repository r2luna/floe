// The composer's two pieces of real logic, kept pure so they can be tested
// without a DOM: colouring markdown source, and continuing a list on newline.
//
// This highlights the SOURCE — it never turns `**x**` into a <strong>. The text
// you typed stays exactly the text you typed, character for character. That is
// not a stylistic choice: the highlight is painted on a mirror element sitting
// behind a transparent <textarea>, so if the mirror ever dropped or added a
// single character the two would drift apart and the caret would land in the
// wrong place. Every function here preserves the input exactly.

export type Token = { text: string; cls: string }

const FENCE = /^(\s*)(`{3,}|~{3,})(.*)$/
const HEADING = /^(#{1,6}\s+)(.*)$/
const QUOTE = /^(\s*>\s?)(.*)$/
const HR = /^\s*([-*_])(?:\s*\1){2,}\s*$/
const LIST = /^(\s*)([-*+]|\d+[.)])(\s+)(.*)$/

// Inline spans, longest-first so `**a**` never matches the `*a*` branch.
const INLINE =
  /(`[^`\n]+`)|(\*\*[^*\n]+\*\*|__[^_\n]+__)|(\*[^*\n]+\*|_[^_\n]+_)|(\[[^\]\n]*\]\([^)\n]*\))/g

/**
 * What could be a reference: a mention (`#name`, `@name`) or a path with an
 * extension, each optionally carrying a line range.
 *
 * Deliberately generous — it only proposes. Whether a candidate IS a reference
 * is `isRef`'s answer, because that depends on things this file must not know:
 * which sessions exist, and which short tokens stand for a path.
 */
const REF =
  /(^|[\s([])([#@][\w./:-]+|(?:[\w.-]+\/)*[\w.-]+\.[A-Za-z][\w-]*(?::\d+(?:-\d+)?)?)/g

/** Split a plain run into text and the references inside it. */
function refs(text: string, out: Token[], isRef: (token: string) => boolean): void {
  let last = 0
  for (const m of text.matchAll(REF)) {
    const token = m[2]
    if (!isRef(token)) continue
    const at = m.index + m[1].length
    if (at > last) out.push({ text: text.slice(last, at), cls: '' })
    out.push({ text: token, cls: 'md-ref' })
    last = at + token.length
  }
  if (last < text.length) out.push({ text: text.slice(last), cls: '' })
}

function inline(text: string, out: Token[], isRef?: (token: string) => boolean): void {
  const plain = (slice: string): void => {
    if (!slice) return
    if (isRef) refs(slice, out, isRef)
    else out.push({ text: slice, cls: '' })
  }
  let last = 0
  INLINE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = INLINE.exec(text))) {
    if (m.index > last) plain(text.slice(last, m.index))
    const cls = m[1] ? 'md-code' : m[2] ? 'md-bold' : m[3] ? 'md-em' : 'md-link'
    out.push({ text: m[0], cls })
    last = m.index + m[0].length
  }
  if (last < text.length) plain(text.slice(last))
}

/**
 * Colour markdown source. The concatenation of every token's text always equals
 * the input — see the note above on why that matters.
 *
 * `isRef` is what turns a file or session reference into a chip in the
 * composer. It is passed in rather than decided here: the file panel highlights
 * the same markdown and has no references to draw, and the composer's answer
 * depends on the sessions this project has and the paths it has shortened.
 */
export function tokenizeMarkdown(text: string, isRef?: (token: string) => boolean): Token[] {
  const out: Token[] = []
  const lines = text.split('\n')
  let fence: string | null = null

  lines.forEach((line, i) => {
    if (i > 0) out.push({ text: '\n', cls: '' })

    const fenceMatch = FENCE.exec(line)
    if (fenceMatch) {
      const mark = fenceMatch[2]
      // A closing fence needs the same character and at least the same length.
      if (!fence) fence = mark
      else if (mark[0] === fence[0] && mark.length >= fence.length) fence = null
      out.push({ text: line, cls: 'md-marker' })
      return
    }
    if (fence) {
      out.push({ text: line, cls: 'md-code' })
      return
    }
    if (HR.test(line) && line.trim()) {
      out.push({ text: line, cls: 'md-marker' })
      return
    }

    const heading = HEADING.exec(line)
    if (heading) {
      out.push({ text: heading[1], cls: 'md-marker' })
      if (heading[2]) out.push({ text: heading[2], cls: 'md-head' })
      return
    }

    const quote = QUOTE.exec(line)
    if (quote) {
      out.push({ text: quote[1], cls: 'md-marker' })
      if (quote[2]) out.push({ text: quote[2], cls: 'md-quote' })
      return
    }

    const list = LIST.exec(line)
    if (list) {
      if (list[1]) out.push({ text: list[1], cls: '' })
      out.push({ text: list[2] + list[3], cls: 'md-marker' })
      inline(list[4], out, isRef)
      return
    }

    inline(line, out, isRef)
  })

  return out
}

/* --- rendering markdown, one source line at a time ------------------------ */

/**
 * A rendered line, as the file panel draws it.
 *
 * Rendering is per LINE, not per block, because the panel numbers its rows and
 * the cursor moves through them — the same thing vim does with
 * render-markdown. So a line knows its own shape (heading, list item, quote)
 * and nothing about the paragraph it belongs to.
 *
 * Unlike tokenizeMarkdown, this one DROPS the markers: `**x**` comes back as
 * `x` in bold. That is the whole difference between showing the source (what
 * the composer does, where the caret must line up character for character) and
 * showing the document.
 */
export type MdSpan = { text: string; cls: string }

export type MdLine = {
  kind: 'text' | 'heading' | 'list' | 'quote' | 'fence' | 'code' | 'rule' | 'table' | 'front'
  spans: MdSpan[]
  /** Heading level, 1-6. */
  level?: number
  /** How deep a list item sits, in indent steps. */
  depth?: number
  /** The bullet or number drawn in place of the source marker. */
  marker?: string
  /** A table row's cells, already inline-rendered. Absent on the |---| row. */
  cells?: MdSpan[][]
  /** The |---|:--| row: drawn as a rule under the header, not as cells. */
  rule?: boolean
  /** True for the rows above the |---| row. */
  head?: boolean
  /** Column weights for the whole table block, in characters of widest cell. */
  cols?: number[]
  /** The marker column's width, in characters — shared by a list block. */
  markerWidth?: number
  /** Per-column alignment, read from the |---| row. */
  aligns?: ('left' | 'center' | 'right')[]
  /** A `- [ ]` item: the marker is a checkbox instead of a bullet. */
  task?: 'open' | 'done'
  /** A line that continues the item above it — indented under its text. */
  cont?: boolean
}

// Inline spans with their delimiters, so the rendered text can drop them.
// Longest-first, and image before link: `![a](b)` must never match as a link
// with a stray `!` in front of it.
const RENDER_INLINE = new RegExp(
  [
    /\\([\\`*_~[\]()#!>+-])/, // an escape is the literal character
    /`([^`\n]+)`/, // code — never nested, it is literal by definition
    /!\[([^\]\n]*)\]\([^)\n]*\)/, // image: only its alt text can be drawn
    /\[\^([^\]\n]+)\]/, // footnote reference
    /\[([^\]\n]*)\]\([^)\n]*\)/, // inline link
    /\[([^\]\n]*)\]\[[^\]\n]*\]/, // reference link
    /<((?:https?|mailto):[^>\s]+)>/, // autolink
    /\*\*([^*\n]+)\*\*|__([^_\n]+)__/, // bold
    /~~([^~\n]+)~~/, // strikethrough
    /\*([^*\n]+)\*|_([^_\n]+)_/ // emphasis
  ]
    .map((re) => `(?:${re.source})`)
    .join('|'),
  'g'
)

/**
 * Render one line's inline markup, dropping the delimiters.
 *
 * `base` is what the surrounding span already is, so nesting composes instead
 * of replacing: bold inside a link comes back as "md-link md-bold" and gets
 * both the colour and the weight. The recursion is what makes that work — each
 * form renders its own content through this function again.
 */
function renderInline(text: string, out: MdSpan[], base = ''): void {
  const add = (t: string, cls: string): void => {
    if (t) out.push({ text: t, cls: [base, cls].filter(Boolean).join(' ') })
  }
  const nest = (t: string, cls: string): void =>
    renderInline(t, out, [base, cls].filter(Boolean).join(' '))

  let last = 0
  const re = new RegExp(RENDER_INLINE.source, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    if (m.index > last) add(text.slice(last, m.index), '')
    const [, esc, code, img, note, link, ref, auto, bold, boldAlt, strike, em, emAlt] = m
    if (esc !== undefined) add(esc, '')
    else if (code !== undefined) add(code, 'md-code')
    else if (img !== undefined) add(img, 'md-img')
    // The brackets stay: a bare "1" in the middle of a sentence would read as
    // part of it, and this is a reference you are meant to be able to find.
    else if (note !== undefined) add(`[${note}]`, 'md-note')
    else if (link !== undefined) nest(link, 'md-link')
    else if (ref !== undefined) nest(ref, 'md-link')
    else if (auto !== undefined) add(auto, 'md-link')
    else if (bold !== undefined || boldAlt !== undefined) nest((bold ?? boldAlt) as string, 'md-bold')
    else if (strike !== undefined) nest(strike, 'md-del')
    else nest((em ?? emAlt) as string, 'md-em')
    last = m.index + m[0].length
  }
  if (last < text.length) add(text.slice(last), '')
}

/** Render a whole file, line by line. The array is 1:1 with the source lines. */
export function renderMarkdown(text: string): MdLine[] {
  const src = text.split('\n')
  const out: MdLine[] = []
  let fence: string | null = null
  // YAML front matter, which is metadata rather than prose. Only at the very top
  // of the file, and only when it CLOSES — an opening `---` with no partner is
  // a rule on the first line, not a block that swallows the whole document.
  let front = src[0]?.trim() === '---' && src.slice(1).some((l) => l.trim() === '---')
  // The item a lazily-indented line would continue, and whether the line above
  // was blank — indented code needs one, a continuation must not have one.
  // Depth of the item an indented line would continue, or -1 for "no list open".
  // A holder rather than a plain let: `push` below writes it, and a variable
  // written from a closure keeps whatever type it was narrowed to at the call
  // site, which would make this permanently "no list".
  const open = { item: -1 }
  let blank = true
  // Set when the line below is a setext underline the heading already consumed.
  let underline = false

  for (let n = 0; n < src.length; n++) {
    const line = src[n]
    const next = src[n + 1] ?? ''
    const empty = !line.trim()

    const push = (mdLine: MdLine): void => {
      out.push(mdLine)
      if (mdLine.kind === 'list') open.item = mdLine.depth ?? 0
      else if (!mdLine.cont && !empty) open.item = -1
      blank = empty
    }

    if (underline) {
      // The `====` under a setext heading: its row stays (the numbers must match
      // the file) and draws nothing, because the heading above already reads as
      // one and a second line under it would be a rule it never asked for.
      underline = false
      push({ kind: 'text', spans: [] })
      continue
    }

    if (front) {
      // The closing `---` ends it; both delimiters read as part of the block.
      if (n > 0 && line.trim() === '---') front = false
      push({ kind: 'front', spans: [{ text: line, cls: '' }] })
      continue
    }

    const fenceMatch = FENCE.exec(line)
    if (fenceMatch) {
      const mark = fenceMatch[2]
      const open = fence
      if (!open) fence = mark
      else if (mark[0] === open[0] && mark.length >= open.length) fence = null
      // The fence itself is not content: it keeps its row (the numbers must
      // stay true to the file) but shows only the language, if it named one.
      push({ kind: 'fence', spans: [{ text: open ? '' : fenceMatch[3].trim(), cls: '' }] })
      continue
    }
    // Inside a fence everything is literal — no bold, no links, no bullets.
    if (fence) {
      push({ kind: 'code', spans: [{ text: line, cls: '' }] })
      continue
    }

    // A setext heading is the only shape a line cannot recognise alone: it is
    // the line BELOW that makes it one. Checked before HR, because `---` under
    // a paragraph is an underline, not a rule.
    if (!empty && open.item < 0 && /^\s*(=+|-+)\s*$/.test(next) && !LIST.test(line) && !/^\s*[|>#]/.test(line)) {
      const spans: MdSpan[] = []
      renderInline(line, spans)
      underline = true
      push({ kind: 'heading', level: next.trim()[0] === '=' ? 1 : 2, spans })
      continue
    }

    if (HR.test(line) && !empty) {
      push({ kind: 'rule', spans: [] })
      continue
    }

    const heading = HEADING.exec(line)
    if (heading) {
      const spans: MdSpan[] = []
      renderInline(heading[2], spans)
      push({ kind: 'heading', level: heading[1].trim().length, spans })
      continue
    }

    const quote = QUOTE.exec(line)
    if (quote) {
      // `> > x` is a quote inside a quote: strip every level and count them, so
      // the depth shows as indentation instead of as a stray `>` in the text.
      let body = quote[2]
      let depth = 1
      let deeper: RegExpExecArray | null
      while ((deeper = QUOTE.exec(body))) {
        body = deeper[2]
        depth++
      }
      const spans: MdSpan[] = []
      renderInline(body, spans)
      push({ kind: 'quote', depth, spans })
      continue
    }

    const list = LIST.exec(line)
    if (list) {
      // `- [ ] thing` is a task: the checkbox replaces the bullet, and the
      // brackets are markup rather than the first two characters of the text.
      const task = /^\[([ xX])\]\s+/.exec(list[4])
      const spans: MdSpan[] = []
      renderInline(task ? list[4].slice(task[0].length) : list[4], spans)
      push({
        kind: 'list',
        // Two spaces per level is the common case and the only one a line can
        // know on its own; a tab counts as one step.
        depth: Math.floor(list[1].replace(/\t/g, '  ').length / 2),
        // Empty for an unordered item: the dot is drawn in CSS, not typed, so
        // it does not depend on the mono face having a decent bullet glyph.
        marker: /^\d/.test(list[2]) ? list[2] : '',
        task: task ? (task[1] === ' ' ? 'open' : 'done') : undefined,
        spans
      })
      continue
    }

    // A table row becomes cells, not pipes. The row is still ONE line — the
    // columns are lined up by a shared grid template, computed per block in
    // `layoutTables` below, so the panel keeps numbering and walking lines.
    if (/^\s*\|/.test(line)) {
      // The |---|:--| row is scaffolding, not content: it keeps its row (the
      // numbers must match the file) but draws as the rule under the header.
      const rule = /^[\s|:-]+$/.test(line)
      const spans: MdSpan[] = [{ text: line, cls: rule ? 'md-marker' : '' }]
      if (rule) push({ kind: 'table', spans, rule: true })
      else
        push({
          kind: 'table',
          spans,
          cells: splitRow(line).map((cell) => {
            const cellSpans: MdSpan[] = []
            renderInline(cell, cellSpans)
            return cellSpans
          })
        })
      continue
    }

    // An indented line is one of two things, and the list decides which: under
    // an item it continues that item's paragraph; on its own, four spaces are a
    // code block — but only where a block can start, since indented code cannot
    // interrupt a paragraph.
    const after = out[out.length - 1]?.kind
    const canStart = blank || !after || after === 'fence' || after === 'rule' || after === 'front'
    if (!empty && /^(?: {4}|\t)/.test(line) && open.item < 0 && canStart) {
      push({ kind: 'code', spans: [{ text: line.replace(/^(?: {4}|\t)/, ''), cls: '' }] })
      continue
    }
    if (!empty && /^\s+\S/.test(line) && open.item >= 0) {
      const spans: MdSpan[] = []
      renderInline(line.trim(), spans)
      push({ kind: 'text', cont: true, depth: open.item, spans })
      continue
    }

    // A definition — of a link or of a footnote — is machinery, not prose: it
    // is what makes `[x]` elsewhere work, and nobody reads it as a sentence.
    if (/^\s*\[[^\]\n]+\]:\s/.test(line)) {
      push({ kind: 'text', spans: [{ text: line, cls: 'md-def' }] })
      continue
    }

    // Raw HTML passes through markdown untouched, so it reaches here as-is.
    // Shown dimmed and literal rather than parsed: this panel reads documents,
    // it does not run them.
    // The tag name must be followed by a space, a slash or the closing angle —
    // `<https://floe.dev>` is an autolink, and "https:" is not a tag.
    if (/^\s*<\/?[a-zA-Z][a-zA-Z0-9-]*(\s[^>]*)?\/?>/.test(line)) {
      push({ kind: 'text', spans: [{ text: line, cls: 'md-html' }] })
      continue
    }

    const spans: MdSpan[] = []
    renderInline(line, spans)
    push({ kind: 'text', spans })
  }

  numberLists(out)
  layoutTables(out)
  return out
}

/**
 * Renumber ordered lists, and size the marker column for the whole block.
 *
 * Both are things a line cannot know alone. Markdown lets every item be written
 * `1.` — the sequence is the renderer's job — and the markers only line up if
 * the items of a block agree on how wide their column is, so `10.` does not
 * push its own text out of step with `9.`.
 */
function numberLists(lines: MdLine[]): void {
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].kind !== 'list') continue

    // The block runs to the last list item, blank lines included: a blank line
    // between items is a loose list, not the end of one.
    let end = i
    for (let n = i; n < lines.length; n++) {
      if (lines[n].kind === 'list') end = n
      // A continuation belongs to the item above it, so it is part of the block.
      else if (lines[n].cont) end = n
      else if (lines[n].kind !== 'text' || lines[n].spans.some((span) => span.text.trim())) break
    }

    // One counter per depth. A deeper level starts at 1 and is forgotten on the
    // way back out, so a second sub-list does not continue the first one's
    // numbering.
    const counters: number[] = []
    let width = 2
    for (let n = i; n <= end; n++) {
      const line = lines[n]
      if (line.kind !== 'list' || !line.marker) continue
      const depth = line.depth ?? 0
      counters.length = depth + 1
      counters[depth] = (counters[depth] ?? 0) + 1
      line.marker = `${counters[depth]}.`
      // +1 for the gap between the marker and the text it labels.
      width = Math.max(width, line.marker.length + 1)
    }

    // Continuation lines get it too: their indent is the item's text column.
    for (let n = i; n <= end; n++)
      if (lines[n].kind === 'list' || lines[n].cont) lines[n].markerWidth = width
    i = end
  }
}

/** The cells of a `| a | b |` row, trimmed, with the outer pipes dropped. */
function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim())
}

/**
 * Give every row of a table block the same column weights and alignment.
 *
 * This is the one thing a line cannot know on its own: columns line up only if
 * the rows agree on their widths. So the per-line pass above stays per-line,
 * and this walks the finished array to hand each block's rows a shared layout.
 */
function layoutTables(lines: MdLine[]): void {
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].kind !== 'table') continue
    let end = i
    while (end + 1 < lines.length && lines[end + 1].kind === 'table') end++
    const block = lines.slice(i, end + 1)

    // Widest cell per column, in characters — the grid then splits the panel's
    // width in that proportion, so a column of dates never takes a third of a
    // table just because it is a column.
    const cols: number[] = []
    for (const row of block) {
      row.cells?.forEach((cell, c) => {
        const len = cell.reduce((n, span) => n + span.text.length, 0)
        cols[c] = Math.max(cols[c] ?? 1, Math.min(len, 40))
      })
    }

    const ruleAt = block.findIndex((row) => row.rule)
    const aligns = ruleAt === -1 ? [] : splitRow(block[ruleAt].spans[0].text).map(alignOf)

    block.forEach((row, n) => {
      row.cols = cols
      row.aligns = aligns
      // Everything above the |---| row is the header. A table without one has
      // no header at all rather than a first row pretending to be one.
      row.head = ruleAt > 0 && n < ruleAt
    })
    i = end
  }
}

const alignOf = (spec: string): 'left' | 'center' | 'right' =>
  spec.startsWith(':') && spec.endsWith(':')
    ? 'center'
    : spec.endsWith(':')
      ? 'right'
      : 'left'

/* --- list continuation --------------------------------------------------- */

export type Continuation = { value: string; cursor: number }

/**
 * The newline behaviour inside a list. Returns null when the caret is not on a
 * list item, and the caller should insert an ordinary newline.
 *
 * On an item with content, the next marker is written for you — numbers
 * increment, bullets repeat, indentation is kept. On an EMPTY item, the marker
 * is removed instead: pressing newline twice is how you leave a list, and
 * emitting a third empty bullet would trap you in it.
 */
export function continueList(value: string, cursor: number): Continuation | null {
  const lineStart = value.lastIndexOf('\n', cursor - 1) + 1
  const line = value.slice(lineStart, cursor)

  const m = LIST.exec(line)
  if (!m) return null

  const [, indent, marker, gap, content] = m

  if (!content.trim()) {
    // Empty item — drop the marker and end the list.
    const before = value.slice(0, lineStart)
    const after = value.slice(cursor)
    return { value: before + after, cursor: lineStart }
  }

  const next = /^\d/.test(marker)
    ? String(Number.parseInt(marker, 10) + 1) + marker.slice(-1)
    : marker
  const insert = '\n' + indent + next + gap
  return {
    value: value.slice(0, cursor) + insert + value.slice(cursor),
    cursor: cursor + insert.length
  }
}

/**
 * Drop blank lines from the top and bottom of a fenced block's body.
 *
 * A model that writes a fence with an empty line inside it means nothing by it,
 * but the block prints it: an empty row above and below the command, inside a
 * frame that already has padding. Only whole blank lines go — the first real
 * line keeps its indentation, which is part of the code.
 */
export function trimBlankEdges(code: string): string {
  return code.replace(/^(?:[ \t]*\r?\n)+/, '').replace(/(?:\r?\n[ \t]*)+$/, '')
}
