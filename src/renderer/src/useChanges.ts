import { useCallback, useEffect, useState } from 'react'
import type { ChangedFile } from '../../shared/types'

export interface Changes {
  files: ChangedFile[]
  loading: boolean
  error?: string
  /**
   * The unified diff for one file, fetched on demand. `context` is git's -U:
   * the prose view asks for the whole file, the code view takes git's default.
   */
  diffOf: (relPath: string, context?: number) => Promise<string>
}

/**
 * What the worktree has changed against its review base.
 *
 * The list is watched, not polled: `review.watch` asks main to follow the
 * worktree and `review.onEvent` fires when it moves. An agent editing files
 * behind the UI is the normal case here, so a list that only refreshed when you
 * clicked would be wrong most of the time.
 */
export function useChanges(worktreePath?: string): Changes {
  const [files, setFiles] = useState<ChangedFile[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()

  const reload = useCallback(() => {
    if (!worktreePath) {
      setFiles([])
      return
    }
    setLoading(true)
    window.floe.review
      .changedFiles(worktreePath)
      .then((list) => {
        setFiles(list)
        setError(undefined)
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false))
  }, [worktreePath])

  useEffect(reload, [reload])

  useEffect(() => {
    if (!worktreePath) return
    void window.floe.review.watch(worktreePath)
    return window.floe.review.onEvent((event) => {
      if (event.worktreePath === worktreePath) reload()
    })
  }, [worktreePath, reload])

  const diffOf = useCallback(
    (relPath: string, context?: number) =>
      worktreePath
        ? window.floe.review.fileDiff(worktreePath, relPath, context)
        : Promise.resolve(''),
    [worktreePath]
  )

  return { files, loading, error, diffOf }
}
