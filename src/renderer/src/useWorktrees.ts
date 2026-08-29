import { useCallback, useEffect, useState } from 'react'
import type { ClaudeSessionMeta } from '../../main/claudeSessions'
import type { Worktree } from '../../shared/types'

/** A worktree with the sessions that live in it. */
export interface WorktreeRow {
  worktree: Worktree
  sessions: ClaudeSessionMeta[]
}

export interface Worktrees {
  rows: WorktreeRow[]
  loading: boolean
  error?: string
  /** The worktree the app considers current, by path. */
  currentPath?: string
  select: (path: string) => void
  reload: () => void
}

/**
 * A project's worktrees, each with its sessions.
 *
 * Sessions come from `claude.sessions` per worktree rather than the global
 * `sessions:all`. Two reasons: it is the call that carries `claudeId` — the id
 * the transcript file is named after, which is NOT Floe's session id — and
 * it asks only about the project you are looking at.
 */
export function useWorktrees(repoPath?: string): Worktrees {
  const [rows, setRows] = useState<WorktreeRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const [currentPath, setCurrentPath] = useState<string>()

  const reload = useCallback(() => {
    if (!repoPath) {
      setRows([])
      return
    }
    setLoading(true)
    window.floe.worktrees
      .list(repoPath)
      .then(async (worktrees) => {
        const rows = await Promise.all(
          worktrees.map(async (worktree) => {
            const sessions = (await window.floe.claude.sessions(worktree.path))
              // Most recently touched first: the session you were just in is the
              // one you are most likely coming back to.
              .slice()
              .sort((a, b) => b.mtime - a.mtime)
            return { worktree, sessions }
          })
        )
        setRows(rows)
        setError(undefined)
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false))
  }, [repoPath])

  useEffect(reload, [reload])

  // Switching project invalidates the selection: a worktree path from the old
  // project would leave the panel pointing at something no longer listed.
  useEffect(() => setCurrentPath(undefined), [repoPath])

  // The MCP create_worktree tool changes the set behind the UI's back; without
  // this the panel would keep showing a list that is already stale.
  useEffect(() => {
    return window.floe.worktrees.onUpdated((event) => {
      if (event.project === repoPath) reload()
    })
  }, [repoPath, reload])

  return { rows, loading, error, currentPath, select: setCurrentPath, reload }
}
