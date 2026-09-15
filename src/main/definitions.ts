import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { SymbolDefinition } from '../shared/types'

const execFileAsync = promisify(execFile)

// Go-to-definition for the file and diff viewers, without a language server.
//
// `git grep -w` finds every line naming the symbol, and the patterns below keep
// the lines that DEFINE it. That is a guess, not a compiler's answer — but it is
// one guess for every language the viewer highlights, it needs nothing
// installed, and it reads the worktree as it is on disk, which is what a review
// is looking at.

/** Anything else is not an identifier, and a pattern built from it would be a different pattern. */
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/

/** A minified bundle names everything on one line; it is never the definition you wanted. */
const MAX_LINE = 400

const MAX_DEFINITIONS = 50

/**
 * The lines that define `name`, as regexes. Word boundaries are written out as
 * lookarounds because `\b` does not treat `$` as part of a name.
 */
export function definitionPatterns(name: string): RegExp[] {
  const n = name.replace(/\$/g, '\\$')
  const end = '(?![\\w$])'
  return [
    // A type, in the spelling nearly every language shares: `class Foo`, `struct Foo`, `enum Foo`.
    new RegExp(
      `(?<![\\w$])(?:class|interface|type|enum|struct|trait|protocol|module|record|object|namespace|typealias|mod)\\s+${n}${end}`
    ),
    // A function: `function`, `def`, `fn`, `fun`, and Go's `func (r *T) Foo`.
    new RegExp(`(?<![\\w$])(?:function\\*?|def|fn|func|fun)\\s+(?:\\([^)]*\\)\\s*)?(?:self\\.)?${n}${end}`),
    // A binding: `const foo =`, `let foo: T =`.
    new RegExp(`(?<![\\w$])(?:const|let|var|val)\\s+${n}\\s*[=:]`),
    // An arrow or function bound to a name — a class field or an object key.
    new RegExp(`^\\s*(?:[\\w$]+\\s+)*${n}\\s*[:=]\\s*(?:async\\s*)?(?:\\([^)]*\\)|[\\w$]+)\\s*(?::[^=]+)?=>`),
    // A method with its body opening on the same line: `async foo(a: T): R {`, `public void foo() {`.
    new RegExp(`^\\s*(?:[\\w$<>\\[\\],.?]+\\s+)*\\*?${n}\\s*(?:<[^>]*>)?\\([^)]*\\)\\s*(?::\\s*[^={;]+)?\\{\\s*$`)
  ]
}

/** Whether a line of source defines `name`. */
export function definesName(line: string, patterns: RegExp[]): boolean {
  return line.length <= MAX_LINE && patterns.some((p) => p.test(line))
}

/**
 * `git grep -z -n` output → definitions of `name`. Each match is
 * `path\0line\0text`, which survives a path with a colon in it.
 */
export function parseDefinitions(stdout: string, name: string): SymbolDefinition[] {
  const patterns = definitionPatterns(name)
  const out: SymbolDefinition[] = []
  for (const record of stdout.split('\n')) {
    const [path, line, text] = record.split('\0')
    if (text === undefined || !definesName(text, patterns)) continue
    out.push({ path, line: Number(line), text: text.trim() })
  }
  return out
}

/**
 * The file you are reading first: a name defined there is almost always the one
 * you meant. Everything else keeps git's path order. Stable, so a file's own
 * definitions stay in line order.
 */
export function rankDefinitions(defs: SymbolDefinition[], fromPath?: string): SymbolDefinition[] {
  return [...defs].sort((a, b) => Number(b.path === fromPath) - Number(a.path === fromPath))
}

/**
 * Where `name` is defined in the worktree, best guess first. Empty when it is
 * not an identifier, not defined anywhere, or the tree is not a repo.
 */
export async function findDefinitions(
  worktreePath: string,
  name: string,
  fromPath?: string
): Promise<SymbolDefinition[]> {
  if (!IDENTIFIER.test(name)) return []
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', worktreePath, 'grep', '-z', '-n', '-I', '-w', '-F', '--untracked', '-e', name],
      { maxBuffer: 32 * 1024 * 1024 }
    )
    return rankDefinitions(parseDefinitions(stdout, name), fromPath).slice(0, MAX_DEFINITIONS)
  } catch {
    // Exit 1 is "no match"; anything else (not a repo, output too large) has no
    // better answer than none.
    return []
  }
}
