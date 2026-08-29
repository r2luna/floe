import { dialog } from 'electron'
import { existsSync, readFileSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { dataDir } from './dataDir'
import { DEFAULT_GROUP, type Project, type ProjectEnvConfig, type Worktree } from '../shared/types'
import { isGitRepo, repoRoot } from './git'
import { floeConfig, setFloeValue } from './config/floe'
import {
  createProject,
  invalidateProjects,
  projectScan,
  removeProject as removeProjectDir,
  setProjectEnvValue,
  setProjectValue,
  updateProject,
  type ProjectConfig
} from './config/projectStore'

// Storage lives in `~/.config/floe/projects/<dir>/config.toml`, one directory per
// project (config/projectStore.ts). This module is the app's view of that: it
// maps a stored project onto the `Project` the renderer speaks, owns the group
// list (which needs a home of its own, since an empty group has no directory),
// and carries the one-way migration off the old `projects.json`.

// The synthetic "Home" workspace. It isn't stored in projects.json — it's a
// constant the renderer injects at the top of the project/group lists so the app
// can boot straight into a terminal in the user's home directory and "Switch
// project…" can always return there. Not a git repo: it carries a single
// synthetic worktree and no git chrome. See the `home` flags in shared/types.
export const HOME_GROUP = 'Home'

export const homeProjectPath = (): string => homedir()

export const homeProject = (): Project => ({
  path: homeProjectPath(),
  name: 'Home',
  group: HOME_GROUP,
  home: true
})

export const homeWorktree = (): Worktree => ({
  path: homeProjectPath(),
  branch: '~',
  isMain: true,
  home: true
})

export const isHomePath = (path: string): boolean => path === homeProjectPath()

const toProject = (p: ProjectConfig): Project => ({
  path: p.path,
  name: p.name?.trim() || basename(p.path),
  group: p.group,
  readOnly: p.readOnly ? true : undefined,
  pinned: p.pinned ? true : undefined,
  env: p.env as ProjectEnvConfig | undefined
})

function stored(path: string): ProjectConfig | undefined {
  return projectScan().projects.find((p) => p.path === path)
}

function all(): Project[] {
  migrateLegacyProjects()
  return projectScan().projects.map(toProject)
}

// Read a project's env config by its root path — used by provisioning to pick the
// container recipe. Returns undefined for host-native (unconfigured) projects.
export function getProjectEnv(path: string): ProjectEnvConfig | undefined {
  return stored(path)?.env as ProjectEnvConfig | undefined
}

export function setProjectEnv(path: string, env: ProjectEnvConfig | null): Project[] {
  if (stored(path)) {
    if (env) {
      setProjectEnvValue(path, 'mode', env.mode)
      setProjectEnvValue(path, 'runtime', env.runtime)
      setProjectEnvValue(path, 'php', env.php)
      setProjectEnvValue(path, 'package-manager', env.packageManager)
      setProjectEnvValue(path, 'db', env.db)
      setProjectEnvValue(path, 'db-admin', env.dbAdmin !== false)
    } else {
      // Clearing the env means running on the host. The keys go rather than being
      // set to some "off" value, so the block reads the way the template documents
      // it: absent means host-native.
      for (const key of ['mode', 'runtime', 'php', 'package-manager', 'db', 'db-admin']) {
        updateProject(path, [{ op: 'unset', table: 'env', key }])
      }
    }
  }
  return all()
}

export function listProjects(): Project[] {
  return all()
}

// The default first, then the rest in the order they were made. Callers render
// this straight through, so the ordering rule lives here rather than in each of
// them — and the default is guaranteed present even for a store that predates it.
function ordered(groups: string[]): string[] {
  return [DEFAULT_GROUP, ...groups.filter((g) => g !== DEFAULT_GROUP)]
}

/** Groups actually in use, plus the ones declared but still empty. */
function currentGroups(): string[] {
  const declared = floeConfig().projects.groups
  const used = projectScan().projects.map((p) => p.group)
  return ordered([...declared, ...used.filter((g) => !declared.includes(g))])
}

function writeGroups(groups: string[]): string[] {
  const value = ordered(groups)
  setFloeValue('projects', 'groups', value)
  return value
}

export function listGroups(): string[] {
  migrateLegacyProjects()
  return currentGroups()
}

export function addGroup(name: string): string[] {
  const trimmed = name.trim()
  const groups = currentGroups()
  if (!trimmed || groups.includes(trimmed)) return groups
  return writeGroups([...groups, trimmed])
}

/**
 * Drop a group; its projects fall back to the default rather than vanishing with
 * it — losing a project because you tidied up the rail would be the worst
 * possible reading of "delete group". The default itself can't go: it's where
 * everything else lands.
 */
export function deleteGroup(name: string): { groups: string[]; projects: Project[] } {
  if (name === DEFAULT_GROUP) return { groups: currentGroups(), projects: all() }
  for (const p of projectScan().projects) {
    if (p.group === name) setProjectValue(p.path, 'group', DEFAULT_GROUP)
  }
  const groups = writeGroups(currentGroups().filter((g) => g !== name))
  return { groups, projects: all() }
}

export async function addProject(group?: string): Promise<{ project?: Project; error?: string }> {
  const result = await dialog.showOpenDialog({
    title: 'Select a project folder',
    properties: ['openDirectory']
  })
  if (result.canceled || result.filePaths.length === 0) return {}
  return addProjectByPath(result.filePaths[0], group)
}

// Add a project by an explicit path (no dialog) — used by the `floe` CLI.
// Validates it's a git repo, resolves to the repo root, and dedupes by root
// (re-adding an existing project just returns it, keeping its current group).
export async function addProjectByPath(
  picked: string,
  group?: string
): Promise<{ project?: Project; error?: string }> {
  if (!existsSync(picked)) return { error: `Path does not exist: ${picked}` }
  if (!(await isGitRepo(picked))) {
    return { error: `"${basename(picked)}" is not a git repository.` }
  }

  const root = (await repoRoot(picked)) ?? picked
  migrateLegacyProjects()
  const existing = stored(root)
  if (existing) return { project: toProject(existing) }

  const groups = currentGroups()
  const targetGroup = (group && group.trim()) || groups[0] || DEFAULT_GROUP
  if (!groups.includes(targetGroup)) writeGroups([...groups, targetGroup])
  return { project: toProject(createProject(root, { group: targetGroup })) }
}

export function renameGroup(
  oldName: string,
  newName: string
): { groups: string[]; projects: Project[] } {
  const trimmed = newName.trim()
  // The default is a fixed slot, not a name the user owns — renaming it would
  // leave deleteGroup with nowhere to move orphaned projects.
  if (!trimmed || oldName === DEFAULT_GROUP || trimmed === oldName) {
    return { groups: currentGroups(), projects: all() }
  }
  const groups = currentGroups()
  if (!groups.includes(oldName)) return { groups, projects: all() }
  for (const p of projectScan().projects) {
    if (p.group === oldName) setProjectValue(p.path, 'group', trimmed)
  }
  // Merge into an existing group if the name is taken; otherwise rename in place.
  const next = groups.includes(trimmed)
    ? groups.filter((g) => g !== oldName)
    : groups.map((g) => (g === oldName ? trimmed : g))
  return { groups: writeGroups(next), projects: all() }
}

export function renameProject(path: string, newName: string): Project[] {
  if (stored(path)) {
    const trimmed = newName.trim()
    // A blank name (or one matching the folder) clears the override and falls back
    // to the directory basename. The folder on disk is never touched.
    if (trimmed && trimmed !== basename(path)) setProjectValue(path, 'name', trimmed)
    else updateProject(path, [{ op: 'unset', key: 'name' }])
  }
  return all()
}

export function setProjectGroup(path: string, group: string): Project[] {
  if (stored(path)) {
    setProjectValue(path, 'group', group)
    if (!currentGroups().includes(group)) writeGroups([...currentGroups(), group])
  }
  return all()
}

export function setProjectReadOnly(path: string, value: boolean): Project[] {
  if (stored(path)) {
    if (value) setProjectValue(path, 'read-only', true)
    else updateProject(path, [{ op: 'unset', key: 'read-only' }])
  }
  return all()
}

export function setProjectPinned(path: string, value: boolean): Project[] {
  if (stored(path)) {
    if (value) setProjectValue(path, 'pinned', true)
    else updateProject(path, [{ op: 'unset', key: 'pinned' }])
  }
  return all()
}

export function removeProject(path: string): Project[] {
  removeProjectDir(path)
  return all()
}

/**
 * Fold the old `projects.json` into one directory per project, once.
 *
 * One way: the JSON is renamed rather than deleted, so a migration that went
 * wrong is still recoverable by hand, and is never read again either way.
 */
let migrated = false
export function migrateLegacyProjects(): void {
  if (migrated) return
  migrated = true
  const legacy = join(dataDir(), 'projects.json')
  if (!existsSync(legacy)) return
  try {
    const data = JSON.parse(readFileSync(legacy, 'utf8')) as {
      groups?: unknown
      projects?: unknown
    }
    const groups = Array.isArray(data.groups) ? (data.groups as string[]).filter((g) => typeof g === 'string') : []
    if (groups.length) writeGroups(groups)
    const raw = Array.isArray(data.projects) ? data.projects : []
    for (const entry of raw) {
      // The oldest shape was a bare array of paths.
      const p = typeof entry === 'string' ? { path: entry } : (entry as Record<string, unknown>)
      if (!p || typeof p.path !== 'string') continue
      const project = createProject(p.path, {
        group: typeof p.group === 'string' ? p.group : DEFAULT_GROUP,
        name: typeof p.name === 'string' ? p.name : undefined,
        pinned: p.pinned === true
      })
      if (p.readOnly === true) setProjectValue(project.path, 'read-only', true)
      if (isEnvConfig(p.env)) {
        setProjectEnv(project.path, p.env)
      }
    }
  } catch {
    // A corrupt legacy store is not worth failing the app over; it is renamed
    // either way so this runs once.
  }
  renameSync(legacy, `${legacy}.migrated`)
  invalidateProjects()
}

// A stored `env` blob is valid only if it names the container mode with the
// required fields; anything else is dropped (falls back to host-native).
function isEnvConfig(v: unknown): v is ProjectEnvConfig {
  if (!v || typeof v !== 'object') return false
  const e = v as Record<string, unknown>
  return (
    e.mode === 'container' &&
    e.runtime === 'laravel' &&
    typeof e.php === 'string' &&
    typeof e.packageManager === 'string' &&
    (e.db === 'mysql' || e.db === 'postgres')
  )
}
