import { useCallback, useEffect, useRef, useState } from 'react'
import type { ClaudeSessionMeta } from '../../main/claudeSessions'
import type { Worktree, WorktreeStatus } from '../../shared/types'

/** A worktree with the sessions that live in it. */
export interface WorktreeRow {
  worktree: Worktree
  sessions: ClaudeSessionMeta[]
}

/**
 * Which fetch is the one whose answer counts.
 *
 * Every project switch starts a list fetch, and nothing makes them finish in
 * order: the list reads sessions per worktree, so a project with many
 * transcripts answers after one with few. Without this, the slower answer
 * lands last and the panel shows the project you LEFT under the name of the
 * one you picked. Each fetch takes a ticket; only the newest ticket may write.
 */
export class Latest {
  private n = 0
  next(): number {
    return ++this.n
  }
  is(ticket: number): boolean {
    return ticket === this.n
  }
}

export interface Worktrees {
  rows: WorktreeRow[]
  /** Each worktree's git dirt, keyed by path. Absent until it has been read. */
  status: Record<string, WorktreeStatus>
  /**
   * The project `rows` were loaded for.
   *
   * Switching project leaves one render where the new project is current and
   * these rows are still the old project's — the fetch has not even started. A
   * caller that acts on the list (landing on a branch, remembering which one you
   * were on) has to be able to tell, and comparing paths is the only way.
   */
  repo?: string
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
  const [repo, setRepo] = useState<string>()
  const [status, setStatus] = useState<Record<string, WorktreeStatus>>({})

  const latest = useRef(new Latest())

  const reload = useCallback(() => {
    // Clearing takes a ticket too, or a fetch still in flight for the project
    // just closed would fill the empty list back in.
    const ticket = latest.current.next()
    if (!repoPath) {
      setRows([])
      setRepo(undefined)
      setLoading(false)
      return
    }
    setLoading(true)
    window.floe.worktrees
      .list(repoPath)
      .then(async (worktrees) => {
        const rows = await Promise.all(
          worktrees.map(async (worktree) => {
            // Creation order, exactly as main returns it: sorting by mtime made
            // a row jump the moment its session got activity, which moves the
            // list out from under the pointer.
            const sessions = await window.floe.claude.sessions(worktree.path)
            return { worktree, sessions }
          })
        )
        if (!latest.current.is(ticket)) return
        setRows(rows)
        setRepo(repoPath)
        setError(undefined)
      })
      .catch((e: Error) => {
        if (latest.current.is(ticket)) setError(e.message)
      })
      .finally(() => {
        // Loading is about the fetch that counts, not the first one to finish.
        if (latest.current.is(ticket)) setLoading(false)
      })
  }, [repoPath])

  useEffect(reload, [reload])

  // Git dirt, read AFTER the list is on screen and never as part of it: a
  // `git status` per worktree is exactly what listWorktrees refuses to do,
  // because that call gates landing on a session.
  const paths = rows.map((r) => r.worktree.path).join('\n')
  const readStatus = useCallback(() => {
    if (!paths) return setStatus({})
    void window.floe.worktrees
      .status(paths.split('\n'))
      .then(setStatus)
      // A failed read leaves the last numbers up rather than blanking the
      // column: stale dirt is closer to the truth than no dirt.
      .catch(() => {})
  }, [paths])

  useEffect(readStatus, [readStatus])

  // Follow the working tree. The watcher only covers the worktree you are in,
  // which is the one whose numbers actually move while you watch; the others
  // refresh whenever the list does. Debounced because one save fires several
  // fs events, and each one would cost a git call per worktree.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const off = window.floe.review.onEvent(() => {
      clearTimeout(timer)
      timer = setTimeout(readStatus, 400)
    })
    return () => {
      clearTimeout(timer)
      off()
    }
  }, [readStatus])

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

  return { rows, status, repo, loading, error, currentPath, select: setCurrentPath, reload }
}
