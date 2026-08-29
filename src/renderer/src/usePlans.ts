import { useEffect, useState } from 'react'
import type { PlanFile } from '../../shared/types'

/**
 * The plan documents for a worktree: the gitignored `.floe/plans/*.md` Claude
 * writes in plan mode, plus the `specs/<folder>/` docs of a spec-driven
 * pipeline whose folder matches `branch`. The main process does both the
 * gathering and the branch→folder match — see src/main/plans.ts.
 *
 * A hook rather than state in App because nothing above the panel needs the
 * list: the plans panel is the only reader, the same way the account and
 * settings panels own theirs.
 */
export function usePlans(root?: string, branch?: string): {
  plans: PlanFile[]
  loading: boolean
  error?: string
} {
  const [plans, setPlans] = useState<PlanFile[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  // Bumped by anything that means "the directory changed": the fs watcher, and
  // regaining focus after the user was away in their editor.
  const [reload, setReload] = useState(0)

  // Watch the worktree's plans dir in the main process, so a plan written while
  // the panel is open shows up without a keypress. One watcher, retargeted as
  // the worktree changes.
  useEffect(() => {
    if (!root) return
    void window.floe.plans.watch(root)
    return window.floe.plans.onEvent((e) => {
      if (e.worktreePath === root) setReload((n) => n + 1)
    })
  }, [root])

  // Plans are also written by things Floe never sees — a `claude` run in a real
  // terminal, an editor. Coming back to the window is the cheap moment to look.
  useEffect(() => {
    const onFocus = (): void => setReload((n) => n + 1)
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])

  useEffect(() => {
    if (!root) {
      setPlans([])
      return
    }
    let live = true
    setLoading(true)
    setError(undefined)
    window.floe.plans
      .list(root, branch)
      .then((p) => live && setPlans(p))
      .catch((e: Error) => live && setError(e.message))
      .finally(() => live && setLoading(false))
    // Guard the late reply the way the file reader does: switching worktree
    // quickly must not land one worktree's plans in a panel showing another's.
    return () => {
      live = false
    }
  }, [root, branch, reload])

  return { plans, loading, error }
}
