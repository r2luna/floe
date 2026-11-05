import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ChecklistItem } from '../shared/checklist'
import { dataDir } from './dataDir'
import { getCreatedSession } from './sessionStore'

// One file per session, and deliberately not a field in sessions.json. That file
// is rewritten whole by every process that shares it, and a build that does not
// know a field drops it: lists kept there were seen vanishing from the shared dev
// store while the sessions they belonged to stayed. A list also changes on every
// step, which is no reason to rewrite every session's record.

const dir = (): string => join(dataDir(), 'checklists')

// Filed under Floe's own id: a session answers to its claudeId too, and the turn
// that wrote the list may have run under either name. Encoded because a key comes
// off an MCP url, and it must not be able to name a path outside this directory.
const fileFor = (key: string): string =>
  join(dir(), `${encodeURIComponent(getCreatedSession(key)?.id ?? key)}.json`)

export function getChecklist(key: string): ChecklistItem[] {
  try {
    const items: unknown = JSON.parse(readFileSync(fileFor(key), 'utf8'))
    return Array.isArray(items) ? (items as ChecklistItem[]) : []
  } catch {
    return []
  }
}

/** An empty list removes the file, so closed and finished sessions leave nothing behind. */
export function saveChecklist(key: string, items: ChecklistItem[]): void {
  const file = fileFor(key)
  if (!items.length) return rmSync(file, { force: true })
  mkdirSync(dir(), { recursive: true })
  // Through a temp file, as sessions.json is: a kill mid-write leaves the old list.
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(items))
  renameSync(tmp, file)
}
