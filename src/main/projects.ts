import { dialog } from 'electron'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename } from 'node:path'
import {
  DEFAULT_GROUP,
  type PathProbe,
  type Project,
  type ProjectEnvConfig,
  type Worktree
} from '../shared/types'
import { isGitRepo, listWorktrees, repoRoot } from './git'
import { floeConfig, setFloeValue } from './config/floe'
import {
  createProject,
  projectScan,
  removeProject as removeProjectDir,
  setProjectEnvValue,
  setProjectValue,
  updateProject,
  type ProjectConfig
} from './config/projectStore'

// Storage lives in `~/.config/floe/projects/<dir>/config.toml`, one directory per
// project (config/projectStore.ts). This module is the app's view of that: it
// maps a stored project onto the `Project` the renderer speaks, and owns the
// group list, which needs a home of its own since an empty group has no
// directory to live in.

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

export async function addProject(
  group?: string
): Promise<{ project?: Project; created?: boolean; error?: string }> {
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
//
// `created` tells the two apart. A re-add answers with the project it already
// had, which reads identically to a fresh one at the call site — and the setup
// flow must fire for a project Floe has never seen and for no other, so the
// distinction has to be stated here rather than guessed at upstream.
export async function addProjectByPath(
  picked: string,
  group?: string
): Promise<{ project?: Project; created?: boolean; error?: string }> {
  if (!existsSync(picked)) return { error: `Path does not exist: ${picked}` }
  if (!(await isGitRepo(picked))) {
    return { error: `"${basename(picked)}" is not a git repository.` }
  }

  const root = (await repoRoot(picked)) ?? picked
  const existing = stored(root)
  if (existing) return { project: toProject(existing), created: false }

  const groups = currentGroups()
  const targetGroup = (group && group.trim()) || groups[0] || DEFAULT_GROUP
  if (!groups.includes(targetGroup)) writeGroups([...groups, targetGroup])
  return { project: toProject(createProject(root, { group: targetGroup })), created: true }
}

/**
 * What a path is, without adding it — the add dialog's preview pane.
 *
 * Runs the same checks as addProjectByPath and in the same order, so what the
 * pane says is what the add will do. It never expands `~`, never creates
 * anything, and answers for a path that does not exist rather than throwing:
 * the caller is asking about half-typed text.
 */
export async function probePath(picked: string): Promise<PathProbe> {
  const path = picked.trim()
  if (!path || !existsSync(path)) return { path, exists: false, isRepo: false }
  if (!(await isGitRepo(path))) return { path, exists: true, isRepo: false }

  const root = (await repoRoot(path)) ?? path
  const existing = stored(root)
  // One call for both facts: the main worktree carries the branch, and the list
  // length is how many worktrees come along with the project.
  const worktrees = await listWorktrees(root).catch(() => [] as Worktree[])
  return {
    path,
    exists: true,
    isRepo: true,
    root,
    name: existing?.name || basename(root),
    branch: worktrees.find((w) => w.isMain)?.branch,
    worktrees: worktrees.length,
    added: !!existing,
    group: existing ? toProject(existing).group : undefined
  }
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
