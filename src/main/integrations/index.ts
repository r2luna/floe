// Open a worktree from a pull request or an issue. The form and the MCP tools
// both come through here, whichever service answers.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { floeConfig } from '../config/floe'
import { branchExists, createWorktree, fetchPullRequest, listWorktrees } from '../git'
import { writePremise } from '../premise'
import {
  SOURCE_LABELS,
  isIssueBranch,
  parseSourceRef,
  pickRemote,
  sourceBranch,
  sourceLabel,
  sourceWorktreePremise,
  type ForgeRepo,
  type SourceId,
  type SourceItem,
  type SourceSearch
} from '../../shared/worktreeSource'
import type { Worktree } from '../../shared/types'
import { SOURCE_FAILURE } from '../../shared/worktreeError'
import { bitbucketBackend } from './bitbucket'
import { readCredentials } from './credentials'
import { githubBackend, ghLoggedIn } from './github'
import { ApiError } from './http'
import { jiraBackend, jiraOrigin } from './jira'
import type { SourceBackend } from './types'

const exec = promisify(execFile)

const remotesOf = async (root: string): Promise<string> =>
  (await exec('git', ['-C', root, 'remote', '-v'])).stdout

/**
 * The tabs this project gets. A forge only where a remote points at it, since its
 * PRs mean nothing anywhere else. Jira always: an issue tracker is not tied to a
 * remote, and the tab is also where Floe says the keys are missing.
 */
export async function availableSources(root: string): Promise<SourceId[]> {
  const remotes = await remotesOf(root).catch(() => '')
  return [
    ...(pickRemote(remotes, 'github.com') ? (['github'] as const) : []),
    ...(pickRemote(remotes, 'bitbucket.org') ? (['bitbucket'] as const) : []),
    'jira'
  ]
}

interface Opened {
  backend: SourceBackend
  /** Absent on Jira, which has no repository of its own. */
  repo?: ForgeRepo
}

const missingKeys = (source: SourceId, what: string): Error =>
  new Error(`Add your ${SOURCE_LABELS[source]} ${what} in Settings, under Integrations.`)

async function forgeRepo(root: string, source: SourceId, host: 'github.com' | 'bitbucket.org'): Promise<ForgeRepo> {
  const repo = pickRemote(await remotesOf(root), host)
  if (!repo) throw new Error(`This project has no ${SOURCE_LABELS[source]} remote.`)
  return repo
}

async function openSource(root: string, source: SourceId): Promise<Opened> {
  const keys = readCredentials()
  if (source === 'github') {
    const repo = await forgeRepo(root, source, 'github.com')
    return { repo, backend: githubBackend(repo.slug) }
  }
  if (source === 'bitbucket') {
    const repo = await forgeRepo(root, source, 'bitbucket.org')
    const { email, token } = keys.bitbucket ?? {}
    if (!email || !token) throw missingKeys(source, 'email and API token')
    return { repo, backend: bitbucketBackend(repo.slug, email, token) }
  }
  const { site, email, token } = keys.jira ?? {}
  if (!site || !email || !token) throw missingKeys(source, 'site, email and API token')
  return { backend: jiraBackend(site, email, token) }
}

/** Why it failed, as a sentence with the next step in it. */
export function explainSourceFailure(source: SourceId, error: unknown): string {
  const name = SOURCE_LABELS[source]
  if (error instanceof ApiError) {
    return error.status === 401 || error.status === 403
      ? `${name} refused the key. Check it in Settings, under Integrations.`
      : `${name} answered ${error.message}.`
  }
  const failure = error as { stderr?: string; name?: string; message?: string }
  if (failure.name === 'TimeoutError' || failure.message === 'fetch failed') return `Could not reach ${name}.`
  return (failure.stderr?.trim() || failure.message || `${name} failed.`).split('\n')[0]
}

/**
 * The form's list: open PRs and issues, a text search over them, or the one item
 * a number, key or URL names. Never rejects, since every failure here is
 * something the form shows in place of the list.
 */
export async function searchSource(root: string, source: SourceId, query = ''): Promise<SourceSearch> {
  try {
    const { backend, repo } = await openSource(root, source)
    const ref = parseSourceRef(source, query)
    if (ref?.slug && repo && ref.slug.toLowerCase() !== repo.slug.toLowerCase()) {
      return { items: [], error: `That link is in ${ref.slug}. This project is ${repo.slug}.` }
    }
    if (ref) {
      const item = await backend.view(ref.ref)
      return { items: item ? [item] : [] }
    }
    return { items: await backend.search(query.trim().replace(/^#/, '')) }
  } catch (e) {
    return { items: [], error: explainSourceFailure(source, e) }
  }
}

export interface SourceWorktree {
  worktrees: Worktree[]
  branch: string
  item: SourceItem
  /** It already had a worktree: nothing was created, so nothing needs provisioning. */
  existed: boolean
}

async function resolveItem(
  root: string,
  source: SourceId,
  ref: string
): Promise<{ repo?: ForgeRepo; item: SourceItem }> {
  let found: { repo?: ForgeRepo; item: SourceItem | null }
  try {
    const { backend, repo } = await openSource(root, source)
    found = { repo, item: await backend.view(ref) }
  } catch (e) {
    throw new Error(SOURCE_FAILURE + explainSourceFailure(source, e))
  }
  if (found.item) return { repo: found.repo, item: found.item }
  const named = sourceLabel({ source, ref })
  throw new Error(`${SOURCE_FAILURE}${named} is not a pull request or issue in ${found.repo?.slug ?? SOURCE_LABELS[source]}.`)
}

// Where a fork's head can be fetched from, when the source has no ref for it in
// the base repository: the project's own remote URL, pointed at the fork.
async function forkUrl(root: string, repo: ForgeRepo, item: SourceItem): Promise<string | undefined> {
  if (!item.forkSlug) return undefined
  const { stdout } = await exec('git', ['-C', root, 'remote', 'get-url', repo.remote])
  return stdout.trim().replace(repo.slug, item.forkSlug)
}

// Fetches the head, and answers with the PR's target when it exists locally. One
// that was never fetched falls back to the project's main branch.
async function pullBase(root: string, repo: ForgeRepo, item: SourceItem, branch: string): Promise<string | undefined> {
  await fetchPullRequest(
    root,
    repo.remote,
    { id: item.ref, head: item.head ?? '', fork: Boolean(item.fork), forkUrl: await forkUrl(root, repo, item) },
    branch
  )
  return item.base && (await branchExists(root, item.base)) ? item.base : undefined
}

const sourceKey = (branch: string): string => `branch.${branch}.floe-source`
const sourceId = (item: SourceItem): string => `${item.source}:${item.ref}`

/**
 * The worktree of an issue retitled since it was opened, whose branch name no
 * longer matches. The number alone cannot say so: `275-…` may be local task 275's,
 * so the branch has to carry the source it was made for.
 */
async function retitledWorktree(root: string, current: Worktree[], item: SourceItem): Promise<Worktree | undefined> {
  if (item.kind !== 'issue') return undefined
  for (const tree of current.filter((w) => isIssueBranch(w.branch, item))) {
    const said = await exec('git', ['-C', root, 'config', '--get', sourceKey(tree.branch)]).catch(() => null)
    if (said?.stdout.trim() === sourceId(item)) return tree
  }
  return undefined
}

/**
 * The worktree for a PR or issue, created if it has none.
 *
 * A PR checks out its head and records the branch it merges into, so review and
 * merge target what the PR targets. An issue forks a new branch from `base`.
 */
export async function createWorktreeFromSource(
  root: string,
  source: SourceId,
  ref: string,
  options: { base?: string; writePremise?: boolean } = {}
): Promise<SourceWorktree> {
  const { repo, item } = await resolveItem(root, source, ref)
  const branch = sourceBranch(item, { lowercase: floeConfig().worktree.lowercase })
  const current = await listWorktrees(root)
  const found = current.find((w) => w.branch === branch) ?? (await retitledWorktree(root, current, item))
  if (found) return { worktrees: current, branch: found.branch, item, existed: true }

  const base = item.kind === 'pr' && repo ? await pullBase(root, repo, item, branch) : options.base
  const worktrees = await createWorktree(root, branch, { base, exact: true })
  if (item.kind === 'issue') await exec('git', ['-C', root, 'config', sourceKey(branch), sourceId(item)])
  const created = worktrees.find((w) => w.branch === branch)
  if (created && options.writePremise) writePremise(created.path, sourceWorktreePremise(item))
  return { worktrees, branch, item, existed: false }
}

/** One source's section in the tasks panel. */
export interface TaskIssues {
  source: SourceId
  items: SourceItem[]
  error?: string
}

/**
 * The issues the tasks panel lists under its local tasks. GitHub where a remote
 * points there. Jira once its keys are saved: without them it is a project that
 * does not use Jira, not a problem to report on every open. Bitbucket is left out,
 * since issues there are rare, and a PR is not a task.
 */
export async function listTaskIssues(root: string): Promise<TaskIssues[]> {
  const { site, email, token } = readCredentials().jira ?? {}
  const sources = (await availableSources(root)).filter(
    (source) => source === 'github' || (source === 'jira' && site && email && token)
  )
  return Promise.all(
    sources.map(async (source) => {
      const { items, error } = await searchSource(root, source)
      return { source, items: items.filter((i) => i.kind === 'issue'), error }
    })
  )
}

/** What Settings shows. Whether a key is saved, and never the key. */
export interface IntegrationStatus {
  github: { gh: boolean; token: boolean }
  bitbucket: { email: string; token: boolean }
  jira: { site: string; email: string; token: boolean }
}

export async function integrationStatus(): Promise<IntegrationStatus> {
  const { github, bitbucket, jira } = readCredentials()
  return {
    github: { gh: await ghLoggedIn(), token: Boolean(github?.token) },
    bitbucket: { email: bitbucket?.email ?? '', token: Boolean(bitbucket?.token) },
    jira: { site: jira?.site ? jiraOrigin(jira.site) : '', email: jira?.email ?? '', token: Boolean(jira?.token) }
  }
}
