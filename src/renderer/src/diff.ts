// Parse a unified diff (the output of `git diff`) into a structure the diff
// viewer can render and the keyboard can navigate. We only care about a single
// file's diff at a time, so file headers are skipped and every hunk's lines
// carry their old/new line numbers for the gutter and for comment anchoring.

export type DiffLineKind = 'add' | 'del' | 'ctx'

export interface DiffLine {
  kind: DiffLineKind
  text: string // the line content, without the leading +/-/space marker
  oldNo?: number // 1-based line number on the old side (del + ctx)
  newNo?: number // 1-based line number on the new side (add + ctx)
}

export interface DiffHunk {
  header: string // the @@ … @@ section heading
  lines: DiffLine[]
}

// A single selectable row in the rendered diff: either a hunk header (not
// selectable for comments) or a code line. We flatten hunks into this list so
// the cursor is a plain index walk, like FileTree's rows.
export interface DiffRow {
  kind: 'hunk' | DiffLineKind
  text: string
  oldNo?: number
  newNo?: number
  hunkIndex: number
}

export interface ParsedDiff {
  hunks: DiffHunk[]
  rows: DiffRow[]
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/

export function parseUnifiedDiff(text: string): ParsedDiff {
  const hunks: DiffHunk[] = []
  const rows: DiffRow[] = []
  let hunk: DiffHunk | null = null
  let oldNo = 0
  let newNo = 0

  for (const raw of text.split('\n')) {
    const m = HUNK_RE.exec(raw)
    if (m) {
      oldNo = Number(m[1])
      newNo = Number(m[2])
      hunk = { header: raw, lines: [] }
      hunks.push(hunk)
      rows.push({ kind: 'hunk', text: raw, hunkIndex: hunks.length - 1 })
      continue
    }
    if (!hunk) continue // skip the file header preamble (diff --git, ---, +++, etc.)

    const marker = raw[0]
    const body = raw.slice(1)
    const hunkIndex = hunks.length - 1

    if (marker === '+') {
      const line: DiffLine = { kind: 'add', text: body, newNo }
      hunk.lines.push(line)
      rows.push({ kind: 'add', text: body, newNo, hunkIndex })
      newNo++
    } else if (marker === '-') {
      const line: DiffLine = { kind: 'del', text: body, oldNo }
      hunk.lines.push(line)
      rows.push({ kind: 'del', text: body, oldNo, hunkIndex })
      oldNo++
    } else if (marker === ' ') {
      const line: DiffLine = { kind: 'ctx', text: body, oldNo, newNo }
      hunk.lines.push(line)
      rows.push({ kind: 'ctx', text: body, oldNo, newNo, hunkIndex })
      oldNo++
      newNo++
    }
    // A line starting with '\' ("\ No newline at end of file") is ignored.
  }

  return { hunks, rows }
}

// Reconstruct the old/new file text from the rows so a syntax highlighter can
// tokenize each side with full multi-line context. `map[i]` points row i at its
// line within the matching side (null for hunk headers); context lines belong
// to both sides but render from the new one.
export interface DiffSides {
  newCode: string
  oldCode: string
  map: ({ side: 'new' | 'old'; line: number } | null)[]
}

export function diffSides(rows: DiffRow[]): DiffSides {
  const newLines: string[] = []
  const oldLines: string[] = []
  const map: DiffSides['map'] = []
  for (const r of rows) {
    if (r.kind === 'add') {
      map.push({ side: 'new', line: newLines.length })
      newLines.push(r.text)
    } else if (r.kind === 'del') {
      map.push({ side: 'old', line: oldLines.length })
      oldLines.push(r.text)
    } else if (r.kind === 'ctx') {
      map.push({ side: 'new', line: newLines.length })
      newLines.push(r.text)
      oldLines.push(r.text)
    } else {
      map.push(null) // hunk header
    }
  }
  return { newCode: newLines.join('\n'), oldCode: oldLines.join('\n'), map }
}

// The side + line number a comment on this row anchors to. Added/context lines
// anchor to the new side; deleted lines anchor to the old side.
export function rowAnchor(row: DiffRow): { side: 'new' | 'old'; line: number } | null {
  if (row.kind === 'del') return row.oldNo != null ? { side: 'old', line: row.oldNo } : null
  if (row.kind === 'add' || row.kind === 'ctx')
    return row.newNo != null ? { side: 'new', line: row.newNo } : null
  return null
}

// The directory every changed path shares. Shown once above the list so each
// row can drop it — in a session that touched one area, the prefix is the part
// carrying no information.
//
// Split on '/' boundaries, never on characters: `panels.tsx` and `parse.ts`
// share the letters "pa" but not a directory, and trimming to that would
// produce a path that never existed.
export function commonDir(paths: string[]): string {
  if (paths.length < 2) return ''
  const parts = paths.map((p) => p.split('/').slice(0, -1))
  let i = 0
  while (parts.every((s) => i < s.length && s[i] === parts[0][i])) i++
  return i ? parts[0].slice(0, i).join('/') + '/' : ''
}

/* --- line selection ------------------------------------------------------- */

// A visual-mode selection over rows: `anchor` is where you pressed v, `head` is
// where the cursor is now. Kept unordered so extending upward works the same as
// downward; `selRange` is what everything else reads.
export interface DiffSelection {
  anchor: number
  head: number
}

export function selRange(sel: DiffSelection | null | undefined): [number, number] | null {
  if (!sel) return null
  return sel.anchor <= sel.head ? [sel.anchor, sel.head] : [sel.head, sel.anchor]
}

export function inSelection(sel: DiffSelection | null | undefined, row: number): boolean {
  const r = selRange(sel)
  return !!r && row >= r[0] && row <= r[1]
}

/**
 * The comment body for a selection: a location line, then the selected rows as
 * a diff block.
 *
 * The markers are kept (`+`, `-`, space) rather than stripped — the whole point
 * of commenting on a diff is that you're pointing at a change, and "this line"
 * means something different depending on which side it's on. Line numbers come
 * from the side each row actually belongs to (see rowAnchor).
 */
export function quoteSelection(rows: DiffRow[], from: number, to: number, path: string): string {
  const picked = rows.slice(from, to + 1).filter((r) => r.kind !== 'hunk')
  if (!picked.length) return ''

  const first = rowAnchor(picked[0])
  const last = rowAnchor(picked[picked.length - 1])
  const span = first && last && first.line !== last.line ? `${first.line}-${last.line}` : `${first?.line ?? ''}`

  const body = picked
    .map((r) => (r.kind === 'add' ? '+' : r.kind === 'del' ? '-' : ' ') + r.text)
    .join('\n')

  return `${path}:${span}\n\n\`\`\`diff\n${body}\n\`\`\`\n\n`
}

/**
 * Append a quoted block to whatever is already in the composer.
 *
 * Appending, not prepending: you build a review by picking a range, saying
 * something about it, picking the next range. Each new block has to land after
 * the note you just wrote, or the message reads backwards by the time you send
 * it.
 *
 * Exactly one blank line between what was there and what arrives — the block
 * already ends with one, so the join is the only place spacing can go wrong.
 */
export function appendComment(base: string, block: string): string {
  const trimmed = base.replace(/\s+$/, '')
  return trimmed ? `${trimmed}\n\n${block}` : block
}
