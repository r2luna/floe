// `<repo>/.floe/commands.toml` — a project's named processes, committed with it.
// `<repo>/.floe/local/commands.toml` holds the ones scoped to a single worktree:
// they name an absolute path, so they stay on this machine (gitignored).
//
// Two shape decisions worth knowing before reading:
//
// SCOPE IS A FIELD, NOT A NESTING. A command belongs to the whole project unless
// it names a `worktree`. The alternative — `[[worktree]]` tables each holding
// their own `[[worktree.command]]` — reads fine but makes every write target "the
// third command of the second worktree", and moving a command between scopes
// becomes a cut-and-paste across tables instead of setting one key.
//
// IDS ARE DERIVED, NOT STORED. The runtime keys a running process as
// `<worktreePath>#<id>`, so ids have to exist — but writing `id = "cmd_lx8f2_3"`
// into a file meant to be edited by hand is exactly the machine noise we moved to
// TOML to get away from. So the id is the slugified name, numbered on collision.
// The cost is real and bounded: renaming a command while it runs detaches its
// output pane, because the rename gives it a new id. The process itself keeps
// running and is still reaped by pid.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ErrorSink, type ConfigError } from './errors'
import { TableReader } from './read'
import { editToml, parseToml, type TomlEdit, type TomlValue } from './toml'
import { writeTomlFile } from './io'
import { COMMANDS_TOML, LOCAL_COMMANDS_TOML } from './template'
import { createProject, invalidateProjects, projectScan } from './projectStore'
import { ensureRepoDir, repoFloeDir, repoLocalDir } from './repoConfig'

export type NotifyLevel = 'all' | 'important' | 'none'
export const NOTIFY_LEVELS = ['all', 'important', 'none'] as const

export interface StoredCommand {
  id: string
  name: string
  command: string
  cwd?: string
  autoStart?: boolean
  autoRestart?: boolean
  notify?: NotifyLevel
  watch?: string[]
  /** Absolute worktree path when the command is scoped to one; absent means project-wide. */
  worktree?: string
  /** Position in the file's `[[command]]` array — what writes address. */
  index: number
  /** True when the entry lives in `.floe/local/commands.toml`. */
  local?: boolean
}

export const commandsPath = (dir: string): string => join(dir, 'commands.toml')

function slugId(name: string): string {
  return (
    name
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'command'
  )
}

export function parseCommands(raw: string, file: string): { commands: StoredCommand[]; errors: ConfigError[] } {
  const sink = new ErrorSink(file, raw)
  const parsed = parseToml(raw)
  if (!parsed.ok) {
    sink.add(parsed.error.line, parsed.error.message)
    return { commands: [], errors: sink.errors }
  }
  const entries = (parsed.value as { command?: unknown }).command
  if (entries === undefined) return { commands: [], errors: sink.errors }
  if (!Array.isArray(entries)) {
    sink.add(1, 'command must be a list of [[command]] entries')
    return { commands: [], errors: sink.errors }
  }

  const used = new Map<string, number>()
  const commands: StoredCommand[] = []
  entries.forEach((entry, index) => {
    if (typeof entry !== 'object' || entry === null) return
    const t = new TableReader(sink, raw, entry as Record<string, unknown>, 'command', index)
    const name = t.optStr('name')
    const command = t.optStr('command')
    if (!name || !command) {
      t.reject(name ? 'command' : 'name', 'a command needs both a name and a command to run')
      return
    }
    const base = slugId(name)
    const seen = used.get(base) ?? 0
    used.set(base, seen + 1)
    commands.push({
      id: seen === 0 ? base : `${base}-${seen + 1}`,
      name,
      command,
      cwd: t.optStr('cwd'),
      autoStart: t.has('auto-start') ? t.bool('auto-start', false) : undefined,
      autoRestart: t.has('auto-restart') ? t.bool('auto-restart', false) : undefined,
      notify: t.optOneOf('notify', NOTIFY_LEVELS),
      watch: t.strArray('watch'),
      worktree: t.optStr('worktree'),
      index
    })
  })
  return { commands, errors: sink.errors }
}

export interface CommandsFile {
  /** The shared file, where it is or would be. Null when the project isn't tracked at all. */
  path: string | null
  commands: StoredCommand[]
  errors: ConfigError[]
}

function readFile(path: string, local: boolean): { commands: StoredCommand[]; errors: ConfigError[] } {
  if (!existsSync(path)) return { commands: [], errors: [] }
  const read = parseCommands(readFileSync(path, 'utf8'), path)
  return { commands: read.commands.map((c) => ({ ...c, local })), errors: read.errors }
}

export function readCommands(projectPath: string): CommandsFile {
  if (!projectScan().byPath.has(projectPath)) return { path: null, commands: [], errors: [] }
  const path = commandsPath(repoFloeDir(projectPath))
  const shared = readFile(path, false)
  const local = readFile(commandsPath(repoLocalDir(projectPath)), true)
  // Ids are unique across both files, numbered in reading order: shared first.
  const used = new Map<string, number>()
  const commands = [...shared.commands, ...local.commands].map((c) => {
    const base = slugId(c.name)
    const seen = used.get(base) ?? 0
    used.set(base, seen + 1)
    return { ...c, id: seen === 0 ? base : `${base}-${seen + 1}` }
  })
  return { path, commands, errors: [...shared.errors, ...local.errors] }
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

function edit(projectPath: string, local: boolean, edits: TomlEdit[]): void {
  // Creating the project entry if this is its first command.
  if (!projectScan().byPath.has(projectPath)) createProject(projectPath)
  const path = commandsPath(ensureRepoDir(projectPath, local))
  const raw = existsSync(path) ? readFileSync(path, 'utf8') : local ? LOCAL_COMMANDS_TOML : COMMANDS_TOML
  writeTomlFile(path, editToml(raw, edits))
  invalidateProjects()
}

export interface NewCommand {
  name: string
  command: string
  worktree?: string
  cwd?: string
  autoStart?: boolean
  autoRestart?: boolean
  notify?: NotifyLevel
  watch?: string[]
}

/** The TOML key each field is written under. One place, so reads and writes agree. */
const FIELD_KEYS: Array<[keyof NewCommand, string]> = [
  ['name', 'name'],
  ['command', 'command'],
  ['cwd', 'cwd'],
  ['autoStart', 'auto-start'],
  ['autoRestart', 'auto-restart'],
  ['notify', 'notify'],
  ['watch', 'watch'],
  ['worktree', 'worktree']
]

export function addCommand(projectPath: string, cmd: NewCommand): void {
  const fields: Array<[string, TomlValue]> = []
  for (const [prop, key] of FIELD_KEYS) {
    const value = cmd[prop]
    if (value !== undefined && value !== '') fields.push([key, value as TomlValue])
  }
  edit(projectPath, !!cmd.worktree, [{ op: 'appendEntry', table: 'command', fields }])
}

export type CommandPatch = Partial<NewCommand>

export function updateCommand(projectPath: string, id: string, patch: CommandPatch): void {
  const found = readCommands(projectPath).commands.find((c) => c.id === id)
  if (!found) return
  const edits: TomlEdit[] = []
  for (const [prop, key] of FIELD_KEYS) {
    const value = patch[prop]
    if (value === undefined) continue
    // Clearing a field removes the line rather than writing `cwd = ""` — an empty
    // string would read back as a real (empty) override.
    if (value === '') edits.push({ op: 'unset', table: 'command', key, index: found.index })
    else edits.push({ op: 'setInEntry', table: 'command', index: found.index, key, value: value as TomlValue })
  }
  if (edits.length) edit(projectPath, !!found.local, edits)
}

export function removeCommand(projectPath: string, id: string): void {
  const found = readCommands(projectPath).commands.find((c) => c.id === id)
  if (!found) return
  edit(projectPath, !!found.local, [{ op: 'removeEntry', table: 'command', index: found.index }])
}

/**
 * Move a command between project scope and a single worktree.
 *
 * The scopes are two files, so a move is a remove from one and an append to the
 * other. Within the local file, only the `worktree` key changes.
 */
export function setCommandWorktree(projectPath: string, id: string, worktree: string | null): void {
  const found = readCommands(projectPath).commands.find((c) => c.id === id)
  if (!found) return
  if (worktree !== null && found.local) {
    edit(projectPath, true, [{ op: 'setInEntry', table: 'command', index: found.index, key: 'worktree', value: worktree }])
    return
  }
  if (worktree === null && !found.local) return
  const { id: _id, index: _index, local: _local, ...cmd } = found
  edit(projectPath, !!found.local, [{ op: 'removeEntry', table: 'command', index: found.index }])
  addCommand(projectPath, { ...cmd, worktree: worktree ?? undefined })
}
