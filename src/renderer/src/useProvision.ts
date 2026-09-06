import { useEffect, useRef, useState } from 'react'
import type { ProvisionEvent, ProvisionStep } from '../../shared/types'

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
}

export interface Provision {
  /** The setup for the worktree the app is in, or null. */
  flow: ProvisionFlow | null
  /** Worktrees provisioning right now — the sidebar's "still working" set. */
  runningPaths: string[]
  /** Run the recipe for a worktree. Called on create, and by ⌘K's re-run. */
  start: (target: { root: string; worktreePath: string; branch: string }) => void
  /** Re-run from the step that failed, keeping what already succeeded. */
  retry: () => void
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

  function start(target: { root: string; worktreePath: string; branch: string }, from?: string): void {
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
        tail: undefined
      }
    }))
    show()
    void window.floe.provision
      .run(target.root, target.worktreePath, target.branch, from ? { from } : undefined)
      .catch((e: Error) => {
        patch(target.worktreePath, (f) => ({ ...f, running: false, ok: false, tail: e.message }))
      })
  }

  function retry(): void {
    const f = flow
    if (!f) return
    const failed = f.steps.find((s) => s.status === 'failed')
    // Without a failed step there is nothing to resume from, so this re-runs
    // the whole recipe. Every step is idempotent — that is what makes the
    // re-run safe to offer at all.
    start({ root: f.root, worktreePath: f.worktreePath, branch: f.branch }, failed?.id)
  }

  function dismiss(): void {
    if (!here) return
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
              tail: e.steps.length ? undefined : 'No known stack here — nothing to set up'
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
        // Output arrives in chunks that are usually a partial line; the last
        // non-empty one is what the step is doing right now.
        if (e.kind === 'log') {
          const line = e.text.split('\n').filter((l) => l.trim()).pop()
          return line ? { ...all, [e.worktreePath]: { ...cur, tail: line } } : all
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
              tail: cur.steps.length ? undefined : cur.tail
            }
          }
        }
        return all
      })
    })
  }, [])

  return { flow, runningPaths, start: (t) => start(t), retry, dismiss }
}
