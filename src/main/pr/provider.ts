import type { PrFile, PrStatus, PullRequest } from '../../shared/types'

// The contract every PR backend implements. Keeping the renderer behind this
// interface means adding Bitbucket (and any future host) is one new file + one
// registry line — the PR panel, vim nav, diff view, approve/merge flow already
// speak the normalized `PullRequest` / `PrFile`. Mirrors `tasks/provider.ts`.
export interface PrProvider {
  name: PrStatus['provider']
  // Cheap check: does this host serve the project at `root`, and is it usable
  // right now? Returns null when it doesn't apply at all (so the registry moves
  // on to the next provider); returns a PrStatus (available true/false) when it
  // does — `available:false` carries an actionable reason for the empty state.
  detect(root: string): Promise<PrStatus | null>
  // List the project's open pull requests, newest activity first. Only called
  // after detect() reported `available`.
  list(root: string): Promise<PullRequest[]>
  // The changed files of a PR, each carrying its unified-diff `patch`.
  files(root: string, number: number): Promise<PrFile[]>
  // Post a single inline review comment to a PR line. `side` is the diff side
  // the anchor sits on — 'new' (added) vs 'old' (removed).
  addComment(root: string, number: number, c: PrComment): Promise<void>
  // Approve a PR (optionally with a body).
  approve(root: string, number: number, body?: string): Promise<void>
  // Merge a PR with the chosen strategy.
  merge(root: string, number: number, method: PrMergeMethod): Promise<void>
}

export interface PrComment {
  relPath: string
  side: 'new' | 'old'
  startLine: number
  endLine: number
  body: string
}

export type PrMergeMethod = 'merge' | 'squash' | 'rebase'
