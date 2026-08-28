import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { PrFile, PrStatus, PullRequest } from '../../shared/types'
import { ghAvailable, originUrl, parseGithubRemote } from '../tasks/github'
import type { PrComment, PrMergeMethod, PrProvider } from './provider'

const exec = promisify(execFile)

// Run a `gh` command, throwing a trimmed error on failure. gh writes the useful
// reason to stderr (often several lines, e.g. a GraphQL message) — surface its
// last meaningful line rather than the raw "Command failed: …" execFile dump, so
// the renderer banner reads cleanly.
async function gh(args: string[], opts?: { maxBuffer?: number }): Promise<string> {
  try {
    const { stdout } = await exec('gh', args, { maxBuffer: opts?.maxBuffer ?? 32 * 1024 * 1024 })
    return stdout
  } catch (e) {
    const err = e as { stderr?: string; message?: string }
    const line = (err.stderr ?? err.message ?? 'gh command failed')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .pop()
    throw new Error(line || 'gh command failed')
  }
}

// Resolve a project root to its `owner/repo` GitHub slug, or null when the repo
// has no GitHub origin. Shared by every PR call below.
async function repoSlug(root: string): Promise<string | null> {
  const url = await originUrl(root)
  const repo = url ? parseGithubRemote(url) : null
  return repo ? `${repo.owner}/${repo.repo}` : null
}

// Validate the PR number at the IPC trust boundary before it's interpolated into
// `gh` argv or a REST path — a non-integer (or a leading-dash string) could
// smuggle a flag or alter the API URL.
function prNum(n: number): number {
  if (!Number.isInteger(n) || n <= 0) throw new Error(`Invalid PR number: ${n}`)
  return n
}

const MERGE_METHODS = new Set(['merge', 'squash', 'rebase'])

// The authenticated `gh` user's login — needed to mark which PRs are the viewer's
// own and which request the viewer's review. Cached process-wide (it never
// changes within a session and shells out).
let ghViewerCache: string | null | undefined
async function ghViewer(): Promise<string | null> {
  if (ghViewerCache !== undefined) return ghViewerCache
  try {
    ghViewerCache = (await gh(['api', 'user', '--jq', '.login'])).trim() || null
  } catch {
    ghViewerCache = null
  }
  return ghViewerCache
}

// Settings → Integrations: the current `gh` auth state (authenticated login, if
// any). Best-effort — a missing/​unauthenticated CLI reports `authed: false`.
export async function githubAuth(): Promise<{ authed: boolean; user: string | null }> {
  const user = await ghViewer()
  return { authed: !!user, user }
}

// One record from `gh pr list --json …`.
interface GhPr {
  number: number
  title: string
  author?: { login?: string } | null
  headRefName: string
  baseRefName: string
  isDraft: boolean
  reviewDecision?: string | null
  mergeable?: string | null
  updatedAt: string
  url: string
  additions: number
  deletions: number
  changedFiles: number
  // Requested reviewers who haven't reviewed yet (GitHub clears the request once
  // a review lands). Users carry `login`; teams don't — filtered out below.
  reviewRequests?: { login?: string }[]
}

// Map GitHub's per-file status to the ChangedFile status set the diff list uses.
function mapStatus(s: string): PrFile['status'] {
  if (s === 'added') return 'added'
  if (s === 'removed') return 'deleted'
  return 'modified' // modified / renamed / changed / copied
}

interface GhFile {
  filename: string
  status: string
  additions: number
  deletions: number
  patch?: string
}

export const githubPrProvider: PrProvider = {
  name: 'github',

  // GitHub PRs apply once the origin is a github.com remote. Returns null for a
  // non-GitHub remote so the registry falls through to the next provider;
  // otherwise reports usability (an authenticated `gh`). Mirrors the Tasks
  // panel's status so the PR panel can show the same actionable empty states.
  async detect(root: string): Promise<PrStatus | null> {
    const source = await repoSlug(root)
    if (!source) return null // not a GitHub remote → let another provider try
    if (!(await ghAvailable())) {
      return { available: false, provider: 'github', source, reason: 'GitHub CLI not authenticated — run `gh auth login`' }
    }
    return { available: true, provider: 'github', source, viewer: (await ghViewer()) ?? undefined }
  },

  // List the project's open pull requests, newest activity first.
  async list(root: string): Promise<PullRequest[]> {
    const source = await repoSlug(root)
    if (!source) return []
    const viewer = await ghViewer()
    const stdout = await gh([
      'pr',
      'list',
      '--repo',
      source,
      '--state',
      'open',
      '--limit',
      '200',
      '--json',
      'number,title,author,headRefName,baseRefName,isDraft,reviewDecision,mergeable,updatedAt,url,additions,deletions,changedFiles,reviewRequests'
    ])
    const prs = JSON.parse(stdout) as GhPr[]
    return prs
      .map((p) => ({
        number: p.number,
        title: p.title,
        author: p.author?.login ?? '',
        headRefName: p.headRefName,
        baseRefName: p.baseRefName,
        isDraft: !!p.isDraft,
        reviewDecision: p.reviewDecision ?? null,
        mergeable: p.mergeable ?? null,
        updatedAt: p.updatedAt,
        url: p.url,
        additions: p.additions ?? 0,
        deletions: p.deletions ?? 0,
        changedFiles: p.changedFiles ?? 0,
        isAuthor: !!viewer && (p.author?.login ?? '') === viewer,
        needsMyReview: !!viewer && (p.reviewRequests ?? []).some((r) => r.login === viewer)
      }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  },

  // The changed files of a PR, each with its unified-diff `patch` — fetched in
  // one REST call (`…/pulls/{n}/files`) so the renderer can open any file's diff
  // without a second round-trip or a local checkout. Paginated for large PRs.
  async files(root: string, number: number): Promise<PrFile[]> {
    prNum(number)
    const source = await repoSlug(root)
    if (!source) return []
    const stdout = await gh(
      ['api', '--paginate', `repos/${source}/pulls/${number}/files`, '--jq', '.[] | {filename,status,additions,deletions,patch}'],
      { maxBuffer: 64 * 1024 * 1024 }
    )
    // --jq with --paginate emits one JSON object per line (NDJSON), not an array.
    const files: GhFile[] = stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l) as GhFile)
    return files.map((f) => ({
      relPath: f.filename,
      status: mapStatus(f.status),
      additions: f.additions ?? 0,
      deletions: f.deletions ?? 0,
      patch: f.patch ?? ''
    }))
  },

  // Post a single inline review comment to a PR line (created immediately, not
  // queued in a pending review). `side` is the diff side the anchor sits on —
  // new ('+') maps to GitHub's RIGHT, old ('-') to LEFT. A range comment sets
  // start_line/start_side; `endLine` is always the anchored (last) line.
  async addComment(root: string, number: number, c: PrComment): Promise<void> {
    prNum(number)
    if (c.side !== 'new' && c.side !== 'old') throw new Error(`Invalid comment side: ${c.side}`)
    const source = await repoSlug(root)
    if (!source) throw new Error('No GitHub remote')
    // The comment must anchor to the PR's latest commit.
    const stdout = await gh(['pr', 'view', String(number), '--repo', source, '--json', 'headRefOid'])
    const headSha = (JSON.parse(stdout) as { headRefOid: string }).headRefOid
    const ghSide = c.side === 'old' ? 'LEFT' : 'RIGHT'
    const args = [
      'api',
      '--method',
      'POST',
      `repos/${source}/pulls/${number}/comments`,
      '-f',
      `body=${c.body}`,
      '-f',
      `commit_id=${headSha}`,
      '-f',
      `path=${c.relPath}`,
      '-f',
      `side=${ghSide}`,
      '-F',
      `line=${c.endLine}`
    ]
    if (c.startLine && c.startLine !== c.endLine) {
      args.push('-F', `start_line=${c.startLine}`, '-f', `start_side=${ghSide}`)
    }
    await gh(args)
  },

  // Approve a PR (optionally with a body). Surfaces gh's first error line on
  // failure (e.g. "can not approve your own pull request").
  async approve(root: string, number: number, body?: string): Promise<void> {
    prNum(number)
    const source = await repoSlug(root)
    if (!source) throw new Error('No GitHub remote')
    const args = ['pr', 'review', String(number), '--repo', source, '--approve']
    if (body && body.trim()) args.push('--body', body)
    await gh(args)
  },

  // Merge a PR with the chosen strategy. `gh pr merge` errors when the repo
  // disallows the method or required checks haven't passed — the message is
  // surfaced to the user.
  async merge(root: string, number: number, method: PrMergeMethod): Promise<void> {
    prNum(number)
    if (!MERGE_METHODS.has(method)) throw new Error(`Invalid merge method: ${method}`)
    const source = await repoSlug(root)
    if (!source) throw new Error('No GitHub remote')
    await gh(['pr', 'merge', String(number), '--repo', source, `--${method}`])
  }
}
