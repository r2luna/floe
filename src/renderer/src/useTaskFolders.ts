import { useCallback, useEffect, useState } from 'react'
import type { TaskFolder, TaskFolderDetail } from '../../shared/taskFolders'

/**
 * Re-read when anything that changes a task happens: the folders' own watcher
 * (an agent writing a plan), the board moving the card a sent task became, and
 * coming back to the window (a `claude` in a real terminal, an editor).
 */
function useTaskReload(root?: string): [number, () => void] {
  const [n, setN] = useState(0)
  const reload = useCallback(() => setN((x) => x + 1), [])
  useEffect(() => {
    if (!root) return
    void window.floe.tasks.watch(root)
    const offTasks = window.floe.tasks.onEvent((e) => {
      if (e.root === root) reload()
    })
    const offBoard = window.floe.colony.onEvent((e) => {
      if (e.project === root) reload()
    })
    window.addEventListener('focus', reload)
    return () => {
      offTasks()
      offBoard()
      window.removeEventListener('focus', reload)
    }
  }, [root, reload])
  return [n, reload]
}

/** Every task of a project — the tasks panel's list. */
export function useTaskFolders(root?: string): { tasks: TaskFolder[]; loading: boolean; error?: string } {
  const [tasks, setTasks] = useState<TaskFolder[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const [n] = useTaskReload(root)

  useEffect(() => {
    if (!root) {
      setTasks([])
      return
    }
    let live = true
    setLoading(true)
    setError(undefined)
    window.floe.tasks
      .list(root)
      .then((t) => live && setTasks(t))
      .catch((e: Error) => live && setError(e.message))
      .finally(() => live && setLoading(false))
    // A late reply for the project you just left must not land in this one.
    return () => {
      live = false
    }
  }, [root, n])

  return { tasks, loading, error }
}

/** One task in full — the item panel. */
export function useTaskFolder(
  root: string | undefined,
  ref: string | undefined
): { task: TaskFolderDetail | null; error?: string } {
  const [task, setTask] = useState<TaskFolderDetail | null>(null)
  const [error, setError] = useState<string>()
  const [n] = useTaskReload(root)

  useEffect(() => {
    if (!root || !ref) {
      setTask(null)
      return
    }
    let live = true
    window.floe.tasks
      .read(root, ref)
      .then((t) => {
        if (!live) return
        setTask(t)
        setError(undefined)
      })
      .catch((e: Error) => live && setError(e.message))
    return () => {
      live = false
    }
  }, [root, ref, n])

  return { task, error }
}
