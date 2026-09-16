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
//   ~/.config/floe/builtin-skills/<name>.md      built-in — shipped with Floe
//   ~/.config/floe/skills/<name>.md              global — every project
//   <repo>/.floe/skills/<name>.md                this project only, committed
//
// A skill may also be a DIRECTORY holding `SKILL.md`, which is how you ship one
// with reference files beside it. The narrower scope wins a name clash: a
// project skill beats a global one, and either beats a built-in — which is how
// you customize a built-in, since its own file is rewritten on every launch
// (builtinSkills.ts). `importSkills` copies a project's harness skills into its
// `.floe/skills`.

import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { configDir } from '../dataDir'
import { BUILTIN_SKILLS } from './builtinSkills'
import { repoFloeDir } from './repoConfig'

/** Where a skill came from, narrowest last — the order they override in. */
export type SkillScope = 'builtin' | 'global' | 'project'

/** The scopes a user can write to. Built-ins are Floe's, and are read-only. */
export type WritableScope = Exclude<SkillScope, 'builtin'>

export interface Skill {
  /** The token you type after `/`. */
  name: string
  description?: string
  scope: SkillScope
  /** Absolute path of the markdown file, for opening it in the reader. */
  file: string
  /** The directory the file sits in — a bundled skill's reference files live here. */
  dir: string
}

export const globalSkillsDir = (): string => join(configDir(), 'skills')

/** Floe's own skills, rewritten from BUILTIN_SKILLS on every boot. */
export const builtinSkillsDir = (): string => join(configDir(), 'builtin-skills')

/** The project's skills, committed in the repository itself. */
export const projectSkillsDir = (projectPath: string): string => join(repoFloeDir(projectPath), 'skills')

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
 * Every skill available to a project: Floe's own, then the global ones, then
 * the project's.
 *
 * Collected widest first so each scope overwrites the one before it — the
 * narrower one is the one you meant.
 */
export function listSkills(projectPath?: string): Skill[] {
  const found = new Map<string, Skill>()
  collect(builtinSkillsDir(), 'builtin', found)
  collect(globalSkillsDir(), 'global', found)
  if (projectPath) collect(projectSkillsDir(projectPath), 'project', found)
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

/**
 * Write Floe's own skills, every boot.
 *
 * Managed the way the hook scripts are: this directory belongs to Floe, and an
 * edit made here is gone on the next launch. Customizing a built-in means
 * writing a global or project skill of the SAME NAME — which wins the lookup
 * anyway, and survives every update.
 */
export function ensureBuiltinSkills(): void {
  const dir = builtinSkillsDir()
  mkdirSync(dir, { recursive: true })
  for (const skill of BUILTIN_SKILLS) {
    const file = join(dir, `${skill.name}.md`)
    let current = ''
    try {
      current = readFileSync(file, 'utf8')
    } catch {
      // Not there yet — the write below is the whole point.
    }
    // Only when it differs: the config watcher repaints the app on every write
    // under this directory, and boot is not a reason to repaint.
    if (current !== skill.text) writeFileSync(file, skill.text)
  }
  // A skill Floe stopped shipping, or renamed, would otherwise stay forever —
  // nobody deletes a file they did not know they had.
  const ours = new Set(BUILTIN_SKILLS.map((skill) => `${skill.name}.md`))
  for (const entry of readdirSync(dir)) {
    if (entry.endsWith('.md') && !ours.has(entry)) rmSync(join(dir, entry), { force: true })
  }
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
- \`<repo>/.floe/skills/<name>.md\` — that project only, committed with it.

A project skill wins over a global one with the same name.

## Bundling files with a skill

A skill can be a directory instead of a file:

    skills/deploy/SKILL.md
    skills/deploy/checklist.md

The directory name is the skill name unless the frontmatter says otherwise, and
anything beside \`SKILL.md\` is yours to reference from the text.
`

/* --- editing ------------------------------------------------------------- */
//
// The panel writes through these rather than through the file tree: a skill is
// addressed by NAME (which is what the composer types and what the list shows),
// and the name is not always the filename — frontmatter can override it, and a
// bundled skill is a directory. Resolving through `listSkills` means the panel
// acts on exactly the row it is showing, including the project-wins rule, and
// no path from the renderer is ever written to.

/** The token rule, matching what `expandSkills` will actually recognise. */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9:_-]*$/

function checkName(name: string): string {
  const clean = name.trim()
  if (!NAME_RE.test(clean)) {
    throw new Error(`"${name}" is not a skill name — letters, digits, - _ : only`)
  }
  return clean
}

/** Where a new skill of this scope goes, created if it isn't there yet. */
function dirFor(scope: WritableScope, projectPath?: string): string {
  if (scope === 'global') return globalSkillsDir()
  if (!projectPath) throw new Error('no project here to keep a project skill in')
  return projectSkillsDir(projectPath)
}

/** Refuse a write to Floe's own copy — the next boot would undo it anyway. */
function writable(skill: Skill): Skill {
  if (skill.scope !== 'builtin') return skill
  throw new Error(
    `"${skill.name}" is a built-in skill — create a global skill with the same name to change it`
  )
}

function find(name: string, projectPath?: string): Skill {
  const skill = listSkills(projectPath).find((s) => s.name === name)
  if (!skill) throw new Error(`no skill called "${name}"`)
  return skill
}

// A bundled skill is a directory holding SKILL.md, so its `dir` is its own and
// renaming or deleting it means moving the whole directory. A plain file skill's
// `dir` is the skills root it sits in, which must never be touched.
const isBundle = (skill: Skill): boolean => basename(skill.file) === 'SKILL.md'

export function createSkill(name: string, scope: WritableScope, projectPath?: string): Skill {
  const clean = checkName(name)
  if (listSkills(projectPath).some((s) => s.name === clean && s.scope === scope)) {
    throw new Error(`"${clean}" already exists`)
  }
  const dir = dirFor(scope, projectPath)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${clean}.md`)
  if (existsSync(file)) throw new Error(`${file} is already there`)
  writeFileSync(file, template(clean))
  return { name: clean, scope, file, dir }
}

/**
 * Rename a skill — both halves of it.
 *
 * The file (or directory) moves AND the frontmatter `name:` follows, because
 * that field is what the composer matches: renaming only the file would leave
 * `/old-name` still working and the list still showing the old word.
 */
export function renameSkill(name: string, to: string, projectPath?: string): Skill {
  const clean = checkName(to)
  const skill = writable(find(name, projectPath))
  if (clean === skill.name) return skill
  if (listSkills(projectPath).some((s) => s.name === clean)) throw new Error(`"${clean}" already exists`)

  const bundle = isBundle(skill)
  const root = bundle ? dirname(skill.dir) : skill.dir
  const target = join(root, bundle ? clean : `${clean}.md`)
  if (existsSync(target)) throw new Error(`${target} is already there`)
  renameSync(bundle ? skill.dir : skill.file, target)

  const file = bundle ? join(target, 'SKILL.md') : target
  try {
    const raw = readFileSync(file, 'utf8')
    const named = withName(raw, clean)
    if (named !== raw) writeFileSync(file, named)
  } catch {
    // The rename already happened; a frontmatter we could not rewrite is a
    // skill that still lists under its old name, not a failed operation.
  }
  return { ...skill, name: clean, file, dir: bundle ? target : skill.dir }
}

/** Delete a skill: the file, or the whole directory a bundled one owns. */
export function deleteSkill(name: string, projectPath?: string): void {
  const skill = writable(find(name, projectPath))
  rmSync(isBundle(skill) ? skill.dir : skill.file, { recursive: true, force: true })
}

/**
 * One skill with its raw markdown (frontmatter included) — the editing view,
 * as opposed to `readSkill`, which strips to the body a harness receives.
 * Throws when there is no such skill.
 */
export function readSkillFile(name: string, projectPath?: string): { skill: Skill; raw: string } {
  const skill = find(name, projectPath)
  return { skill, raw: readFileSync(skill.file, 'utf8') }
}

/**
 * Replace a skill's markdown wholesale (frontmatter included). The file is
 * resolved by NAME through the same project-wins lookup every other edit uses,
 * so the caller can never write outside a skills directory. A frontmatter
 * `name:` that disagrees with the filename re-labels the skill — same rule as
 * hand-editing the file.
 */
export function updateSkill(name: string, content: string, projectPath?: string): Skill {
  const skill = writable(find(name, projectPath))
  writeFileSync(skill.file, content)
  return skill
}

/** Rewrite the frontmatter's `name:`, when it has one. */
function withName(raw: string, name: string): string {
  if (!raw.startsWith('---')) return raw
  const end = raw.indexOf('\n---', 3)
  if (end < 0) return raw
  const head = raw.slice(0, end)
  if (!/^name:/m.test(head)) return raw
  return head.replace(/^name:.*$/m, `name: ${name}`) + raw.slice(end)
}

/**
 * What a brand-new skill starts as.
 *
 * Not empty: the frontmatter is the part you cannot guess, so the file that
 * opens in the editor already has it, with the two fields filled in the way
 * they will be read.
 */
function template(name: string): string {
  return `---
name: ${name}
description: What this skill is for — shown beside it in the list.
---

# ${name}

Everything below the frontmatter is the skill. Typing \`/${name}\` in the composer
sends this whole text to whichever harness answers the turn.
`
}

/* --- importing from a harness --------------------------------------------- */
//
// A project set up for Claude or Codex already has skills, in that harness's
// own directory. Importing copies them into `<repo>/.floe/skills`, so every
// harness gets them through Floe. Floe wins a clash: a name Floe already has is
// skipped, never overwritten, and the first harness to offer a name keeps it.

/** Each harness's project-level skills directory, relative to the repo root. */
export const HARNESS_SKILL_DIRS = [
  '.claude/skills',
  '.codex/skills',
  '.agents/skills',
  '.opencode/skills',
  '.opencode/skill',
  '.gemini/skills'
]

export interface SkillImport {
  imported: Array<{ name: string; from: string; file: string }>
  skipped: Array<{ name: string; from: string; reason: string }>
}

export function importSkills(projectPath: string): SkillImport {
  const result: SkillImport = { imported: [], skipped: [] }
  const taken = new Set(listSkills(projectPath).map((s) => s.name))
  const target = projectSkillsDir(projectPath)
  for (const rel of HARNESS_SKILL_DIRS) {
    const found = new Map<string, Skill>()
    collect(join(projectPath, rel), 'project', found)
    for (const skill of found.values()) {
      const reason = taken.has(skill.name) ? 'Floe already has a skill with this name' : copySkill(skill, target)
      if (reason) {
        result.skipped.push({ name: skill.name, from: skill.file, reason })
        continue
      }
      taken.add(skill.name)
      result.imported.push({ name: skill.name, from: skill.file, file: join(target, relative(skill)) })
    }
  }
  return result
}

/** Where a skill sits under its skills root: `name.md`, or `name/SKILL.md`. */
const relative = (skill: Skill): string =>
  isBundle(skill) ? join(basename(skill.dir), 'SKILL.md') : basename(skill.file)

/** Copy one skill into `target`. Returns why it was not copied, or null. */
function copySkill(skill: Skill, target: string): string | null {
  const bundle = isBundle(skill)
  const dest = join(target, bundle ? basename(skill.dir) : basename(skill.file))
  if (existsSync(dest)) return `${dest} is already there`
  mkdirSync(target, { recursive: true })
  // Dereference: a harness skill is often a symlink, and the copy must stand alone.
  if (bundle) cpSync(skill.dir, dest, { recursive: true, dereference: true })
  else copyFileSync(skill.file, dest)
  return null
}
