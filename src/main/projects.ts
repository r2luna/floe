import { dialog } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { dataDir } from './dataDir'
import type { Project, ProjectEnvConfig, Worktree } from '../shared/types'
import { isGitRepo, repoRoot } from './git'

const DEFAULT_GROUP = 'Projects'

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

interface StoreShape {
  groups: string[]
  // `name` is an optional display-name override; when unset the folder basename is used.
  // `readOnly` flips the project into reader mode (open files in the renderer's
  // viewer instead of nvim).
  // `pinned` keeps the project on the rail even with no activity today.
  // `env` is the containerized-environment config (opt-in per project).
  projects: Array<{
    path: string
    group: string
    name?: string
    readOnly?: boolean
    pinned?: boolean
    env?: ProjectEnvConfig
  }>
}

const storeFile = (): string => join(dataDir(), 'projects.json')

function read(): StoreShape {
  const file = storeFile()
  if (!existsSync(file)) return { groups: [DEFAULT_GROUP], projects: [] }
  try {
    const data = JSON.parse(readFileSync(file, 'utf8')) as {
      groups?: unknown
      projects?: unknown
    }
    const rawProjects = Array.isArray(data.projects) ? data.projects : []

    // Migrate the old shape: { projects: string[] }.
    if (rawProjects.length > 0 && typeof rawProjects[0] === 'string') {
      return {
        groups: [DEFAULT_GROUP],
        projects: (rawProjects as string[]).map((p) => ({ path: p, group: DEFAULT_GROUP }))
      }
    }

    const groups =
      Array.isArray(data.groups) && data.groups.length > 0 ? (data.groups as string[]) : [DEFAULT_GROUP]
    const projects = (
      rawProjects as Array<{
        path?: unknown
        group?: unknown
        name?: unknown
        readOnly?: unknown
        pinned?: unknown
        env?: unknown
      }>
    )
      .filter((p) => p && typeof p.path === 'string')
      .map((p) => ({
        path: p.path as string,
        group: typeof p.group === 'string' ? p.group : DEFAULT_GROUP,
        name: typeof p.name === 'string' ? p.name : undefined,
        readOnly: p.readOnly === true ? true : undefined,
        pinned: p.pinned === true ? true : undefined,
        env: isEnvConfig(p.env) ? p.env : undefined
      }))
    return { groups, projects }
  } catch {
    return { groups: [DEFAULT_GROUP], projects: [] }
  }
}

function write(store: StoreShape): void {
  writeFileSync(storeFile(), JSON.stringify(store, null, 2))
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

const toProject = (p: {
  path: string
  group: string
  name?: string
  readOnly?: boolean
  pinned?: boolean
  env?: ProjectEnvConfig
}): Project => ({
  path: p.path,
  name: p.name?.trim() || basename(p.path),
  group: p.group,
  readOnly: p.readOnly === true ? true : undefined,
  pinned: p.pinned === true ? true : undefined,
  env: p.env
})

// Read a project's env config by its root path — used by provisioning to pick the
// container recipe. Returns undefined for host-native (unconfigured) projects.
export function getProjectEnv(path: string): ProjectEnvConfig | undefined {
  return read().projects.find((p) => p.path === path)?.env
}

export function setProjectEnv(path: string, env: ProjectEnvConfig | null): Project[] {
  const store = read()
  const project = store.projects.find((p) => p.path === path)
  if (project) {
    if (env) project.env = env
    else delete project.env
    write(store)
  }
  return store.projects.map(toProject)
}

export function listProjects(): Project[] {
  return read().projects.map(toProject)
}

export function listGroups(): string[] {
  return read().groups
}

export function addGroup(name: string): string[] {
  const store = read()
  const trimmed = name.trim()
  if (trimmed && !store.groups.includes(trimmed)) {
    store.groups.push(trimmed)
    write(store)
  }
  return store.groups
}

export async function addProject(group?: string): Promise<{ project?: Project; error?: string }> {
  const result = await dialog.showOpenDialog({
    title: 'Select a project folder',
    properties: ['openDirectory']
  })
  if (result.canceled || result.filePaths.length === 0) return {}
  return addProjectByPath(result.filePaths[0], group)
}

// Add a project by an explicit path (no dialog) — used by the `rookery` CLI.
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
  const store = read()
  const existing = store.projects.find((p) => p.path === root)
  if (existing) return { project: toProject(existing) }

  const targetGroup = (group && group.trim()) || store.groups[0] || DEFAULT_GROUP
  if (!store.groups.includes(targetGroup)) store.groups.push(targetGroup)
  store.projects.push({ path: root, group: targetGroup })
  write(store)

  return { project: toProject({ path: root, group: targetGroup }) }
}

export function renameGroup(
  oldName: string,
  newName: string
): { groups: string[]; projects: Project[] } {
  const store = read()
  const trimmed = newName.trim()
  const idx = store.groups.indexOf(oldName)
  if (trimmed && idx !== -1 && trimmed !== oldName) {
    // Merge into an existing group if the name is taken; otherwise rename in place.
    if (store.groups.includes(trimmed)) store.groups.splice(idx, 1)
    else store.groups[idx] = trimmed
    for (const p of store.projects) {
      if (p.group === oldName) p.group = trimmed
    }
    write(store)
  }
  return { groups: store.groups, projects: store.projects.map(toProject) }
}

export function renameProject(path: string, newName: string): Project[] {
  const store = read()
  const project = store.projects.find((p) => p.path === path)
  if (project) {
    const trimmed = newName.trim()
    // A blank name (or one matching the folder) clears the override and falls back
    // to the directory basename. The folder on disk is never touched.
    if (trimmed && trimmed !== basename(path)) project.name = trimmed
    else delete project.name
    write(store)
  }
  return store.projects.map(toProject)
}

export function setProjectGroup(path: string, group: string): Project[] {
  const store = read()
  const project = store.projects.find((p) => p.path === path)
  if (project) {
    project.group = group
    if (!store.groups.includes(group)) store.groups.push(group)
    write(store)
  }
  return store.projects.map(toProject)
}

export function setProjectReadOnly(path: string, value: boolean): Project[] {
  const store = read()
  const project = store.projects.find((p) => p.path === path)
  if (project) {
    if (value) project.readOnly = true
    else delete project.readOnly
    write(store)
  }
  return store.projects.map(toProject)
}

export function setProjectPinned(path: string, value: boolean): Project[] {
  const store = read()
  const project = store.projects.find((p) => p.path === path)
  if (project) {
    if (value) project.pinned = true
    else delete project.pinned
    write(store)
  }
  return store.projects.map(toProject)
}

export function removeProject(path: string): Project[] {
  const store = read()
  store.projects = store.projects.filter((p) => p.path !== path)
  write(store)
  return store.projects.map(toProject)
}
