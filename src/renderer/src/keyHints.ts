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

/** One entry of a panel's key footer: the keys, and what they do there. */
export interface PanelKey {
  keys: string
  label: string
}

/**
 * Whether a `when` clause holds in a panel of this kind, and only there.
 *
 * Only a bare panel scope counts — `panel == "files"`, `panel in [...]`, or an
 * `or` of them. A clause that also needs a flag (`and selecting`, `and marked`)
 * is a key that is off most of the time, and a footer that names a key the
 * panel then ignores is worse than one that leaves it to `?`.
 */
export function scopedTo(when: string | undefined, kind: string): boolean {
  if (!when) return false
  return when.split(/\s+or\s+/).some((part) => {
    const t = part.trim()
    let m = /^panel\s*==\s*["']([^"']+)["']$/.exec(t)
    if (m) return m[1] === kind
    m = /^panel\s+in\s*\[([^\]]*)\]$/.exec(t)
    if (m) return m[1].split(',').some((v) => v.trim().replace(/^["']|["']$/g, '') === kind)
    return false
  })
}

/**
 * The footer under a panel: the keys that panel alone answers to.
 *
 * Read from the bindings in force, like the `?` overlay, so a rebind shows up
 * here too. Global keys are left out on purpose — they mean the same thing in
 * every panel, and repeating them under each one would bury the few that do
 * not. Two binds for one command share an entry (`j k`), and a command the
 * palette does not offer (`titleOf` returns null) is not advertised either.
 */
export function panelKeys(
  binds: readonly Keybind[],
  kind: string,
  titleOf: (command: string, arg?: string) => string | null
): PanelKey[] {
  const out: PanelKey[] = []
  const byLabel = new Map<string, PanelKey>()
  for (const b of binds) {
    if (!scopedTo(b.when, kind)) continue
    const title = titleOf(b.command, b.arg)
    if (!title) continue
    const label = shortTitle(title)
    const keys = footerChord(b.key)
    const had = byLabel.get(label)
    if (had) {
      if (!had.keys.split(' ').includes(keys)) had.keys += ` ${keys}`
      continue
    }
    const entry = { keys, label }
    byLabel.set(label, entry)
    out.push(entry)
  }
  return out
}

/**
 * A chord the way the footer prints it. A bare letter stays lower case, as it
 * is typed — `formatChord` capitalises it, which next to a shifted `H` would
 * make `n` and `⇧N` look like the same key. `shift+?` reads as `?`, since shift
 * is how that key is typed, not part of a chord.
 */
function footerChord(key: string): string {
  if (/^[a-z]$/.test(key)) return key
  if (/^shift\+[a-z]$/.test(key)) return key.slice(-1).toUpperCase()
  return formatChord(/^shift\+[^a-z]$/.test(key) ? key.slice('shift+'.length) : key)
}

/**
 * A palette title cut to footer size: the aside in brackets goes, and the
 * sentence case with it — `Task status up (idea → shaping → ready)` is
 * `task status up`. An acronym keeps its capital (`MCP…`).
 */
export function shortTitle(title: string): string {
  const t = title.replace(/\s*\([^)]*\)\s*$/, '').replace(/…$/, '').trim()
  return /^[A-Z][a-z]/.test(t) ? t[0].toLowerCase() + t.slice(1) : t
}
