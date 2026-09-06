import { useCallback, useEffect, useState } from 'react'
import type { Board } from '../../shared/colony'

/**
 * One project's board.
 *
 * A hook rather than state in App for the same reason `usePlans` is one: the
 * colony panel is the only reader, and a board in App would repaint the whole
 * lane every time a lane wrote a line.
 *
 * The board arrives as ONE shape from main — columns, their caps, and every task
 * already sorted into a band. Assembling it here would mean the renderer knew
 * the cap rules too, and the moment the two copies disagreed a column would
 * count a card it was not showing.
 */
export function useColony(project?: string): {
  board: Board | null
  loading: boolean
  error?: string
  reload: () => void
} {
  const [board, setBoard] = useState<Board | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const [n, setN] = useState(0)
  const reload = useCallback(() => setN((x) => x + 1), [])

  // Main pushes on every move a lane makes, so the board repaints without a
  // keypress — which is the whole point of watching a board.
  useEffect(() => {
    if (!project) return
    return window.floe.colony.onEvent((e) => {
      if (e.project === project) reload()
    })
  }, [project, reload])

  useEffect(() => {
    if (!project) {
      setBoard(null)
      return
    }
    let live = true
    setLoading(true)
    window.floe.colony
      .board(project)
      .then((b) => live && setBoard(b))
      .catch((e: Error) => live && setError(e.message))
      .finally(() => live && setLoading(false))
    return () => {
      live = false
    }
  }, [project, n])

  // A poll on top of the push, because one band is DERIVED rather than moved:
  // `needs you` is a running session that has stopped on a question, and nothing
  // in the colony fires when that happens — the agent does. The card's elapsed
  // clock is the panel's own, not this.
  useEffect(() => {
    if (!project) return
    const timer = setInterval(reload, 2000)
    return () => clearInterval(timer)
  }, [project, reload])

  return { board, loading, error, reload }
}
