import type { Task, TaskCloseResult, TasksStatus } from '../../shared/types'
import type { TaskListOptions, TaskProvider } from './provider'
import { getJiraCreds, getProjectKey, type JiraCreds } from './jiraConfig'
import { adfToMarkdown } from './adf'

// Jira Cloud provider. Auth is HTTP Basic with `email:token` (an Atlassian API
// token), per Atlassian's REST v3. Credentials are global (see jiraConfig); the
// project key is per-repo, so `detect`/`list` take the repo root and look it up.

function authHeader(creds: JiraCreds): string {
  return 'Basic ' + Buffer.from(`${creds.email}:${creds.token}`).toString('base64')
}

async function jiraGet(creds: JiraCreds, path: string): Promise<Response> {
  return fetch(`${creds.site}${path}`, {
    headers: { Authorization: authHeader(creds), Accept: 'application/json' }
  })
}

// Validate a set of credentials by hitting /myself. Used by the connect modal so
// the user gets immediate confirmation the token works before we save it.
export async function jiraTestCreds(input: {
  site: string
  email: string
  token: string
}): Promise<{ ok: boolean; displayName?: string; reason?: string }> {
  const creds: JiraCreds = {
    site: (input.site ?? '').replace(/\/+$/, ''),
    email: (input.email ?? '').trim(),
    token: (input.token ?? '').trim()
  }
  if (!/^https?:\/\//i.test(creds.site)) creds.site = `https://${creds.site}`
  try {
    const res = await jiraGet(creds, '/rest/api/3/myself')
    if (res.status === 401 || res.status === 403)
      return { ok: false, reason: 'Authentication failed — check the email and API token.' }
    if (!res.ok) return { ok: false, reason: `Jira responded ${res.status}.` }
    const me = (await res.json()) as { displayName?: string }
    return { ok: true, displayName: me.displayName }
  } catch (e) {
    return { ok: false, reason: `Could not reach Jira (${(e as Error).message}).` }
  }
}

// One issue from the search response — only the fields we request.
interface JiraIssueType {
  name?: string
}
interface JiraUser {
  displayName?: string
}
interface JiraParent {
  key: string
  fields?: { summary?: string; issuetype?: JiraIssueType }
}
interface JiraIssue {
  key: string
  fields: {
    summary?: string
    updated?: string
    labels?: string[]
    status?: { name?: string; statusCategory?: { key?: string } }
    issuetype?: JiraIssueType
    assignee?: JiraUser | null
    reporter?: JiraUser | null
    parent?: JiraParent | null
    description?: unknown
  }
}

const FIELDS = ['summary', 'status', 'issuetype', 'assignee', 'reporter', 'updated', 'labels', 'parent', 'description']

// A Jira issue key embedded in a branch ref — an uppercase project key, a dash,
// then digits (e.g. `feat/DOS-219` → `DOS-219`).
const JIRA_IN_BRANCH_RE = /[A-Z]+-\d+/

// One transition Jira offers from the issue's current status.
interface JiraTransition {
  id: string
  name?: string
  to?: { name?: string; statusCategory?: { key?: string } }
}

// Move an issue into its "Done" status. Jira has no generic "close"; you POST a
// workflow transition. We look up the transitions available from the current
// status and pick the one landing in the Done status category (falling back to a
// name match). If none is offered, the issue is likely already done — confirm via
// its status and treat that as a no-op rather than an error.
async function jiraTransitionToDone(creds: JiraCreds, key: string): Promise<TaskCloseResult> {
  const enc = encodeURIComponent(key)
  const res = await jiraGet(creds, `/rest/api/3/issue/${enc}/transitions`)
  if (res.status === 404) return { ok: false, detail: `${key} not found in Jira` }
  if (!res.ok) return { ok: false, detail: `Jira transitions lookup failed (${res.status})` }
  const data = (await res.json()) as { transitions?: JiraTransition[] }
  const transitions = data.transitions ?? []
  const done =
    transitions.find((t) => (t.to?.statusCategory?.key ?? '').toLowerCase() === 'done') ??
    transitions.find((t) => /\b(done|complete|completed|resolved|closed)\b/i.test(t.name ?? ''))
  if (!done) {
    // No Done transition on offer — maybe it's already there.
    const cur = await jiraGet(creds, `/rest/api/3/issue/${enc}?fields=status`)
    if (cur.ok) {
      const f = (await cur.json()) as { fields?: { status?: { name?: string; statusCategory?: { key?: string } } } }
      if ((f.fields?.status?.statusCategory?.key ?? '').toLowerCase() === 'done')
        return { ok: true, skipped: true, detail: `${key} already ${f.fields?.status?.name ?? 'Done'}` }
    }
    return { ok: false, detail: `${key}: no “Done” transition available` }
  }
  const post = await fetch(`${creds.site}/rest/api/3/issue/${enc}/transitions`, {
    method: 'POST',
    headers: {
      Authorization: authHeader(creds),
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ transition: { id: done.id } })
  })
  if (!post.ok) return { ok: false, detail: `Jira transition failed (${post.status})` }
  return { ok: true, detail: `${key} → ${done.to?.name ?? done.name ?? 'Done'}` }
}

function mapIssue(creds: JiraCreds, issue: JiraIssue): Task {
  const f = issue.fields
  const typeName = f.issuetype?.name
  const isEpic = (typeName ?? '').toLowerCase() === 'epic'
  // Group key: an Epic heads its own group; everything else rolls up to its
  // parent when that parent is an Epic. (Sub-tasks whose parent is a Story get
  // no epic — Jira only links one level here.)
  let epic: Task['epic'] = null
  if (isEpic) {
    epic = { key: issue.key, name: f.summary ?? issue.key }
  } else if (f.parent && (f.parent.fields?.issuetype?.name ?? '').toLowerCase() === 'epic') {
    epic = { key: f.parent.key, name: f.parent.fields?.summary ?? f.parent.key }
  }
  const done = (f.status?.statusCategory?.key ?? '').toLowerCase() === 'done'
  return {
    id: `jira:${issue.key}`,
    key: issue.key,
    title: f.summary ?? issue.key,
    state: done ? 'closed' : 'open',
    labels: (f.labels ?? []).map((name) => ({ name })),
    assignees: f.assignee?.displayName ? [f.assignee.displayName] : [],
    author: f.reporter?.displayName,
    updatedAt: f.updated ?? new Date(0).toISOString(),
    url: `${creds.site}/browse/${issue.key}`,
    body: adfToMarkdown(f.description),
    provider: 'jira' as const,
    epic,
    type: typeName,
    status: f.status?.name
  }
}

export const jiraProvider: TaskProvider = {
  name: 'jira',

  // Cheap, network-free detection: Jira applies once a project key is configured
  // for this repo, OR once the user has connected Jira at all (so we can prompt
  // for the missing piece). The actual token is validated by the connect modal.
  async detect(root: string): Promise<TasksStatus | null> {
    const key = getProjectKey(root)
    const creds = getJiraCreds()
    if (!key && !creds) return null // Jira doesn't apply — fall through to the next provider
    if (!creds)
      return {
        available: false,
        provider: 'jira',
        source: key,
        reason: 'Connect Jira — set your API token (⌘K → Connect Jira)'
      }
    if (!key)
      return {
        available: false,
        provider: 'jira',
        reason: 'Set this repo’s Jira project key (⌘K → Set Jira project key, or press p)'
      }
    return { available: true, provider: 'jira', source: key }
  },

  async list(root: string, opts: TaskListOptions): Promise<Task[]> {
    const creds = getJiraCreds()
    const key = getProjectKey(root)
    if (!creds || !key) return []
    // Escape any quotes in the key defensively, then build JQL. Open = anything
    // not in the Done status category; All = the whole project.
    const safeKey = key.replace(/"/g, '\\"')
    const jql =
      opts.state === 'open'
        ? `project = "${safeKey}" AND statusCategory != Done ORDER BY updated DESC`
        : `project = "${safeKey}" ORDER BY updated DESC`

    const tasks: Task[] = []
    let nextPageToken: string | undefined
    const MAX = 2000 // defensive cap so a huge backlog can't hang the pane
    // Enhanced search endpoint (the classic /search is being retired). Paginate
    // by nextPageToken until Jira reports the last page.
    for (let i = 0; i < 50 && tasks.length < MAX; i++) {
      const res = await fetch(`${creds.site}/rest/api/3/search/jql`, {
        method: 'POST',
        headers: {
          Authorization: authHeader(creds),
          Accept: 'application/json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ jql, fields: FIELDS, maxResults: 100, nextPageToken })
      })
      if (!res.ok) throw new Error(`Jira search failed (${res.status})`)
      const data = (await res.json()) as { issues?: JiraIssue[]; nextPageToken?: string; isLast?: boolean }
      for (const issue of data.issues ?? []) tasks.push(mapIssue(creds, issue))
      nextPageToken = data.nextPageToken
      if (data.isLast || !nextPageToken || (data.issues ?? []).length === 0) break
    }
    return tasks
  },

  // `feat/DOS-219` → `DOS-219`. The branch keeps the issue key in its original
  // (upper) case, matching the worktree-from-task convention.
  keyFromBranch(branch: string): string | null {
    const m = branch.match(JIRA_IN_BRANCH_RE)
    return m ? m[0] : null
  },

  async close(_root: string, key: string): Promise<TaskCloseResult> {
    const creds = getJiraCreds()
    if (!creds) return { ok: false, detail: 'Jira not connected' }
    return jiraTransitionToDone(creds, key)
  }
}
