// The colony's two shared shapes: what a lane says when it is finished, and what
// the board looks like once main has assembled it.
//
// Both sides need them — main parses the line and builds the board, the renderer
// draws it — so they live here rather than being copied across the IPC seam.

import type { ColonyTask, TaskStatus } from '../main/colony/store'

export type { ColonyTask, TaskStatus, TaskKind, TaskVisit } from '../main/colony/store'

/**
 * The hand-off line a lane ends its last message with — the single line the
 * board parses to move a card. See specs/colony/skills/LANE-CONTRACT.md.
 *
 *   COLONY: pass
 *   COLONY: return <lane> — <why>
 *   COLONY: stop — <why>
 */
export type Handoff =
  | { verdict: 'pass' }
  | { verdict: 'return'; lane: string; why: string }
  | { verdict: 'stop'; why: string }

/**
 * Read the hand-off out of a lane's final message.
 *
 * The LAST match wins, not the first: a lane that quotes the contract while
 * explaining itself would otherwise hand the board the example instead of its
 * own verdict, and the real line is always the last thing in the message.
 *
 * Null means the turn ended without a line the board can read. The contract is
 * explicit about what that costs — `pass` with a warning on the card — so the
 * caller has to be able to tell "no line" from "pass".
 */
export function parseHandoff(text: string): Handoff | null {
  const lines = text.split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i--) {
    // Tolerant of the wrappers a model reaches for — bullets, bold, backticks —
    // because the verdict is the point and the punctuation around it is not.
    const line = lines[i].trim().replace(/^[-*>\s]+/, '').replace(/[`*_]/g, '').trim()
    const m = /^COLONY:\s*(pass|return|stop)\b(.*)$/i.exec(line)
    if (!m) continue
    const verdict = m[1].toLowerCase()
    // Every dash a model might type between the target and the reason.
    const rest = m[2].trim().replace(/^[—–-]\s*/, '').trim()
    if (verdict === 'pass') return { verdict: 'pass' }
    if (verdict === 'stop') return { verdict: 'stop', why: rest }
    // The lane and the reason are separated by a dash WITH SPACE around it. A
    // bare hyphen is not a separator: `code-review` is one lane name, and
    // splitting on the hyphen inside it hands the board a lane called `code`
    // and then parks the card as "returned to an unknown lane".
    const dash = /\s+[—–-]\s+/.exec(rest)
    // No dash at all is still a return — take the first word as the lane and
    // whatever follows as the reason, rather than losing both to a missing
    // punctuation mark.
    const lane = (dash ? rest.slice(0, dash.index) : (rest.split(/\s+/)[0] ?? '')).trim()
    if (!lane) return null
    const why = dash ? rest.slice(dash.index + dash[0].length) : rest.slice(lane.length)
    return { verdict: 'return', lane, why: why.trim() }
  }
  return null
}

/** One column of the board as the renderer receives it. */
export interface BoardColumn {
  name: string
  /** Empty for `inbox` and `done`, and for a stage config forgot (D13). */
  skill: string
  harness?: string
  model?: string
  /** 0 for a retired stage; absent for the two uncapped ends. */
  cap?: number
  /** Dropped from config while tasks still sit in it — greyed, and draining. */
  retired?: boolean
  /** Ran and stopped on a question for you. Takes a spot. */
  blocked: ColonyTask[]
  /** An agent is on it. Takes a spot. */
  working: ColonyTask[]
  /** Waiting to ENTER this column. Takes none. */
  holding: ColonyTask[]
  /** Reached the end, or a lane said stop. Only `done` and `inbox` ever have any. */
  settled: ColonyTask[]
}

export interface Board {
  project: string
  columns: BoardColumn[]
  /** Config problems, so a board that cannot run says why instead of doing nothing. */
  errors: { file: string; line: number; reason: string }[]
}

/** What takes a spot in a column: working plus blocked. Holding is free (D4). */
export const busyOf = (column: BoardColumn): number => column.working.length + column.blocked.length

export const isFull = (column: BoardColumn): boolean =>
  column.cap !== undefined && busyOf(column) >= column.cap

/** The rows of a column, top to bottom, in the order the board draws them. */
export function rowsOf(column: BoardColumn): { task: ColonyTask; status: TaskStatus }[] {
  return [
    ...column.blocked.map((task) => ({ task, status: 'blocked' as const })),
    ...column.working.map((task) => ({ task, status: 'working' as const })),
    ...column.settled.map((task) => ({ task, status: 'settled' as const })),
    ...column.holding.map((task) => ({ task, status: 'holding' as const }))
  ]
}
