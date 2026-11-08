// Where a worktree can come from besides a name you type: a pull request or an
// issue. Shared by the form and main, so the branch the form promises is the
// branch main creates.
import { clipBranch, slugifyBranch } from './slug.ts'

export type SourceId = 'github' | 'bitbucket' | 'jira'

export const SOURCE_LABELS: Record<SourceId, string> = {
  github: 'GitHub',
  bitbucket: 'Bitbucket',
  jira: 'Jira'
}

/** A pull request or an issue, as the new-worktree form lists it. */
export interface SourceItem {
  source: SourceId
  kind: 'pr' | 'issue'
  /** What the source calls it: `123`, or `PROJ-123` on Jira. */
  ref: string
  title: string
  url: string
  author: string
  /** The PR's head branch. */
  head?: string
  /** The branch the PR merges into. */
  base?: string
  /** The head lives in another repository, so it cannot be pushed back to from here. */
  fork?: boolean
  /** That repository's `owner/name`, when the source cannot serve its head itself. */
  forkSlug?: string
  draft?: boolean
  /** The description. Only a single-item lookup fills this in. */
  body?: string
}

/** One answer to the form's query. `error` is a sentence to show, not a stack. */
export interface SourceSearch {
  items: SourceItem[]
  error?: string
}

export interface ForgeRepo {
  /** The git remote that points at it, which is not always `origin`. */
  remote: string
  /** `owner/name`. */
  slug: string
}

/** A query that names one item rather than searching for it. */
export interface SourceRef {
  ref: string
  /** Set when the query was a repository URL, which also says which repository it means. */
  slug?: string
}

// The remote names that usually hold the PRs, best first: on a fork `upstream`
// is where they are, and `github` is the convention next to a non-GitHub origin.
const REMOTE_ORDER = ['upstream', 'github', 'bitbucket', 'origin']

/** The remote pointing at `host`, from the output of `git remote -v`. */
export function pickRemote(remotes: string, host: 'github.com' | 'bitbucket.org'): ForgeRepo | null {
  const name = host.replace('.', '\\.')
  const pattern = new RegExp(
    `^(\\S+)\\s+(?:[a-z+]+://)?(?:[^/@\\s]+@)?(?:ssh\\.)?${name}(?::\\d+)?[:/]([^/\\s]+/[^/\\s]+?)(?:\\.git)?/?\\s+\\(fetch\\)$`
  )
  const found: ForgeRepo[] = []
  for (const line of remotes.split('\n')) {
    const match = line.trim().match(pattern)
    if (match) found.push({ remote: match[1], slug: match[2] })
  }
  const rank = (repo: ForgeRepo): number => {
    const at = REMOTE_ORDER.indexOf(repo.remote)
    return at === -1 ? REMOTE_ORDER.length : at
  }
  return found.sort((a, b) => rank(a) - rank(b))[0] ?? null
}

const JIRA_KEY = '[A-Za-z][A-Za-z0-9_]*-\\d+'

function parseJiraRef(text: string): SourceRef | null {
  const key = text.match(new RegExp(`^${JIRA_KEY}$`))?.[0]
  const linked = text.match(new RegExp(`(?:/browse/|selectedIssue=)(${JIRA_KEY})`))?.[1]
  const found = key ?? linked
  return found ? { ref: found.toUpperCase() } : null
}

/** A number, a key or a URL. Anything else is text to search for. */
export function parseSourceRef(source: SourceId, query: string): SourceRef | null {
  const text = query.trim()
  if (source === 'jira') return parseJiraRef(text)
  const number = text.match(/^#?(\d+)$/)
  if (number) return { ref: number[1] }
  const path =
    source === 'github'
      ? /github\.com\/([^/\s]+\/[^/\s]+)\/(?:pull|issues)\/(\d+)/
      : /bitbucket\.org\/([^/\s]+\/[^/\s]+)\/(?:pull-requests|issues)\/(\d+)/
  const url = text.match(path)
  return url ? { ref: url[2], slug: url[1] } : null
}

/**
 * Which tab text typed in the Name box belongs to, if it can only mean a PR or
 * an issue. Nothing starts a branch name with `#`, and a URL is not a name anyone
 * is typing. A bare `PROJ-123` stays a name, since that is a fine branch.
 */
export function sourceForInput(text: string, available: SourceId[]): SourceId | undefined {
  const wanted: SourceId | undefined = text.startsWith('#')
    ? available.find((s) => s !== 'jira')
    : text.startsWith('https://github.com/')
      ? 'github'
      : text.startsWith('https://bitbucket.org/')
        ? 'bitbucket'
        : /^https:\/\/[^/]+\.atlassian\.net\//.test(text)
          ? 'jira'
          : undefined
  return wanted && available.includes(wanted) ? wanted : undefined
}

/** How the form writes an item's reference. */
export function sourceLabel(item: Pick<SourceItem, 'source' | 'ref'>): string {
  return item.source === 'jira' ? item.ref : `#${item.ref}`
}

/**
 * The branch a worktree for `item` sits on.
 *
 * A PR keeps its head's exact name, since that is the branch being reviewed. A
 * fork's head gets `pr-<n>`, because its name means nothing here and can clash
 * with a local branch. An issue has no branch yet, so its name is made from the
 * reference and title, with slashes flattened so a title cannot open a namespace.
 * A long title gives way, and the reference never does.
 */
export function sourceBranch(item: SourceItem, opts: { lowercase?: boolean } = {}): string {
  if (item.kind === 'pr') return item.fork || !item.head ? `pr-${item.ref}` : item.head
  const slug = slugifyBranch(`${item.ref} ${item.title.replace(/\//g, ' ')}`, {
    preserveCase: !opts.lowercase
  })
  return clipBranch(slug, item.ref.length)
}

/**
 * Is `branch` this issue's, whatever its title was when the branch was made? An
 * issue can be retitled, and that must find its worktree rather than make another.
 */
export function isIssueBranch(branch: string, item: Pick<SourceItem, 'ref'>): boolean {
  const name = branch.toLowerCase()
  const ref = item.ref.toLowerCase()
  return name === ref || name.startsWith(`${ref}-`)
}

const kindOf = (item: SourceItem): string =>
  item.kind === 'pr' ? 'Pull request' : item.source === 'jira' ? 'Jira issue' : 'Issue'

/** The one line the form prefills. */
export function sourcePremise(item: SourceItem): string {
  return `${kindOf(item)} ${sourceLabel(item)}: ${item.title} (${item.url})`
}

// Longer than a task's quote, because the rest of a task is one read away and the
// rest of a Jira issue is behind a login the agent does not have.
const PREMISE_BODY_LIMIT = 1500

/** The premise written verbatim for a worktree opened directly from `item`. */
export function sourceWorktreePremise(item: SourceItem): string {
  const body = item.body?.trim() ?? ''
  const clipped = body.length > PREMISE_BODY_LIMIT ? `${body.slice(0, PREMISE_BODY_LIMIT).trimEnd()}…` : body
  return [
    '## Goal',
    `Deliver ${kindOf(item).toLowerCase()} ${sourceLabel(item)} from ${SOURCE_LABELS[item.source]}: "${item.title}".`,
    '',
    '## Reference',
    item.url,
    ...(clipped ? ['', '## Description', clipped] : [])
  ].join('\n')
}
