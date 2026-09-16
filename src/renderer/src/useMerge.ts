import { useEffect, useRef, useState } from 'react'
import type { MergeStep, MergeStepId, MergeStepStatus, Worktree } from '../../shared/types'

/**
 * A guided merge in flight.
 *
 * Identified by its worktree: merges are independent of each other, so a branch
 * stuck on a failed step never stands between you and merging another one.
 * `root` is the project it belongs to, so a flow survives switching project and
 * comes back when you return — the git work carries on either way, and a
 * checklist that vanished with a click would leave it unobservable.
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
  /** When it started, so the panel can fall back to the newest one. */
  startedAt: number
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

/**
 * Which checklist the panel shows, and what else is running behind it.
 *
 * The tree the app is in wins, like every other worktree command. Otherwise the
 * project's newest flow, so a merge running in the background stays watchable —
 * including the one whose worktree its own cleanup step has just deleted, which
 * would otherwise take the finished checklist off screen with it.
 *
 * Pure, and separate from the hook, because it is the whole of "merges are
 * independent": what is on screen is a question about the branch you are in,
 * never about which merge started first.
 */
export function pickFlow(
  flows: Record<string, MergeFlow>,
  root?: string,
  worktreePath?: string
): { flow: MergeFlow | null; mine: MergeFlow[] } {
  const mine = Object.values(flows)
    .filter((f) => f.root === root)
    .sort((a, b) => b.startedAt - a.startedAt)
  const here = worktreePath ? (flows[worktreePath] ?? null) : null
  return { flow: (here?.root === root ? here : null) ?? mine[0] ?? null, mine }
}

/**
 * Write one flow into the chain's map, in the ref, now.
 *
 * The steps run async and read their flow back through the ref before touching
 * it, so the write has to land before the next line runs — `start` creates the
 * flow and calls preflight in the same tick, and React state is a render away.
 * Returns the new map, which is what the component renders.
 */
export function writeFlow(
  ref: { current: Record<string, MergeFlow> },
  key: string,
  arg: MergeFlow | null | ((f: MergeFlow | null) => MergeFlow | null)
): Record<string, MergeFlow> {
  const all = ref.current
  const cur = all[key] ?? null
  const next = typeof arg === 'function' ? arg(cur) : arg
  const copy = { ...all }
  if (next) copy[key] = next
  else delete copy[key]
  ref.current = copy
  return copy
}

export interface Merge {
  /** The flow on screen: the one for the tree the app is in, else the newest of the open project. */
  flow: MergeFlow | null
  /** Every flow of the open project, newest first — the panel names the ones it is not showing. */
  flows: MergeFlow[]
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
 *
 * Flows are per worktree and run side by side: a merge that stopped on a failed
 * step is that branch's problem, and waiting for it before you can merge another
 * branch would make one bad preflight block the whole project.
 */
export function useMerge(deps: {
  /** The open project. Which flows the panel can show follows it. */
  root?: string
  /** The tree the app is in. Its flow is the one on screen, like every other worktree command. */
  worktreePath?: string
  /** Open a chat on the session that will resolve the conflicts. */
  openResolve: (session: { id: string; worktreePath: string }, prompt: string) => void
  /** Stop the turns running in a worktree — main tears down everything else. */
  stopAgents: (worktreePath: string) => void
  /** The worktree is gone: close what was showing it and reload the list. */
  onWorktreeGone: (worktreePath: string) => void
  /** Bring the merge panel up. Called when a flow starts. */
  show: () => void
}): Merge {
  const { root, worktreePath, openResolve, stopAgents, onWorktreeGone, show } = deps

  // Keyed by worktree path: every merge is its own chain, and the key is also
  // the flow's identity — the steps thread it around instead of writing to
  // whichever one happened to start last.
  // The ref is the chain's copy and it leads the state: `start` writes the new
  // flow and calls the first step in the same tick, so a ref that only caught up
  // on the next render would hand that step a flow that does not exist yet — and
  // every step reads its flow back before doing anything, so the checklist would
  // sit on a spinner forever. setFlows mirrors the ref for rendering.
  const [flows, setFlows] = useState<Record<string, MergeFlow>>({})
  const flowsRef = useRef(flows)

  const { flow, mine } = pickFlow(flows, root, worktreePath)

  const at = (key: string): MergeFlow | null => flowsRef.current[key] ?? null
  /** The flow, unless the user has dropped it — a step in flight then writes nothing. */
  const alive = (key: string): MergeFlow | null => {
    const f = at(key)
    return f && !f.cancelled ? f : null
  }

  function patchFlow(
    key: string,
    arg: MergeFlow | null | ((f: MergeFlow | null) => MergeFlow | null)
  ): void {
    setFlows(writeFlow(flowsRef, key, arg))
  }

  function step(key: string, id: MergeStepId, patch: Partial<MergeStep>): void {
    patchFlow(key, (f) =>
      f ? { ...f, steps: f.steps.map((s) => (s.id === id ? { ...s, ...patch } : s)) } : f
    )
  }

  function skip(key: string, ids: MergeStepId[]): void {
    patchFlow(key, (f) =>
      f ? { ...f, steps: f.steps.map((s) => (ids.includes(s.id) ? { ...s, status: 'skipped' } : s)) } : f
    )
  }

  // --- the chain -----------------------------------------------------------
  //
  // Every step takes the flow's key and reads its state back through `at`: the
  // chain is async and several can be in flight at once, so nothing here may
  // depend on which merge the user is looking at.

  async function runPreflight(key: string): Promise<void> {
    const f = at(key)
    if (!f) return
    const pf = await window.floe.merge.preflight(f.root, key)
    if (!alive(key)) return
    if (!pf.ok || !pf.base || !pf.branch) {
      step(key, 'preflight', { status: 'error', detail: pf.message ?? 'Preflight failed' })
      return
    }
    const base = pf.base
    const branch = pf.branch
    // The two steps that name the branches only learn them here — before
    // preflight nobody knows what base is.
    patchFlow(key, (fl) =>
      fl
        ? {
            ...fl,
            base,
            branch,
            steps: fl.steps.map((s) =>
              s.id === 'preflight'
                ? { ...s, status: 'done' }
                : s.id === 'merge'
                  ? { ...s, title: `Merge ${base} → ${branch}` }
                  : s.id === 'fastforward'
                    ? { ...s, title: `Fast-forward ${base}` }
                    : s
            )
          }
        : fl
    )
    void runMergeBase(key, base, branch)
  }

  async function runMergeBase(key: string, base: string, branch: string): Promise<void> {
    step(key, 'merge', { status: 'running' })
    const res = await window.floe.merge.base(key, base)
    if (!alive(key)) return
    if (res.status === 'error') {
      step(key, 'merge', { status: 'error', detail: res.message })
      return
    }
    if (res.status === 'uptodate') {
      step(key, 'merge', { status: 'done', detail: 'Already up to date' })
      skip(key, ['resolve', 'review', 'commit'])
      void runFastForward(key)
      return
    }
    if (res.status === 'clean') {
      step(key, 'merge', { status: 'done', detail: 'No conflicts' })
      // Nothing to resolve and nothing to review: git already made the commit.
      skip(key, ['resolve', 'review'])
      step(key, 'commit', {
        status: 'done',
        detail: `${res.commit ?? ''} ${res.subject ?? ''}`.trim() || 'Committed'
      })
      void runFastForward(key)
      return
    }
    step(key, 'merge', { status: 'done', detail: `${res.conflicts?.length ?? 0} conflict(s)` })
    startResolve(key, base, branch, res.conflicts ?? [])
  }

  /**
   * Hand the conflicts to an agent, in a session of its own.
   *
   * Always a fresh session: reusing whatever chat the worktree had open drags
   * that conversation's context into the conflict analysis, and the answer to
   * "which side wins here" is not improved by an hour of unrelated work.
   */
  function startResolve(key: string, base: string, branch: string, conflicts: string[]): void {
    const id = crypto.randomUUID()
    void window.floe.claude
      .createSession({ id, worktreePath: key, title: `Merge ${branch}` })
      .then(() => {
        if (!alive(key)) return
        patchFlow(key, (f) => (f ? { ...f, sessionId: id } : f))
        step(key, 'resolve', { status: 'running', detail: 'Resolving conflicts…' })
        openResolve({ id, worktreePath: key }, resolvePrompt(base, branch, conflicts))
      })
      .catch((e: Error) => step(key, 'resolve', { status: 'error', detail: e.message }))
  }

  async function onResolved(key: string): Promise<void> {
    if (!alive(key)) return
    const check = await window.floe.merge.resolveCheck(key)
    if (!alive(key)) return
    if (!check.resolved) {
      step(key, 'resolve', {
        status: 'error',
        detail: `Still ${check.conflicts.length} file(s) with conflicts`
      })
      return
    }
    step(key, 'resolve', { status: 'done', detail: 'Conflicts resolved' })
    // The one human checkpoint in the flow: what an agent decided about a
    // conflict is exactly the kind of change nobody should commit unread.
    patchFlow(key, (fl) =>
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

  async function runCommit(key: string): Promise<void> {
    if (!at(key)) return
    step(key, 'commit', { status: 'running' })
    const res = await window.floe.merge.commit(key)
    if (!alive(key)) return
    if (!res.ok) {
      step(key, 'commit', { status: 'error', detail: res.message })
      return
    }
    step(key, 'commit', {
      status: 'done',
      detail: `${res.commit ?? ''} ${res.subject ?? ''}`.trim() || 'Committed'
    })
    void runFastForward(key)
  }

  async function runFastForward(key: string): Promise<void> {
    const f = at(key)
    if (!f) return
    step(key, 'fastforward', { status: 'running' })
    const res = await window.floe.merge.ff(f.root, f.base, f.branch)
    if (!alive(key)) return
    if (!res.ok) {
      step(key, 'fastforward', { status: 'error', detail: res.message })
      return
    }
    step(key, 'fastforward', {
      status: 'done',
      detail: res.baseCommit ? `${f.base} → ${res.baseCommit}` : 'Fast-forwarded'
    })
    await runDropDatabase(key)
  }

  /**
   * Drop the branch's own database before the worktree goes.
   *
   * Order matters: the credentials live in the worktree's `.env`, which the
   * cleanup step deletes. A no-op (no database configured) counts as done.
   */
  async function runDropDatabase(key: string): Promise<void> {
    const f = at(key)
    if (!f) return
    step(key, 'database', { status: 'running', detail: undefined })
    let res: { ok: boolean; dropped: boolean; detail?: string; message?: string }
    try {
      res = await window.floe.remove.dropDatabase(f.root, key)
    } catch (e) {
      step(key, 'database', { status: 'error', detail: e instanceof Error ? e.message : String(e) })
      return
    }
    if (!res.ok) {
      step(key, 'database', { status: 'error', detail: res.message })
      return
    }
    step(key, 'database', res.dropped ? { status: 'done', detail: res.detail } : { status: 'skipped', detail: res.detail })
    if (!alive(key)) return
    await runCleanup(key)
  }

  async function runCleanup(key: string): Promise<void> {
    const f = at(key)
    if (!f) return
    step(key, 'cleanup', { status: 'running' })
    // Main stops the dev server, the commands and the terminals; the turns in
    // flight are the renderer's to stop.
    stopAgents(key)
    let ok = true
    try {
      await window.floe.worktrees.teardown(f.root, key)
    } catch (e) {
      ok = false
      step(key, 'cleanup', { status: 'error', detail: e instanceof Error ? e.message : String(e) })
    }
    if (!ok) return
    onWorktreeGone(key)
    step(key, 'cleanup', { status: 'done', detail: 'Worktree closed' })
    await runCloseBranch(key)
  }

  // The branch is fully in base after the fast-forward, so a safe delete is
  // enough — a forced one would hide the case where it somehow is not. Safe
  // means merged into THIS flow's base: a base that is another worktree's
  // branch is not the root's HEAD, and measured there the branch looks unmerged.
  async function runCloseBranch(key: string): Promise<void> {
    const f = at(key)
    if (!f) return
    step(key, 'closebranch', { status: 'running' })
    const res = await window.floe.remove.branch(f.root, f.branch, false, f.base)
    if (!res.ok) {
      step(key, 'closebranch', { status: 'error', detail: res.message })
      return
    }
    step(key, 'closebranch', { status: 'done', detail: `Deleted ${f.branch}` })
    finish(key)
  }

  // Let the all-green checklist linger, then drop it.
  function finish(key: string): void {
    patchFlow(key, (f) => (f ? { ...f, done: true } : f))
    setTimeout(() => {
      setFlows((all) => {
        if (!all[key]?.done) return all
        const copy = { ...all }
        delete copy[key]
        return copy
      })
    }, 1800)
  }

  // --- entry points --------------------------------------------------------
  //
  // The four answers act on the flow ON SCREEN, which is the one the panel's
  // chips and keys are labelled for.

  function start(wt: Worktree): string | null {
    if (!root) return 'no project open'
    if (wt.isMain) return `"${wt.branch}" is the main worktree — there is nothing to merge it into`
    if (wt.blocked) return `merge is blocked for "${wt.branch}" (.gw-nomerge)`
    const open = flowsRef.current[wt.path]
    if (open && !open.done) {
      // This branch is already merging: show it rather than starting a second
      // chain over the same worktree. Another branch is free to start its own.
      show()
      return null
    }
    const steps: MergeStep[] = STEP_IDS.map((id) => ({
      id,
      title: MERGE_STEP_TITLES[id],
      status: 'pending' as MergeStepStatus
    }))
    steps[0].status = 'running'
    patchFlow(wt.path, {
      root,
      worktreePath: wt.path,
      branch: wt.branch,
      base: '',
      steps,
      awaiting: null,
      done: false,
      cancelled: false,
      startedAt: Date.now()
    })
    show()
    void runPreflight(wt.path)
    return null
  }

  function approve(): void {
    if (!flow) return
    const key = flow.worktreePath
    patchFlow(key, (f) =>
      f
        ? {
            ...f,
            awaiting: null,
            steps: f.steps.map((s) => (s.id === 'review' ? { ...s, status: 'done' } : s))
          }
        : f
    )
    void runCommit(key)
  }

  async function stashRetry(): Promise<void> {
    if (!flow) return
    const key = flow.worktreePath
    const errored = flow.steps.find((s) => s.status === 'error')
    if (!errored) return
    // Which tree is dirty is in the message preflight refused with — the branch,
    // or the main worktree it is going into.
    const path = /main worktree/i.test(errored.detail ?? '') ? flow.root : key
    step(key, 'preflight', { status: 'running', detail: 'Stashing…' })
    const res = await window.floe.merge.stash(path)
    if (!alive(key)) return
    if (!res.ok) {
      step(key, 'preflight', { status: 'error', detail: res.message ?? 'Stash failed' })
      return
    }
    void runPreflight(key)
  }

  function retry(): void {
    if (!flow) return
    const key = flow.worktreePath
    const errored = flow.steps.find((s) => s.status === 'error')
    if (!errored) return
    step(key, errored.id, { status: 'running', detail: undefined })
    if (errored.id === 'preflight') void runPreflight(key)
    else if (errored.id === 'merge') void runMergeBase(key, flow.base, flow.branch)
    else if (errored.id === 'resolve') {
      // Ask again in the same session — it already has the conflict in context.
      if (flow.sessionId) openResolve({ id: flow.sessionId, worktreePath: key }, resolvePrompt(flow.base, flow.branch, []))
    } else if (errored.id === 'commit') void runCommit(key)
    else if (errored.id === 'fastforward') void runFastForward(key)
    else if (errored.id === 'database') void runDropDatabase(key)
    else if (errored.id === 'cleanup') void runCleanup(key)
    else if (errored.id === 'closebranch') void runCloseBranch(key)
  }

  function cancel(): void {
    if (!flow) return
    const key = flow.worktreePath
    // Marked cancelled first so a step already in flight drops its result
    // instead of writing into a flow the user has dismissed.
    patchFlow(key, (f) => (f ? { ...f, cancelled: true } : f))
    patchFlow(key, null)
  }

  /**
   * Resume when the resolving turn ends.
   *
   * Keyed by the session, not by what is on screen: the merge carries on while
   * you are somewhere else, and the flow it belongs to is whichever one started
   * that session.
   */
  useEffect(() => {
    return window.floe.agent.onEvent(({ key, event }) => {
      const hit = Object.entries(flowsRef.current).find(([, f]) => f.sessionId === key)
      if (!hit) return
      const [target, f] = hit
      if (f.steps.find((s) => s.id === 'resolve')?.status !== 'running') return
      if (event.kind === 'done') void onResolved(target)
      else if (event.kind === 'error') step(target, 'resolve', { status: 'error', detail: 'The turn failed' })
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return { flow, flows: mine, start, approve, retry, stashRetry: () => void stashRetry(), cancel }
}
