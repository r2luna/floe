// Per-project backends: the projects panel is the union of every attached
// machine's list, and opening a project points the window at the machine that
// owns it. This module owns what that implies — fanning a read out across
// backends, merging one machine's answer back into the union without dropping
// the others, and carrying the landing across the remount a move causes.
//
// Ported from rookery's src/renderer/src/app/backends.ts: same router, same
// problem, and the group canonicalisation had already been worked out there.
//
// Channel strings live here and nowhere else in the renderer — `backends.invokeOn`
// is the only untyped seam, so it stays behind these wrappers.
import type { Project } from '../../shared/types'

export const LOCAL = 'local'

export const backendIds = (): string[] => window.floe.backends.list().map((b) => b.id)
export const currentBackend = (): string => window.floe.backends.current()
export const backendOf = (p: Project | null | undefined): string => p?.backend ?? LOCAL
export const backendLabel = (id: string): string =>
  window.floe.backends.list().find((b) => b.id === id)?.label ?? id
export const isRemote = (id: string): boolean =>
  window.floe.backends.list().find((b) => b.id === id)?.remote ?? false
/** The socket to a machine: 'open' is the only state its projects can be read in. */
export const backendState = (id: string): 'connecting' | 'open' | 'closed' =>
  window.floe.backends.state(id)

/**
 * Point the window at a machine and rebuild the app on it.
 *
 * The dispatch remounts <App> by key (main.tsx), which is what makes every hook
 * refetch from the machine now named — the guarantee a fresh window gives,
 * without opening one. False when the id names no backend.
 */
export function attach(id: string): boolean {
  if (!window.floe.backends.use(id)) return false
  window.dispatchEvent(new Event('floe:backend-switched'))
  return true
}

// --- the landing handed across a remount -------------------------------------

/** Where the app should land once it comes up on the other machine. */
export interface Landing {
  path: string
  /** The project was new there: start its setup once we arrive. */
  created?: boolean
}

// Module scope is what survives the remount — component state is exactly what
// does not, and the instance that asked for the move is thrown away by it.
let landing: Landing | null = null
// Who handed it off. The move is dispatched from inside an effect, so the
// instance that asked for it still finishes its own commit — including the
// effect that applies landings. Without an owner it would land on ITSELF and
// leave nothing for the instance that comes up, which is the one that is
// actually on the other machine.
let owner: object | null = null

export const handOff = (next: Landing, from: object): void => {
  landing = next
  owner = from
}

/**
 * The landing waiting to be applied, if any.
 *
 * Peek rather than take: the instance that comes up cannot act on it until its
 * project list has loaded, and a read that consumed it would lose the landing on
 * the render before that (and again on StrictMode's second mount). Whoever
 * applies it calls `dropLanding`.
 */
export const peekLanding = (self: object): Landing | null => (owner === self ? null : landing)

export const dropLanding = (): void => {
  landing = null
  owner = null
}

// --- the union ---------------------------------------------------------------

/**
 * Group names are shared across machines on purpose — a "Projects" group holding
 * local and remote repos is the point — and they are matched case-insensitively:
 * the panel renders them uppercase, so `elevaris` here and `Elevaris` there read
 * as one group and must BE one. First spelling seen wins (local's, then attach
 * order); the map is rebuilt by each full load, so a rename is not pinned to the
 * old case.
 */
const canonical = new Map<string, string>()

export function canonGroup(name: string): string {
  const seen = canonical.get(name.toLowerCase())
  if (seen) return seen
  canonical.set(name.toLowerCase(), name)
  return name
}

/** One machine's answer, as it lands. */
export interface ProjectSlice {
  /** The load this slice belongs to — a stale one is ignored. */
  gen: number
  backend: string
  projects: Project[]
  groups: string[]
  /** The machine did not answer. Its rows are not in this slice — see the load. */
  error?: string
}

/**
 * How long one machine gets to answer before the panel calls it offline.
 *
 * Not the socket's own timeout, which is the OS's and runs for minutes: with no
 * network the read simply never comes back, and a spinner that turns for two
 * minutes says nothing you can act on. Eight seconds is long enough for a
 * healthy link over a slow connection and short enough to hand you the retry
 * while you still care. A late answer is not thrown away — see the load.
 */
const SLICE_MS = 8000

/**
 * Every backend's projects, handed over one machine at a time.
 *
 * Deliberately not a single awaited union: a machine that is unreachable takes
 * as long as the OS takes to give up on its socket, and waiting for it held the
 * whole panel on "Loading…" — with the network down, the local projects were
 * ready in milliseconds and unreadable for a minute. So each slice is reported
 * the moment it lands and the caller paints what it has: local first, remotes
 * behind it, and a machine that is down reported as an error rather than as
 * silence.
 *
 * `gen` is handed back with every slice because a slow machine can answer after
 * the next load has already started — the caller uses it to tell a late answer
 * from a current one.
 *
 * Group spelling is settled by arrival order rather than backend order now.
 * Local answers in milliseconds and remotes do not, so in practice it is still
 * this machine's spelling that wins.
 */
let generation = 0

export async function loadProjectUnion(onSlice: (slice: ProjectSlice) => void): Promise<void> {
  canonical.clear()
  const gen = ++generation
  await Promise.all(
    backendIds().map(async (id) => {
      // The slow answer still counts when it arrives — it just arrives after the
      // machine was already reported as offline, and reports it back as up.
      const late = setTimeout(
        () => onSlice({ gen, backend: id, projects: [], groups: [], error: 'no answer' }),
        SLICE_MS
      )
      try {
        const [groups, list] = await Promise.all([
          window.floe.backends.invokeOn(id, 'projects:groups') as Promise<string[]>,
          window.floe.backends.invokeOn(id, 'projects:list') as Promise<Project[]>
        ])
        onSlice({
          gen,
          backend: id,
          // Canonicalise the group list FIRST: it arrives in the user's own
          // order, so that is the spelling to keep — the projects follow it.
          groups: groups.map(canonGroup),
          projects: list.map((p) => ({ ...p, backend: id, group: canonGroup(p.group) }))
        })
      } catch (e) {
        onSlice({ gen, backend: id, projects: [], groups: [], error: (e as Error).message })
      } finally {
        clearTimeout(late)
      }
    })
  )
}

/**
 * Splice one machine's answer back into the union.
 *
 * A mutation (move, remove, a new group) is answered with only its own backend's
 * list. Writing that straight to state would drop every other machine's projects
 * from the panel, so the slice replaces its own machine's rows and leaves the
 * rest where the backend order puts them. `order` is that order (the live one;
 * the test passes its own).
 */
export function mergeProjects(
  prev: Project[],
  list: Project[],
  backend: string,
  order: string[] = backendIds()
): Project[] {
  const tagged = list.map((p) => ({ ...p, backend, group: canonGroup(p.group) }))
  return order.flatMap((id) => (id === backend ? tagged : prev.filter((p) => backendOf(p) === id)))
}

// --- typed calls on a named machine ------------------------------------------
// A project belongs to one machine, so every mutation on it names that machine
// rather than riding the pointer: the panel lists rows you are not attached to,
// and acting on one must not reach the wrong disk.

export const setGroupOn = (backend: string, path: string, group: string): Promise<Project[]> =>
  window.floe.backends.invokeOn(backend, 'projects:setGroup', path, group) as Promise<Project[]>

export const removeOn = (backend: string, path: string): Promise<Project[]> =>
  window.floe.backends.invokeOn(backend, 'projects:remove', path) as Promise<Project[]>

// Groups are shared across machines (that is the point of the union), so the two
// group edits run on every backend that has the name.
export const addGroupOn = (backend: string, name: string): Promise<string[]> =>
  window.floe.backends.invokeOn(backend, 'projects:addGroup', name) as Promise<string[]>

export const deleteGroupOn = (
  backend: string,
  name: string
): Promise<{ groups: string[]; projects: Project[] }> =>
  window.floe.backends.invokeOn(backend, 'projects:deleteGroup', name) as Promise<{
    groups: string[]
    projects: Project[]
  }>
