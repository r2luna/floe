import { useCallback, useEffect, useState } from 'react'
import { DEFAULT_GROUP, type Project } from '../../shared/types'
import {
  addGroupOn,
  attach,
  backendIds,
  backendOf,
  currentBackend,
  deleteGroupOn,
  dropLanding,
  handOff,
  loadProjectUnion,
  mergeProjects,
  removeOn,
  setGroupOn
} from './backends'

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
  /**
   * Add by an explicit path, which is the only way on a remote machine.
   * `backend` names the machine that reads it; omitted, it is the one the
   * window is pointed at.
   */
  addByPath: (path: string, group?: string, backend?: string) => Promise<AddResult>
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

/**
 * `self` identifies the App instance that owns this hook — a landing it hands
 * off is for the instance that comes up on the other machine, never for the one
 * that asked for the move (see handOff).
 */
export function useProjects(self: object): Projects {
  const [all, setAll] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [currentPath, setCurrentPath] = useState<string>()

  const [groupNames, setGroupNames] = useState<string[]>([])

  // Every attached machine's projects at once, each row tagged with the machine
  // it came from — one panel you can read across, instead of a list that empties
  // and refills whenever the window moves. A machine that is down drops out of
  // the union rather than failing the load (see fanOut).
  const reload = useCallback(() => {
    loadProjectUnion()
      .then(({ projects, groups }) => {
        setAll(projects)
        setGroupNames(groups)
        setError(undefined)
        // Nothing selected yet: start on the first real project rather than on
        // nothing, so the app has somewhere to be on a cold boot. Backend order
        // is local-first, so that is a project on this machine.
        setCurrentPath((p) => p ?? projects.find((x) => !x.home)?.path ?? projects[0]?.path)
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  useEffect(reload, [reload])

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
    async (path: string, group?: string, backend?: string) => {
      const res = await window.floe.projects.addByPath(path, group, backend)
      // A project added on ANOTHER machine is not in this list, and making it
      // the selection here would leave the rail pointing at something it cannot
      // show. The caller moves the window there and lands it on the far side.
      if (backend && backend !== currentBackend()) {
        return { error: res.error, path: res.project?.path, created: res.created }
      }
      return landOn(res)
    },
    [landOn]
  )

  const add = useCallback(
    async (group?: string) => landOn(await window.floe.projects.add(group)),
    [landOn]
  )

  /** The machine a row belongs to — where any edit to it has to run. */
  const backendFor = useCallback(
    (path: string) => backendOf(all.find((p) => p.path === path)),
    [all]
  )

  // Group edits all resolve the same way: main is the record, so take what it
  // returns rather than patching the local copy and hoping the two agree. They
  // run on EVERY machine: a group is one name across the union, so a group that
  // was only half-created would show up as two groups on the next load.
  const addGroup = useCallback(async (name: string) => {
    const names = new Set<string>()
    for (const id of backendIds()) {
      for (const g of await addGroupOn(id, name)) names.add(g)
    }
    setGroupNames([...names])
  }, [])

  const deleteGroup = useCallback(async (name: string) => {
    const names = new Set<string>()
    for (const id of backendIds()) {
      const { groups: g, projects: list } = await deleteGroupOn(id, name)
      g.forEach((n) => names.add(n))
      setAll((prev) => mergeProjects(prev, list, id))
    }
    setGroupNames([...names])
  }, [])

  const setGroup = useCallback(
    async (path: string, group: string) => {
      const backend = backendFor(path)
      const list = await setGroupOn(backend, path, group)
      setAll((prev) => mergeProjects(prev, list, backend))
      // A group the user just typed exists now even if no machine listed it before.
      setGroupNames((names) => (names.includes(group) ? names : [...names, group]))
    },
    [backendFor]
  )

  const remove = useCallback(
    async (path: string) => {
      const backend = backendFor(path)
      const list = await removeOn(backend, path)
      setAll((prev) => mergeProjects(prev, list, backend))
      // The removed one cannot stay current: land on whatever is left of the
      // machine it was on — being current means we are attached there — or on
      // nothing when it was the last project.
      setCurrentPath((p) => (p === path ? list.find((x) => !x.home)?.path ?? list[0]?.path : p))
    },
    [backendFor]
  )

  /**
   * Open a project, wherever it lives.
   *
   * A project on another machine moves the window there — the pointer follows
   * the project, so every panel that opens next reads that machine's disk — and
   * the landing is handed to the instance the move mounts, since this one is
   * about to be replaced.
   */
  const select = useCallback(
    (path: string) => {
      // A path the union does not know is NOT local — the machine it belongs to
      // may still be loading, or down. Treating "not found" as this machine
      // would bounce the window home the moment it arrived somewhere else.
      const known = all.some((p) => p.path === path)
      const backend = known ? backendFor(path) : currentBackend()
      if (backend === currentBackend()) return setCurrentPath(path)
      handOff({ path }, self)
      // Refused: the machine went away since the list was built. Stay put rather
      // than select a project this machine cannot show.
      if (!attach(backend)) dropLanding()
    },
    [all, backendFor, self]
  )

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
    select,
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
