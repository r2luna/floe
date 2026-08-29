// `~/.config/floe/projects/<dir>/` — one directory per project.
//
// A single file listing every project is the thing that breaks: two writes race,
// one bad edit takes out the whole sidebar, and an agent asked to change one
// project has to rewrite a document describing forty. A directory each means a
// write touches exactly the project it is about, and deleting a project is
// deleting a directory.
//
// The directory NAME is a label, not an identity. `path` inside `config.toml` is
// what identifies a project, so the user can rename directories freely. That
// means we can't look a project up by name — the whole set is scanned at boot
// into a `path → directory` map, which is also where the three ways this can go
// wrong get reported: a duplicate path, a missing path, a path that isn't a repo.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { configDir } from '../dataDir'
import { ErrorSink, type ConfigError } from './errors'
import { TableReader, subTable } from './read'
import { editToml, parseToml, type TomlEdit, type TomlValue } from './toml'
import { writeTomlFile } from './io'
import { PROJECT_TOML } from './template'

export const PHP_VERSIONS = ['8.2', '8.3', '8.4', '8.5'] as const
export const PACKAGE_MANAGERS = ['bun', 'pnpm', 'yarn', 'npm'] as const
export const DATABASES = ['mysql', 'postgres'] as const

export interface ProjectEnv {
  mode: 'container'
  runtime: 'laravel'
  php: (typeof PHP_VERSIONS)[number]
  packageManager: (typeof PACKAGE_MANAGERS)[number]
  db: (typeof DATABASES)[number]
  dbAdmin: boolean
}

export interface ProjectConfig {
  /** Absolute path to the repository. The project's identity. */
  path: string
  group: string
  name?: string
  readOnly: boolean
  pinned: boolean
  env?: ProjectEnv
  jiraProject?: string
  /**
   * Whether this project's stack defaults were already seeded. It marks work
   * that was done TO the config (commands were written), so it belongs with the
   * config — not in the state dir, where it would drift out of a backup.
   */
  seeded: boolean
  /** Absolute path of the project's config directory. Not user-editable. */
  dir: string
}

export const projectsDir = (): string => join(configDir(), 'projects')

export const projectConfigPath = (dir: string): string => join(dir, 'config.toml')

// ---------------------------------------------------------------------------
// Naming a new directory
// ---------------------------------------------------------------------------

function slug(text: string): string {
  return (
    text
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '') || 'project'
  )
}

/**
 * A free directory name for a project at `path`.
 *
 * The basename alone, until two projects share one — then the parent segment is
 * prefixed, which is exactly how a human tells `00.projects/os` from
 * `03.clients/os`. Only ever used at creation time; nothing reads it afterwards.
 */
export function directoryNameFor(path: string, taken: Set<string>): string {
  const segments = path.split('/').filter(Boolean)
  const base = slug(segments[segments.length - 1] ?? 'project')
  if (!taken.has(base)) return base
  const parent = slug(segments[segments.length - 2] ?? '')
  const withParent = parent ? `${parent}-${base}` : base
  if (!taken.has(withParent)) return withParent
  for (let n = 2; ; n++) {
    const candidate = `${withParent}-${n}`
    if (!taken.has(candidate)) return candidate
  }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Expand a leading `~` so the file can stay portable across machines. */
function expandHome(path: string): string {
  if (path === '~') return process.env.HOME ?? path
  if (path.startsWith('~/')) return join(process.env.HOME ?? '~', path.slice(2))
  return path
}

export function parseProjectConfig(
  raw: string,
  file: string,
  dir: string
): { project: ProjectConfig | null; errors: ConfigError[] } {
  const sink = new ErrorSink(file, raw)
  const parsed = parseToml(raw)
  if (!parsed.ok) {
    sink.add(parsed.error.line, parsed.error.message)
    return { project: null, errors: sink.errors }
  }
  const root = parsed.value as Record<string, unknown>
  const t = new TableReader(sink, raw, root)

  const rawPath = t.optStr('path')
  if (!rawPath) {
    // Deliberately NOT inferred from the directory name. The name is a label the
    // user may have typed; guessing here would invent a project pointing at the
    // wrong place, which is worse than not loading it.
    t.reject('path', 'path is required — it is what identifies the project')
    return { project: null, errors: sink.errors }
  }
  const path = expandHome(rawPath)

  const envTable = subTable(sink, raw, root, 'env')
  const env = envTable ? readEnv(envTable) : undefined
  const integrations = subTable(sink, raw, root, 'integrations')

  return {
    project: {
      path,
      group: t.str('group', 'Projects'),
      name: t.optStr('name'),
      readOnly: t.bool('read-only', false),
      pinned: t.bool('pinned', false),
      env,
      jiraProject: integrations?.optStr('jira-project'),
      seeded: t.bool('seeded', false),
      dir
    },
    errors: sink.errors
  }
}

function readEnv(t: TableReader): ProjectEnv {
  return {
    mode: t.oneOf('mode', ['container'] as const, 'container'),
    runtime: t.oneOf('runtime', ['laravel'] as const, 'laravel'),
    php: t.oneOf('php', PHP_VERSIONS, '8.4'),
    packageManager: t.oneOf('package-manager', PACKAGE_MANAGERS, 'npm'),
    db: t.oneOf('db', DATABASES, 'mysql'),
    dbAdmin: t.bool('db-admin', true)
  }
}

export interface ProjectScan {
  projects: ProjectConfig[]
  /** Repository path → its config directory. The only way to locate a project's files. */
  byPath: Map<string, string>
  errors: ConfigError[]
}

/**
 * Read every project directory.
 *
 * Ordering is alphabetical by display name with pinned projects first, because a
 * directory has no order of its own and inventing an `order` key would be one
 * more thing to keep correct on every add and remove.
 */
export function scanProjects(): ProjectScan {
  const root = projectsDir()
  const projects: ProjectConfig[] = []
  const byPath = new Map<string, string>()
  const errors: ConfigError[] = []
  if (!existsSync(root)) return { projects, byPath, errors }

  for (const entry of readdirSync(root).sort()) {
    const dir = join(root, entry)
    if (!statSync(dir).isDirectory()) continue
    const file = projectConfigPath(dir)
    if (!existsSync(file)) continue
    const { project, errors: errs } = parseProjectConfig(readFileSync(file, 'utf8'), file, dir)
    errors.push(...errs)
    if (!project) continue
    const existing = byPath.get(project.path)
    if (existing) {
      // The realistic cause is copying a project directory to "duplicate" a
      // setup. Merging two descriptions of one project would be a guess, so the
      // first (alphabetically) wins and the other is named rather than dropped
      // in silence.
      errors.push({
        file,
        line: 1,
        text: project.path,
        reason: `duplicate project path — already configured by ${existing}, this directory is ignored`
      })
      continue
    }
    byPath.set(project.path, dir)
    projects.push(project)
  }

  projects.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    return displayName(a).localeCompare(displayName(b))
  })
  return { projects, byPath, errors }
}

export function displayName(project: ProjectConfig): string {
  return project.name ?? project.path.split('/').filter(Boolean).pop() ?? project.path
}

// The scan is held between reads and dropped by the watcher, so an agent that
// writes a new project directory shows up without a restart.
let cached: ProjectScan | null = null

export function projectScan(): ProjectScan {
  if (!cached) cached = scanProjects()
  return cached
}

export function invalidateProjects(): void {
  cached = null
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** Create the directory and config for a project that isn't tracked yet. */
export function createProject(
  path: string,
  fields: { group?: string; name?: string; pinned?: boolean } = {}
): ProjectConfig {
  const existingDir = projectScan().byPath.get(path)
  if (existingDir) {
    const found = projectScan().projects.find((p) => p.path === path)
    if (found) return found
  }
  const root = projectsDir()
  mkdirSync(root, { recursive: true })
  const taken = new Set(readdirSync(root))
  const dir = join(root, directoryNameFor(path, taken))
  mkdirSync(dir, { recursive: true })

  const edits: TomlEdit[] = [{ op: 'set', key: 'path', value: path }]
  if (fields.group) edits.push({ op: 'set', key: 'group', value: fields.group })
  if (fields.name) edits.push({ op: 'set', key: 'name', value: fields.name })
  if (fields.pinned) edits.push({ op: 'set', key: 'pinned', value: true })
  writeTomlFile(projectConfigPath(dir), editToml(PROJECT_TOML, edits))
  invalidateProjects()

  const created = projectScan().projects.find((p) => p.path === path)
  if (!created) throw new Error(`wrote ${dir} but it did not read back as a project`)
  return created
}

/** Change keys in a project's `config.toml`, comments and all. */
export function updateProject(path: string, edits: TomlEdit[]): void {
  const dir = projectScan().byPath.get(path)
  if (!dir) throw new Error(`no project configured for ${path}`)
  const file = projectConfigPath(dir)
  writeTomlFile(file, editToml(readFileSync(file, 'utf8'), edits))
  invalidateProjects()
}

export function setProjectValue(path: string, key: string, value: TomlValue): void {
  updateProject(path, [{ op: 'set', key, value }])
}

export function setProjectEnvValue(path: string, key: string, value: TomlValue): void {
  updateProject(path, [{ op: 'set', table: 'env', key, value }])
}

/** Remove a project: its directory and everything Floe put in it. */
export function removeProject(path: string): void {
  const dir = projectScan().byPath.get(path)
  if (!dir) return
  rmSync(dir, { recursive: true, force: true })
  invalidateProjects()
}
