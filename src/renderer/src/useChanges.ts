import { useCallback, useEffect, useState } from 'react'
import type { ChangedFile } from '../../shared/types'

export interface Changes {
  files: ChangedFile[]
  loading: boolean
  error?: string
  /** The unified diff for one file, fetched on demand. */
  diffOf: (relPath: string) => Promise<string>
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
    window.rookery.review
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
    void window.rookery.review.watch(worktreePath)
    return window.rookery.review.onEvent((event) => {
      if (event.worktreePath === worktreePath) reload()
    })
  }, [worktreePath, reload])

  const diffOf = useCallback(
    (relPath: string) =>
      worktreePath ? window.rookery.review.fileDiff(worktreePath, relPath) : Promise.resolve(''),
    [worktreePath]
  )

  return { files, loading, error, diffOf }
}
