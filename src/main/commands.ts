import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { configDir, dataDir } from './dataDir'
import { worktreeComposePath } from './compose'
import { detectPackageManager } from './devServer'

export type CommandScope = 'project' | 'local'
export type NotifyLevel = 'all' | 'important' | 'none'

interface StoredCommand {
  id: string
  name: string
  command: string
  cwd?: string // override the working directory (defaults to the worktree path)
  autoStart?: boolean
  autoRestart?: boolean
  notify?: NotifyLevel
  watch?: string[] // glob patterns that restart the command when they change
}

// A named process the user registers for a worktree. Project-scope commands are
// shared by every worktree of the project; local ones belong to a single
// worktree. (Running/status arrives with the process runner in a later phase.)
export type ProjectCommand = StoredCommand & { scope: CommandScope }

// The fields an edit can touch — every one optional so callers patch just one.
export interface CommandPatch {
  name?: string
  command?: string
  cwd?: string
  autoStart?: boolean
  autoRestart?: boolean
  notify?: NotifyLevel
  watch?: string[]
}

interface StoreShape {
  // project-scope commands, keyed by the project (repo) path
  projects: Record<string, StoredCommand[]>
  // local commands, keyed by the worktree path
  worktrees: Record<string, StoredCommand[]>
  // project paths already seeded with their stack's defaults (so we seed once,
  // and don't re-add commands the user deleted on purpose)
  seeded: string[]
}

// User-authored config, so it lives in `configDir()` (backup-worthy) rather than
// with the app's state. The old `<userData>/commands.json` is read once and
// copied over, so an existing setup lands in the config dir on first launch
// instead of waiting for the next edit.
const storeFile = (): string => join(configDir(), 'commands.json')

function read(): StoreShape {
  const migrated = existsSync(storeFile())
  const file = migrated ? storeFile() : join(dataDir(), 'commands.json')
  if (!existsSync(file)) return { projects: {}, worktrees: {}, seeded: [] }
  try {
    const data = JSON.parse(readFileSync(file, 'utf8')) as Partial<StoreShape>
    const store = {
      projects: data.projects && typeof data.projects === 'object' ? data.projects : {},
      worktrees: data.worktrees && typeof data.worktrees === 'object' ? data.worktrees : {},
      seeded: Array.isArray(data.seeded) ? data.seeded : []
    }
    if (!migrated) write(store)
    return store
  } catch {
    return { projects: {}, worktrees: {}, seeded: [] }
  }
}

// A Laravel project ships with `artisan` + `composer.json`. New Laravel projects
// get a starter command set the first time they're opened.
export function isLaravel(projectPath: string): boolean {
  return existsSync(join(projectPath, 'artisan')) && existsSync(join(projectPath, 'composer.json'))
}

// A Laravel project's starter commands. `Dev` runs the JS bundler's dev server
// via the project's package manager (bun/pnpm/yarn/npm by lockfile) — not
// `composer dev` — so it's computed per project rather than hardcoded.
function laravelDefaults(projectPath: string): Omit<StoredCommand, 'id'>[] {
  const pm = detectPackageManager(projectPath)
  return [
    // The long-running services start automatically so a fresh worktree is ready
    // to work — the provisioner's "Start commands" step picks up autoStart.
    { name: 'Scheduler', command: 'php artisan schedule:work', autoStart: true },
    { name: 'Queue', command: 'php artisan queue:work', autoStart: true },
    { name: 'Dev', command: `${pm} run dev`, autoStart: true },
    // A watcher, not a service: it re-runs a fresh migrate + seed whenever a
    // migration file changes, so it stays off autoStart (it would wipe the DB on
    // every worktree creation).
    { name: 'Migrate on change', command: 'php artisan migrate:fresh --seed', watch: ['database/migrations'] }
  ]
}

// Seed a project's defaults once (project scope). Returns true if it wrote.
function seedDefaults(store: StoreShape, projectPath: string): boolean {
  if (store.seeded.includes(projectPath)) return false
  store.seeded.push(projectPath)
  if ((store.projects[projectPath]?.length ?? 0) > 0) return true // already has commands
  if (!isLaravel(projectPath)) return true
  store.projects[projectPath] = laravelDefaults(projectPath).map((c) => ({ ...c, id: newId() }))
  return true
}

function write(store: StoreShape): void {
  writeFileSync(storeFile(), JSON.stringify(store, null, 2))
}

let seq = 0
function newId(): string {
  seq += 1
  return `cmd_${Date.now().toString(36)}_${seq}`
}

// Commands run on the host, but a containerized worktree has no PHP or JS runtime
// there (the headless server box has neither) — so `php artisan queue:work` and
// `bun run dev` just fail with "not found". The `rookery` CLI router
// (bin/rookery-server.mjs) execs those into the worktree's app container, which is
// why every containerized process command must carry the prefix.
//
// Applied at read time rather than at seed time so projects seeded before this
// (and any command the user typed by hand) heal on the next listing, with no
// migration of commands.json. Gated on the worktree's compose file: exactly when
// the router has a container to route into.
const CONTAINER_CMD = /^(?:artisan|bun|bunx|composer|php|node|npm|npx|pnpm|yarn)\s/
export function containerizeCommand(command: string, worktreePath: string): string {
  if (!CONTAINER_CMD.test(command)) return command
  if (!existsSync(worktreeComposePath(worktreePath))) return command
  return `rookery ${command}`
}

// In a containerized worktree the dev server must bind 0.0.0.0 and advertise the
// Caddy-fronted vite host — settings the project's own vite config can't know, and
// commonly contradicts. Provisioning writes `.rookery/vite.config.mjs` (see
// compose.ts) which wraps the project's config with them; this points the seeded
// `Dev` command at it.
//
// Rewriting here rather than at the call sites means the UI shows and runs the
// same command provisioning autostarts. Deliberately narrow: only the seeded
// `<pm> run dev` shape, and only when the project's `dev` script is plain vite —
// anything else (a `concurrently` fan-out, a custom runner) would not forward the
// extra arguments to vite, so it is left alone.
// ponytail: a `concurrently` dev script stays unwrapped and keeps the old failure;
// widen by parsing the script if a project actually needs it.
export function containerizeViteCommand(command: string, projectPath: string, worktreePath: string): string {
  // Both shapes occur: the bare seeded one, and the `rookery `-prefixed form the
  // container command router (bin/rookery-server.mjs) uses on the server.
  if (!/^(?:rookery\s+)?(?:bun|pnpm|yarn|npm) run dev$/.test(command)) return command
  if (!existsSync(join(worktreePath, '.rookery', 'vite.config.mjs'))) return command
  let dev: unknown
  try {
    dev = JSON.parse(readFileSync(join(projectPath, 'package.json'), 'utf8')).scripts?.dev
  } catch {
    return command // no/unreadable package.json — nothing to wrap
  }
  if (typeof dev !== 'string' || !/^vite(\s|$)/.test(dev.trim())) return command
  return `${command} -- --config .rookery/vite.config.mjs`
}

// The merged command list for a worktree: the project's shared commands first,
// then this worktree's local ones.
export function listCommands(projectPath: string, worktreePath: string): ProjectCommand[] {
  const store = read()
  if (seedDefaults(store, projectPath)) write(store)
  const project = (store.projects[projectPath] ?? []).map((c) => ({ ...c, scope: 'project' as const }))
  const local = (store.worktrees[worktreePath] ?? []).map((c) => ({ ...c, scope: 'local' as const }))
  return [...project, ...local].map((c) => ({
    ...c,
    command: containerizeViteCommand(containerizeCommand(c.command, worktreePath), projectPath, worktreePath)
  }))
}

export function addCommand(
  scope: CommandScope,
  projectPath: string,
  worktreePath: string,
  name: string,
  command: string
): ProjectCommand[] {
  const store = read()
  const bucket = scope === 'project' ? store.projects : store.worktrees
  const key = scope === 'project' ? projectPath : worktreePath
  const list = bucket[key] ?? []
  list.push({ id: newId(), name: name.trim() || 'Command', command: command.trim() })
  bucket[key] = list
  write(store)
  return listCommands(projectPath, worktreePath)
}

export function updateCommand(
  projectPath: string,
  worktreePath: string,
  id: string,
  patch: CommandPatch
): ProjectCommand[] {
  const store = read()
  for (const bucket of [store.projects, store.worktrees]) {
    for (const list of Object.values(bucket)) {
      const c = list.find((x) => x.id === id)
      if (!c) continue
      if (patch.name != null) c.name = patch.name.trim() || c.name
      if (patch.command != null) c.command = patch.command.trim()
      if (patch.cwd != null) c.cwd = patch.cwd.trim() || undefined
      if (patch.autoStart != null) c.autoStart = patch.autoStart
      if (patch.autoRestart != null) c.autoRestart = patch.autoRestart
      if (patch.notify != null) c.notify = patch.notify
      if (patch.watch != null) c.watch = patch.watch
    }
  }
  write(store)
  return listCommands(projectPath, worktreePath)
}

export function removeCommand(projectPath: string, worktreePath: string, id: string): ProjectCommand[] {
  const store = read()
  for (const bucket of [store.projects, store.worktrees]) {
    for (const key of Object.keys(bucket)) bucket[key] = bucket[key].filter((x) => x.id !== id)
  }
  write(store)
  return listCommands(projectPath, worktreePath)
}

// Move a command between local and project scope, so "mark as project" makes it
// show up across every worktree (and back again).
export function setCommandScope(
  projectPath: string,
  worktreePath: string,
  id: string,
  scope: CommandScope
): ProjectCommand[] {
  const store = read()
  let found: StoredCommand | undefined
  for (const bucket of [store.projects, store.worktrees]) {
    for (const key of Object.keys(bucket)) {
      const idx = bucket[key].findIndex((x) => x.id === id)
      if (idx >= 0) {
        found = bucket[key][idx]
        bucket[key].splice(idx, 1)
      }
    }
  }
  if (found) {
    const bucket = scope === 'project' ? store.projects : store.worktrees
    const key = scope === 'project' ? projectPath : worktreePath
    ;(bucket[key] ??= []).push(found)
    write(store)
  }
  return listCommands(projectPath, worktreePath)
}
