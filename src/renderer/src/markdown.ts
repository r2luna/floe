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

function inline(text: string, out: Token[]): void {
  let last = 0
  INLINE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = INLINE.exec(text))) {
    if (m.index > last) out.push({ text: text.slice(last, m.index), cls: '' })
    const cls = m[1] ? 'md-code' : m[2] ? 'md-bold' : m[3] ? 'md-em' : 'md-link'
    out.push({ text: m[0], cls })
    last = m.index + m[0].length
  }
  if (last < text.length) out.push({ text: text.slice(last), cls: '' })
}

/**
 * Colour markdown source. The concatenation of every token's text always equals
 * the input — see the note above on why that matters.
 */
export function tokenizeMarkdown(text: string): Token[] {
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
      inline(list[4], out)
      return
    }

    inline(line, out)
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
  kind: 'text' | 'heading' | 'list' | 'quote' | 'fence' | 'code' | 'rule' | 'table'
  spans: MdSpan[]
  /** Heading level, 1-6. */
  level?: number
  /** How deep a list item sits, in indent steps. */
  depth?: number
  /** The bullet or number drawn in place of the source marker. */
  marker?: string
}

// Inline spans with their delimiters, so the rendered text can drop them.
const RENDER_INLINE =
  /`([^`\n]+)`|\*\*([^*\n]+)\*\*|__([^_\n]+)__|\*([^*\n]+)\*|_([^_\n]+)_|\[([^\]\n]*)\]\(([^)\n]*)\)/g

function renderInline(text: string, out: MdSpan[]): void {
  let last = 0
  RENDER_INLINE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = RENDER_INLINE.exec(text))) {
    if (m.index > last) out.push({ text: text.slice(last, m.index), cls: '' })
    const [, code, bold, boldAlt, em, emAlt, link] = m
    if (code !== undefined) out.push({ text: code, cls: 'md-code' })
    else if (bold !== undefined || boldAlt !== undefined)
      out.push({ text: (bold ?? boldAlt) as string, cls: 'md-bold' })
    else if (em !== undefined || emAlt !== undefined)
      out.push({ text: (em ?? emAlt) as string, cls: 'md-em' })
    else out.push({ text: link ?? '', cls: 'md-link' })
    last = m.index + m[0].length
  }
  if (last < text.length) out.push({ text: text.slice(last), cls: '' })
}

/** Render a whole file, line by line. The array is 1:1 with the source lines. */
export function renderMarkdown(text: string): MdLine[] {
  const out: MdLine[] = []
  let fence: string | null = null

  for (const line of text.split('\n')) {
    const fenceMatch = FENCE.exec(line)
    if (fenceMatch) {
      const mark = fenceMatch[2]
      const open = fence
      if (!open) fence = mark
      else if (mark[0] === open[0] && mark.length >= open.length) fence = null
      // The fence itself is not content: it keeps its row (the numbers must
      // stay true to the file) but shows only the language, if it named one.
      out.push({ kind: 'fence', spans: [{ text: open ? '' : fenceMatch[3].trim(), cls: '' }] })
      continue
    }
    // Inside a fence everything is literal — no bold, no links, no bullets.
    if (fence) {
      out.push({ kind: 'code', spans: [{ text: line, cls: '' }] })
      continue
    }

    if (HR.test(line) && line.trim()) {
      out.push({ kind: 'rule', spans: [] })
      continue
    }

    const heading = HEADING.exec(line)
    if (heading) {
      const spans: MdSpan[] = []
      renderInline(heading[2], spans)
      out.push({ kind: 'heading', level: heading[1].trim().length, spans })
      continue
    }

    const quote = QUOTE.exec(line)
    if (quote) {
      const spans: MdSpan[] = []
      renderInline(quote[2], spans)
      out.push({ kind: 'quote', spans })
      continue
    }

    const list = LIST.exec(line)
    if (list) {
      const spans: MdSpan[] = []
      renderInline(list[4], spans)
      out.push({
        kind: 'list',
        // Two spaces per level is the common case and the only one a line can
        // know on its own; a tab counts as one step.
        depth: Math.floor(list[1].replace(/\t/g, '  ').length / 2),
        marker: /^\d/.test(list[2]) ? list[2] : '•',
        spans
      })
      continue
    }

    // A table row keeps its pipes: they are what lines the columns up, and the
    // panel is monospaced, so the source already reads as a table.
    if (/^\s*\|/.test(line)) {
      // The |---|:--| row is scaffolding, not content: it stays (the numbers
      // must match the file) but reads as a rule rather than as a row.
      const rule = /^[\s|:-]+$/.test(line)
      out.push({ kind: 'table', spans: [{ text: line, cls: rule ? 'md-marker' : '' }] })
      continue
    }

    const spans: MdSpan[] = []
    renderInline(line, spans)
    out.push({ kind: 'text', spans })
  }

  return out
}

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
