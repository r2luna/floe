// Bitbucket Cloud's REST API. An Atlassian API token authenticates with the
// account's email as the user: the Bitbucket username does not work here.
import type { SourceItem } from '../../shared/worktreeSource'
import { basicAuth, getJson, orNull } from './http'
import type { SourceBackend } from './types'

const API = 'https://api.bitbucket.org/2.0/repositories'
const PAGE = 20

interface Pull {
  id: number
  title: string
  description?: string
  draft?: boolean
  author?: { display_name?: string }
  links: { html: { href: string } }
  source: { branch: { name: string }; repository?: { full_name?: string } | null }
  destination: { branch: { name: string }; repository?: { full_name?: string } | null }
}

interface Issue {
  id: number
  title: string
  content?: { raw?: string } | null
  reporter?: { display_name?: string } | null
  links: { html: { href: string } }
}

function pullItem(pr: Pull): SourceItem {
  const from = pr.source.repository?.full_name
  const fork = from !== pr.destination.repository?.full_name
  return {
    source: 'bitbucket',
    kind: 'pr',
    ref: String(pr.id),
    title: pr.title,
    url: pr.links.html.href,
    author: pr.author?.display_name ?? '',
    head: pr.source.branch.name,
    base: pr.destination.branch.name,
    fork,
    forkSlug: fork ? from : undefined,
    draft: pr.draft
  }
}

function issueItem(issue: Issue): SourceItem {
  return {
    source: 'bitbucket',
    kind: 'issue',
    ref: String(issue.id),
    title: issue.title,
    url: issue.links.html.href,
    author: issue.reporter?.display_name ?? ''
  }
}

/** `text` as a quoted string in Bitbucket's query language. */
const quoted = (text: string): string => `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

export function bitbucketBackend(slug: string, email: string, token: string): SourceBackend {
  const get = <T>(path: string): Promise<T> =>
    getJson<T>(`${API}/${slug}${path}`, { Authorization: basicAuth(email, token) })
  const page = <T>(path: string, filter: string): Promise<T[]> =>
    get<{ values: T[] }>(`${path}?pagelen=${PAGE}&q=${encodeURIComponent(filter)}`).then((found) => found.values)

  return {
    view: async (ref) => {
      const pull = await orNull(get<Pull>(`/pullrequests/${ref}`))
      if (pull) return { ...pullItem(pull), body: pull.description }
      const issue = await orNull(get<Issue>(`/issues/${ref}`))
      return issue && { ...issueItem(issue), body: issue.content?.raw ?? undefined }
    },
    search: async (query) => {
      const titled = query ? ` AND title ~ ${quoted(query)}` : ''
      // Separately, because most Bitbucket repositories have the issue tracker
      // turned off, and that answers 404 without costing them their PRs.
      const [pulls, issues] = await Promise.allSettled([
        page<Pull>('/pullrequests', `state = "OPEN"${titled}`),
        page<Issue>('/issues', `(state = "new" OR state = "open")${titled}`)
      ])
      if (pulls.status === 'rejected') throw pulls.reason
      return [...pulls.value.map(pullItem), ...(issues.status === 'fulfilled' ? issues.value.map(issueItem) : [])]
    }
  }
}
