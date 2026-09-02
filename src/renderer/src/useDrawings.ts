import { useEffect, useState } from 'react'
import type { DrawFile } from '../../shared/types'

/**
 * The Excalidraw scenes a worktree holds: the branch's `specs/<folder>/` ones,
 * then the gitignored `.floe/draw/*.excalidraw`. Same two sources — and the same
 * branch→folder match — as the plans list, decided in main (src/main/draw).
 *
 * A hook rather than state in App, for the reason usePlans is one: nothing above
 * the panel reads the list.
 */
export function useDrawings(
  root?: string,
  branch?: string
): { drawings: DrawFile[]; loading: boolean; error?: string; reload: () => void } {
  const [drawings, setDrawings] = useState<DrawFile[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  // Bumped by anything that means "the directory changed": the fs watcher,
  // regaining focus, and a create/rename/delete this panel just did.
  const [reload, setReload] = useState(0)

  // The same watcher the drawing panel listens to — a scene an agent wrote (or
  // created) shows up without a keypress.
  useEffect(() => {
    if (!root) return
    void window.floe.draw.watch(root)
    return window.floe.draw.onEvent((e) => {
      if (e.worktreePath === root) setReload((n) => n + 1)
    })
  }, [root])

  // Drawings are also written by things Floe never sees — a `claude` in a real
  // terminal, an editor. Coming back to the window is the cheap moment to look.
  useEffect(() => {
    const onFocus = (): void => setReload((n) => n + 1)
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])

  useEffect(() => {
    if (!root) {
      setDrawings([])
      return
    }
    let live = true
    setLoading(true)
    setError(undefined)
    window.floe.draw
      .list(root, branch)
      .then((d) => live && setDrawings(d))
      .catch((e: Error) => live && setError(e.message))
      .finally(() => live && setLoading(false))
    // Guard the late reply the way the plans list does: switching worktree
    // quickly must not land one worktree's drawings in a panel showing another's.
    return () => {
      live = false
    }
  }, [root, branch, reload])

  return { drawings, loading, error, reload: () => setReload((n) => n + 1) }
}
