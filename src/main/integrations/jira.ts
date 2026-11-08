// Jira Cloud's REST API, with an Atlassian API token and the account's email.
import type { SourceItem } from '../../shared/worktreeSource'
import { basicAuth, getJson, orNull } from './http'
import type { SourceBackend } from './types'

const FIELDS = 'summary,reporter'
const VIEW_FIELDS = `${FIELDS},description`
const LIMIT = 20
const OPEN = 'statusCategory != Done ORDER BY updated DESC'

// A node of Atlassian Document Format, which is what v3 returns for a description.
interface AdfNode {
  type?: string
  text?: string
  content?: AdfNode[]
}

interface Issue {
  key: string
  fields: { summary?: string; reporter?: { displayName?: string } | null; description?: AdfNode | null }
}

const INLINE_PARENTS = new Set(['paragraph', 'heading'])

/** A description as plain text: one line per block, marks and layout dropped. */
export function adfText(node?: AdfNode | null): string {
  if (!node) return ''
  if (node.type === 'text') return node.text ?? ''
  if (node.type === 'hardBreak') return '\n'
  const parts = (node.content ?? []).map(adfText)
  return parts.join(INLINE_PARENTS.has(node.type ?? '') ? '' : '\n')
}

/** `acme`, `acme.atlassian.net` or a pasted URL, as the site's origin. */
export function jiraOrigin(site: string): string {
  const text = site.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
  return `https://${text.includes('.') ? text : `${text}.atlassian.net`}`
}

/** `text` as a quoted string in JQL. */
const quoted = (text: string): string => `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

export function jiraBackend(site: string, email: string, token: string): SourceBackend {
  const origin = jiraOrigin(site)
  const item = (issue: Issue): SourceItem => ({
    source: 'jira',
    kind: 'issue',
    ref: issue.key,
    title: issue.fields.summary ?? '',
    url: `${origin}/browse/${issue.key}`,
    author: issue.fields.reporter?.displayName ?? ''
  })
  const get = <T>(path: string): Promise<T> =>
    getJson<T>(`${origin}/rest/api/3${path}`, { Authorization: basicAuth(email, token) })

  return {
    view: async (ref) => {
      const issue = await orNull(get<Issue>(`/issue/${encodeURIComponent(ref)}?fields=${VIEW_FIELDS}`))
      return issue && { ...item(issue), body: adfText(issue.fields.description) }
    },
    // Your own open work when nothing is typed: a whole site's backlog is not a
    // list anyone can pick from.
    search: async (query) => {
      const jql = query ? `text ~ ${quoted(query)} AND ${OPEN}` : `assignee = currentUser() AND ${OPEN}`
      const found = await get<{ issues: Issue[] }>(
        `/search/jql?maxResults=${LIMIT}&fields=${FIELDS}&jql=${encodeURIComponent(jql)}`
      )
      return found.issues.map(item)
    }
  }
}
