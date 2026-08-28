import type { Task, TaskCloseResult, TasksStatus } from '../../shared/types'
import { githubProvider } from './github'
import { jiraProvider } from './jira'
import type { TaskListOptions, TaskProvider } from './provider'

// Ordered list of trackers. The first whose detect() applies wins. GitHub goes
// first (a GitHub remote is a strong signal); Jira applies to anything else once
// the user has connected it. Everything downstream speaks the normalized `Task`.
const PROVIDERS: TaskProvider[] = [githubProvider, jiraProvider]

// Resolve which provider serves this project, plus its status. Walks the list:
// the first to report `available` wins; otherwise we surface the most useful
// "applies but unusable" reason (e.g. GitHub repo found but gh not authed),
// falling back to a generic "no tracker" message.
async function resolve(root: string): Promise<{ provider?: TaskProvider; status: TasksStatus }> {
  let firstUnavailable: TasksStatus | null = null
  for (const provider of PROVIDERS) {
    const status = await provider.detect(root).catch(() => null)
    if (!status) continue // provider doesn't apply to this project
    if (status.available) return { provider, status }
    if (!firstUnavailable) firstUnavailable = status
  }
  return {
    status: firstUnavailable ?? {
      available: false,
      reason: 'No connected issue tracker — add a GitHub remote, or connect Jira (⌘K → Connect Jira)'
    }
  }
}

export async function tasksStatus(root: string): Promise<TasksStatus> {
  return (await resolve(root)).status
}

export async function tasksList(root: string, opts: TaskListOptions): Promise<Task[]> {
  const { provider, status } = await resolve(root)
  if (!provider || !status.available) return []
  return provider.list(root, opts)
}

// Mark the task linked to `branch` as done/closed in its tracker — the merge
// flow's final step. Resolves the active provider, asks it for the key carried by
// the branch, and closes it. Returns a skipped result (never throws) when no
// tracker applies or the branch carries no recognizable key, so a plain feature
// branch merges cleanly without touching any tracker.
export async function tasksCloseForBranch(root: string, branch: string): Promise<TaskCloseResult> {
  const { provider, status } = await resolve(root)
  if (!provider || !status.available || !provider.keyFromBranch || !provider.close)
    return { ok: true, skipped: true, detail: 'no linked task' }
  const key = provider.keyFromBranch(branch)
  if (!key) return { ok: true, skipped: true, detail: 'no linked task' }
  return provider.close(root, key)
}
