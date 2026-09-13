// What presses a command, read from the keymap that is actually installed.
//
// The registry used to carry a hand-written `keys` string per command. It was a
// second copy of the keymap, and it drifted: `commands.open` claimed ⌘K C while
// the keymap bound ⌘K C to `panel.goto commands`, `panel.goto` named three of
// its ten bindings, and Escape was spelled three ways. Deriving the chip from
// the live bindings makes the palette, the rail tooltip and the MCP list agree
// with the file the user edits — and a rebind shows up everywhere at once.

import { formatChord, type Keybind } from '../../shared/keymap.ts'

/** The flags, in the words a chip has room for. */
const FLAG_WORDS: Record<string, string> = {
  'stack-below': 'stacked',
  'stack-above': 'stacked'
}

/**
 * A `when` clause, said the way a chip says it: `panel == "files"` is `files`,
 * `panel in ["diff", "file"]` is `diff, file`, `typing` stays `typing`.
 *
 * Tolerant rather than a second parser: an expression this cannot read is
 * returned as it was written, which is still true, only longer.
 */
export function describeWhen(when?: string): string | undefined {
  if (!when) return undefined
  const term = (raw: string): string => {
    const t = raw.trim()
    let m = /^panel\s*(==|!=)\s*["']([^"']+)["']$/.exec(t)
    if (m) return m[1] === '==' ? m[2] : `not ${m[2]}`
    m = /^panel\s+in\s*\[([^\]]*)\]$/.exec(t)
    if (m) return m[1].split(',').map((v) => v.trim().replace(/^["']|["']$/g, '')).filter(Boolean).join(', ')
    m = /^not\s+(.+)$/.exec(t)
    if (m) return `not ${term(m[1])}`
    return FLAG_WORDS[t] ?? t
  }
  return when
    .split(/\s+or\s+/)
    .map((part) => part.split(/\s+and\s+/).map(term).join(', '))
    .join(' or ')
}

export interface KeyHint {
  /** The one binding a row has room for: the first that fires, with its context. */
  chip: string
  /** Every binding, for the pane that explains the row. */
  all: string
}

/**
 * The bindings for a command — for one of its arguments, when it takes any.
 *
 * `arg` narrows the way the keymap does: a bind carrying `arg: 'files'` belongs
 * to the `panel.goto files` row and to no other, and a command without
 * arguments only matches binds without one. First match wins in the keymap, so
 * the first bind here is the one that actually fires.
 */
export function keyHint(binds: readonly Keybind[], id: string, arg?: string): KeyHint | undefined {
  const mine = binds.filter((b) => b.command === id && (b.arg ?? undefined) === arg)
  if (!mine.length) return undefined
  const labels: string[] = []
  const seen = new Set<string>()
  for (const b of mine) {
    const where = describeWhen(b.when)
    const label = formatChord(b.key) + (where ? ` · ${where}` : '')
    if (seen.has(label)) continue
    seen.add(label)
    labels.push(label)
  }
  return { chip: labels[0], all: labels.join(' / ') }
}
