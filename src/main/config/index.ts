// The config directory as a whole: bring it into existence, watch it, and answer
// "what is wrong with it right now?" in one list.
//
// Files are generated on every boot rather than on first edit. A config you
// cannot see is a config you do not know you can change, and these files are the
// interface — for the user, and for an agent asked to "turn the sandbox off" or
// "add a command to this project". The defaults stay in code either way, so a
// file that is missing, unreadable or wrong costs nothing but the customization.

import { existsSync, watch, type FSWatcher } from 'node:fs'
import { basename, join } from 'node:path'
import { configDir } from '../dataDir'
import type { ConfigError } from './errors'
import { ensureFloeConfig, floeConfigPath, floeConfigResult, invalidateFloeConfig } from './floe'
import { invalidateProjects, projectScan } from './projectStore'
import { invalidateEditorCache } from '../editors'
import { readCommands } from './commandStore'
import { colonyConfig, globalColony } from './colony'
import { ensureKeybindings } from '../keybindings'
import { ensureBuiltinSkills, ensureSkills } from './skills'
import { ensureSystemPrompt, systemPromptPath } from '../appSettings'
import { migrateProjectsToRepo } from './migrateRepo'
import { repoFloeDir } from './repoConfig'

/** Create anything missing. Never throws: a read-only home is not a crash. */
export function initConfig(): void {
  const steps = [ensureFloeConfig, ensureKeybindings, ensureSkills, ensureBuiltinSkills, ensureSystemPrompt, migrateProjectsToRepo]
  for (const step of steps) {
    try {
      step()
    } catch (err) {
      console.error('[config] could not generate a config file:', (err as Error).message)
    }
  }
}

/**
 * Every problem across every config file, in one list.
 *
 * Collected on demand rather than accumulated as files are read: the caches
 * behind these are dropped by the watcher, so recomputing is the only way to
 * report the CURRENT state rather than whatever was true at boot.
 */
export function configErrors(): ConfigError[] {
  const errors: ConfigError[] = [...floeConfigResult().errors, ...projectScan().errors]
  // `[colony]` lives in floe.toml but is not read by parseFloeConfig, so its own
  // errors come from here — once, not once per project.
  errors.push(...globalColony().errors)
  for (const project of projectScan().projects) {
    errors.push(...readCommands(project.path).errors)
    // And the project's own board. A stage naming a skill nobody has starts
    // nothing, so a colony that does not run has to be able to say why here.
    errors.push(...colonyConfig(project.path).errors.filter((e) => e.file !== floeConfigPath()))
  }
  return errors
}

export function invalidateAll(): void {
  invalidateFloeConfig()
  invalidateProjects()
  // The editor's resolved binary is cached off `[editor] command`, so changing
  // it has to drop that too — otherwise the new editor takes a relaunch.
  invalidateEditorCache()
}

/**
 * Watch the config directory and report changes.
 *
 * Recursive, because a project's `config.toml` is two levels down and an agent
 * writing one has to show up in the sidebar without a restart. Debounced,
 * because an editor saving a file is two or three filesystem events, and a
 * package of them should reload once.
 *
 * Each project's `<repo>/.floe/` is watched too, since its settings, commands,
 * MCP servers and skills live there now (repoConfig.ts).
 */
export function watchConfig(onChange: (file: string) => void): () => void {
  const dir = configDir()
  let timer: NodeJS.Timeout | null = null
  let pending: string | null = null
  let watcher: FSWatcher | null = null
  const repos = new Map<string, FSWatcher[]>()
  // Whether a project's watchers include its `.floe/`, so sync can tell when
  // that directory has appeared or gone since.
  const floeWatched = new Map<string, boolean>()

  const schedule = (file: string): void => {
    pending = file
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      invalidateAll()
      syncRepos()
      onChange(pending ?? '')
    }, 120)
  }

  // One watcher set per project: its `.floe/` when there is one, and the repo
  // root alone so a `.floe/` created later is noticed and picked up.
  const syncRepos = (): void => {
    const want = new Set(projectScan().projects.map((p) => p.path).filter((p) => existsSync(p)))
    for (const [path, list] of repos) {
      if (want.has(path) && floeWatched.get(path) === existsSync(repoFloeDir(path))) continue
      list.forEach((w) => w.close())
      repos.delete(path)
      floeWatched.delete(path)
    }
    for (const path of want) {
      if (repos.has(path)) continue
      floeWatched.set(path, existsSync(repoFloeDir(path)))
      repos.set(path, watchRepo(path, schedule))
    }
  }

  try {
    watcher = watch(dir, { recursive: true }, (_event, filename) => {
      if (!filename) return
      const name = basename(filename.toString())
      // Our own atomic writes land as `<file>.tmp` first; reacting to those would
      // reload a file that is about to be replaced anyway.
      if (name.endsWith('.tmp') || name.endsWith('.migrated')) return
      // Plugins live under the config dir but are code + private state, not
      // config: a plugin writing its own files must not repaint the app, and a
      // changed bundle only takes effect on relaunch anyway.
      if (filename.toString().split('/')[0] === 'plugins') return
      schedule(filename.toString())
    })
  } catch {
    // No watcher (platform, permissions) just means edits need a relaunch.
    return () => {}
  }
  syncRepos()
  return () => {
    if (timer) clearTimeout(timer)
    watcher?.close()
    for (const list of repos.values()) list.forEach((w) => w.close())
  }
}

/** The files under `.floe/` that are config. Plans, drawings and reports are not. */
export const isRepoConfigFile = (rel: string): boolean =>
  /^(config\.toml|commands\.toml|mcp\.toml|local\/(commands|mcp)\.toml|skills(\/.*)?)$/.test(rel)

function watchRepo(path: string, schedule: (file: string) => void): FSWatcher[] {
  const out: FSWatcher[] = []
  const add = (target: string, recursive: boolean, fn: (name: string) => void): void => {
    try {
      out.push(watch(target, { recursive }, (_event, filename) => filename && fn(filename.toString())))
    } catch {
      // Unwatchable (permissions, a path gone mid-scan): edits there need a relaunch.
    }
  }
  const floe = repoFloeDir(path)
  const watching = existsSync(floe)
  // Only a `.floe/` appearing or vanishing matters here: the root also reports
  // `.floe` whenever a plan or drawing is written inside it.
  add(path, false, (name) => name === '.floe' && existsSync(floe) !== watching && schedule(floe))
  if (watching) {
    add(floe, true, (rel) => {
      if (!rel.endsWith('.tmp') && isRepoConfigFile(rel)) schedule(join(floe, rel))
    })
  }
  return out
}

/** Where the user's config lives, for "Reveal in Finder" and error messages. */
export function configPaths(): { dir: string; floe: string; projects: string; systemPrompt: string } {
  return {
    dir: configDir(),
    floe: floeConfigPath(),
    projects: join(configDir(), 'projects'),
    // Not necessarily inside `dir`: `[agent] system-prompt` may name a file the
    // user keeps elsewhere, and Settings has to open the one actually in use.
    systemPrompt: systemPromptPath()
  }
}

export const configDirExists = (): boolean => existsSync(configDir())
export type { ConfigError }
