import type { Worktree, WorktreeStatus } from '../../shared/types'

/**
 * What the top bar says about the worktree you are in, read off the sidebar's
 * git status (see mocks/topbar.html for every state drawn out).
 *
 * `merge` is the last group, the one you act on:
 * - `main` the main worktree, which merges into nothing;
 * - `blocked` a `.gw-nomerge` worktree;
 * - `commit-first` uncommitted files, which the merge preflight would refuse;
 * - `nothing` no commits the base lacks: fresh, or already merged;
 * - `ready` commits to merge (the bar warns when `base.behind` says the base moved on);
 * - `unknown` no status yet, or no base: git could not resolve it, or the tree is on it.
 */
export type MergeState = 'main' | 'blocked' | 'commit-first' | 'nothing' | 'ready' | 'unknown'

export interface TopBarState {
  /** Files still to commit, per kind. Absent when the tree is clean. */
  dirty?: { added: number; modified: number; deleted: number }
  /** Commits to push to, and to pull from, the upstream. */
  push: number
  pull: number
  merge: MergeState
  /** The branch it merges into, and how far apart the two are. */
  base?: { name: string; ahead: number; behind: number }
}

export function topBarState(worktree: Worktree | undefined, status: WorktreeStatus | undefined): TopBarState {
  const { added = 0, modified = 0, deleted = 0, ahead = 0, behind = 0 } = status ?? {}
  const dirty = added + modified + deleted > 0 ? { added, modified, deleted } : undefined
  const base = status?.base
  return { dirty, push: ahead, pull: behind, base, merge: mergeState(worktree, status, !!dirty) }
}

function mergeState(worktree: Worktree | undefined, status: WorktreeStatus | undefined, dirty: boolean): MergeState {
  if (worktree?.isMain) return 'main'
  if (worktree?.blocked) return 'blocked'
  // No base, nothing to say about merging — even with files to commit. A tree
  // sitting on its own base (a main checkout the list did not flag) has
  // nothing to merge into, so "merge after commit" would be a promise.
  if (!status?.base) return 'unknown'
  if (dirty) return 'commit-first'
  return status.base.ahead > 0 ? 'ready' : 'nothing'
}
