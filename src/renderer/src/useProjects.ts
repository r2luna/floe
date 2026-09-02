import { useCallback, useEffect, useState } from 'react'
import { DEFAULT_GROUP, type Project } from '../../shared/types'

/**
 * The real project list from the main process.
 *
 * One hook, shared by the panel and the palette, so both read the same list and
 * an add from either shows up in both — the list is state that belongs to the
 * app, not to whichever surface asked for it first.
 */
export interface Projects {
  all: Project[]
  /** Grouped for display, in the order groups first appear in the list. */
  groups: { name: string; projects: Project[] }[]
  loading: boolean
  error?: string
  /** The one the app considers current. */
  current?: Project
  select: (path: string) => void
  /** Every group name, including empty ones — the add dialog offers them all. */
  groupNames: string[]
  /** Native folder picker (desktop) — resolves to the added project or an error. */
  add: (group?: string) => Promise<AddResult>
  /** Add by an explicit path, which is the only way on a remote machine. */
  addByPath: (path: string, group?: string) => Promise<AddResult>
  /** Create an empty group. A name that already exists is a no-op. */
  addGroup: (name: string) => Promise<void>
  /** Remove a group; its projects fall back to the default. */
  deleteGroup: (name: string) => Promise<void>
  /** Move a project into a group, creating the group if it is new. */
  setGroup: (path: string, group: string) => Promise<void>
  /** Forget a project. Its folder on disk is untouched — Floe just stops listing it. */
  remove: (path: string) => Promise<void>
  reload: () => void
}

/**
 * What an add came back with.
 *
 * `created` rather than "we got a project back": a re-add answers with the
 * project Floe already had, and the two are indistinguishable at the call site
 * without it — which matters because the setup flow fires for a project that is
 * new and for no other. See addProjectByPath in main.
 */
export interface AddResult {
  error?: string
  /** The project's root path, once it is in the list. */
  path?: string
  /** It was not already known. */
  created?: boolean
}

export function useProjects(): Projects {
  const [all, setAll] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [currentPath, setCurrentPath] = useState<string>()

  const reload = useCallback(() => {
    window.floe.projects
      .list()
      .then((list) => {
        setAll(list)
        setError(undefined)
        // Nothing selected yet: start on the first real project rather than on
        // nothing, so the app has somewhere to be on a cold boot.
        setCurrentPath((p) => p ?? list.find((x) => !x.home)?.path ?? list[0]?.path)
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  useEffect(reload, [reload])

  const [groupNames, setGroupNames] = useState<string[]>([])

  useEffect(() => {
    void window.floe.projects.groups().then(setGroupNames).catch(() => {})
  }, [])

  const landOn = useCallback(
    (res: { project?: { path: string }; created?: boolean; error?: string }): AddResult => {
      if (res.error) return { error: res.error }
      if (res.project) {
        reload()
        // Land on what you just added — adding a project and then having to go
        // find it is a step the app can take for you.
        setCurrentPath(res.project.path)
      }
      // `created` is carried through untouched: main is the only one that knows
      // whether the project was already stored, and the caller decides what to
      // do about it (App starts the setup flow).
      return { path: res.project?.path, created: res.created }
    },
    [reload]
  )

  const addByPath = useCallback(
    async (path: string, group?: string) =>
      landOn(await window.floe.projects.addByPath(path, group)),
    [landOn]
  )

  const add = useCallback(
    async (group?: string) => landOn(await window.floe.projects.add(group)),
    [landOn]
  )

  // Group edits all resolve the same way: main is the record, so take what it
  // returns rather than patching the local copy and hoping the two agree.
  const addGroup = useCallback(async (name: string) => {
    setGroupNames(await window.floe.projects.addGroup(name))
  }, [])

  const deleteGroup = useCallback(async (name: string) => {
    const { groups: g, projects: list } = await window.floe.projects.deleteGroup(name)
    setGroupNames(g)
    setAll(list)
  }, [])

  const setGroup = useCallback(async (path: string, group: string) => {
    setAll(await window.floe.projects.setGroup(path, group))
    setGroupNames(await window.floe.projects.groups())
  }, [])

  const remove = useCallback(async (path: string) => {
    const list = await window.floe.projects.remove(path)
    setAll(list)
    // The removed one cannot stay current: land on whatever is left, or on
    // nothing when it was the last project.
    setCurrentPath((p) => (p === path ? list.find((x) => !x.home)?.path ?? list[0]?.path : p))
  }, [])

  // Grouped in first-seen order rather than alphabetically: the order in
  // projects.json is the user's own, and re-sorting it would move things they
  // arranged. The default group is the one exception — it leads, always, so the
  // ungrouped pile has a fixed home instead of drifting with the list.
  const groups: Projects['groups'] = []
  for (const p of all) {
    const group = p.group || DEFAULT_GROUP
    const found = groups.find((g) => g.name === group)
    if (found) found.projects.push(p)
    else groups.push({ name: group, projects: [p] })
  }
  groups.sort((a, b) => Number(b.name === DEFAULT_GROUP) - Number(a.name === DEFAULT_GROUP))

  return {
    all,
    groups,
    loading,
    error,
    current: all.find((p) => p.path === currentPath),
    select: setCurrentPath,
    // Groups that exist on disk, plus any a project sits in — the dialog must
    // offer every group you could pick, not only the ones main persisted.
    groupNames: [...new Set([...groupNames, ...all.map((p) => p.group).filter(Boolean)])],
    add,
    addByPath,
    addGroup,
    deleteGroup,
    setGroup,
    remove,
    reload
  }
}
