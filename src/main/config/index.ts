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

/** Create anything missing. Never throws: a read-only home is not a crash. */
export function initConfig(): void {
  for (const step of [ensureFloeConfig, ensureKeybindings, ensureSkills, ensureBuiltinSkills, ensureSystemPrompt]) {
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
 */
export function watchConfig(onChange: (file: string) => void): () => void {
  const dir = configDir()
  let timer: NodeJS.Timeout | null = null
  let pending: string | null = null
  let watcher: FSWatcher | null = null
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
      pending = filename.toString()
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        invalidateAll()
        onChange(pending ?? '')
      }, 120)
    })
  } catch {
    // No watcher (platform, permissions) just means edits need a relaunch.
    return () => {}
  }
  return () => {
    if (timer) clearTimeout(timer)
    watcher?.close()
  }
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
