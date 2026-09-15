// The colony's two shared shapes: what a lane says when it is finished, and what
// the board looks like once main has assembled it.
//
// Both sides need them — main parses the line and builds the board, the renderer
// draws it — so they live here rather than being copied across the IPC seam.

import type { ColonyTask, TaskStatus } from '../main/colony/store'

export type { ColonyTask, TaskStatus, TaskKind, TaskVisit } from '../main/colony/store'
// The board's own record of what it did unasked. Same reason as the shapes
// above: main writes it, the nanny panel draws it, so it crosses the IPC seam.
export type { BoardEvent, BoardEventKind } from '../main/colony/events'

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
  /**
   * Whether a card reaching `done` merges itself.
   *
   * On the board and not only in the file, because it is the one setting that
   * decides whether the board changes your base branch unasked — and a policy
   * you cannot see is one you cannot have agreed to.
   */
  automerge: boolean
  /** Whether cards entering the first stage are measured for the step report. */
  report: boolean
  /** Where this project's `colony.toml` is, or would be. Null when untracked. */
  configPath: string | null
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

/** One line of a lane's `FINDINGS:` block. */
export interface Finding {
  severity: 'high' | 'med' | 'low'
  /** `new` — this step is the first to raise it. False is `seen <stage>`. */
  fresh: boolean
  /** The stage that raised it first, when the lane said so. */
  seenIn?: string
  text: string
}

/**
 * Read the `FINDINGS:` block a lane writes when the board's report is on.
 *
 *   FINDINGS:
 *   - [high] new: <one line>
 *   - [med] seen coder: <one line>
 *   COLONY: pass
 *
 * or `FINDINGS: none`. The LAST block wins, for the same reason as the hand-off
 * line: a lane quoting the format while explaining itself would otherwise hand
 * the report the example. `declared` false means no block at all — the report
 * has to tell "found nothing" from "never said", or a lane that ignored the
 * instruction would read as a step with no signal.
 *
 * Tolerant of what a model reaches for: bold, backticks, a missing severity (read
 * as `med`) or a missing new/seen mark (read as new — the lane did not claim it
 * was a repeat, and inventing that claim for it would be worse).
 */
export function parseFindings(text: string): { declared: boolean; findings: Finding[] } {
  const clean = (line: string): string => line.trim().replace(/[`*_]/g, '').trim()
  const lines = text.split(/\r?\n/)
  let start = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^FINDINGS:/i.test(clean(lines[i]).replace(/^[>\s]+/, ''))) {
      start = i
      break
    }
  }
  if (start === -1) return { declared: false, findings: [] }

  const findings: Finding[] = []
  const inline = clean(lines[start]).replace(/^[>\s]*FINDINGS:\s*/i, '')
  const rows = inline && !/^none\b/i.test(inline) ? [inline] : []
  for (let i = start + 1; i < lines.length; i++) {
    const line = clean(lines[i])
    if (!line) {
      if (findings.length || rows.length) break
      continue
    }
    if (!/^[-*•]|^\d+[.)]/.test(lines[i].trim())) break
    rows.push(line.replace(/^([-*•]|\d+[.)])\s*/, ''))
  }
  for (const row of rows) {
    const m = /^(?:\[(high|med|medium|low)\]\s*)?(?:(new|seen)(?:\s+([\w-]+))?\s*[:—–-]\s*)?(.+)$/i.exec(row)
    if (!m || !m[4].trim()) continue
    const sev = (m[1] ?? 'med').toLowerCase()
    const seen = m[2]?.toLowerCase() === 'seen'
    findings.push({
      severity: sev === 'medium' ? 'med' : (sev as Finding['severity']),
      fresh: !seen,
      ...(seen && m[3] ? { seenIn: m[3] } : {}),
      text: m[4].trim()
    })
  }
  return { declared: true, findings }
}
