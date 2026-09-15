// Where a task's state lives: `<dataDir>/colony.json`, keyed by project root.
//
// Spec Q3, answered. It goes beside `sessions.json` and not in `configDir()`
// because the two directories mean different things (see dataDir.ts): config is
// hand-editable and backup-worthy, state is the app's own bookkeeping. Which
// stage a task is in, how many passes it has made and which session is running
// it are not settings — nobody edits them by hand, and a dotfiles repo carrying
// them would restore a board full of tasks that no longer exist.
//
// Not inside the worktree either: a task exists before its worktree does (it
// starts life in the backlog, which is exactly the state that has not paid for
// a checkout yet), and a `done` task outlives the worktree it is merged from.
//
// Same shape as sessionStore: one JSON file, read through an mtime-checked
// cache, written temp-then-rename so a kill mid-write cannot truncate it.

import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir } from '../dataDir'
import { INBOX } from '../config/colony'
import type { Usage } from '../usageLedger'
import type { Finding } from '../../shared/colony'

/** What a task is doing IN the column it currently sits in. */
export type TaskStatus =
  /** Waiting to ENTER this column. Costs no spot — see D4. */
  | 'holding'
  /** A lane's agent is on it right now. */
  | 'working'
  /** It ran and stopped on a question for you. Holds its spot until answered. */
  | 'blocked'
  /** It reached `done`, or a lane said `stop`. */
  | 'settled'

export type TaskKind = 'feat' | 'fix' | 'chore'
export const TASK_KINDS: TaskKind[] = ['feat', 'fix', 'chore']

/** One step a task took, so the card can draw a second visit rather than a fresh arrival (D23). */
export interface TaskVisit {
  at: number
  stage: string
  /** The session that step ran in — one per step, so the transcript is per visit. */
  sessionId?: string
  /** What the lane's hand-off line said. `none` is a turn that ended without one. */
  verdict: 'pass' | 'return' | 'stop' | 'none'
  why?: string
  /** What the step cost and produced. Only on a card the report is tracking. */
  step?: StepRecord
}

/**
 * One step, measured — the row the colony report draws.
 *
 * The diff is NOT stored, only the two trees it is between: patches are large,
 * `colony.json` is rewritten on every card move, and the report computes them
 * once, when it is written.
 */
export interface StepRecord {
  startedAt: number
  endedAt: number
  harness?: string
  model?: string
  usage: Usage
  /** The worktree's content when the step started and ended (git's `snapshotTree`). */
  treeBefore?: string
  treeAfter?: string
  /** False when the lane wrote no `FINDINGS:` block at all. */
  findingsDeclared: boolean
  findings: Finding[]
  /** The lane's last message, capped — its own account of what it did. */
  message: string
}

/** A card the step report is tracking. Set when it enters the first stage with the report on. */
export interface TaskReport {
  since: number
  /** The step running now: when it started, and the tree it started from. */
  current?: { at: number; tree?: string }
  /** The last report written for this card, in the project's `.floe/colony/reports/`. */
  file?: string
}

export interface ColonyTask {
  id: string
  /** Repo root. The board is project-scoped, so this is what partitions it. */
  project: string
  /** The card's name, and the branch's last segment. */
  name: string
  kind: TaskKind
  /** What the user asked for, in their words. Written to `specs/<dir>/task.md` on release. */
  brief: string
  /** The card's second line: what the lane is doing right now. */
  line?: string
  /** Set when the task is released from the backlog and its tree is cut. */
  branch?: string
  worktreePath?: string
  /**
   * The card's chat: the session of the step running now, or of the last one
   * that ran. Every step mints its own (see runner's `startLane`), so this moves
   * with the card — the earlier ones are on `visits`.
   */
  sessionId?: string
  /** A stage name, or the two ends: `inbox`, `done`. */
  stage: string
  status: TaskStatus
  /** How many lanes have passed it. The card prints `✓N`. */
  passes: number
  /**
   * Task ids this one has to wait for. Declared when the card is created, not
   * derived: the manager knows two changes touch the same code BEFORE either has
   * a worktree, and by the time a file overlap is visible both trees exist and
   * the sequencing decision is already lost.
   *
   * It gates RELEASE, not the lanes — an unreleased card has no worktree, which
   * is the whole point. Two dependent trees never exist at the same time.
   */
  dependsOn?: string[]
  /**
   * Somebody asked to release this and a dependency was not merged yet, so it
   * stayed in the backlog. The intent has to be stored: nothing else remembers
   * that this card is next, and the sweep after a merge is what acts on it.
   */
  queued?: boolean
  /**
   * When its branch landed on base. A `done` task is finished; a merged one is
   * gone from the board's problem list, and it is what unblocks its dependents.
   */
  mergedAt?: number
  /**
   * A lane ended without a hand-off line the board could parse. LANE-CONTRACT
   * promises that is treated as `pass` with a warning on the card, so the card
   * has to be able to carry one.
   */
  warn?: string
  /** Present while the step report is tracking this card. */
  report?: TaskReport
  createdAt: number
  updatedAt: number
  visits: TaskVisit[]
}

interface Store {
  tasks: ColonyTask[]
  /**
   * The board's own session, one per project (D7).
   *
   * Here rather than derived from the session list because "the nanny" is an
   * identity, not a title: a session the user renamed is still the nanny, and a
   * lookup by name would quietly mint a second one the moment they did.
   */
  nannies: Record<string, string>
}

const storeFile = (): string => join(dataDir(), 'colony.json')

let cached: { file: string; mtimeMs: number; size: number; store: Store } | undefined

function cacheStore(file: string, store: Store): Store {
  try {
    const stat = statSync(file)
    cached = { file, mtimeMs: stat.mtimeMs, size: stat.size, store }
  } catch {
    cached = undefined
  }
  return store
}

function read(): Store {
  const file = storeFile()
  if (!existsSync(file)) return { tasks: [], nannies: {} }
  if (cached && cached.file === file) {
    try {
      const stat = statSync(file)
      if (stat.mtimeMs === cached.mtimeMs && stat.size === cached.size) return cached.store
    } catch {
      /* fall through to a fresh parse */
    }
  }
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'))
    if (!data || typeof data !== 'object') return { tasks: [], nannies: {} }
    return cacheStore(file, {
      tasks: Array.isArray(data.tasks) ? (data.tasks as ColonyTask[]) : [],
      nannies: (data.nannies as Record<string, string>) ?? {}
    })
  } catch {
    // A corrupt board is not worth a broken launch. Same call sessionStore makes.
    return { tasks: [], nannies: {} }
  }
}

function write(store: Store): void {
  const file = storeFile()
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(store, null, 2))
  renameSync(tmp, file)
  cacheStore(file, store)
}

/** Every task the app knows about, across projects — for the boot sweep. */
export function allTasks(): ColonyTask[] {
  return read().tasks
}

/** Every task on one project's board, oldest first. */
export function listTasks(project: string): ColonyTask[] {
  return read().tasks.filter((t) => t.project === project)
}

export function getTask(id: string): ColonyTask | undefined {
  return read().tasks.find((t) => t.id === id)
}

/** The task a session belongs to — how a finished turn finds its card. */
export function taskForSession(sessionId: string): ColonyTask | undefined {
  return read().tasks.find((t) => t.sessionId === sessionId)
}

/**
 * Every session the colony owns, across all boards.
 *
 * For the lists that rank sessions by how recently they were touched: a board
 * running four cards writes far more often than the user types, so a panel that
 * counts colony sessions shows the colony working and nothing else — which is
 * what the board itself is for.
 *
 * A card is not one session for its whole life. Every step mints its own (see
 * the runner's `startLane`) and the finished ones stay on `visits`, so reading
 * `sessionId` alone would only catch the step running right now. The nannies are
 * here too: the board's own session is the colony's, not the user's.
 */
export function colonySessionIds(): Set<string> {
  const store = read()
  const ids = new Set<string>()
  for (const task of store.tasks) {
    if (task.sessionId) ids.add(task.sessionId)
    for (const visit of task.visits ?? []) if (visit.sessionId) ids.add(visit.sessionId)
  }
  for (const id of Object.values(store.nannies)) ids.add(id)
  return ids
}

/**
 * A name no other task on this board has.
 *
 * The name is the branch's last segment, so a collision would be two tasks
 * pointing at one worktree — which is the one thing "one task = one worktree"
 * cannot survive.
 */
export function freeName(project: string, wanted: string): string {
  const base =
    wanted
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'task'
  const taken = new Set(listTasks(project).map((t) => t.name))
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`
}

export interface NewTask {
  project: string
  name: string
  kind?: TaskKind
  brief: string
  /** Ids of tasks that must be merged before this one is released. */
  dependsOn?: string[]
}

/** Add a task to the backlog. It gets no worktree until it is released. */
export function addTask(task: NewTask): ColonyTask {
  const store = read()
  const now = Date.now()
  const created: ColonyTask = {
    id: `task_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    project: task.project,
    name: freeName(task.project, task.name),
    kind: task.kind ?? 'feat',
    brief: task.brief,
    // Only when there is one: an empty array on every card would read like a
    // declared "depends on nothing", which is not a thing anybody stated.
    ...(task.dependsOn?.length ? { dependsOn: [...task.dependsOn] } : {}),
    stage: INBOX,
    status: 'holding',
    passes: 0,
    createdAt: now,
    updatedAt: now,
    visits: []
  }
  write({ ...store, tasks: [...store.tasks, created] })
  return created
}

export function patchTask(id: string, patch: Partial<ColonyTask>): ColonyTask | undefined {
  const store = read()
  const at = store.tasks.findIndex((t) => t.id === id)
  if (at === -1) return undefined
  const next = { ...store.tasks[at], ...patch, updatedAt: Date.now() }
  const tasks = [...store.tasks]
  tasks[at] = next
  write({ ...store, tasks })
  return next
}

/** Record a lane's verdict and move the card in one write, so the two can never disagree. */
export function recordVisit(id: string, visit: TaskVisit, patch: Partial<ColonyTask>): ColonyTask | undefined {
  const task = getTask(id)
  if (!task) return undefined
  return patchTask(id, { ...patch, visits: [...task.visits, visit] })
}

export function removeTask(id: string): void {
  const store = read()
  const tasks = store.tasks.filter((t) => t.id !== id)
  if (tasks.length !== store.tasks.length) write({ ...store, tasks })
}

/** The project's nanny session, if one has been opened. */
export function getNanny(project: string): string | undefined {
  return read().nannies[project]
}

export function setNanny(project: string, sessionId: string): void {
  const store = read()
  write({ ...store, nannies: { ...store.nannies, [project]: sessionId } })
}

/** Drop the cache — for the tests, which repoint dataDir mid-process. */
export function invalidateColonyTasks(): void {
  cached = undefined
}
