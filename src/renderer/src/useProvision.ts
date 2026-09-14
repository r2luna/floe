import { useEffect, useRef, useState } from 'react'
import type { ProvisionAsk, ProvisionEvent, ProvisionStep } from '../../shared/types'

/**
 * A worktree's setup, in flight.
 *
 * Keyed by WORKTREE, not by project like the merge and the removal: two
 * worktrees of the same repo provision at the same time — that is the normal
 * case, not a corner one — and a per-project flow would have the second one
 * overwrite the first's checklist while both were still installing.
 */
export interface ProvisionFlow {
  root: string
  worktreePath: string
  branch: string
  steps: ProvisionStep[]
  running: boolean
  /** How it ended, once it has. Undefined while it runs. */
  ok?: boolean
  /** The last line of output, so a long install says what it is doing. */
  tail?: string
  /**
   * Which step the tail came from.
   *
   * The interview runs beside the recipe, so two rows can be live at once —
   * without this the migrate step's output is drawn under the premise question
   * as well, and the same line appears twice on the checklist. Undefined when
   * the tail belongs to the run rather than a step (no stack, or a run that
   * failed before any step started).
   */
  tailId?: string
  /**
   * The premise question waiting on the user, if one is.
   *
   * Held on the flow rather than beside it because it belongs to this
   * worktree's setup like every other row: switch worktree and the question
   * goes with it, come back and it is still there waiting.
   */
  ask?: ProvisionAsk | null
}

export interface Provision {
  /** The setup for the worktree the app is in, or null. */
  flow: ProvisionFlow | null
  /** Worktrees provisioning right now — the sidebar's "still working" set. */
  runningPaths: string[]
  /** Run the recipe for a worktree. Called on create, and by ⌘K's re-run. */
  start: (
    target: { root: string; worktreePath: string; branch: string },
    opts?: { premiseAnswer?: string }
  ) => void
  /** Re-run from the step that failed, keeping what already succeeded. */
  retry: () => void
  /** Answer the premise question on screen. `null` ends the interview. */
  answer: (requestId: string, text: string | null) => void
  /** Drop the checklist. The steps that ran stay run. */
  dismiss: () => void
}

/**
 * The per-worktree setup: copy `.env`, rewrite it for this branch, install
 * dependencies, link the site, create the database, migrate and seed.
 *
 * All of that lives in main (`provision.ts`) and streams here as events — this
 * hook only collects them into something the panel can draw. Which is the whole
 * point of surfacing it: a worktree that lands without an environment is
 * indistinguishable from a working one until you open the site and read the
 * wrong branch's code.
 */
export function useProvision(deps: {
  /** The worktree the app is in. Which flow the panel shows follows it. */
  here?: string
  /** Bring the setup panel up. Called when a run starts. */
  show: () => void
  /** The worktree's environment changed — reload what reads it. */
  onDone: (worktreePath: string, ok: boolean) => void
}): Provision {
  const { here, show, onDone } = deps

  const [flows, setFlows] = useState<Record<string, ProvisionFlow>>({})
  // `onDone` is called from the event listener, which is mounted once. Held in
  // a ref so the listener never goes stale without being torn down and rebuilt
  // mid-provision — which would drop the events arriving in between.
  const onDoneRef = useRef(onDone)
  onDoneRef.current = onDone

  const flow = here ? (flows[here] ?? null) : null
  const runningPaths = Object.values(flows)
    .filter((f) => f.running)
    .map((f) => f.worktreePath)

  function patch(path: string, fn: (f: ProvisionFlow) => ProvisionFlow): void {
    setFlows((all) => (all[path] ? { ...all, [path]: fn(all[path]) } : all))
  }

  function start(
    target: { root: string; worktreePath: string; branch: string },
    opts?: { from?: string; premiseAnswer?: string }
  ): void {
    setFlows((all) => ({
      ...all,
      [target.worktreePath]: {
        ...target,
        // The plan event replaces these — until it lands the panel shows an
        // empty checklist rather than nothing at all, so a slow detectStack
        // still reads as "starting", not as "did not run".
        steps: all[target.worktreePath]?.steps ?? [],
        running: true,
        ok: undefined,
        tail: undefined,
        tailId: undefined
      }
    }))
    show()
    void window.floe.provision
      .run(target.root, target.worktreePath, target.branch, opts?.from || opts?.premiseAnswer ? opts : undefined)
      .catch((e: Error) => {
        patch(target.worktreePath, (f) => ({
          ...f,
          running: false,
          ok: false,
          tail: e.message,
          tailId: undefined
        }))
      })
  }

  function retry(): void {
    const f = flow
    if (!f) return
    const failed = f.steps.find((s) => s.status === 'failed')
    // Without a failed step there is nothing to resume from, so this re-runs
    // the whole recipe. Every step is idempotent — that is what makes the
    // re-run safe to offer at all.
    start({ root: f.root, worktreePath: f.worktreePath, branch: f.branch }, { from: failed?.id })
  }

  function dismiss(): void {
    if (!here) return
    // Dropping the checklist ends the interview with it: main is holding a
    // question this panel was the only way to answer, and leaving it pending
    // would keep the worktree waiting on a panel that no longer exists. Sent
    // outside the updater, which React is free to run more than once.
    const pending = flow?.ask
    if (pending) void window.floe.provision.answer(pending.requestId, null)
    setFlows((all) => {
      const copy = { ...all }
      delete copy[here]
      return copy
    })
  }

  /**
   * Collect the stream.
   *
   * Mounted once and keyed by the event's own worktree path, so a run started
   * from anywhere — the create flow, ⌘K, or the MCP `create_worktree` tool —
   * lands in the same place without the renderer having to know it happened.
   */
  useEffect(() => {
    return window.floe.provision.onEvent((e: ProvisionEvent) => {
      // Outside the updater: a state updater can be replayed, and reloading the
      // worktree's commands twice per finish is not free.
      if (e.kind === 'done') onDoneRef.current(e.worktreePath, e.ok)
      setFlows((all) => {
        const cur = all[e.worktreePath]
        if (e.kind === 'plan') {
          // No steps means no stack main could recognise. Say so instead of
          // showing an empty checklist: silence here is exactly the failure
          // this panel exists to make visible.
          const base = cur ?? { root: '', worktreePath: e.worktreePath, branch: e.branch }
          return {
            ...all,
            [e.worktreePath]: {
              ...base,
              branch: e.branch,
              steps: e.steps,
              running: e.steps.length > 0,
              ok: e.steps.length ? undefined : true,
              tail: e.steps.length ? undefined : 'No known stack here — nothing to set up',
              tailId: undefined
            }
          }
        }
        if (!cur) return all
        if (e.kind === 'step')
          return {
            ...all,
            [e.worktreePath]: {
              ...cur,
              steps: cur.steps.map((s) =>
                s.id === e.id ? { ...s, status: e.status, detail: e.detail ?? s.detail } : s
              )
            }
          }
        // A question, or its withdrawal (`ask: null`) once the interview is
        // past it. Both are the same event so the panel never has to guess
        // whether the thing it is drawing is still being asked.
        if (e.kind === 'ask') return { ...all, [e.worktreePath]: { ...cur, ask: e.ask } }
        // Output arrives in chunks that are usually a partial line; the last
        // non-empty one is what the step is doing right now.
        if (e.kind === 'log') {
          const line = e.text.split('\n').filter((l) => l.trim()).pop()
          return line ? { ...all, [e.worktreePath]: { ...cur, tail: line, tailId: e.id } } : all
        }
        if (e.kind === 'done') {
          // The tail is a running step's live output, so it goes when the run
          // does — except when there are no steps at all, where it is the only
          // thing the panel has to say (no stack was recognised here).
          return {
            ...all,
            [e.worktreePath]: {
              ...cur,
              running: false,
              ok: e.ok,
              tail: cur.steps.length ? undefined : cur.tail,
              tailId: undefined
            }
          }
        }
        return all
      })
    })
  }, [])

  /**
   * Send the answer and drop the question in the same beat.
   *
   * Optimistic on purpose: main's next event is the following question (or the
   * step going green), and leaving the answered one on screen until it arrives
   * reads as an answer that did not register.
   */
  function answer(requestId: string, text: string | null): void {
    setFlows((all) => {
      const path = Object.keys(all).find((p) => all[p].ask?.requestId === requestId)
      return path ? { ...all, [path]: { ...all[path], ask: null } } : all
    })
    void window.floe.provision.answer(requestId, text)
  }

  return { flow, runningPaths, start: (t, o) => start(t, o), retry, answer, dismiss }
}
