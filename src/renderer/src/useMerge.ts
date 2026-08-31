import { useEffect, useRef, useState } from 'react'
import type { MergeStep, MergeStepId, MergeStepStatus, Worktree } from '../../shared/types'

/**
 * A guided merge in flight.
 *
 * `root` is the project the merge belongs to, so a flow survives switching
 * project and comes back when you return — the git work carries on either way,
 * and a checklist that vanished with a click would leave it unobservable.
 */
export interface MergeFlow {
  root: string
  worktreePath: string
  branch: string
  base: string
  steps: MergeStep[]
  /** A checkpoint waiting on the user. Only the review one exists today. */
  awaiting: 'review' | null
  /** The session resolving conflicts, watched for the end of its turn. */
  sessionId?: string
  done: boolean
  cancelled: boolean
}

/** The steps a merge runs, in order. `closetask` is deliberately not among them. */
const STEP_IDS: MergeStepId[] = [
  'preflight',
  'merge',
  'resolve',
  'review',
  'commit',
  'fastforward',
  'database',
  'cleanup',
  'closebranch'
]

export const MERGE_STEP_TITLES: Record<MergeStepId, string> = {
  preflight: 'Preflight checks',
  merge: 'Merge base into branch',
  resolve: 'Resolve conflicts (agent)',
  review: 'Review & approve',
  commit: 'Commit merge',
  fastforward: 'Fast-forward base',
  database: 'Drop database',
  cleanup: 'Close worktree',
  closebranch: 'Delete branch',
  closetask: 'Mark task done'
}

/** What the resolving session is told. Explicit about NOT committing: the commit
 * is the user's checkpoint, and an agent that commits skips the only review in
 * the whole flow. */
export function resolvePrompt(base: string, branch: string, files: string[]): string {
  const list = files.length
    ? ` in ${files.length} file(s):\n${files.map((f) => `- ${f}`).join('\n')}`
    : '.'
  return `I'm merging \`${base}\` into \`${branch}\` and hit conflicts${list}\n\nResolve the conflicts preserving the intent of both sides and removing all markers (<<<<<<<, =======, >>>>>>>). Then run \`git add\` on the resolved files, but do NOT commit — I'll review and commit. When you're done, briefly summarize what changed.`
}

export interface Merge {
  /** The flow belonging to the open project, or null. */
  flow: MergeFlow | null
  /** Begin a merge. Returns why it refused, or null when it started. */
  start: (wt: Worktree) => string | null
  /** Approve at the review checkpoint: commit the merge and carry on. */
  approve: () => void
  /** Re-run the step that failed. */
  retry: () => void
  /** Stash the blocking worktree and re-run preflight. */
  stashRetry: () => void
  /** Drop the flow. The git work already done stays done. */
  cancel: () => void
}

/**
 * The guided merge: bring base into the branch, hand conflicts to an agent,
 * pause for review, commit, fast-forward base, then tear the worktree down.
 *
 * A state machine rather than one IPC because every step can fail on its own
 * and each failure has a different answer — stash and retry, resolve again,
 * fast-forward by hand. `merge:*` in main exposes the steps; this decides what
 * happens between them, and the panel only draws what it finds here.
 */
export function useMerge(deps: {
  /** The open project. Which flow the panel shows follows it. */
  root?: string
  /** Open a chat on the session that will resolve the conflicts. */
  openResolve: (session: { id: string; worktreePath: string }, prompt: string) => void
  /** Stop the turns running in a worktree — main tears down everything else. */
  stopAgents: (worktreePath: string) => void
  /** The worktree is gone: close what was showing it and reload the list. */
  onWorktreeGone: (worktreePath: string) => void
  /** Bring the merge panel up. Called when a flow starts. */
  show: () => void
}): Merge {
  const { root, openResolve, stopAgents, onWorktreeGone, show } = deps

  // Keyed by project root: two projects can have a merge running at once, and
  // switching between them swaps which checklist is on screen without touching
  // either chain.
  const [flows, setFlows] = useState<Record<string, MergeFlow>>({})
  const flowsRef = useRef(flows)
  flowsRef.current = flows
  // The chain mutates ONE flow — the one it was started for, pinned here so the
  // async steps keep writing to it after the user has switched project.
  const runRoot = useRef<string | null>(null)

  const flow = root ? (flows[root] ?? null) : null

  const running = (): MergeFlow | null => {
    const r = runRoot.current
    return r ? (flowsRef.current[r] ?? null) : null
  }

  function patchFlow(arg: MergeFlow | null | ((f: MergeFlow | null) => MergeFlow | null)): void {
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

  function step(id: MergeStepId, patch: Partial<MergeStep>): void {
    patchFlow((f) => (f ? { ...f, steps: f.steps.map((s) => (s.id === id ? { ...s, ...patch } : s)) } : f))
  }

  function skip(ids: MergeStepId[]): void {
    patchFlow((f) =>
      f ? { ...f, steps: f.steps.map((s) => (ids.includes(s.id) ? { ...s, status: 'skipped' } : s)) } : f
    )
  }

  // --- the chain -----------------------------------------------------------

  async function runPreflight(target: string, worktreePath: string): Promise<void> {
    const pf = await window.floe.merge.preflight(target, worktreePath)
    if (running()?.cancelled) return
    if (!pf.ok || !pf.base || !pf.branch) {
      step('preflight', { status: 'error', detail: pf.message ?? 'Preflight failed' })
      return
    }
    const base = pf.base
    const branch = pf.branch
    // The two steps that name the branches only learn them here — before
    // preflight nobody knows what base is.
    patchFlow((f) =>
      f
        ? {
            ...f,
            base,
            branch,
            steps: f.steps.map((s) =>
              s.id === 'preflight'
                ? { ...s, status: 'done' }
                : s.id === 'merge'
                  ? { ...s, title: `Merge ${base} → ${branch}` }
                  : s.id === 'fastforward'
                    ? { ...s, title: `Fast-forward ${base}` }
                    : s
            )
          }
        : f
    )
    void runMergeBase(worktreePath, base, branch)
  }

  async function runMergeBase(worktreePath: string, base: string, branch: string): Promise<void> {
    step('merge', { status: 'running' })
    const res = await window.floe.merge.base(worktreePath, base)
    if (running()?.cancelled) return
    if (res.status === 'error') {
      step('merge', { status: 'error', detail: res.message })
      return
    }
    if (res.status === 'uptodate') {
      step('merge', { status: 'done', detail: 'Already up to date' })
      skip(['resolve', 'review', 'commit'])
      void runFastForward()
      return
    }
    if (res.status === 'clean') {
      step('merge', { status: 'done', detail: 'No conflicts' })
      // Nothing to resolve and nothing to review: git already made the commit.
      skip(['resolve', 'review'])
      step('commit', {
        status: 'done',
        detail: `${res.commit ?? ''} ${res.subject ?? ''}`.trim() || 'Committed'
      })
      void runFastForward()
      return
    }
    step('merge', { status: 'done', detail: `${res.conflicts?.length ?? 0} conflict(s)` })
    startResolve(worktreePath, base, branch, res.conflicts ?? [])
  }

  /**
   * Hand the conflicts to an agent, in a session of its own.
   *
   * Always a fresh session: reusing whatever chat the worktree had open drags
   * that conversation's context into the conflict analysis, and the answer to
   * "which side wins here" is not improved by an hour of unrelated work.
   */
  function startResolve(worktreePath: string, base: string, branch: string, conflicts: string[]): void {
    const id = crypto.randomUUID()
    void window.floe.claude
      .createSession({ id, worktreePath, title: `Merge ${branch}` })
      .then(() => {
        patchFlow((f) => (f ? { ...f, sessionId: id } : f))
        step('resolve', { status: 'running', detail: 'Resolving conflicts…' })
        openResolve({ id, worktreePath }, resolvePrompt(base, branch, conflicts))
      })
      .catch((e: Error) => step('resolve', { status: 'error', detail: e.message }))
  }

  async function onResolved(): Promise<void> {
    const f = running()
    if (!f || f.cancelled) return
    const check = await window.floe.merge.resolveCheck(f.worktreePath)
    if (running()?.cancelled) return
    if (!check.resolved) {
      step('resolve', {
        status: 'error',
        detail: `Still ${check.conflicts.length} file(s) with conflicts`
      })
      return
    }
    step('resolve', { status: 'done', detail: 'Conflicts resolved' })
    // The one human checkpoint in the flow: what an agent decided about a
    // conflict is exactly the kind of change nobody should commit unread.
    patchFlow((fl) =>
      fl
        ? {
            ...fl,
            awaiting: 'review',
            steps: fl.steps.map((s) =>
              s.id === 'review'
                ? { ...s, status: 'blocked', detail: 'Review and approve to commit' }
                : s
            )
          }
        : fl
    )
  }

  async function runCommit(): Promise<void> {
    const f = running()
    if (!f) return
    step('commit', { status: 'running' })
    const res = await window.floe.merge.commit(f.worktreePath)
    if (running()?.cancelled) return
    if (!res.ok) {
      step('commit', { status: 'error', detail: res.message })
      return
    }
    step('commit', {
      status: 'done',
      detail: `${res.commit ?? ''} ${res.subject ?? ''}`.trim() || 'Committed'
    })
    void runFastForward()
  }

  async function runFastForward(): Promise<void> {
    const f = running()
    if (!f) return
    step('fastforward', { status: 'running' })
    const res = await window.floe.merge.ff(f.root, f.base, f.branch)
    if (running()?.cancelled) return
    if (!res.ok) {
      step('fastforward', { status: 'error', detail: res.message })
      return
    }
    step('fastforward', {
      status: 'done',
      detail: res.baseCommit ? `${f.base} → ${res.baseCommit}` : 'Fast-forwarded'
    })
    await runDropDatabase()
  }

  /**
   * Drop the branch's own database before the worktree goes.
   *
   * Order matters: the credentials live in the worktree's `.env`, which the
   * cleanup step deletes. A no-op (no database configured) counts as done.
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
    await runCleanup()
  }

  async function runCleanup(): Promise<void> {
    const f = running()
    if (!f) return
    step('cleanup', { status: 'running' })
    // Main stops the dev server, the commands and the terminals; the turns in
    // flight are the renderer's to stop.
    stopAgents(f.worktreePath)
    let ok = true
    try {
      await window.floe.worktrees.teardown(f.root, f.worktreePath)
    } catch (e) {
      ok = false
      step('cleanup', { status: 'error', detail: e instanceof Error ? e.message : String(e) })
    }
    if (!ok) return
    onWorktreeGone(f.worktreePath)
    step('cleanup', { status: 'done', detail: 'Worktree closed' })
    await runCloseBranch()
  }

  // The branch is fully in base after the fast-forward, so a safe `-d` is
  // enough — a `-D` here would hide the case where it somehow is not.
  async function runCloseBranch(): Promise<void> {
    const f = running()
    if (!f) return
    step('closebranch', { status: 'running' })
    const res = await window.floe.remove.branch(f.root, f.branch, false)
    if (!res.ok) {
      step('closebranch', { status: 'error', detail: res.message })
      return
    }
    step('closebranch', { status: 'done', detail: `Deleted ${f.branch}` })
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
    if (wt.isMain) return `"${wt.branch}" is the main worktree — there is nothing to merge it into`
    if (wt.blocked) return `merge is blocked for "${wt.branch}" (.gw-nomerge)`
    if (flowsRef.current[root] && !flowsRef.current[root].done) {
      // Already running: show it rather than starting a second chain over the
      // same repository.
      show()
      return null
    }
    runRoot.current = root
    const steps: MergeStep[] = STEP_IDS.map((id) => ({
      id,
      title: MERGE_STEP_TITLES[id],
      status: 'pending' as MergeStepStatus
    }))
    steps[0].status = 'running'
    patchFlow({
      root,
      worktreePath: wt.path,
      branch: wt.branch,
      base: '',
      steps,
      awaiting: null,
      done: false,
      cancelled: false
    })
    show()
    void runPreflight(root, wt.path)
    return null
  }

  function approve(): void {
    if (!root) return
    runRoot.current = root
    patchFlow((f) =>
      f
        ? {
            ...f,
            awaiting: null,
            steps: f.steps.map((s) => (s.id === 'review' ? { ...s, status: 'done' } : s))
          }
        : f
    )
    void runCommit()
  }

  async function stashRetry(): Promise<void> {
    if (!root) return
    runRoot.current = root
    const f = running()
    if (!f) return
    const errored = f.steps.find((s) => s.status === 'error')
    if (!errored) return
    // Which tree is dirty is in the message preflight refused with — the branch,
    // or the main worktree it is going into.
    const path = /main worktree/i.test(errored.detail ?? '') ? f.root : f.worktreePath
    step('preflight', { status: 'running', detail: 'Stashing…' })
    const res = await window.floe.merge.stash(path)
    if (running()?.cancelled) return
    if (!res.ok) {
      step('preflight', { status: 'error', detail: res.message ?? 'Stash failed' })
      return
    }
    void runPreflight(f.root, f.worktreePath)
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
    else if (errored.id === 'merge') void runMergeBase(f.worktreePath, f.base, f.branch)
    else if (errored.id === 'resolve') {
      // Ask again in the same session — it already has the conflict in context.
      if (f.sessionId) openResolve({ id: f.sessionId, worktreePath: f.worktreePath }, resolvePrompt(f.base, f.branch, []))
    } else if (errored.id === 'commit') void runCommit()
    else if (errored.id === 'fastforward') void runFastForward()
    else if (errored.id === 'database') void runDropDatabase()
    else if (errored.id === 'cleanup') void runCleanup()
    else if (errored.id === 'closebranch') void runCloseBranch()
  }

  function cancel(): void {
    if (!root) return
    runRoot.current = root
    // Marked cancelled first so a step already in flight drops its result
    // instead of writing into a flow the user has dismissed.
    patchFlow((f) => (f ? { ...f, cancelled: true } : f))
    patchFlow(null)
  }

  /**
   * Resume when the resolving turn ends.
   *
   * Keyed by the session, not by the open project: the merge carries on while
   * you are somewhere else, and the flow it belongs to is whichever one started
   * that session.
   */
  useEffect(() => {
    return window.floe.agent.onEvent(({ key, event }) => {
      const hit = Object.entries(flowsRef.current).find(([, f]) => f.sessionId === key)
      if (!hit) return
      const [target, f] = hit
      if (f.steps.find((s) => s.id === 'resolve')?.status !== 'running') return
      runRoot.current = target
      if (event.kind === 'done') void onResolved()
      else if (event.kind === 'error') step('resolve', { status: 'error', detail: 'The turn failed' })
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return { flow, start, approve, retry, stashRetry: () => void stashRetry(), cancel }
}
