// A worktree for a task: `w` in the tasks panel, and task_create_worktree.
import { createWorktree, listWorktrees } from './git'
import { writePremise } from './premise'
import { readTaskFolder } from './taskFolders'
import { cardLookup } from './taskFolderDeps'
import { clipBranch } from '../shared/slug'
import { taskPremise, type TaskFolderDetail } from '../shared/taskFolders'
import type { Worktree } from '../shared/types'

export interface TaskWorktree {
  worktrees: Worktree[]
  branch: string
  task: TaskFolderDetail
  /** It already had one: nothing was created, so nothing needs provisioning. */
  existed: boolean
}

/**
 * The task's worktree, created if it has none.
 *
 * On a branch named after the task's folder, so asking again finds the same one.
 * A folder name can be as long as its title, so only the number is sure to survive.
 * The premise is written here rather than handed to the setup interview: its model
 * rewrites what it is given, and this is a reference that has to stay exact.
 */
export async function createTaskWorktree(root: string, ref: string): Promise<TaskWorktree> {
  const task = readTaskFolder(root, ref, cardLookup)
  if (task.status === 'in dev' || task.status === 'done') {
    throw new Error(`Task ${task.number} was sent to the colony, which runs its own worktrees.`)
  }
  const branch = clipBranch(task.name, task.number.length)
  const current = await listWorktrees(root)
  if (current.some((w) => w.branch === branch)) return { worktrees: current, branch, task, existed: true }

  const worktrees = await createWorktree(root, branch, { exact: true })
  const created = worktrees.find((w) => w.branch === branch)
  if (created) writePremise(created.path, taskPremise(task, root))
  return { worktrees, branch, task, existed: false }
}
