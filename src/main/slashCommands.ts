import { homedir } from 'node:os'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SlashCommand } from '../shared/types'

// Discover the Claude Code slash commands and skills available in a given
// worktree, mirroring how the CLI resolves them: personal entries under
// ~/.claude, plus project-local entries under <worktree>/.claude (which win on
// a name clash). Custom commands are markdown files under commands/ (nested
// folders namespace with ":"); skills are folders holding a SKILL.md.

type Add = (cmd: SlashCommand) => void

// Minimal YAML frontmatter reader — enough for the `key: value` pairs Claude
// Code uses (name, description, argument-hint). Ignores nested/list values.
function readFrontmatter(file: string): Record<string, string> {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return {}
  }
  if (!raw.startsWith('---')) return {}
  const end = raw.indexOf('\n---', 3)
  if (end < 0) return {}
  const block = raw.slice(raw.indexOf('\n') + 1, end)
  const out: Record<string, string> = {}
  for (const line of block.split('\n')) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
    if (!m) continue
    let v = m[2].trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    out[m[1].toLowerCase()] = v
  }
  return out
}

function collectCommands(root: string, scope: 'user' | 'project', add: Add, prefix = ''): void {
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return // dir missing or unreadable
  }
  for (const e of entries) {
    const full = join(root, e.name)
    if (e.isDirectory()) {
      collectCommands(full, scope, add, prefix + e.name + ':')
    } else if (e.name.endsWith('.md')) {
      const name = prefix + e.name.slice(0, -'.md'.length)
      const fm = readFrontmatter(full)
      add({ name, description: fm.description, source: 'command', scope, argumentHint: fm['argument-hint'] })
    }
  }
}

function collectSkills(root: string, scope: 'user' | 'project', add: Add): void {
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    // Skills are often symlinked (e.g. -> ../../.ai/skills/<name>), and a
    // symlink reports isDirectory() === false. Accept symlinks too and let
    // existsSync (which follows links) confirm the SKILL.md.
    if (!e.isDirectory() && !e.isSymbolicLink()) continue
    const file = join(root, e.name, 'SKILL.md')
    if (!existsSync(file)) continue
    const fm = readFrontmatter(file)
    add({ name: fm.name || e.name, description: fm.description, source: 'skill', scope })
  }
}

export function discoverSlashCommands(worktreePath: string): SlashCommand[] {
  // Keyed by source+name so a command and a skill may share a name, while a
  // project entry overrides the personal one (added later → overwrites).
  const map = new Map<string, SlashCommand>()
  const add: Add = (cmd) => map.set(cmd.source + ':' + cmd.name, cmd)

  const home = join(homedir(), '.claude')
  collectCommands(join(home, 'commands'), 'user', add)
  collectSkills(join(home, 'skills'), 'user', add)
  if (worktreePath) {
    // Project entries live in the repo's .claude. A gw worktree
    // (<repo>/.worktrees/<branch>) usually doesn't carry .claude, so also scan
    // the main repo root derived from the path.
    const roots = new Set<string>([worktreePath])
    const marker = worktreePath.indexOf('/.worktrees/')
    if (marker >= 0) roots.add(worktreePath.slice(0, marker))
    for (const root of roots) {
      collectCommands(join(root, '.claude', 'commands'), 'project', add)
      collectSkills(join(root, '.claude', 'skills'), 'project', add)
    }
  }

  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name))
}
