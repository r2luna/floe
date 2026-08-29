// `~/.config/floe/projects/<dir>/commands.toml` — a project's named processes.
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
import { COMMANDS_TOML } from './template'
import { createProject, invalidateProjects, projectScan } from './projectStore'

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
  /** Where the file is, or would be. Null when the project isn't tracked at all. */
  path: string | null
  commands: StoredCommand[]
  errors: ConfigError[]
}

export function readCommands(projectPath: string): CommandsFile {
  const dir = projectScan().byPath.get(projectPath)
  if (!dir) return { path: null, commands: [], errors: [] }
  const path = commandsPath(dir)
  if (!existsSync(path)) return { path, commands: [], errors: [] }
  const { commands, errors } = parseCommands(readFileSync(path, 'utf8'), path)
  return { path, commands, errors }
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** The file's directory, creating the project entry if this is the first command. */
function ensureDir(projectPath: string): string {
  const dir = projectScan().byPath.get(projectPath)
  if (dir) return dir
  return createProject(projectPath).dir
}

function edit(projectPath: string, edits: TomlEdit[]): void {
  const dir = ensureDir(projectPath)
  const path = commandsPath(dir)
  const raw = existsSync(path) ? readFileSync(path, 'utf8') : COMMANDS_TOML
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
  edit(projectPath, [{ op: 'appendEntry', table: 'command', fields }])
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
  if (edits.length) edit(projectPath, edits)
}

export function removeCommand(projectPath: string, id: string): void {
  const found = readCommands(projectPath).commands.find((c) => c.id === id)
  if (!found) return
  edit(projectPath, [{ op: 'removeEntry', table: 'command', index: found.index }])
}

/** Move a command between project scope and a single worktree. */
export function setCommandWorktree(projectPath: string, id: string, worktree: string | null): void {
  const found = readCommands(projectPath).commands.find((c) => c.id === id)
  if (!found) return
  edit(projectPath, [
    worktree === null
      ? { op: 'unset', table: 'command', key: 'worktree', index: found.index }
      : { op: 'setInEntry', table: 'command', index: found.index, key: 'worktree', value: worktree }
  ])
}
