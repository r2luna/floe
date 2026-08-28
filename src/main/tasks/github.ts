import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Task, TaskCloseResult, TasksStatus } from '../../shared/types'
import type { TaskListOptions, TaskProvider } from './provider'

const exec = promisify(execFile)

// Parse `owner/repo` out of a remote URL, handling both SSH and HTTPS forms:
//   git@github.com:owner/repo.git   →  { owner, repo }
//   https://github.com/owner/repo   →  { owner, repo }
// Returns null for non-GitHub remotes (so the provider doesn't apply).
export function parseGithubRemote(url: string): { owner: string; repo: string } | null {
  const trimmed = url.trim()
  const m =
    trimmed.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?\/?$/i) ?? null
  if (!m) return null
  return { owner: m[1], repo: m[2] }
}

export async function originUrl(root: string): Promise<string | null> {
  try {
    const { stdout } = await exec('git', ['-C', root, 'config', '--get', 'remote.origin.url'])
    return stdout.trim() || null
  } catch {
    return null
  }
}

// Is the `gh` CLI installed and authenticated? Cached process-wide — auth state
// rarely changes within a session and `gh auth status` shells out.
let ghReady: boolean | null = null
export async function ghAvailable(): Promise<boolean> {
  if (ghReady !== null) return ghReady
  try {
    await exec('gh', ['auth', 'status'])
    ghReady = true
  } catch {
    ghReady = false
  }
  return ghReady
}

// One record from `gh issue list --json …`. PRs are already excluded by gh.
interface GhIssue {
  number: number
  title: string
  state: string // "OPEN" | "CLOSED"
  url: string
  body: string
  updatedAt: string
  author?: { login?: string } | null
  assignees?: { login: string }[]
  labels?: { name: string; color?: string }[]
}

export const githubProvider: TaskProvider = {
  name: 'github',

  async detect(root: string): Promise<TasksStatus | null> {
    const url = await originUrl(root)
    if (!url) return null // no remote at all → GitHub doesn't apply
    const repo = parseGithubRemote(url)
    if (!repo) return null // a non-GitHub remote → let another provider try
    const source = `${repo.owner}/${repo.repo}`
    if (!(await ghAvailable())) {
      return {
        available: false,
        provider: 'github',
        source,
        reason: 'GitHub CLI not authenticated — run `gh auth login`'
      }
    }
    return { available: true, provider: 'github', source }
  },

  async list(root: string, opts: TaskListOptions): Promise<Task[]> {
    const url = await originUrl(root)
    const repo = url ? parseGithubRemote(url) : null
    if (!repo) return []
    const { stdout } = await exec(
      'gh',
      [
        'issue',
        'list',
        '--repo',
        `${repo.owner}/${repo.repo}`,
        '--state',
        opts.state,
        '--limit',
        '1000',
        '--json',
        'number,title,state,url,body,updatedAt,author,assignees,labels'
      ],
      { maxBuffer: 32 * 1024 * 1024 }
    )
    const issues = JSON.parse(stdout) as GhIssue[]
    return issues.map((i) => ({
      id: `gh:${i.number}`,
      key: `#${i.number}`,
      title: i.title,
      state: i.state.toLowerCase() === 'closed' ? 'closed' : 'open',
      labels: (i.labels ?? []).map((l) => ({ name: l.name, color: l.color || undefined })),
      assignees: (i.assignees ?? []).map((a) => a.login),
      author: i.author?.login,
      updatedAt: i.updatedAt,
      url: i.url,
      body: i.body ?? '',
      provider: 'github' as const
    }))
  },

  // A worktree-from-issue branch is `feat/123` / `fix/123` (slugifyBranch drops
  // the `#`). Recover the issue number from the last all-digit path segment, so a
  // word that merely contains digits (e.g. `feat/v2`) is ignored.
  keyFromBranch(branch: string): string | null {
    const segs = branch.split('/')
    for (let i = segs.length - 1; i >= 0; i--) if (/^\d+$/.test(segs[i])) return segs[i]
    return null
  },

  // Close the issue via `gh issue close`. gh exits 0 (with a notice) when the
  // issue is already closed, so re-running a merge stays green.
  async close(root: string, key: string): Promise<TaskCloseResult> {
    const url = await originUrl(root)
    const repo = url ? parseGithubRemote(url) : null
    if (!repo) return { ok: false, detail: 'No GitHub remote' }
    try {
      await exec('gh', ['issue', 'close', key, '--repo', `${repo.owner}/${repo.repo}`])
      return { ok: true, detail: `Closed #${key}` }
    } catch (e) {
      return { ok: false, detail: `gh issue close failed: ${(e as Error).message}` }
    }
  }
}
