import { useRef, useState } from 'react'
import type { RemoveStep, RemoveStepId, RemoveStepStatus, Worktree } from '../../shared/types'

/**
 * A guided removal in flight.
 *
 * Keyed by project like a merge flow, and for the same reason: the git work
 * carries on while you are somewhere else, and a checklist that vanished when
 * you switched project would leave it unobservable.
 */
export interface RemoveFlow {
  root: string
  worktreePath: string
  branch: string
  /** A real branch exists (not a detached HEAD), so there is one to delete. */
  hasBranch: boolean
  /** Already merged into base → a safe `-d`; otherwise deletion has to force. */
  merged: boolean
  /** Porcelain lines from preflight, shown under the step while they matter. */
  changes: string[]
  steps: RemoveStep[]
  /** The one checkpoint: a dirty tree needs a yes before anything is thrown away. */
  awaiting: 'force' | null
  done: boolean
  cancelled: boolean
}

const STEP_IDS: RemoveStepId[] = ['preflight', 'database', 'site', 'worktree', 'branch']

export const REMOVE_STEP_TITLES: Record<RemoveStepId, string> = {
  preflight: 'Inspect worktree',
  database: 'Drop database',
  site: 'Unlink Herd site',
  worktree: 'Remove worktree',
  branch: 'Delete branch'
}

export interface Remove {
  /** The flow belonging to the open project, or null. */
  flow: RemoveFlow | null
  /** Begin a removal. Returns why it refused, or null when it started. */
  start: (wt: Worktree) => string | null
  /** Answer the force checkpoint with yes: remove the dirty tree anyway. */
  force: () => void
  /** Re-run the step that failed. */
  retry: () => void
  /** Drop the flow. What has already been removed stays removed. */
  cancel: () => void
}

/**
 * The guided removal: inspect the tree, drop its database, remove the worktree,
 * delete its branch.
 *
 * A state machine for the same reason the merge is one — each step fails on its
 * own and the answer differs per step — and it stops in exactly one place: a
 * tree with uncommitted work. Everything this flow does is unrecoverable, so
 * that stop is the whole point of having a panel rather than one IPC.
 */
export function useRemove(deps: {
  /** The open project. Which flow the panel shows follows it. */
  root?: string
  /** Stop the turns running in a worktree — main tears down everything else. */
  stopAgents: (worktreePath: string) => void
  /** The worktree is gone: close what was showing it and reload the list. */
  onWorktreeGone: (worktreePath: string) => void
  /** Bring the remove panel up. Called when a flow starts. */
  show: () => void
}): Remove {
  const { root, stopAgents, onWorktreeGone, show } = deps

  const [flows, setFlows] = useState<Record<string, RemoveFlow>>({})
  const flowsRef = useRef(flows)
  flowsRef.current = flows
  // The chain mutates ONE flow — the one it was started for, pinned here so the
  // async steps keep writing to it after the user has switched project.
  const runRoot = useRef<string | null>(null)

  const flow = root ? (flows[root] ?? null) : null

  const running = (): RemoveFlow | null => {
    const r = runRoot.current
    return r ? (flowsRef.current[r] ?? null) : null
  }

  function patchFlow(arg: RemoveFlow | null | ((f: RemoveFlow | null) => RemoveFlow | null)): void {
    const target = runRoot.current
    if (!target) return
    setFlows((all) => {
      const cur = all[target] ?? null
      const next = typeof arg === 'function' ? arg(cur) : arg
      const copy = { ...all }
      if (next) copy[target] = next
      else delete copy[target]
      return copy
    })
  }

  function step(id: RemoveStepId, patch: Partial<RemoveStep>): void {
    patchFlow((f) => (f ? { ...f, steps: f.steps.map((s) => (s.id === id ? { ...s, ...patch } : s)) } : f))
  }

  // --- the chain -----------------------------------------------------------

  async function runPreflight(target: string, worktreePath: string): Promise<void> {
    const pf = await window.floe.remove.preflight(target, worktreePath)
    if (running()?.cancelled) return
    if (!pf.ok) {
      step('preflight', { status: 'error', detail: pf.message ?? 'Inspection failed' })
      return
    }
    // The branch step only learns its name here — a detached worktree has none,
    // and preflight is where that is decided.
    patchFlow((f) =>
      f
        ? {
            ...f,
            branch: pf.branch ?? f.branch,
            hasBranch: pf.hasBranch,
            merged: pf.merged,
            changes: pf.changes,
            steps: f.steps.map((s) =>
              s.id === 'preflight'
                ? {
                    ...s,
                    status: 'done',
                    detail: pf.dirty ? `${pf.changes.length} uncommitted change(s)` : 'Clean'
                  }
                : s.id === 'branch' && pf.hasBranch
                  ? { ...s, title: `Delete branch ${pf.branch}` }
                  : s
            )
          }
        : f
    )
    if (!pf.dirty) {
      void runDropDatabase()
      return
    }
    // The one human checkpoint, and it comes BEFORE any of the destructive
    // steps — not after the database is already dropped. Cancelling here has to
    // leave a worktree that still works, or "no" would be the answer that
    // breaks it.
    patchFlow((fl) =>
      fl
        ? {
            ...fl,
            awaiting: 'force',
            steps: fl.steps.map((s) =>
              s.id === 'database'
                ? { ...s, status: 'blocked', detail: 'Uncommitted changes — confirm to force' }
                : s
            )
          }
        : fl
    )
  }

  /**
   * Drop the branch's own database.
   *
   * Order matters: the credentials live in the worktree's `.env`, which removal
   * deletes, so this has to happen while the directory is still there.
   */
  async function runDropDatabase(): Promise<void> {
    const f = running()
    if (!f) return
    step('database', { status: 'running', detail: undefined })
    let res: { ok: boolean; dropped: boolean; detail?: string; message?: string }
    try {
      res = await window.floe.remove.dropDatabase(f.root, f.worktreePath)
    } catch (e) {
      step('database', { status: 'error', detail: e instanceof Error ? e.message : String(e) })
      return
    }
    if (!res.ok) {
      step('database', { status: 'error', detail: res.message })
      return
    }
    step('database', res.dropped ? { status: 'done', detail: res.detail } : { status: 'skipped', detail: res.detail })
    if (running()?.cancelled) return
    await runUnlinkSite()
  }

  /**
   * Undo the Herd site the provisioning linked.
   *
   * Also before the removal, and for the same reason as the database: `herd
   * unlink` reads the site from the directory it runs in. A link left behind
   * keeps serving a path that is about to stop existing.
   */
  async function runUnlinkSite(): Promise<void> {
    const f = running()
    if (!f) return
    step('site', { status: 'running', detail: undefined })
    let res: { ok: boolean; unlinked: boolean; detail?: string; message?: string }
    try {
      res = await window.floe.remove.unlinkSite(f.worktreePath)
    } catch (e) {
      step('site', { status: 'error', detail: e instanceof Error ? e.message : String(e) })
      return
    }
    if (!res.ok) {
      step('site', { status: 'error', detail: res.message })
      return
    }
    step('site', res.unlinked ? { status: 'done', detail: res.detail } : { status: 'skipped', detail: res.detail })
    if (running()?.cancelled) return
    void runRemove(f.changes.length > 0)
  }

  async function runRemove(force: boolean): Promise<void> {
    const f = running()
    if (!f) return
    step('worktree', { status: 'running', detail: undefined })
    // Main stops the dev server, the commands and the terminals; the turns in
    // flight are the renderer's to stop.
    stopAgents(f.worktreePath)
    try {
      await window.floe.remove.worktree(f.root, f.worktreePath, force)
    } catch (e) {
      step('worktree', { status: 'error', detail: e instanceof Error ? e.message : String(e) })
      return
    }
    if (running()?.cancelled) return
    onWorktreeGone(f.worktreePath)
    step('worktree', { status: 'done', detail: 'Worktree removed' })
    if (!f.hasBranch) {
      // Detached HEAD: there is no branch, so there is nothing left to do.
      step('branch', { status: 'skipped', detail: 'no branch' })
      finish()
      return
    }
    await runDeleteBranch()
  }

  // An unmerged branch needs `-D`; a merged one is deleted safely with `-d`, so
  // git still gets to refuse if it disagrees about what has landed.
  async function runDeleteBranch(): Promise<void> {
    const f = running()
    if (!f) return
    step('branch', { status: 'running', detail: undefined })
    const res = await window.floe.remove.branch(f.root, f.branch, !f.merged)
    if (running()?.cancelled) return
    if (!res.ok) {
      step('branch', { status: 'error', detail: res.message })
      return
    }
    step('branch', { status: 'done', detail: `Deleted ${f.branch}` })
    finish()
  }

  // Let the all-green checklist linger, then drop it. Pinned to the root it
  // started on: `runRoot` may have moved by the time the timer fires.
  function finish(): void {
    const target = runRoot.current
    patchFlow((f) => (f ? { ...f, done: true } : f))
    setTimeout(() => {
      if (!target) return
      setFlows((all) => {
        if (!all[target]?.done) return all
        const copy = { ...all }
        delete copy[target]
        return copy
      })
    }, 1800)
  }

  // --- entry points --------------------------------------------------------

  function start(wt: Worktree): string | null {
    if (!root) return 'no project open'
    if (wt.isMain) return `"${wt.branch}" is the main worktree — removing it would remove the project`
    if (flowsRef.current[root] && !flowsRef.current[root].done) {
      // Already running: show it rather than starting a second chain over the
      // same repository.
      show()
      return null
    }
    runRoot.current = root
    const steps: RemoveStep[] = STEP_IDS.map((id) => ({
      id,
      title: REMOVE_STEP_TITLES[id],
      status: 'pending' as RemoveStepStatus
    }))
    steps[0].status = 'running'
    patchFlow({
      root,
      worktreePath: wt.path,
      branch: wt.branch,
      hasBranch: false,
      merged: false,
      changes: [],
      steps,
      awaiting: null,
      done: false,
      cancelled: false
    })
    show()
    void runPreflight(root, wt.path)
    return null
  }

  function force(): void {
    if (!root) return
    runRoot.current = root
    if (running()?.awaiting !== 'force') return
    patchFlow((f) => (f ? { ...f, awaiting: null } : f))
    void runDropDatabase()
  }

  function retry(): void {
    if (!root) return
    runRoot.current = root
    const f = running()
    if (!f) return
    const errored = f.steps.find((s) => s.status === 'error')
    if (!errored) return
    step(errored.id, { status: 'running', detail: undefined })
    if (errored.id === 'preflight') void runPreflight(f.root, f.worktreePath)
    else if (errored.id === 'database') void runDropDatabase()
    else if (errored.id === 'site') void runUnlinkSite()
    else if (errored.id === 'worktree') void runRemove(f.changes.length > 0)
    else if (errored.id === 'branch') void runDeleteBranch()
  }

  function cancel(): void {
    if (!root) return
    runRoot.current = root
    // Marked cancelled first so a step already in flight drops its result
    // instead of writing into a flow the user has dismissed.
    patchFlow((f) => (f ? { ...f, cancelled: true } : f))
    patchFlow(null)
  }

  return { flow, start, force, retry, cancel }
}
