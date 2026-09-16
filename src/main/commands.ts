// A worktree's named processes, as the rest of the app sees them.
//
// Stored in each project's own `commands.toml` (config/commandStore.ts) — one
// file per project, documented in place, editable by hand and by agents. This
// module keeps the shape the app already speaks: a flat list per worktree,
// project-scope commands first, with the container rewrites applied at read time.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { worktreeComposePath } from './compose'
import { detectPackageManager } from './devServer'
import {
  addCommand as storeAdd,
  readCommands,
  removeCommand as storeRemove,
  setCommandWorktree,
  updateCommand as storeUpdate,
  type NewCommand,
  type NotifyLevel,
  type StoredCommand
} from './config/commandStore'
import { createProject, projectScan, updateRepoProject } from './config/projectStore'

export type CommandScope = 'project' | 'local'
export type { NotifyLevel }

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

export type ProjectCommand = Omit<StoredCommand, 'index' | 'worktree'> & { scope: CommandScope }

// A Laravel project ships with `artisan` + `composer.json`. New Laravel projects
// get a starter command set the first time they're opened.
export function isLaravel(projectPath: string): boolean {
  return existsSync(join(projectPath, 'artisan')) && existsSync(join(projectPath, 'composer.json'))
}

// A Laravel project's starter commands. `Dev` runs the JS bundler's dev server
// via the project's package manager (bun/pnpm/yarn/npm by lockfile) — not
// `composer dev` — so it's computed per project rather than hardcoded.
function laravelDefaults(projectPath: string): Array<{ name: string; command: string; autoStart?: boolean; watch?: string[] }> {
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

/**
 * Seed a project's stack defaults, once.
 *
 * `seeded` is recorded in the repo's own `.floe/config.toml` rather than in a
 * shared list, so it travels with the project — and so a user who deletes a
 * seeded command does not get it back on the next launch. It is written only
 * when defaults were actually added: a repo with nothing to seed gets no file.
 */
function seedDefaults(projectPath: string): void {
  const project = projectScan().projects.find((p) => p.path === projectPath)
  if (project?.seeded) return
  // A path this machine does not have is not a project to file here. Listing the
  // commands of a project that lives on ANOTHER machine used to create an entry
  // on this one, pointing at a directory that isn't there — a ghost row on the
  // panel that no one added. There is nothing to seed either: the stack sniff
  // below reads the repo, and there is no repo.
  if (!existsSync(projectPath)) return
  if (!project) createProject(projectPath)
  if (readCommands(projectPath).commands.length > 0) return
  if (!isLaravel(projectPath)) return
  for (const c of laravelDefaults(projectPath)) storeAdd(projectPath, c)
  updateRepoProject(projectPath, [{ op: 'set', key: 'seeded', value: true }])
}

// Commands run on the host, but a containerized worktree has no PHP or JS runtime
// there (the headless server box has neither) — so `php artisan queue:work` and
// `bun run dev` just fail with "not found". The `floe` CLI router
// (bin/floe-server.mjs) execs those into the worktree's app container, which is
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
  return `floe ${command}`
}

// In a containerized worktree the dev server must bind 0.0.0.0 and advertise the
// Caddy-fronted vite host — settings the project's own vite config can't know, and
// commonly contradicts. Provisioning writes `.floe/vite.config.mjs` (see
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
  // Both shapes occur: the bare seeded one, and the `floe `-prefixed form the
  // container command router (bin/floe-server.mjs) uses on the server.
  if (!/^(?:floe\s+)?(?:bun|pnpm|yarn|npm) run dev$/.test(command)) return command
  if (!existsSync(join(worktreePath, '.floe', 'vite.config.mjs'))) return command
  let dev: unknown
  try {
    dev = JSON.parse(readFileSync(join(projectPath, 'package.json'), 'utf8')).scripts?.dev
  } catch {
    return command // no/unreadable package.json — nothing to wrap
  }
  if (typeof dev !== 'string' || !/^vite(\s|$)/.test(dev.trim())) return command
  return `${command} -- --config .floe/vite.config.mjs`
}

// The merged command list for a worktree: the project's shared commands first,
// then this worktree's local ones.
export function listCommands(projectPath: string, worktreePath: string): ProjectCommand[] {
  seedDefaults(projectPath)
  const { commands } = readCommands(projectPath)
  return commands
    .filter((c) => !c.worktree || c.worktree === worktreePath)
    .map(({ index: _index, worktree, ...c }) => ({
      ...c,
      scope: worktree ? ('local' as const) : ('project' as const),
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
  storeAdd(projectPath, {
    name: name.trim() || 'Command',
    command: command.trim(),
    worktree: scope === 'local' ? worktreePath : undefined
  })
  return listCommands(projectPath, worktreePath)
}

export function updateCommand(
  projectPath: string,
  worktreePath: string,
  id: string,
  patch: CommandPatch
): ProjectCommand[] {
  storeUpdate(projectPath, id, {
    ...patch,
    name: patch.name?.trim() || undefined,
    command: patch.command?.trim(),
    // An empty cwd means "no override": commandStore removes the key rather than
    // writing an empty string, which would read back as a real override.
    cwd: patch.cwd === undefined ? undefined : patch.cwd.trim()
  })
  return listCommands(projectPath, worktreePath)
}

export function removeCommand(projectPath: string, worktreePath: string, id: string): ProjectCommand[] {
  storeRemove(projectPath, id)
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
  setCommandWorktree(projectPath, id, scope === 'local' ? worktreePath : null)
  return listCommands(projectPath, worktreePath)
}

/* --- the agent's view ----------------------------------------------------- */
//
// The panel always asks about ONE worktree, because that is the pane it draws.
// An agent registering a project's commands has no worktree in mind yet, so
// these two work on the project as a whole: every entry in commands.toml, and a
// write that carries the full [[command]] shape rather than the name/command
// pair the panel's inline row can type.

export type CommandDefinition = NewCommand
/** A stored command as an agent sees it — no file index, `worktree` kept. */
export type DefinedCommand = Omit<StoredCommand, 'index' | 'local'>

export function projectCommands(projectPath: string): DefinedCommand[] {
  seedDefaults(projectPath)
  return readCommands(projectPath).commands.map(({ index: _index, local: _local, ...c }) => c)
}

/**
 * Add a command to the project's commands.toml.
 *
 * Refuses a name that is already there. Ids are slugified from the name, so a
 * second "Dev" would land as `dev-2` — two rows saying the same word, which is
 * never what a re-run of the analysis meant.
 */
export function defineCommand(projectPath: string, spec: CommandDefinition): DefinedCommand[] {
  const name = spec.name.trim()
  const command = spec.command.trim()
  if (!name || !command) throw new Error('a command needs both a name and a command to run')
  const taken = projectCommands(projectPath).some((c) => c.name.toLowerCase() === name.toLowerCase())
  if (taken) throw new Error(`"${name}" is already a command in this project`)
  storeAdd(projectPath, { ...spec, name, command })
  return projectCommands(projectPath)
}
