import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir } from './dataDir'

// Append-only JSONL diagnostics log, for tracing session-turn lifecycle so a
// stuck "Thinking…" (a turn that never emitted `done`) can be diagnosed after
// the fact. Lives at <dataDir>/logs/agent.log — `tail -f` it, or read it later.
// ponytail: naive size cap — rotate to .1 (overwriting the last rotation) past
// 5 MB; swap for real rotation only if these logs ever grow fast (they don't —
// lifecycle events are rare, not per-token).
const MAX_BYTES = 5_000_000
let cached: string | null = null

export function agentLogPath(): string {
  if (cached) return cached
  const dir = join(dataDir(), 'logs')
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    /* best-effort */
  }
  cached = join(dir, 'agent.log')
  return cached
}

export function log(event: string, data: Record<string, unknown> = {}): void {
  const p = agentLogPath()
  try {
    appendFileSync(p, JSON.stringify({ t: new Date().toISOString(), event, ...data }) + '\n')
    if (statSync(p).size > MAX_BYTES) renameSync(p, p + '.1')
  } catch {
    /* logging must never take down a turn */
  }
}
