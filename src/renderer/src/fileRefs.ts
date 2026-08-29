/**
 * Short file references in the composer, full ones on the wire.
 *
 * A reference has to be resolvable by whoever reads the message — a skill lives
 * in Floe's config, not in the worktree, so `example.md:7-23` names nothing the
 * agent can open. The full path fixes that and ruins the composer: a line of
 * `/Users/…/.config/floe/skills/example.md:7-23` is most of the box.
 *
 * So the two are separated. The text you edit carries a SHORT token (the file
 * name and its lines), and the map here remembers what it stands for; `expand`
 * puts the full reference back at send time. The map is module state on purpose:
 * both composers, the file reader and the `#` menu all mint tokens, and a
 * reference minted in one panel has to survive being typed about in another.
 */

/** short token → the full reference it stands for. */
const full = new Map<string, string>()

/** A path, then optionally `:12` or `:12-30`. */
const REF = /^(.*?)(:\d+(?:-\d+)?)?$/

/**
 * Register `ref` and return the shortest token that still means only it.
 *
 * Shortest is the file name; a second file of the same name in another folder
 * takes one more segment, and so on, so two `index.ts` from different folders
 * never collapse into one token that expands to the wrong file.
 */
export function shorten(ref: string): string {
  const [, path = ref, lines = ''] = REF.exec(ref) ?? []
  const parts = path.split('/').filter(Boolean)

  for (let take = 1; take <= parts.length; take++) {
    const token = parts.slice(-take).join('/') + lines
    const claimed = full.get(token)
    if (claimed === undefined) {
      // A short token that is already the whole reference needs no entry —
      // remembering it would only make `expand` rewrite text into itself.
      if (token !== ref) full.set(token, ref)
      return token
    }
    if (claimed === ref) return token
  }
  // Every segment used and still taken: it IS the full reference, so say it.
  return ref
}

// What could be a reference: a path with an extension, a leading `#` or `@` if
// it was typed as a mention, and an optional line range. Deliberately narrow —
// a token that is not shaped like a file must not be looked up, or an ordinary
// word could expand into a path.
const TOKEN = /(^|[\s([])([#@]?)((?:[\w.-]+\/)*[\w.-]+\.[A-Za-z][\w-]*(?::\d+(?:-\d+)?)?)/g

/**
 * Put the full reference back wherever a short one is still standing.
 *
 * Called on the way out, never on the way in: the text the user edits stays
 * short, and only the message actually sent carries the long form.
 */
export function expand(text: string): string {
  if (!full.size) return text
  return text.replace(TOKEN, (all, before: string, mark: string, token: string) => {
    const long = full.get(token)
    return long ? `${before}${mark}${long}` : all
  })
}

/**
 * Is this token a reference, or a word that merely looks like one?
 *
 * Two ways to qualify. It carries a folder or a line range — `docs/notes.md`,
 * `notes.md:12` are addresses, `notes.md` mid-sentence is prose. Or it is a
 * short token this module minted, which is the case that matters in the
 * composer: what you insert from the `#` menu is the file NAME, and only this
 * map knows that `Composer.tsx` stands for a path.
 */
export function isFileRef(token: string): boolean {
  return token.includes('/') || token.includes(':') || full.has(token)
}

/** A run of plain text, or a file reference the chat draws as a chip. */
export type TextPart = { text: string; ref?: undefined } | { ref: string; text?: undefined }

/**
 * Cut `text` into plain runs and the file references between them.
 *
 * A token counts only when it is more than a word that happens to end in a
 * dot-something: it carries a folder or a line range. `notes.md` mid-sentence
 * is prose and stays prose; `docs/notes.md` and `notes.md:12-30` are addresses
 * and get drawn as one.
 */
export function splitRefs(text: string): TextPart[] {
  const out: TextPart[] = []
  let last = 0
  for (const m of text.matchAll(TOKEN)) {
    const token = m[3]
    if (!isFileRef(token)) continue
    const at = m.index + m[1].length
    if (at > last) out.push({ text: text.slice(last, at) })
    out.push({ ref: token })
    last = at + m[2].length + token.length
  }
  if (last < text.length) out.push({ text: text.slice(last) })
  return out
}

/**
 * Split a reference into what a chip shows: the file name, its lines, and the
 * whole thing for the tooltip.
 */
export function describeRef(ref: string): { name: string; lines?: string; full: string } {
  const [, path = ref, lines] = REF.exec(ref) ?? []
  const name = path.split('/').filter(Boolean).pop() ?? path
  return { name, lines: lines?.slice(1), full: ref }
}

/** Test seam — the map is process-wide, and a test must not inherit another's. */
export function resetRefs(): void {
  full.clear()
}
