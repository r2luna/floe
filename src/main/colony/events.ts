// The board's own record of what it did without being asked.
//
// A merge that lands on your base branch while you are reading something else
// is only acceptable if it is WRITTEN DOWN and REVERSIBLE. That is the whole
// reason this file exists: the nanny's transcript is a conversation, and a
// conversation is not a record — she summarises, she is asked things out of
// order, and her turn can fail. An event is a fact with a timestamp.
//
// Beside `colony.json` and read the same way: one JSON file through an
// mtime-checked cache, written temp-then-rename. Capped per project, because a
// board that has been running for months is not a board whose first merge
// anybody is scrolling back to.

import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir } from '../dataDir'

/**
 * What the board did. Each is something that happened WITHOUT the user asking,
 * which is exactly the set of things that has to be visible.
 */
export type BoardEventKind =
  /** A card cleared its last stage and reached `done`. */
  | 'passed'
  /** Its branch landed on base. The one that changes code outside the worktree. */
  | 'merged'
  /** It reached `done` and the merge refused — the branch is untouched. */
  | 'refused'
  /** A card queued behind a dependency was let out, because the dependency merged. */
  | 'released'
  /** A lane said `stop`: a decision the board cannot make. */
  | 'stopped'
  /** A lane handed the card back to a stage nobody has. */
  | 'lost'

export interface BoardEvent {
  id: string
  project: string
  at: number
  kind: BoardEventKind
  /** The task id, so a row can act on the card it is about. */
  task: string
  taskName: string
  /** The sentence, already written for a human. The renderer draws, it does not phrase. */
  text: string
  branch?: string
  worktreePath?: string
  /**
   * What `merged` needs to be undoable: the base branch, where it pointed
   * BEFORE the fast-forward, and where it pointed after.
   *
   * Both, not just the old one. Undo has to refuse when base has moved on since
   * — another merge, a commit of your own, a pull — because resetting past
   * somebody else's work is not an undo, it is a second accident.
   */
  base?: string
  baseBefore?: string
  baseAfter?: string
  /** Set when the merge was rolled back, so the row says so instead of offering it twice. */
  undoneAt?: number
}

interface Store {
  events: BoardEvent[]
}

/** Per project. A long-running board should not push another one's history out. */
const KEEP = 200

const storeFile = (): string => join(dataDir(), 'colony-events.json')

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
  if (!existsSync(file)) return { events: [] }
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
    const events = Array.isArray(data?.events) ? (data.events as BoardEvent[]) : []
    return cacheStore(file, { events })
  } catch {
    // Same call the other stores make: a corrupt log is not worth a broken
    // launch. It costs history, and history is the cheapest thing here.
    return { events: [] }
  }
}

function write(store: Store): void {
  const file = storeFile()
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(store, null, 2))
  renameSync(tmp, file)
  cacheStore(file, store)
}

/** Write down something the board did. Returns it, with its id. */
export function recordEvent(event: Omit<BoardEvent, 'id' | 'at'> & { at?: number }): BoardEvent {
  const store = read()
  const at = event.at ?? Date.now()
  const created: BoardEvent = {
    ...event,
    at,
    id: `ev_${at.toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  }
  // Trim this project only, and by age. `events` stays in arrival order across
  // projects, which is what makes the whole file readable when something is
  // wrong with it.
  const mine = store.events.filter((e) => e.project === event.project)
  const drop = new Set(mine.slice(0, Math.max(0, mine.length + 1 - KEEP)).map((e) => e.id))
  write({ events: [...store.events.filter((e) => !drop.has(e.id)), created] })
  return created
}

/** One project's log, oldest first — the order the panel draws it in. */
export function listEvents(project: string, limit = KEEP): BoardEvent[] {
  const mine = read().events.filter((e) => e.project === project)
  return mine.slice(Math.max(0, mine.length - limit))
}

export function getEvent(id: string): BoardEvent | undefined {
  return read().events.find((e) => e.id === id)
}

export function patchEvent(id: string, patch: Partial<BoardEvent>): BoardEvent | undefined {
  const store = read()
  const at = store.events.findIndex((e) => e.id === id)
  if (at === -1) return undefined
  const next = { ...store.events[at], ...patch }
  const events = [...store.events]
  events[at] = next
  write({ events })
  return next
}

/** Drop the cache — for the tests, which repoint dataDir mid-process. */
export function invalidateColonyEvents(): void {
  cached = undefined
}
