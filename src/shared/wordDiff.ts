// Which WORDS of a line changed.
//
// A unified diff answers at line granularity: a sentence that swapped three
// words comes back as one whole removed line and one whole added line, and the
// reader has to spot the difference themselves. This finds it for them.
//
// Shared rather than renderer-local because it is pure index arithmetic over
// two token lists — the kind of code that breaks silently and off-by-one, so it
// has to be testable under plain `node --test` — and because the main process
// will need it the day an MCP tool reports the same marks to an agent.
//
// The heuristics below are not decoration. A raw token diff of two rewritten
// sentences marks every shared "the" and "of" as surviving text, which renders
// as confetti and is harder to read than the two whole lines were. Each one was
// found by looking at the result.

/** A stretch of the display text, and which version of the file it belongs to. */
export interface Run {
  text: string
  /**
   * Absent for text both versions share. `cut` is only in the old file, `new`
   * only in the new one.
   */
  side?: 'cut' | 'new'
}

/**
 * Words and the gaps between them, both kept.
 *
 * Whitespace travels as its own token so a run can be rebuilt character for
 * character: `runs.map(r => r.text).join('')` has to give back the input, or
 * the marks would slide out from under the words they are marking.
 */
export function tokenize(text: string): string[] {
  return text.match(/\s+|\S+/g) ?? []
}

/** Words in common, over the longer side. 0 = nothing shared, 1 = identical. */
export function similarity(a: string, b: string): number {
  const words = tokenize(a).filter((t) => t.trim())
  const other = new Set(tokenize(b).filter((t) => t.trim()))
  if (!words.length || !other.size) return 0
  let hit = 0
  for (const word of words) if (other.has(word)) hit++
  return hit / Math.max(words.length, other.size)
}

type Op = ['=' | '-' | '+', string]

/**
 * Longest common subsequence, as an edit script.
 *
 * The table is O(n·m) in tokens. A line of prose is tens of tokens, so this is
 * nothing — but `MAX_TOKENS` keeps a pathological line (a minified blob on one
 * line, a base64 payload) from allocating a hundred million cells.
 */
const MAX_TOKENS = 400

function ops(a: string[], b: string[]): Op[] {
  const n = a.length
  const m = b.length
  const table: Uint16Array[] = []
  for (let i = 0; i <= n; i++) table.push(new Uint16Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
    }
  }

  const out: Op[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push(['=', a[i]])
      i++
      j++
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      out.push(['-', a[i++]])
    } else {
      out.push(['+', b[j++]])
    }
  }
  while (i < n) out.push(['-', a[i++]])
  while (j < m) out.push(['+', b[j++]])
  return out
}

/** Consecutive ops of the same kind, joined. */
function group(list: Op[]): Op[] {
  const out: Op[] = []
  for (const [op, text] of list) {
    const last = out[out.length - 1]
    if (last && last[0] === op) last[1] += text
    else out.push([op, text])
  }
  return out
}

const words = (text: string): number => tokenize(text).filter((t) => t.trim()).length

/**
 * A one or two word island between two changes reads as noise, not as text that
 * survived — "the" left standing between two rewritten clauses tells you
 * nothing and breaks the phrase in half. Fold it into the change around it.
 */
function absorbIslands(runs: Op[]): Op[] {
  const out: Op[] = []
  runs.forEach((run, i) => {
    const flanked = i > 0 && i < runs.length - 1 && runs[i - 1][0] !== '=' && runs[i + 1][0] !== '='
    if (run[0] === '=' && flanked && words(run[1]) <= 2) {
      out.push(['-', run[1]], ['+', run[1]])
    } else out.push(run)
  })
  return group(out)
}

/**
 * Past roughly half the words, a word-level diff stops being a diff: the marks
 * outnumber the text and the eye has nothing to hold. The line was rewritten,
 * and saying THAT is more useful than pointing at the words that happened to
 * survive. The floor keeps a two-word line — `mood: hopeful` — out of it, where
 * one word changing is always half of them.
 *
 * Judged over the WHOLE line, which is why the words peeled off the ends are
 * counted back in: the question is whether this line was rewritten, and asking
 * it of the residue instead would call every line with a shared opening a
 * rewrite — the residue is, by construction, the part that changed.
 */
function rewritten(list: Op[], shared: number): boolean {
  let same = shared
  let changed = 0
  for (const [op, text] of list) {
    if (!text.trim()) continue
    if (op === '=') same++
    else changed++
  }
  return same + changed >= 6 && changed / (same + changed) > 0.5
}

/** Drop empty runs and merge neighbours from the same side. */
function tidy(runs: Run[]): Run[] {
  const out: Run[] = []
  for (const run of runs) {
    if (!run.text) continue
    const last = out[out.length - 1]
    if (last && last.side === run.side) last.text += run.text
    else out.push({ ...run })
  }
  return out
}

/**
 * The old text and the new one, as one readable sequence.
 *
 * The runs that are NOT cut tile `after` exactly, in order — concatenate them
 * and you get the new file back. That is the contract the caller leans on to
 * map a run onto the rendered spans it covers. A cut run sits between them and
 * belongs to no offset in `after`.
 *
 * A cut run carries its own trailing space when the text after it starts on a
 * word, so the two versions never collide into `oldnew`. The space rides INSIDE
 * the mark on purpose: it exists only because both versions are on screen, so
 * it has to disappear with the half that is hiding it.
 */
export function markRuns(before: string, after: string): Run[] {
  if (before === after) return tidy([{ text: after }])

  const a = tokenize(before)
  const b = tokenize(after)

  // Peel what both sides open and close with. Text that never moved must not
  // end up inside a mark — that is what prints `title: ` twice — and the shared
  // ends are the cheapest tokens to keep out of the table below. They are still
  // counted when judging whether the line was rewritten; see `rewritten`.
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++
  }

  const lead = a.slice(0, head).join('')
  const trail = a.slice(a.length - tail).join('')
  const midBefore = a.slice(head, a.length - tail).join('')
  const midAfter = b.slice(head, b.length - tail).join('')

  const shared = words(lead) + words(trail)
  return tidy([{ text: lead }, ...middle(midBefore, midAfter, shared), { text: trail }])
}

function middle(before: string, after: string, shared: number): Run[] {
  if (!before.trim()) return [{ text: after, side: 'new' }]
  if (!after.trim()) return [{ text: before, side: 'cut' }]

  const a = tokenize(before)
  const b = tokenize(after)
  if (a.length > MAX_TOKENS || b.length > MAX_TOKENS) {
    return separate([{ text: before, side: 'cut' }, { text: after, side: 'new' }])
  }

  const list = ops(a, b)
  if (rewritten(list, shared)) {
    return separate([{ text: before, side: 'cut' }, { text: after, side: 'new' }])
  }

  const runs = absorbIslands(group(list))
  const out: Run[] = []
  let i = 0
  while (i < runs.length) {
    if (runs[i][0] === '=') {
      out.push({ text: runs[i][1] })
      i++
      continue
    }
    let cut = ''
    let add = ''
    while (i < runs.length && runs[i][0] !== '=') {
      if (runs[i][0] === '-') cut += runs[i][1]
      else add += runs[i][1]
      i++
    }
    out.push(...separate([{ text: cut, side: 'cut' }, { text: add, side: 'new' }]))
  }
  return separate(out)
}

/**
 * Keep a cut run from running into whatever follows it. Only the cut side is
 * padded: the new runs have to keep tiling `after` character for character.
 */
function separate(runs: Run[]): Run[] {
  const out = runs.filter((r) => r.text)
  return out.map((run, i) => {
    if (run.side !== 'cut') return run
    const next = out[i + 1]
    if (!next || /\s$/.test(run.text) || /^\s/.test(next.text)) return run
    return { ...run, text: `${run.text} ` }
  })
}
