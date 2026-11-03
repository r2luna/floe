// GitHub, through the `gh` CLI when this machine has it logged in, and through
// the token saved in Settings when it does not.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { userShell } from '../commandRunner'
import type { SourceItem } from '../../shared/worktreeSource'
import { getCredential } from './credentials'
import { getJson, orNull } from './http'
import type { SourceBackend } from './types'

const exec = promisify(execFile)

const LIST_LIMIT = '20'
const GH_TIMEOUT_MS = 20_000
const MAX_OUTPUT = 10 * 1024 * 1024
// A login shell is not free, and every search would otherwise start one to learn
// again that gh is still not installed. Short enough to notice a new install.
const MISSING_TTL_MS = 60_000

const PR_FIELDS = 'number,title,url,author,headRefName,baseRefName,isCrossRepository,isDraft'
const ISSUE_FIELDS = 'number,title,url,author'
// A description is only worth its bytes on the one item being opened.
const WITH_BODY = ',body'

interface GhPull {
  number: number
  title: string
  url: string
  author?: { login?: string }
  headRefName: string
  baseRefName: string
  isCrossRepository: boolean
  isDraft: boolean
  body?: string
}

interface GhIssue {
  number: number
  title: string
  url: string
  author?: { login?: string }
  body?: string
}

function ghPull(pr: GhPull): SourceItem {
  return {
    source: 'github',
    kind: 'pr',
    ref: String(pr.number),
    title: pr.title,
    url: pr.url,
    author: pr.author?.login ?? '',
    head: pr.headRefName,
    base: pr.baseRefName,
    fork: pr.isCrossRepository,
    draft: pr.isDraft,
    body: pr.body
  }
}

function ghIssue(issue: GhIssue): SourceItem {
  return {
    source: 'github',
    kind: 'issue',
    ref: String(issue.number),
    title: issue.title,
    url: issue.url,
    author: issue.author?.login ?? '',
    body: issue.body
  }
}

let ghPath: string | undefined
let ghMissingAt = 0

// A packaged app starts without the user's PATH, so `gh` is looked up through
// the login shell. The path, not the command, is what gets kept: arguments then
// go straight to gh and a search query never meets shell quoting.
async function ghBinary(): Promise<string> {
  if (process.env.FLOE_GH_BIN) return process.env.FLOE_GH_BIN
  if (process.platform === 'win32') return 'gh'
  if (ghPath) return ghPath
  if (Date.now() - ghMissingAt < MISSING_TTL_MS) throw new Error('gh not found')
  try {
    const { stdout } = await exec(userShell(), ['-lc', 'command -v gh'])
    const found = stdout.trim().split('\n').pop()
    if (found) return (ghPath = found)
  } catch {
    /* Reported below, the same as an empty answer. */
  }
  ghMissingAt = Date.now()
  throw new Error('gh not found')
}

async function runGh(args: string[]): Promise<string> {
  const { stdout } = await exec(await ghBinary(), args, { timeout: GH_TIMEOUT_MS, maxBuffer: MAX_OUTPUT })
  return stdout
}

async function gh<T>(args: string[]): Promise<T> {
  return JSON.parse(await runGh(args)) as T
}

const failureText = (error: unknown): string => {
  const failure = error as { stderr?: string; message?: string }
  return failure.stderr?.trim() || failure.message || ''
}

/** gh cannot be used at all here, as opposed to gh answering that something failed. */
export function ghIsUnusable(error: unknown): boolean {
  if ((error as { code?: unknown }).code === 'ENOENT') return true
  return /gh not found|gh auth login|authentication|HTTP 401/i.test(failureText(error))
}

/** Is `gh` here and logged in? For Settings, which says which of the two is in use. */
export async function ghLoggedIn(): Promise<boolean> {
  try {
    await runGh(['auth', 'status', '--hostname', 'github.com'])
    return true
  } catch {
    return false
  }
}

// A number can be either kind and GitHub numbers them together, so asking as a
// PR first settles it. A number that is neither is an answer, not a failure.
async function ghView(slug: string, ref: string): Promise<SourceItem | null> {
  try {
    return ghPull(await gh<GhPull>(['pr', 'view', ref, '-R', slug, '--json', PR_FIELDS + WITH_BODY]))
  } catch {
    /* Not a PR, or gh cannot answer. The issue lookup tells the two apart. */
  }
  try {
    return ghIssue(await gh<GhIssue>(['issue', 'view', ref, '-R', slug, '--json', ISSUE_FIELDS + WITH_BODY]))
  } catch (e) {
    if (/could not resolve/i.test((e as { stderr?: string }).stderr ?? '')) return null
    throw e
  }
}

async function ghSearch(slug: string, query: string): Promise<SourceItem[]> {
  const search = query ? ['--search', query] : []
  const common = ['-R', slug, '--limit', LIST_LIMIT, ...search, '--json']
  // Separately, because a repository can have issues turned off, and that should
  // not cost it its PRs. Only both failing means gh itself cannot answer.
  const [pulls, issues] = await Promise.allSettled([
    gh<GhPull[]>(['pr', 'list', ...common, PR_FIELDS]),
    gh<GhIssue[]>(['issue', 'list', ...common, ISSUE_FIELDS])
  ])
  if (pulls.status === 'rejected' && issues.status === 'rejected') throw pulls.reason
  return [
    ...(pulls.status === 'fulfilled' ? pulls.value.map(ghPull) : []),
    ...(issues.status === 'fulfilled' ? issues.value.map(ghIssue) : [])
  ]
}

interface RestPull {
  number: number
  title: string
  html_url: string
  draft?: boolean
  body?: string | null
  user?: { login?: string }
  head: { ref: string; repo?: { full_name?: string } | null }
  base: { ref: string; repo?: { full_name?: string } | null }
}

interface RestIssue {
  number: number
  title: string
  html_url: string
  body?: string | null
  user?: { login?: string }
  pull_request?: unknown
}

function restPull(pr: RestPull): SourceItem {
  return {
    source: 'github',
    kind: 'pr',
    ref: String(pr.number),
    title: pr.title,
    url: pr.html_url,
    author: pr.user?.login ?? '',
    head: pr.head.ref,
    base: pr.base.ref,
    fork: pr.head.repo?.full_name !== pr.base.repo?.full_name,
    draft: pr.draft
  }
}

function restIssue(issue: RestIssue): SourceItem {
  return {
    source: 'github',
    kind: 'issue',
    ref: String(issue.number),
    title: issue.title,
    url: issue.html_url,
    author: issue.user?.login ?? ''
  }
}

const API = 'https://api.github.com'
const MANY = 100

function restClient(slug: string, token: string): SourceBackend {
  const get = <T>(path: string): Promise<T> =>
    getJson<T>(`${API}${path}`, {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28'
    })
  return {
    view: async (ref) => {
      const pull = await orNull(get<RestPull>(`/repos/${slug}/pulls/${ref}`))
      if (pull) return { ...restPull(pull), body: pull.body ?? undefined }
      const issue = await orNull(get<RestIssue>(`/repos/${slug}/issues/${ref}`))
      return issue && { ...restIssue(issue), body: issue.body ?? undefined }
    },
    search: async (query) => {
      const limit = Number(LIST_LIMIT)
      // PRs are filtered here because the search API leaves out their branches,
      // and asking again for each result would be one request per row.
      const [pulls, issues] = await Promise.allSettled([
        get<RestPull[]>(`/repos/${slug}/pulls?state=open&per_page=${query ? MANY : limit}`),
        query
          ? get<{ items: RestIssue[] }>(
              `/search/issues?per_page=${limit}&q=${encodeURIComponent(`repo:${slug} is:issue is:open ${query}`)}`
            ).then((found) => found.items)
          : get<RestIssue[]>(`/repos/${slug}/issues?state=open&per_page=${limit}`)
      ])
      if (pulls.status === 'rejected' && issues.status === 'rejected') throw pulls.reason
      const words = query.toLowerCase()
      return [
        ...(pulls.status === 'fulfilled'
          ? pulls.value.filter((p) => p.title.toLowerCase().includes(words)).slice(0, limit).map(restPull)
          : []),
        // The issues endpoint lists PRs too.
        ...(issues.status === 'fulfilled' ? issues.value.filter((i) => !i.pull_request).map(restIssue) : [])
      ]
    }
  }
}

export const NO_GITHUB_ACCESS =
  'Log in to the GitHub CLI (gh auth login), or add a GitHub token in Settings, under Integrations.'

/** gh first. Only gh being unusable moves on to the saved token. */
export function githubBackend(slug: string): SourceBackend {
  const fallback = async <T>(viaGh: () => Promise<T>, viaToken: (client: SourceBackend) => Promise<T>): Promise<T> => {
    try {
      return await viaGh()
    } catch (e) {
      if (!ghIsUnusable(e)) throw e
      const token = getCredential('github', 'token')
      if (!token) throw new Error(NO_GITHUB_ACCESS)
      return viaToken(restClient(slug, token))
    }
  }
  return {
    view: (ref) => fallback(() => ghView(slug, ref), (client) => client.view(ref)),
    search: (query) => fallback(() => ghSearch(slug, query), (client) => client.search(query))
  }
}
