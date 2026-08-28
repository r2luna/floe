import { useCallback, useEffect, useState } from 'react'
import type { Project } from '../../shared/types'

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
  add: (group?: string) => Promise<string | undefined>
  /** Add by an explicit path, which is the only way on a remote machine. */
  addByPath: (path: string, group?: string) => Promise<string | undefined>
  reload: () => void
}

export function useProjects(): Projects {
  const [all, setAll] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [currentPath, setCurrentPath] = useState<string>()

  const reload = useCallback(() => {
    window.rookery.projects
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
    void window.rookery.projects.groups().then(setGroupNames).catch(() => {})
  }, [])

  const landOn = useCallback(
    (res: { project?: { path: string }; error?: string }) => {
      if (res.error) return res.error
      if (res.project) {
        reload()
        // Land on what you just added — adding a project and then having to go
        // find it is a step the app can take for you.
        setCurrentPath(res.project.path)
      }
      return undefined
    },
    [reload]
  )

  const addByPath = useCallback(
    async (path: string, group?: string) =>
      landOn(await window.rookery.projects.addByPath(path, group)),
    [landOn]
  )

  const add = useCallback(
    async (group?: string) => landOn(await window.rookery.projects.add(group)),
    [landOn]
  )

  // Grouped in first-seen order rather than alphabetically: the order in
  // projects.json is the user's own, and re-sorting it would move things they
  // arranged.
  const groups: Projects['groups'] = []
  for (const p of all) {
    const group = p.group || 'Ungrouped'
    const found = groups.find((g) => g.name === group)
    if (found) found.projects.push(p)
    else groups.push({ name: group, projects: [p] })
  }

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
    reload
  }
}
