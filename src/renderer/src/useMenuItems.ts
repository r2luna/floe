import { useEffect, useMemo, useState } from 'react'
import type { PaletteItem } from './fuzzy.ts'
import type { Trigger } from './trigger.ts'
import type { WorktreeRow, Worktrees } from './useWorktrees.ts'
import type { Skill } from '../../main/config/skills.ts'
// The slug rule is shared with main, which resolves it back to the session:
// two spellings of the same rule would write tokens that name nothing.
import { sessionSlug } from '../../shared/sessionRefs.ts'
import type { Project } from '../../shared/types.ts'
import { projectSlug, type ProjectRef } from '../../shared/projectRefs.ts'
import { backendLabel, backendOf, currentBackend } from './backends.ts'
import { setRemoteProjects } from './remoteProjects.ts'
import type { TaskFolder } from '../../shared/taskFolders.ts'
import { useTaskFolders } from './useTaskFolders.ts'

/**
 * Every session in the project, named the way the menu shows them — one row per
 * mention, not per session.
 *
 * Sessions of the same name write the same mention, so the second row offers
 * nothing new to pick, and the menu keys its rows by that mention: duplicates
 * reconcile onto each other and leave rows from the previous query on screen.
 */
export function sessionMentions(rows: WorktreeRow[]): PaletteItem[] {
  const seen = new Set<string>()
  const out: PaletteItem[] = []
  for (const row of rows) {
    for (const s of row.sessions) {
      // The id is what gets inserted into the message, so it reads as
      // something a person would write, not as a UUID. What the model gets is
      // the UUID and the harness — see shared/sessionRefs.ts, which expands
      // this token on the way out.
      const id = `#${sessionSlug(s.title)}`
      if (seen.has(id)) continue
      seen.add(id)
      out.push({ id, title: s.title, detail: row.worktree.branch, group: 'sessions' })
    }
  }
  return out
}

/**
 * Every task of the project, as `#001`: the number the tasks panel lists it by.
 * Main expands it into the folder on the way out — see shared/taskRefs.ts.
 */
export function taskMentions(tasks: TaskFolder[]): PaletteItem[] {
  return tasks.map((t) => ({ id: `#${t.number}`, title: `${t.number} ${t.title}`, detail: t.status, group: 'tasks' }))
}

/** Where a project is being named from: the machine answering, and what to call the others. */
export interface Machines {
  current: string
  label: (id: string) => string
}

/** The token a project is named by: bare on this window's machine, `name@machine` elsewhere. */
function projectToken(p: Project, at: Machines): string {
  const slug = projectSlug(p.name)
  const backend = backendOf(p)
  return backend === at.current ? slug : `${slug}@${at.label(backend)}`
}

/**
 * Every project on every attached machine, as `$name`. The ones on another
 * machine than the one answering carry it — `$name@machine` — because two
 * machines can hold a project of the same name, and because main can only
 * resolve its own: those are expanded by the renderer (see remoteProjects.ts).
 * The synthetic Home is left out.
 */
export function projectMentions(projects: Project[], at: Machines): PaletteItem[] {
  const seen = new Set<string>()
  const out: PaletteItem[] = []
  for (const p of projects) {
    if (p.home) continue
    const token = projectToken(p, at)
    const id = `$${token}`
    if (seen.has(id)) continue
    seen.add(id)
    const remote = backendOf(p) !== at.current
    out.push({
      id,
      title: p.name,
      detail: remote ? `${at.label(backendOf(p))} · ${p.path}` : p.path,
      group: 'projects'
    })
  }
  return out
}

/** The projects main cannot resolve, keyed by the token that names them. */
export function remoteProjectRefs(projects: Project[], at: Machines): Map<string, ProjectRef> {
  const out = new Map<string, ProjectRef>()
  for (const p of projects) {
    if (p.home || backendOf(p) === at.current) continue
    out.set(projectToken(p, at), { name: p.name, path: p.path, machine: at.label(backendOf(p)) })
  }
  return out
}

/**
 * Every folder that holds a file in the list, once each, with a trailing `/`.
 *
 * Read off the file paths rather than asked for: the list is already every
 * tracked and untracked file, so the folders it names are exactly the ones
 * worth pointing at, and an empty or ignored folder is not one of them. The
 * slash is what tells the reader it is a folder and not a file without an
 * extension.
 */
export function folderMentions(files: string[]): PaletteItem[] {
  const seen = new Set<string>()
  for (const relPath of files) {
    let cut = relPath.lastIndexOf('/')
    while (cut > 0) {
      const dir = relPath.slice(0, cut + 1)
      if (seen.has(dir)) break
      seen.add(dir)
      cut = relPath.lastIndexOf('/', cut - 1)
    }
  }
  return [...seen]
    .sort()
    .map((dir) => ({ id: `#${dir}`, title: dir, detail: 'folder', group: 'folders' }))
}

/**
 * What `/` and `#` offer in the composer.
 *
 * `/` offers two kinds of skill and says which is which. FLOE skills come first:
 * they live in Floe's own config and are expanded here, so they work whichever
 * harness answers — that is the whole reason they exist. The harness's own
 * skills follow, read from the CLI itself so the list is what that worktree
 * actually has rather than a copy to keep in step.
 *
 * `$` is the projects Floe knows on every attached machine, by name.
 *
 * `#` is sessions of the project you are in, its tasks, then the worktree's
 * folders and files.
 */
export function useMenuItems(
  worktreePath: string | undefined,
  worktrees: Worktrees,
  projectRoot?: string,
  projects: Project[] = []
): (trigger: Trigger) => PaletteItem[] {
  const [skills, setSkills] = useState<string[]>([])
  const [floeSkills, setFloeSkills] = useState<Skill[]>([])
  const [files, setFiles] = useState<string[]>([])

  useEffect(() => {
    if (!worktreePath) {
      setSkills([])
      setFloeSkills([])
      setFiles([])
      return
    }
    let live = true
    window.floe.skills
      .list(worktreePath)
      .then((list) => live && setFloeSkills(list))
      .catch(() => live && setFloeSkills([]))
    window.floe.claude
      .info(worktreePath)
      .then((info) => live && setSkills(info.skills ?? []))
      // The probe spawns a CLI; a worktree where it fails should cost you an
      // empty menu, not an error in the middle of a sentence.
      .catch(() => live && setSkills([]))
    // `all`, not `list`: the tree call answers one directory, which offered the
    // repo root and nothing under it. This is the same list ⌘P searches — every
    // tracked and untracked file, at every depth.
    window.floe.files
      .all(worktreePath)
      .then((paths) => live && setFiles(paths))
      .catch(() => live && setFiles([]))
    return () => {
      live = false
    }
  }, [worktreePath])

  const mentions = useMemo(() => sessionMentions(worktrees.rows), [worktrees.rows])
  // Tasks live in the project's main checkout, not the worktree you are in.
  const { tasks } = useTaskFolders(projectRoot)
  const taskRows = useMemo(() => taskMentions(tasks), [tasks])
  const machines = { current: currentBackend(), label: backendLabel }
  const projectRows = useMemo(() => projectMentions(projects, machines), [projects, machines.current])
  // Main resolves `$name` for its own machine's projects; the rest are expanded
  // on the way out of the renderer, from this list.
  useEffect(() => {
    setRemoteProjects(remoteProjectRefs(projects, machines))
  }, [projects, machines.current])

  // Sessions first: there are a handful of them and hundreds of files, and the
  // fuzzy filter keeps the order it is given.
  //
  // The row is searched by its whole path — `#comp` should find
  // `src/renderer/Composer.tsx` — and the whole path is what lands in the box:
  // which of four `index.ts` you picked is part of what you just said, and a
  // reference you cannot read is one you cannot check before sending.
  //
  // Folders before files for the same reason sessions come first: far fewer
  // rows, and they would sink under a matching file otherwise.
  const paths = useMemo(
    () => [
      ...folderMentions(files),
      ...files.map((relPath) => ({
        id: `#${relPath}`,
        title: relPath,
        detail: 'file',
        group: 'files'
      }))
    ],
    [files]
  )

  return useMemo(
    () => (trigger: Trigger) =>
      trigger.char === '/'
        ? [
            // Floe's own command: resumes a harness's on-disk conversation
            // (session.resume) instead of going out as text.
            { id: '/resume', title: 'resume', detail: 'claude or codex session', group: 'floe' },
            // Floe's first, and named by scope: which skill you get when a
            // global and a project one share a name is a thing you should be
            // able to see before you pick.
            ...floeSkills.map((s) => ({
              id: `/${s.name}`,
              title: s.name,
              detail: s.scope,
              group: 'floe'
            })),
            // A harness skill Floe also has would be dead weight in the list —
            // the Floe one wins the token either way.
            ...skills
              .filter((name) => !floeSkills.some((s) => s.name === name))
              .map((name) => ({ id: `/${name}`, title: name, detail: 'harness', group: 'harness' }))
          ]
        : trigger.char === '$'
          ? projectRows
          : [...mentions, ...taskRows, ...paths],
    [skills, floeSkills, mentions, taskRows, paths, projectRows]
  )
}
