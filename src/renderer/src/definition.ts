import type { SymbolDefinition } from '../../shared/types'

// The reader half of go-to-definition: which name a click or the cursor line
// means, and which of main's answers to jump to. Lookup itself is
// main/definitions.ts.

const IDENTIFIER = /[A-Za-z_$][\w$]*/g

/**
 * Words that are never a symbol you would look up, across the languages the
 * viewer highlights. Skipping them is what lets `d` on `export const foo =
 * bar()` reach `bar` instead of asking where `export` is defined.
 */
const KEYWORDS = new Set(
  (
    'abstract as async await break case catch class const continue def default defer delete do elif else enum ' +
    'export extends false final finally fn for from func function go if impl implements import in instanceof ' +
    'interface is let match mod module mut namespace new nil none null of override package private protected pub ' +
    'public readonly return self static struct super switch this throw throws trait true try type typeof undefined ' +
    'use val var void where while with yield string number boolean any unknown never int bool str'
  ).split(' ')
)

/** The identifier `offset` falls in, or touches from the left. Null on anything else. */
export function wordAt(text: string, offset: number): string | null {
  for (const m of text.matchAll(IDENTIFIER)) {
    if (offset >= m.index && offset <= m.index + m[0].length) return /^\d/.test(m[0]) ? null : m[0]
  }
  return null
}

/** A name declared right after one of these is defined BY the line, not used on it. */
const DECLARED = /(?:const|let|var|val|function\*?|class|def|fn|func|fun|type|interface|enum|struct|trait)\s+([A-Za-z_$][\w$]*)/g

/**
 * The names on a line worth looking up, in reading order, each once. What the
 * line itself declares is left out: on `const target = pick(defs)` the name
 * you want is `pick`, and `target` would only find some other `target`.
 */
export function identifiersOf(line: string): string[] {
  const declared = new Set([...line.matchAll(DECLARED)].map((m) => m[1]))
  const names = (line.match(IDENTIFIER) ?? []).filter((w) => !KEYWORDS.has(w) && !declared.has(w))
  return [...new Set(names)]
}

/**
 * The definition to jump to, from `defs` ranked with the reading file first.
 *
 * The one you are standing on is skipped, so clicking a definition reaches the
 * next one in the same file (an overload, a re-declaration). But standing on
 * the file's only definition means the name is local to it: another file's
 * `target` is a different symbol that happens to share the name, so there is
 * nowhere to go.
 */
export function pickDefinition(
  defs: SymbolDefinition[],
  from: { path: string; line?: number }
): SymbolDefinition | null {
  const here = (d: SymbolDefinition): boolean => d.path === from.path
  const onIt = defs.some((d) => here(d) && d.line === from.line)
  const rest = defs.filter((d) => !here(d) || d.line !== from.line)
  return (onIt ? rest.find(here) : rest[0]) ?? null
}
