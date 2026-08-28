import type { Task, TaskCloseResult, TasksStatus } from '../../shared/types'

// The contract every external tracker implements. Keeping the renderer behind
// this interface means adding Jira later is one new file + one registry line —
// the Tasks tab, vim nav, and worktree flow already speak the normalized `Task`.
export interface TaskProvider {
  name: TasksStatus['provider']
  // Cheap check: does this provider apply to the project at `root`, and is it
  // usable right now? Returns null when it doesn't apply at all (so the registry
  // moves on); returns a TasksStatus (available true/false) when it does.
  detect(root: string): Promise<TasksStatus | null>
  // List normalized tasks for the project. Only called after detect() reported
  // `available`.
  list(root: string, opts: TaskListOptions): Promise<Task[]>
  // Pull this provider's task key out of a branch ref (`feat/DOS-219` → `DOS-219`,
  // `feat/123` → `123`), or null when the branch carries no key this provider
  // recognizes. Used by the merge flow to find the worktree's linked task.
  keyFromBranch?(branch: string): string | null
  // Mark the given task done/closed (Jira → "Done" transition; GitHub → close the
  // issue). Only called with a key produced by keyFromBranch.
  close?(root: string, key: string): Promise<TaskCloseResult>
}

export interface TaskListOptions {
  state: 'open' | 'all'
}
