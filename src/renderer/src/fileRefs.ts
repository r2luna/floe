/**
 * File references in the composer and the chat.
 *
 * A reference has to be resolvable by whoever reads the message — a skill lives
 * in Floe's config, not in the worktree, so `example.md:7-23` names nothing the
 * agent can open. So the whole path is what gets written, and what you see: the
 * reference in the box is the one that leaves it, and which of four `index.ts`
 * you picked is something you can check before pressing send.
 */

/** A path, then optionally `:12` or `:12-30`. */
const REF = /^(.*?)(:\d+(?:-\d+)?)?$/

// What could be a reference: a path with an extension, a leading `#` or `@` if
// it was typed as a mention, and an optional line range. Deliberately narrow —
// an ordinary word must not be drawn as a file.
const TOKEN = /(^|[\s([])([#@]?)((?:[\w.-]+\/)*[\w.-]+\.[A-Za-z][\w-]*(?::\d+(?:-\d+)?)?)/g

/**
 * Is this token a reference, or a word that merely looks like one?
 *
 * It qualifies by carrying a folder or a line range — `docs/notes.md`,
 * `notes.md:12` are addresses, `notes.md` mid-sentence is prose.
 */
export function isFileRef(token: string): boolean {
  return token.includes('/') || token.includes(':')
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
 * Split a reference into what a chip shows: the path, its lines, and the whole
 * thing for the tooltip.
 *
 * The path is shown whole — `src/renderer/src/panels.tsx`, not `panels.tsx`.
 * Which of four `index.ts` the message names is the part you check, and the
 * chip is what you check it in.
 */
export function describeRef(ref: string): { path: string; lines?: string; full: string } {
  const [, path = ref, lines] = REF.exec(ref) ?? []
  return { path, lines: lines?.slice(1), full: ref }
}
