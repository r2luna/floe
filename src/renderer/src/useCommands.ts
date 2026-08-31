import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ProjectCommand } from '../../main/commands'
import type { CommandRun } from '../../main/commandRunner'
import type { CommandState } from '../../main/commandState'

/** One command's live state, as a row draws it. */
export interface CommandRunState {
  state: CommandState
  /** Why auto-restart gave up. Shown in place of the exit note when set. */
  reason?: string
  /** Resident memory of the whole process group, while it runs. */
  rss?: number
  exitCode?: number
  endedAt?: number
  durationMs?: number
}

export interface Commands {
  list: ProjectCommand[]
  runs: Record<string, CommandRunState>
  loading: boolean
  error?: string
  /** `<worktreePath>#<id>` — the runner's key for a command in this worktree. */
  keyOf: (id: string) => string
  runOf: (id: string) => CommandRunState | undefined
  start: (id: string) => void
  stop: (id: string) => void
  restart: (id: string) => void
  startAll: () => void
  reload: () => void
  add: (name: string, command: string, scope?: 'project' | 'local') => Promise<void>
  update: (id: string, patch: { name?: string; command?: string }) => Promise<void>
  remove: (id: string) => Promise<void>
  setScope: (id: string, scope: 'project' | 'local') => Promise<void>
}

const EMPTY: ProjectCommand[] = []

/**
 * The worktree's registered processes, and what each one is doing.
 *
 * State comes from main and only from main. The renderer used to keep its own
 * `running` flag, which a window reload emptied — so a live dev server rendered
 * as stopped and the row offered a start button that did nothing. `command.runs`
 * seeds the map on mount and the event stream keeps it current.
 */
export function useCommands(projectPath?: string, worktreePath?: string, branch = ''): Commands {
  const [list, setList] = useState<ProjectCommand[]>(EMPTY)
  const [runs, setRuns] = useState<Record<string, CommandRunState>>({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()

  const reload = useCallback(() => {
    if (!projectPath || !worktreePath) {
      setList(EMPTY)
      return
    }
    setLoading(true)
    window.floe.commands
      .list(projectPath, worktreePath)
      .then((l) => {
        setList(l)
        setError(undefined)
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false))
  }, [projectPath, worktreePath])

  useEffect(reload, [reload])

  // commands.toml is a file people (and agents) edit directly — that is the
  // whole reason it is TOML — so the list has to follow the file, not just the
  // writes that went through this hook. Main already broadcasts `config:changed`
  // for the config directory; without listening, a hand-edited command simply
  // did not appear until the next project switch.
  useEffect(() => window.floe.config.onChange(reload), [reload])

  // Seed from main, then follow it. Both, not either: the snapshot covers what
  // happened before this window existed, the stream covers what happens next.
  useEffect(() => {
    void window.floe.commands.runs().then((snapshot: CommandRun[]) => {
      setRuns((prev) => {
        const next = { ...prev }
        for (const r of snapshot) {
          next[r.key] = {
            state: r.state,
            reason: r.reason,
            rss: r.rss,
            exitCode: r.exitCode,
            endedAt: r.endedAt,
            durationMs: r.durationMs
          }
        }
        return next
      })
    })
    return window.floe.commands.onEvent((event) => {
      setRuns((prev) => {
        const at = prev[event.key] ?? { state: 'idle' as CommandState }
        if (event.kind === 'started')
          // A fresh run clears the previous one's exit note: the row would
          // otherwise read "running · exit 1" and mean both at once.
          return { ...prev, [event.key]: { state: 'running' } }
        if (event.kind === 'state')
          return { ...prev, [event.key]: { ...at, state: event.state, reason: event.reason } }
        if (event.kind === 'mem') return { ...prev, [event.key]: { ...at, rss: event.rss } }
        if (event.kind === 'exit')
          return {
            ...prev,
            [event.key]: {
              ...at,
              rss: undefined,
              exitCode: event.code,
              endedAt: Date.now(),
              durationMs: event.durationMs
            }
          }
        return prev // `data` belongs to the log panel, not to the row
      })
    })
  }, [])

  const keyOf = useCallback((id: string) => `${worktreePath ?? ''}#${id}`, [worktreePath])
  const runOf = useCallback((id: string) => runs[keyOf(id)], [runs, keyOf])

  const find = useCallback((id: string) => list.find((c) => c.id === id), [list])

  const start = useCallback(
    (id: string) => {
      const c = find(id)
      if (!c || !worktreePath) return
      // 0×0: the panel resizes the PTY the moment it attaches, and a command
      // started from a keybinding has no panel open to ask.
      void window.floe.commands.start(
        keyOf(id),
        c.cwd || worktreePath,
        branch,
        c.command,
        0,
        0,
        c.watch,
        c.autoRestart
      )
    },
    [find, keyOf, worktreePath, branch]
  )

  const restart = useCallback(
    (id: string) => {
      const c = find(id)
      if (!c || !worktreePath) return
      void window.floe.commands.restart(
        keyOf(id),
        c.cwd || worktreePath,
        branch,
        c.command,
        0,
        0,
        c.watch,
        c.autoRestart
      )
    },
    [find, keyOf, worktreePath, branch]
  )

  const stop = useCallback((id: string) => void window.floe.commands.stop(keyOf(id)), [keyOf])

  const startAll = useCallback(() => {
    for (const c of list) if (runs[keyOf(c.id)]?.state !== 'running') start(c.id)
  }, [list, runs, keyOf, start])

  // Every write returns the fresh list, so the file on disk and the panel cannot
  // drift — no reload round-trip, no optimistic copy to reconcile.
  const write = useCallback(
    async (fn: (p: string, w: string) => Promise<ProjectCommand[]>) => {
      if (!projectPath || !worktreePath) return
      setList(await fn(projectPath, worktreePath))
    },
    [projectPath, worktreePath]
  )

  const add = useCallback(
    (name: string, command: string, scope: 'project' | 'local' = 'project') =>
      write((p, w) => window.floe.commands.add(scope, p, w, name, command)),
    [write]
  )
  const update = useCallback(
    (id: string, patch: { name?: string; command?: string }) =>
      write((p, w) => window.floe.commands.update(p, w, id, patch)),
    [write]
  )
  const remove = useCallback(
    (id: string) => write((p, w) => window.floe.commands.remove(p, w, id)),
    [write]
  )
  const setScope = useCallback(
    (id: string, scope: 'project' | 'local') =>
      write((p, w) => window.floe.commands.setScope(p, w, id, scope)),
    [write]
  )

  return useMemo(
    () => ({
      list,
      runs,
      loading,
      error,
      keyOf,
      runOf,
      start,
      stop,
      restart,
      startAll,
      reload,
      add,
      update,
      remove,
      setScope
    }),
    [list, runs, loading, error, keyOf, runOf, start, stop, restart, startAll, reload, add, update, remove, setScope]
  )
}
