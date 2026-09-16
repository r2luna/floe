// Moving a project's config out of `~/.config/floe/projects/<dir>/` and into
// `<repo>/.floe/`, once, on boot.
//
// Each piece moves only when the repo has no file of its own for it yet, so a
// repo that already carries `.floe/commands.toml` from another machine is never
// overwritten by this machine's copy. What moved is renamed to `*.migrated`
// rather than deleted: a bad migration is a rename away from undone.

import { cpSync, existsSync, readFileSync, readdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { addCommand, commandsPath, parseCommands } from './commandStore'
import { addMcpServer, listMcpServers, localMcpPath, parseServers, projectMcpPath } from './mcpServers'
import { invalidateProjects, projectConfigPath, projectScan } from './projectStore'
import { ensureRepoDir, repoConfigPath, repoFloeDir, repoLocalDir } from './repoConfig'
import { projectSkillsDir } from './skills'
import { REPO_PROJECT_TOML } from './template'
import { editToml, parseToml, type TomlEdit, type TomlValue } from './toml'
import { writeTomlFile } from './io'

/** Migrate every project whose repository is on this machine. Never throws. */
export function migrateProjectsToRepo(): void {
  for (const project of projectScan().projects) {
    if (!existsSync(project.path)) continue
    for (const step of [migrateSettings, migrateCommands, migrateMcp, migrateSkills]) {
      try {
        step(project.path, project.dir)
      } catch (err) {
        console.error(`[config] could not move ${step.name} for ${project.path}:`, (err as Error).message)
      }
      invalidateProjects()
    }
  }
}

const backup = (file: string): void => renameSync(file, `${file}.migrated`)

/** The tables and root key that used to sit in the global config.toml. */
const REPO_TABLES = ['env', 'integrations'] as const

export function migrateSettings(path: string, dir: string): void {
  const file = projectConfigPath(dir)
  if (!existsSync(file) || existsSync(repoConfigPath(path))) return
  const raw = readFileSync(file, 'utf8')
  const parsed = parseToml(raw)
  if (!parsed.ok) return
  const root = parsed.value as Record<string, unknown>
  const moving: TomlEdit[] = []
  const clearing: TomlEdit[] = []
  for (const table of REPO_TABLES) {
    const values = root[table]
    if (typeof values !== 'object' || values === null || Array.isArray(values)) continue
    for (const [key, value] of Object.entries(values)) {
      moving.push({ op: 'set', table, key, value: value as TomlValue })
      clearing.push({ op: 'unset', table, key })
    }
  }
  if (root.seeded !== undefined) {
    moving.push({ op: 'set', key: 'seeded', value: root.seeded as TomlValue })
    clearing.push({ op: 'unset', key: 'seeded' })
  }
  if (!moving.length) return
  ensureRepoDir(path)
  writeTomlFile(repoConfigPath(path), editToml(REPO_PROJECT_TOML, moving))
  // Unsetting leaves the `[env]` header behind with nothing under it.
  const header = new RegExp(`^\\[(${REPO_TABLES.join('|')})\\]\\s*$\\n?`, 'gm')
  writeTomlFile(file, editToml(raw, clearing).replace(header, ''))
}

export function migrateCommands(path: string, dir: string): void {
  const legacy = commandsPath(dir)
  if (!existsSync(legacy)) return
  if (existsSync(commandsPath(repoFloeDir(path))) || existsSync(commandsPath(repoLocalDir(path)))) return
  for (const { id: _id, index: _index, ...cmd } of parseCommands(readFileSync(legacy, 'utf8'), legacy).commands) {
    addCommand(path, cmd)
  }
  backup(legacy)
}

export function migrateMcp(path: string, dir: string): void {
  const legacy = join(dir, 'mcp.toml')
  if (!existsSync(legacy)) return
  const shared = projectMcpPath(path)
  const local = localMcpPath(path)
  if ((shared && existsSync(shared)) || (local && existsSync(local))) return
  const known = new Set(listMcpServers(path).filter((s) => s.scope === 'project').map((s) => s.name))
  for (const server of parseServers(readFileSync(legacy, 'utf8'), legacy, 'project').servers) {
    if (!known.has(server.name)) addMcpServer('project', server, path)
  }
  backup(legacy)
}

export function migrateSkills(path: string, dir: string): void {
  const legacy = join(dir, 'skills')
  if (!existsSync(legacy)) return
  const target = projectSkillsDir(path)
  for (const entry of readdirSync(legacy)) {
    const dest = join(target, entry)
    // The repo's own copy wins; the legacy one survives in the backup.
    if (!existsSync(dest)) cpSync(join(legacy, entry), dest, { recursive: true, verbatimSymlinks: true })
  }
  backup(legacy)
}
