import type { PrFile, PrStatus, PullRequest } from '../../shared/types'
import { originUrl } from '../tasks/github'
import { getBitbucketCreds, type BitbucketCreds } from './bitbucketConfig'
import type { PrComment, PrMergeMethod, PrProvider } from './provider'

// Bitbucket Cloud provider. Auth is HTTP Basic with `email:token` — an Atlassian
// API token with scopes (app passwords are deprecated; see bitbucketConfig), the
// same credential shape Jira uses — against the Cloud REST API 2.0. Credentials
// are global (see bitbucketConfig); the workspace/repo come from each repo's
// `bitbucket.org` remote. The twin of the `gh`-based GitHub provider — same
// `PrProvider` contract, fetch instead of CLI.
//
// Self-hosted Bitbucket Server / Data Center uses a different API and is out of
// scope: `parseBitbucketRemote` only matches the bitbucket.org Cloud host.

const API = 'https://api.bitbucket.org/2.0'

// Parse `workspace/repo` out of a remote URL, handling SSH and HTTPS forms:
//   git@bitbucket.org:workspace/repo.git    →  { workspace, repo }
//   https://bitbucket.org/workspace/repo     →  { workspace, repo }
// Returns null for non-Bitbucket-Cloud remotes (so the provider doesn't apply).
export function parseBitbucketRemote(url: string): { workspace: string; repo: string } | null {
  const m = url.trim().match(/bitbucket\.org[:/]([^/]+)\/(.+?)(?:\.git)?\/?$/i)
  if (!m) return null
  return { workspace: m[1], repo: m[2] }
}

async function repoSlug(root: string): Promise<{ workspace: string; repo: string } | null> {
  const url = await originUrl(root)
  return url ? parseBitbucketRemote(url) : null
}

function authHeader(creds: BitbucketCreds): string {
  return 'Basic ' + Buffer.from(`${creds.email}:${creds.token}`).toString('base64')
}

// The connected account's identity — needed to mark which PRs are the viewer's
// own and which request the viewer's review. `/user` requires the `read:account`
// scope, which a PR-only token may lack: a 403 leaves the viewer unidentified
// (cached as null), and the panel then falls back to a flat, ungrouped list.
// Cached process-wide (it never changes within a session).
let bbViewerCache: { accountId?: string; displayName?: string } | null | undefined
async function bbViewer(creds: BitbucketCreds): Promise<{ accountId?: string; displayName?: string } | null> {
  if (bbViewerCache !== undefined) return bbViewerCache
  try {
    const res = await fetch(`${API}/user`, { headers: { Authorization: authHeader(creds), Accept: 'application/json' } })
    if (!res.ok) {
      bbViewerCache = null
    } else {
      const u = (await res.json()) as { account_id?: string; display_name?: string }
      bbViewerCache = { accountId: u.account_id, displayName: u.display_name }
    }
  } catch {
    bbViewerCache = null
  }
  return bbViewerCache
}

// GET an absolute or API-relative path. Throws a trimmed error on non-2xx so the
// renderer banner reads cleanly (Bitbucket returns `{error:{message}}`).
async function bbGet(creds: BitbucketCreds, url: string, accept = 'application/json'): Promise<Response> {
  const res = await fetch(url.startsWith('http') ? url : `${API}${url}`, {
    headers: { Authorization: authHeader(creds), Accept: accept }
  })
  if (!res.ok) throw new Error(await errorMessage(res))
  return res
}

async function bbPost(creds: BitbucketCreds, path: string, body?: unknown): Promise<Response> {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: {
      Authorization: authHeader(creds),
      Accept: 'application/json',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {})
    },
    body: body !== undefined ? JSON.stringify(body) : undefined
  })
  if (!res.ok) throw new Error(await errorMessage(res))
  return res
}

async function errorMessage(res: Response): Promise<string> {
  // An Atlassian token without the Bitbucket scopes authenticates the identity
  // but is rejected here — point the user at the fix rather than echoing
  // Bitbucket's opaque "token … not supported for this endpoint".
  if (res.status === 401 || res.status === 403)
    return 'Bitbucket rejected the token — it needs the pull-request scopes. Recreate it with Bitbucket scopes via ⌘K → Connect Bitbucket.'
  try {
    const data = (await res.json()) as { error?: { message?: string } }
    if (data.error?.message) return data.error.message
  } catch {
    // fall through to status
  }
  return `Bitbucket responded ${res.status}.`
}

// Validate the PR number at the IPC trust boundary before it's put in a REST path.
function prNum(n: number): number {
  if (!Number.isInteger(n) || n <= 0) throw new Error(`Invalid PR number: ${n}`)
  return n
}

// Validate a set of credentials by hitting /user. Used by the connect modal so
// the user gets immediate confirmation the token works before we save it.
//
// A PR-scoped token deliberately won't carry `read:account`/`read:user:bitbucket`
// — those aren't needed to review PRs — so /user returns 403 *even though the
// token authenticates fine*. We treat 401 as a genuinely bad credential and 403
// as "valid, just no identity scope" (the modal then shows the email instead of
// a display name). Only a real auth failure should block saving.
export async function bitbucketTestCreds(input: {
  email: string
  token: string
}): Promise<{ ok: boolean; displayName?: string; reason?: string }> {
  const creds: BitbucketCreds = {
    email: (input.email ?? '').trim(),
    token: (input.token ?? '').trim()
  }
  if (!creds.email || !creds.token) return { ok: false, reason: 'Email and API token are both required.' }
  try {
    const res = await fetch(`${API}/user`, { headers: { Authorization: authHeader(creds), Accept: 'application/json' } })
    if (res.status === 401) return { ok: false, reason: 'Authentication failed — check the email and API token.' }
    if (res.status === 403) return { ok: true } // authenticates, lacks only the identity scope — fine for PRs
    if (!res.ok) return { ok: false, reason: `Bitbucket responded ${res.status}.` }
    const me = (await res.json()) as { display_name?: string; username?: string }
    return { ok: true, displayName: me.display_name ?? me.username }
  } catch (e) {
    return { ok: false, reason: `Could not reach Bitbucket (${(e as Error).message}).` }
  }
}

// --- list ------------------------------------------------------------------

interface BbParticipant {
  approved?: boolean
  state?: string | null // "approved" | "changes_requested" | null
  role?: string // "REVIEWER" | "PARTICIPANT"
  user?: { account_id?: string }
}
interface BbPr {
  id: number
  title?: string
  draft?: boolean
  author?: { display_name?: string; nickname?: string; account_id?: string }
  source?: { branch?: { name?: string } }
  destination?: { branch?: { name?: string } }
  updated_on?: string
  participants?: BbParticipant[]
  links?: { html?: { href?: string } }
}

// Collapse Bitbucket's per-participant approvals into GitHub's single review
// decision so the panel's existing chips light up unchanged: any explicit
// changes-requested wins; otherwise an approval shows APPROVED; else none.
function reviewDecision(participants?: BbParticipant[]): string | null {
  if (!participants?.length) return null
  if (participants.some((p) => (p.state ?? '').toLowerCase() === 'changes_requested')) return 'CHANGES_REQUESTED'
  if (participants.some((p) => p.approved || (p.state ?? '').toLowerCase() === 'approved')) return 'APPROVED'
  return null
}

// Whether the viewer is a requested reviewer on this PR who still owes a review —
// they're a REVIEWER who hasn't approved and hasn't already requested changes
// (those are "acted", waiting on the author). Drives the top "needs your review"
// group. False when the viewer is unknown.
function needsReview(participants: BbParticipant[] | undefined, viewerId?: string): boolean {
  if (!viewerId || !participants?.length) return false
  return participants.some(
    (p) =>
      p.user?.account_id === viewerId &&
      (p.role ?? '').toUpperCase() === 'REVIEWER' &&
      !p.approved &&
      (p.state ?? '').toLowerCase() !== 'changes_requested'
  )
}

export const bitbucketPrProvider: PrProvider = {
  name: 'bitbucket',

  // Bitbucket PRs apply once the origin is a bitbucket.org remote. Returns null
  // for any other remote (so the registry falls through); otherwise usable iff
  // an API token has been connected.
  async detect(root: string): Promise<PrStatus | null> {
    const repo = await repoSlug(root)
    if (!repo) return null // not a Bitbucket remote → let another provider try
    const source = `${repo.workspace}/${repo.repo}`
    if (!getBitbucketCreds()) {
      return {
        available: false,
        provider: 'bitbucket',
        source,
        reason: 'Connect Bitbucket — set an API token (⌘K → Connect Bitbucket)'
      }
    }
    return { available: true, provider: 'bitbucket', source, viewer: (await bbViewer(getBitbucketCreds()!))?.displayName }
  },

  // Open PRs, newest activity first. additions/deletions/changedFiles aren't in
  // the list response and a per-PR diffstat would be N extra requests, so they
  // stay 0 here — the real counts appear per file once a PR is opened.
  async list(root: string): Promise<PullRequest[]> {
    const creds = getBitbucketCreds()
    const repo = await repoSlug(root)
    if (!creds || !repo) return []
    const viewer = await bbViewer(creds)
    const base = `${repo.workspace}/${repo.repo}`
    const prs: BbPr[] = []
    // The default list response omits `participants`/`author.account_id`, so the
    // review chip and the queue grouping would have nothing to key off — pull the
    // needed sub-fields into the list with `fields` (the `+` prefix adds to the
    // default set). Bitbucket carries this query through to the `next` page links,
    // so pagination keeps it.
    const fields = encodeURIComponent(
      '+values.participants.state,+values.participants.approved,+values.participants.role,+values.participants.user.account_id,+values.author.account_id'
    )
    let next: string | undefined = `${API}/repositories/${base}/pullrequests?state=OPEN&pagelen=50&fields=${fields}`
    for (let i = 0; i < 20 && next; i++) {
      const res = await bbGet(creds, next)
      const page = (await res.json()) as { values?: BbPr[]; next?: string }
      prs.push(...(page.values ?? []))
      next = page.next
    }
    return prs
      .map((p) => ({
        number: p.id,
        title: p.title ?? '',
        author: p.author?.display_name ?? p.author?.nickname ?? '',
        headRefName: p.source?.branch?.name ?? '',
        baseRefName: p.destination?.branch?.name ?? '',
        isDraft: !!p.draft,
        reviewDecision: reviewDecision(p.participants),
        mergeable: null, // no cheap mergeability field on Cloud
        updatedAt: p.updated_on ?? new Date(0).toISOString(),
        url: p.links?.html?.href ?? '',
        additions: 0,
        deletions: 0,
        changedFiles: 0,
        isAuthor: !!viewer?.accountId && p.author?.account_id === viewer.accountId,
        needsMyReview: needsReview(p.participants, viewer?.accountId)
      }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  },

  // The changed files of a PR. The diffstat gives the file list (status + line
  // counts); the raw `/diff` gives one unified diff for the whole PR, which we
  // slice per file so the renderer can show any file's hunks without a checkout.
  async files(root: string, number: number): Promise<PrFile[]> {
    prNum(number)
    const creds = getBitbucketCreds()
    const repo = await repoSlug(root)
    if (!creds || !repo) return []
    const base = `${repo.workspace}/${repo.repo}/pullrequests/${number}`

    // diffstat — paginated metadata: per-file status and line counts.
    const stats: BbDiffstat[] = []
    let next: string | undefined = `${API}/repositories/${base}/diffstat?pagelen=500`
    for (let i = 0; i < 20 && next; i++) {
      const res = await bbGet(creds, next)
      const page = (await res.json()) as { values?: BbDiffstat[]; next?: string }
      stats.push(...(page.values ?? []))
      next = page.next
    }

    // raw unified diff for the whole PR, sliced into one patch per file path.
    const raw = await (await bbGet(creds, `/repositories/${base}/diff`, 'text/plain')).text()
    const patches = splitUnifiedDiff(raw)

    return stats.map((s) => {
      const path = s.new?.path ?? s.old?.path ?? ''
      return {
        relPath: path,
        status: mapStatus(s.status),
        additions: s.lines_added ?? 0,
        deletions: s.lines_removed ?? 0,
        patch: patches.get(path) ?? ''
      }
    })
  },

  // Post a single inline comment. Bitbucket anchors inline comments to one line:
  // `inline.to` for the new side, `inline.from` for the old side. The panel's
  // range selection collapses to the anchored (last) line.
  async addComment(root: string, number: number, c: PrComment): Promise<void> {
    prNum(number)
    if (c.side !== 'new' && c.side !== 'old') throw new Error(`Invalid comment side: ${c.side}`)
    const creds = getBitbucketCreds()
    const repo = await repoSlug(root)
    if (!creds || !repo) throw new Error('No Bitbucket remote')
    const inline = c.side === 'old' ? { path: c.relPath, from: c.endLine } : { path: c.relPath, to: c.endLine }
    await bbPost(creds, `/repositories/${repo.workspace}/${repo.repo}/pullrequests/${number}/comments`, {
      content: { raw: c.body },
      inline
    })
  },

  async approve(root: string, number: number): Promise<void> {
    prNum(number)
    const creds = getBitbucketCreds()
    const repo = await repoSlug(root)
    if (!creds || !repo) throw new Error('No Bitbucket remote')
    // Bitbucket's approve endpoint takes no body — a review note can't ride along.
    await bbPost(creds, `/repositories/${repo.workspace}/${repo.repo}/pullrequests/${number}/approve`)
  },

  // Merge with the chosen strategy. Bitbucket's strategies are merge_commit /
  // squash / fast_forward, so `rebase` maps to fast_forward (the nearest — not a
  // true rebase). The API errors when the strategy is disallowed; surfaced as-is.
  async merge(root: string, number: number, method: PrMergeMethod): Promise<void> {
    prNum(number)
    const strategy = MERGE_STRATEGY[method]
    if (!strategy) throw new Error(`Invalid merge method: ${method}`)
    const creds = getBitbucketCreds()
    const repo = await repoSlug(root)
    if (!creds || !repo) throw new Error('No Bitbucket remote')
    await bbPost(creds, `/repositories/${repo.workspace}/${repo.repo}/pullrequests/${number}/merge`, {
      merge_strategy: strategy
    })
  }
}

const MERGE_STRATEGY: Record<PrMergeMethod, string> = {
  merge: 'merge_commit',
  squash: 'squash',
  rebase: 'fast_forward'
}

// --- diff helpers ----------------------------------------------------------

interface BbDiffstat {
  status: string // "added" | "removed" | "modified" | "renamed"
  lines_added?: number
  lines_removed?: number
  old?: { path?: string } | null
  new?: { path?: string } | null
}

function mapStatus(s: string): PrFile['status'] {
  if (s === 'added') return 'added'
  if (s === 'removed') return 'deleted'
  return 'modified' // modified / renamed
}

// Split a whole-PR unified diff into one patch per file, keyed by the file's new
// path (its `b/` side; the old `a/` path for deletions). Each patch starts at the
// file's first `@@` hunk — the renderer's parseUnifiedDiff skips the preamble, and
// this keeps parity with GitHub's per-file `patch` field. Binary files (no `@@`)
// map to an empty patch.
function splitUnifiedDiff(raw: string): Map<string, string> {
  const out = new Map<string, string>()
  if (!raw.trim()) return out
  // Each file section begins with a `diff --git a/<old> b/<new>` header.
  const sections = raw.split(/^diff --git /m).filter((s) => s.trim())
  for (const section of sections) {
    const header = section.slice(0, section.indexOf('\n') === -1 ? undefined : section.indexOf('\n'))
    const m = header.match(/^a\/(.+) b\/(.+)$/)
    const path = m ? m[2] : null
    if (!path) continue
    const at = section.indexOf('\n@@')
    out.set(path, at === -1 ? '' : section.slice(at + 1))
  }
  return out
}
