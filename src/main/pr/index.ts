import type { PrFile, PrStatus, PullRequest } from '../../shared/types'
import { bitbucketPrProvider } from './bitbucket'
import { githubPrProvider } from './github'
import type { PrComment, PrMergeMethod, PrProvider } from './provider'

// Ordered list of PR backends. The first whose detect() applies (i.e. whose host
// matches the origin remote) wins. GitHub goes first; Bitbucket serves
// bitbucket.org remotes. Everything downstream speaks the normalized
// `PullRequest` / `PrFile`. Mirrors the Tasks provider registry (tasks/index.ts).
const PROVIDERS: PrProvider[] = [githubPrProvider, bitbucketPrProvider]

// Resolve which provider serves this project, plus its status. Walks the list:
// the first to report `available` wins; otherwise we surface the most useful
// "applies but unusable" reason (e.g. a GitHub repo found but gh not authed),
// falling back to a generic "no PR host" message.
async function resolve(root: string): Promise<{ provider?: PrProvider; status: PrStatus }> {
  let firstUnavailable: PrStatus | null = null
  for (const provider of PROVIDERS) {
    const status = await provider.detect(root).catch(() => null)
    if (!status) continue // provider doesn't apply to this project
    if (status.available) return { provider, status }
    if (!firstUnavailable) firstUnavailable = status
  }
  return {
    status: firstUnavailable ?? {
      available: false,
      reason: 'No GitHub or Bitbucket remote — pull requests need a github.com or bitbucket.org origin.'
    }
  }
}

// Whether a PR workflow applies to this project and is usable. Mirrors the Tasks
// panel's status so the PR panel can show the same actionable empty states.
export async function prStatus(root: string): Promise<PrStatus> {
  return (await resolve(root)).status
}

export async function listPrs(root: string): Promise<PullRequest[]> {
  const { provider, status } = await resolve(root)
  if (!provider || !status.available) return []
  return provider.list(root)
}

export async function prFiles(root: string, number: number): Promise<PrFile[]> {
  const { provider, status } = await resolve(root)
  if (!provider || !status.available) return []
  return provider.files(root, number)
}

export async function addPrComment(root: string, number: number, c: PrComment): Promise<void> {
  const { provider, status } = await resolve(root)
  if (!provider || !status.available) throw new Error('No connected PR host')
  return provider.addComment(root, number, c)
}

export async function approvePr(root: string, number: number, body?: string): Promise<void> {
  const { provider, status } = await resolve(root)
  if (!provider || !status.available) throw new Error('No connected PR host')
  return provider.approve(root, number, body)
}

export async function mergePr(root: string, number: number, method: PrMergeMethod): Promise<void> {
  const { provider, status } = await resolve(root)
  if (!provider || !status.available) throw new Error('No connected PR host')
  return provider.merge(root, number, method)
}
