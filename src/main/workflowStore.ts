import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir } from './dataDir'

// Floe-side persistence for the Pipeline so a run survives an app restart.
// We store only the *serializable* slice of the runner's state, keyed by the
// worktree the pipeline runs in (one pipeline per worktree at a time). The step
// list itself is hardcoded in the renderer and reconstructed on load from the
// persisted `kind`, so the steps are deliberately absent here — only progress
// (and which pipeline it was) is persisted.
export interface PersistedWorkflow {
  sessionId: string
  input: string
  index: number
  phase: 'dispatched' | 'active'
  statuses: string[]
  status: 'running' | 'waiting' | 'done' | 'failed' | 'cancelled'
  // Which pipeline this run is (feature vs bugfix); absent = 'implement' (a run
  // persisted before bugfix existed). The renderer rebuilds the step list from it.
  kind?: 'implement' | 'bugfix'
  // Per-step wall-clock (epoch ms), so a run's total time survives a restart.
  timings?: { startedAt?: number; endedAt?: number }[]
}

type Store = Record<string, PersistedWorkflow>

const storeFile = (): string => join(dataDir(), 'workflows.json')

function read(): Store {
  const file = storeFile()
  if (!existsSync(file)) return {}
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'))
    if (!data || typeof data !== 'object') return {}
    return data as Store
  } catch {
    return {}
  }
}

function write(store: Store): void {
  writeFileSync(storeFile(), JSON.stringify(store, null, 2))
}

export function saveWorkflow(worktreePath: string, wf: PersistedWorkflow): void {
  if (!worktreePath) return
  const store = read()
  store[worktreePath] = wf
  write(store)
}

export function loadWorkflow(worktreePath: string): PersistedWorkflow | null {
  if (!worktreePath) return null
  return read()[worktreePath] ?? null
}

export function clearWorkflow(worktreePath: string): void {
  if (!worktreePath) return
  const store = read()
  if (!(worktreePath in store)) return
  delete store[worktreePath]
  write(store)
}
