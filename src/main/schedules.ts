import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { addCreatedSession } from './sessionStore'
import { hasActiveTurn, sendToAgent } from './agent'
import { listProjects } from './projects'

// Cron-triggered headless Claude runs. Config lives with the project's root
// worktree (gitignored, same convention as .rookery/plans — see plans.ts) rather
// than app userData, so it's per-project and inspectable as a normal file.
const SCHEDULE_FILE = '.rookery/schedule.json'

export interface ScheduleEntry {
  id: string
  name: string
  cron: string // standard 5-field cron: minute hour dom month dow
  prompt: string // first message sent to the headless session
  model?: string
  enabled: boolean
  createdAt: string
  lastRunAt?: string // ISO, floored to the minute — dedupes fires within the same minute
  lastSessionId?: string // the CreatedSession from the most recent fire; also the overlap guard
}

export type ScheduleInput = {
  name: string
  cron: string
  prompt: string
  model?: string
  enabled?: boolean
}

export type SchedulePatch = Partial<ScheduleInput>

function storeFile(projectPath: string): string {
  return join(projectPath, SCHEDULE_FILE)
}

export function readSchedules(projectPath: string): ScheduleEntry[] {
  const file = storeFile(projectPath)
  if (!existsSync(file)) return []
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'))
    return Array.isArray(data) ? data : []
  } catch {
    return []
  }
}

export function writeSchedules(projectPath: string, entries: ScheduleEntry[]): void {
  mkdirSync(join(projectPath, '.rookery'), { recursive: true })
  writeFileSync(storeFile(projectPath), JSON.stringify(entries, null, 2))
}

let seq = 0
function newId(): string {
  seq += 1
  return `sch_${Date.now().toString(36)}_${seq}`
}

// --- cron matching ---------------------------------------------------------
// One field of a 5-field cron expression: `*`, `*/n`, `a`, `a-b`, `a-b/n`, or a
// comma-separated list of any of those.
interface FieldRange {
  lo: number
  hi: number
  step: number
}

function parseField(field: string, min: number, max: number): FieldRange[] {
  return field.split(',').map((part) => {
    const [range, stepStr] = part.split('/')
    const step = stepStr === undefined ? 1 : Number(stepStr)
    if (!Number.isInteger(step) || step <= 0) throw new Error(`invalid step in cron field "${field}"`)
    let lo = min
    let hi = max
    if (range !== '*') {
      const m = /^(\d+)(?:-(\d+))?$/.exec(range)
      if (!m) throw new Error(`invalid cron field "${field}"`)
      lo = Number(m[1])
      hi = m[2] !== undefined ? Number(m[2]) : lo
      if (lo < min || hi > max || lo > hi) throw new Error(`cron field "${field}" out of range ${min}-${max}`)
    }
    return { lo, hi, step }
  })
}

const CRON_FIELD_RANGES: Array<[number, number]> = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 6]
]

export function assertValidCron(expr: string): void {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) throw new Error(`cron expression must have 5 fields, got "${expr}"`)
  parts.forEach((part, i) => parseField(part, ...CRON_FIELD_RANGES[i]))
}

export function matchesCron(expr: string, date: Date): boolean {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return false
  const values = [date.getMinutes(), date.getHours(), date.getDate(), date.getMonth() + 1, date.getDay()]
  return parts.every((part, i) => {
    const ranges = parseField(part, ...CRON_FIELD_RANGES[i])
    const value = values[i]
    return ranges.some(({ lo, hi, step }) => value >= lo && value <= hi && (value - lo) % step === 0)
  })
}

// --- CRUD --------------------------------------------------------------------

export function createSchedule(projectPath: string, input: ScheduleInput): ScheduleEntry {
  assertValidCron(input.cron)
  const entries = readSchedules(projectPath)
  const entry: ScheduleEntry = {
    id: newId(),
    name: input.name,
    cron: input.cron,
    prompt: input.prompt,
    model: input.model,
    enabled: input.enabled ?? true,
    createdAt: new Date().toISOString()
  }
  entries.push(entry)
  writeSchedules(projectPath, entries)
  return entry
}

export function updateSchedule(projectPath: string, id: string, patch: SchedulePatch): ScheduleEntry {
  if (patch.cron) assertValidCron(patch.cron)
  const entries = readSchedules(projectPath)
  const entry = entries.find((e) => e.id === id)
  if (!entry) throw new Error(`no schedule with id "${id}"`)
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) (entry as unknown as Record<string, unknown>)[key] = value
  }
  writeSchedules(projectPath, entries)
  return entry
}

export function deleteSchedule(projectPath: string, id: string): void {
  const entries = readSchedules(projectPath)
  writeSchedules(
    projectPath,
    entries.filter((e) => e.id !== id)
  )
}

// --- scheduler tick ------------------------------------------------------------

let getWindow: (() => BrowserWindow | undefined) | undefined

export function initScheduler(getter: () => BrowserWindow | undefined): void {
  getWindow = getter
}

function minuteBucket(date: Date): string {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours(), date.getMinutes()).toISOString()
}

// The cron tick: fires any due, enabled schedule across every project as a
// fresh headless session in that project's root worktree. Called from the
// `/api/schedule/run` HTTP route (server mode), itself triggered by system cron.
export async function runDueSchedules(): Promise<{ ran: number }> {
  const win = getWindow?.()
  const now = new Date()
  const bucket = minuteBucket(now)
  let ran = 0
  for (const project of listProjects()) {
    const entries = readSchedules(project.path)
    let changed = false
    for (const entry of entries) {
      if (!entry.enabled || entry.lastRunAt === bucket) continue
      let due = false
      try {
        due = matchesCron(entry.cron, now)
      } catch {
        continue // invalid cron shouldn't crash the whole tick
      }
      if (!due) continue
      if (entry.lastSessionId && hasActiveTurn(entry.lastSessionId)) continue // previous run still going
      const id = randomUUID()
      addCreatedSession({ id, worktreePath: project.path, title: entry.name })
      if (win) sendToAgent(win, id, project.path, entry.prompt, { permissionMode: 'skip', model: entry.model })
      entry.lastRunAt = bucket
      entry.lastSessionId = id
      changed = true
      ran += 1
    }
    if (changed) writeSchedules(project.path, entries)
  }
  return { ran }
}
