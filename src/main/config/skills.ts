// Skills, stored in Floe's config rather than in any harness's directory.
//
// The point of keeping them here: the same skill has to work whichever CLI
// answers the turn. Claude reads `~/.claude/skills`, Codex reads its own place,
// and the next one will read a third — copying the same instructions into each
// is how they drift. So Floe owns them once and hands the text to whoever is
// answering (see shared/skills.ts for the expansion).
//
// Two scopes, the same shape:
//
//   ~/.config/floe/skills/<name>.md              global — every project
//   ~/.config/floe/projects/<dir>/skills/<name>.md   this project only
//
// A skill may also be a DIRECTORY holding `SKILL.md`, which is how you ship one
// with reference files beside it. A project skill wins over a global one of the
// same name: the narrower answer is the one you meant.

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { configDir } from '../dataDir'
import { projectScan } from './projectStore'

export interface Skill {
  /** The token you type after `/`. */
  name: string
  description?: string
  scope: 'global' | 'project'
  /** Absolute path of the markdown file, for opening it in the reader. */
  file: string
  /** The directory the file sits in — a bundled skill's reference files live here. */
  dir: string
}

export const globalSkillsDir = (): string => join(configDir(), 'skills')

export function projectSkillsDir(projectPath: string): string | null {
  const dir = projectScan().byPath.get(projectPath)
  return dir ? join(dir, 'skills') : null
}

// Minimal frontmatter: the `key: value` pairs a skill actually uses. A full
// YAML parser would be a dependency for two fields.
function frontmatter(raw: string): Record<string, string> {
  if (!raw.startsWith('---')) return {}
  const end = raw.indexOf('\n---', 3)
  if (end < 0) return {}
  const out: Record<string, string> = {}
  for (const line of raw.slice(raw.indexOf('\n') + 1, end).split('\n')) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (!m) continue
    let v = m[2].trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1)
    }
    out[m[1].toLowerCase()] = v
  }
  return out
}

/** The skill's text, with the frontmatter removed — what the harness receives. */
export function skillBody(raw: string): string {
  if (!raw.startsWith('---')) return raw.trim()
  const end = raw.indexOf('\n---', 3)
  if (end < 0) return raw.trim()
  return raw.slice(end + '\n---'.length).replace(/^[^\n]*\n?/, '').trim()
}

function collect(root: string, scope: Skill['scope'], into: Map<string, Skill>): void {
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return // no skills at this scope, which is the common case
  }
  for (const entry of entries) {
    // A symlinked skill directory reports isDirectory() === false, and linking a
    // skill in from somewhere else is a normal thing to do.
    const full = join(root, entry.name)
    const isDir = entry.isDirectory() || (entry.isSymbolicLink() && safeIsDir(full))
    const file = isDir ? join(full, 'SKILL.md') : full
    if (isDir ? !existsSync(file) : !entry.name.endsWith('.md')) continue
    const name = isDir ? entry.name : entry.name.slice(0, -'.md'.length)
    let raw = ''
    try {
      raw = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const fm = frontmatter(raw)
    into.set(fm.name || name, {
      name: fm.name || name,
      description: fm.description,
      scope,
      file,
      dir: isDir ? full : root
    })
  }
}

function safeIsDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * Every skill available to a project: the global ones, then its own.
 *
 * Project skills are collected second so they overwrite a global of the same
 * name — the narrower one is the one you meant.
 */
export function listSkills(projectPath?: string): Skill[] {
  const found = new Map<string, Skill>()
  collect(globalSkillsDir(), 'global', found)
  const own = projectPath ? projectSkillsDir(projectPath) : null
  if (own) collect(own, 'project', found)
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** One skill's text, ready to hand to a harness. Null when there is no such skill. */
export function readSkill(name: string, projectPath?: string): string | null {
  const skill = listSkills(projectPath).find((s) => s.name === name)
  if (!skill) return null
  try {
    return skillBody(readFileSync(skill.file, 'utf8'))
  } catch {
    return null
  }
}

/**
 * Create `skills/` with one worked example the first time.
 *
 * The same reason every other config file is generated rather than documented
 * elsewhere: a directory you cannot see is a feature you do not know you have.
 * The example is deliberately real — it explains the format BY being in it.
 */
export function ensureSkills(): void {
  const dir = globalSkillsDir()
  if (existsSync(dir)) return
  mkdirSync(dir, { recursive: true })
  const example = join(dir, 'example.md')
  if (!existsSync(example)) writeFileSync(example, EXAMPLE)
}

const EXAMPLE = `---
name: example
description: What this skill is for — shown beside it in the palette.
---

# Example skill

Everything below the frontmatter is the skill. Typing \`/example\` in the
composer sends this whole text to whichever harness answers the turn, and the
chat still shows just \`/example\`.

That is the point of keeping skills here instead of in \`~/.claude/skills\` or
any other CLI's directory: one copy, every harness.

## Where skills live

- \`~/.config/floe/skills/<name>.md\` — global, offered in every project.
- \`~/.config/floe/projects/<project>/skills/<name>.md\` — that project only.

A project skill wins over a global one with the same name.

## Bundling files with a skill

A skill can be a directory instead of a file:

    skills/deploy/SKILL.md
    skills/deploy/checklist.md

The directory name is the skill name unless the frontmatter says otherwise, and
anything beside \`SKILL.md\` is yours to reference from the text.
`
