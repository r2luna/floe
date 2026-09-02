// A markdown diff, as a document.
//
// The code view answers "which lines changed". Reading prose, that is the wrong
// grain: a sentence that swapped three words comes back as one whole red line
// and one whole green line, and finding the change is left to the reader. This
// pairs a removed line with the added line that replaced it and marks only the
// words that moved, inside the line as the panel already renders it.
//
// The diff is taken over the RENDERED text, not the source: the reader never
// sees `**` or a URL, so marking them would be marking something that is not on
// screen. What is left of the source — a link's destination — is reported on
// the line instead.
//
// Pure, and returns data rather than elements, because the pairing is the part
// that can be wrong in ways a screenshot will not show.

import { markRuns, similarity } from '../../shared/wordDiff.ts'
import type { DiffRow, DiffSides } from './diff.ts'
import { splitByRanges } from './findHits.ts'
import type { MdLine, MdSpan } from './markdown.ts'

/** Markdown is the only thing the prose view knows how to draw. */
export const READS_AS_PROSE = /\.(md|markdown|mdx)$/i

export interface ProseRow {
  /** `mod` is the one the code view cannot express: a line whose words changed. */
  kind: 'ctx' | 'add' | 'del' | 'mod'
  oldNo?: number
  newNo?: number
  /** The line as the file panel draws it, its spans already carrying the marks. */
  line: MdLine
  /** A link on this line now points somewhere else. */
  relink?: { from: string; to: string }
}

/** How alike two lines must read before one is called a rewrite of the other. */
const PAIRED = 0.3

const textOf = (line: MdLine): string => line.spans.map((s) => s.text).join('')

const withClass = (cls: string, extra: string): string => (cls ? `${cls} ${extra}` : extra)

/** Every `](destination)` in a source line, in order. */
function destinations(source: string): string[] {
  return [...source.matchAll(/\]\(([^)\n]*)\)/g)].map((m) => m[1])
}

/**
 * The first link whose destination moved.
 *
 * Compared by position, not by text: a line usually has one link, and pairing
 * them any more cleverly would be inventing certainty the diff does not have.
 */
function relinked(before: string, after: string): { from: string; to: string } | undefined {
  const was = destinations(before)
  const now = destinations(after)
  for (let i = 0; i < now.length; i++) {
    if (was[i] !== undefined && was[i] !== now[i]) return { from: was[i], to: now[i] }
  }
  return undefined
}

/**
 * The new line's spans, cut at the word boundaries the diff found.
 *
 * `markRuns` guarantees the runs that are not cuts tile the new text exactly,
 * which is what lets a run be turned into a [from, to) over the rendered line
 * and handed to the same splitter the find bar uses. A cut belongs to no offset
 * in the new text, so it is remembered by the offset it sits AT and emitted
 * when the walk reaches it.
 */
function markSpans(oldLine: MdLine, newLine: MdLine, relink?: { from: string; to: string }): MdSpan[] {
  const runs = markRuns(textOf(oldLine), textOf(newLine))

  const cutsAt = new Map<number, string>()
  const added: Array<[number, number]> = []
  let at = 0
  for (const run of runs) {
    if (run.side === 'cut') {
      cutsAt.set(at, (cutsAt.get(at) ?? '') + run.text)
      continue
    }
    if (run.side === 'new') added.push([at, at + run.text.length])
    at += run.text.length
  }

  // The link is marked before the split, so the class rides along with the
  // style into however many pieces the span ends up cut into.
  let links = 0
  const source = newLine.spans.map((span) => {
    if (!relink || !span.cls.split(' ').includes('md-link')) return span
    return links++ === 0 ? { ...span, cls: withClass(span.cls, 'md-relink') } : span
  })

  const pieces = splitByRanges(
    source.map((span) => ({ content: span.text, style: span.cls })),
    added
  )

  const out: MdSpan[] = []
  let off = 0
  const flushCut = (): void => {
    const cut = cutsAt.get(off)
    if (cut) out.push({ text: cut, cls: 'md-cut' })
  }

  flushCut()
  for (const piece of pieces) {
    out.push({ text: piece.content, cls: piece.hit ? withClass(piece.style, 'md-new') : piece.style })
    off += piece.content.length
    flushCut()
  }
  return out
}

/**
 * A table row is a grid of cells, not a line of spans, so the word marks have
 * nowhere to live in it. Such a row keeps the honest two-line shape rather than
 * a half-marked one.
 */
const markable = (line?: MdLine): boolean => !!line && line.kind !== 'table' && !line.cells

/**
 * The diff's rows, rendered.
 *
 * `newDoc` and `oldDoc` are `renderMarkdown` over the two sides `diffSides`
 * reconstructed, so a line is rendered with the document around it rather than
 * on its own.
 */
export function proseRows(
  rows: DiffRow[],
  sides: DiffSides,
  newDoc: MdLine[],
  oldDoc: MdLine[]
): ProseRow[] {
  const lineAt = (index: number): MdLine | undefined => {
    const at = sides.map[index]
    if (!at) return undefined
    return (at.side === 'new' ? newDoc : oldDoc)[at.line]
  }

  const out: ProseRow[] = []
  let i = 0

  while (i < rows.length) {
    const row = rows[i]

    // With full-file context there is one hunk header and it says nothing a
    // document reader wants; the line numbers already carry the position.
    if (row.kind === 'hunk') {
      i++
      continue
    }

    if (row.kind === 'ctx') {
      const line = lineAt(i)
      if (line) out.push({ kind: 'ctx', oldNo: row.oldNo, newNo: row.newNo, line })
      i++
      continue
    }

    // One run of change: everything removed here, then everything added.
    const cut: number[] = []
    const add: number[] = []
    while (i < rows.length && (rows[i].kind === 'del' || rows[i].kind === 'add')) {
      ;(rows[i].kind === 'del' ? cut : add).push(i)
      i++
    }

    /*
     * Which removed line each added line rewrites.
     *
     * Best match first, by words in common. A line can be rewritten so
     * thoroughly that it shares nothing with the one it replaces — a retitled
     * heading is the normal case — so when both halves of the run are the same
     * length they are paired in order instead, which is what a person editing
     * in place actually did.
     */
    const free = cut.filter((index) => markable(lineAt(index)))
    const inOrder = cut.length === add.length
    const pairs = new Map<number, number>()
    add.forEach((index, nth) => {
      if (!markable(lineAt(index))) return
      let best = -1
      let score = PAIRED
      for (const other of free) {
        const sim = similarity(textOf(lineAt(other) as MdLine), textOf(lineAt(index) as MdLine))
        if (sim > score) {
          score = sim
          best = other
        }
      }
      if (best < 0 && inOrder && free.includes(cut[nth])) best = cut[nth]
      if (best < 0) return
      pairs.set(index, best)
      free.splice(free.indexOf(best), 1)
    })

    // A line that was only removed goes first: it left before the rest arrived.
    const taken = new Set(pairs.values())
    for (const index of cut) {
      if (taken.has(index)) continue
      const line = lineAt(index)
      if (line) out.push({ kind: 'del', oldNo: rows[index].oldNo, line })
    }

    // Then the new lines, in the order the file has them.
    for (const index of add) {
      const line = lineAt(index)
      if (!line) continue
      const from = pairs.get(index)
      if (from === undefined) {
        out.push({ kind: 'add', newNo: rows[index].newNo, line })
        continue
      }
      const old = lineAt(from) as MdLine
      const relink = relinked(rows[from].text, rows[index].text)
      out.push({
        kind: 'mod',
        oldNo: rows[from].oldNo,
        newNo: rows[index].newNo,
        // The new document's shape, carrying both versions' words.
        line: { ...line, spans: markSpans(old, line, relink) },
        relink
      })
    }
  }

  return out
}
