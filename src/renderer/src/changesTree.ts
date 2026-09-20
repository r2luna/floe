import type { ChangedFile, SubmoduleState } from '../../shared/types'

/**
 * The changes list, grouped by directory — and by repo.
 *
 * A branch that touches hundreds of files under one folder reads as hundreds of
 * rows sharing a prefix too long to show the names. As a tree it reads as a
 * handful of folders you open one at a time.
 *
 * A submodule is a folder that happens to be a repo, so it takes a folder's
 * row, nested wherever it sits — inside another submodule included. Its files
 * hang under it with the submodule's own paths, because a path only means
 * something relative to the repo that holds it.
 */

export interface ChangeDir {
  type: 'dir'
  /** Worktree-relative, no trailing slash. */
  path: string
  /** What the row shows: one segment, or a chain of single-child folders (`docs/design/projects`). */
  name: string
  files: number
  additions: number
  deletions: number
  children: ChangeNode[]
}

export interface ChangeRepo {
  type: 'repo'
  /** Worktree-relative, like a folder's. */
  path: string
  /** From the repo that records it: `packages/ui` under `app`. */
  name: string
  state: SubmoduleState
  files: number
  additions: number
  deletions: number
  /** Its own files not yet committed — what "dirty" on the row counts. */
  uncommitted: number
  children: ChangeNode[]
}

export interface ChangeLeaf {
  type: 'file'
  path: string
  name: string
  file: ChangedFile
}

export type ChangeNode = ChangeDir | ChangeLeaf | ChangeRepo
type Branch = ChangeDir | ChangeRepo

export interface ChangeRow {
  node: ChangeNode
  depth: number
  /** The directory (or repo) row this one sits under, '' at the top. */
  parent: string
}

/**
 * Up to this many files, every folder starts open — the whole list fits on
 * screen and a click to see it would be a click for nothing.
 */
export const OPEN_ALL_UP_TO = 40

/**
 * `flat` skips the folders: every file is one row under its repo, named by its
 * whole path there. The repos stay — a path only reads relative to its own.
 */
export function buildChangeTree(files: ChangedFile[], repos: SubmoduleState[] = [], flat = false): ChangeNode[] {
  const root: ChangeDir = { type: 'dir', path: '', name: '', files: 0, additions: 0, deletions: 0, children: [] }
  const byRepo = new Map<string, Branch>([['', root]])
  // Parents sort before their children, so a nested repo finds its holder.
  for (const state of [...repos].sort((a, b) => a.path.localeCompare(b.path))) {
    const holder = byRepo.get(state.parent) ?? root
    const name = holder.type === 'repo' ? state.path.slice(holder.path.length + 1) : state.path
    const node: ChangeRepo = {
      type: 'repo',
      path: state.path,
      name,
      state,
      files: 0,
      additions: 0,
      deletions: 0,
      uncommitted: 0,
      children: []
    }
    holder.children.push(node)
    byRepo.set(state.path, node)
  }
  for (const file of files) {
    const owner = byRepo.get(file.repo ?? '') ?? root
    const rel = owner.type === 'repo' ? file.relPath.slice(owner.path.length + 1) : file.relPath
    if (owner.type === 'repo' && !file.committed) owner.uncommitted++
    const parts = rel.split('/')
    let dir: Branch = owner
    if (!flat)
      for (let i = 0; i < parts.length - 1; i++) {
        const path = [owner.path, ...parts.slice(0, i + 1)].filter(Boolean).join('/')
        let next = dir.children.find((c): c is ChangeDir => c.type === 'dir' && c.path === path)
        if (!next) {
          next = { type: 'dir', path, name: parts[i], files: 0, additions: 0, deletions: 0, children: [] }
          dir.children.push(next)
        }
        dir = next
      }
    dir.children.push({ type: 'file', path: file.relPath, name: flat ? rel : parts[parts.length - 1], file })
  }
  return prune(finish(root)).children
}

// Folders first, then files, then repos: a repo's rows are a list of their own,
// and reading them after the holder's files keeps each list in one piece.
const ORDER = { dir: 0, file: 1, repo: 2 } as const

// Totals, the single-child fold and the order — one bottom-up pass.
function finish<T extends Branch>(dir: T): T {
  dir.children = dir.children.map((c) => (c.type === 'file' ? c : c.type === 'dir' ? fold(finish(c)) : finish(c)))
  for (const c of dir.children) {
    const [n, add, del] = c.type === 'file' ? [1, c.file.additions, c.file.deletions] : [c.files, c.additions, c.deletions]
    dir.files += n
    dir.additions += add
    dir.deletions += del
  }
  dir.children.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : ORDER[a.type] - ORDER[b.type]))
  return dir
}

// A folder whose only child is a folder carries no choice to make: merge it
// into its child so `docs/design/projects` is one row, not three to open.
function fold(dir: ChangeDir): ChangeDir {
  const only = dir.children.length === 1 ? dir.children[0] : undefined
  return only?.type === 'dir' ? { ...only, name: `${dir.name}/${only.name}` } : dir
}

// A repo with nothing to say — no files, pointer where its parent left it,
// nothing under it either — is not a change, so it is not a row.
function prune<T extends Branch>(dir: T): T {
  dir.children = dir.children.filter((c) => {
    if (c.type !== 'repo') return true
    prune(c)
    return c.files > 0 || repoMoved(c.state) || c.children.some((g) => g.type === 'repo')
  })
  return dir
}

/** The checkout is not at the commit its parent has on record. */
export function repoMoved(state: SubmoduleState): boolean {
  return state.ahead > 0 || (!!state.recorded && state.head !== state.recorded)
}

const short = (sha: string): string => sha.slice(0, 7)

/**
 * What the repo row says on the right: the branch (or the detached commit),
 * how far HEAD moved from what the parent recorded, and whether its own tree
 * is clean. `moved` is the amber case — the parent does not have this yet.
 */
export function repoRef(node: ChangeRepo): { text: string; moved: boolean } {
  const s = node.state
  const parts: string[] = []
  if (s.ahead > 0) parts.push(s.branch ?? short(s.head), `+${s.ahead} ${s.ahead === 1 ? 'commit' : 'commits'}`)
  else if (repoMoved(s)) parts.push(`${short(s.recorded)} → ${short(s.head)}`)
  else parts.push(s.branch ?? short(s.head))
  parts.push(node.uncommitted ? 'dirty' : 'clean')
  return { text: parts.join(' · '), moved: repoMoved(s) }
}

/** How many repo rows the tree holds, at every depth. */
export function countRepos(nodes: ChangeNode[]): number {
  let n = 0
  for (const node of nodes) if (node.type !== 'file') n += (node.type === 'repo' ? 1 : 0) + countRepos(node.children)
  return n
}

/**
 * Whether a folder starts open. Small lists open everything; large ones open
 * only the top level, so the first screen is the shape of the change rather
 * than its first few hundred files.
 */
export function openByDefault(depth: number, total: number): boolean {
  return total <= OPEN_ALL_UP_TO || depth === 0
}

/**
 * The visible rows, in order. A folder is open when its default says so, unless
 * the user flipped it — `flipped` holds the paths toggled away from the default,
 * so folders that appear later still get the right default.
 */
export function flattenChanges(
  nodes: ChangeNode[],
  total: number,
  flipped: ReadonlySet<string>,
  depth = 0,
  parent = '',
  acc: ChangeRow[] = []
): ChangeRow[] {
  for (const node of nodes) {
    acc.push({ node, depth, parent })
    if (node.type !== 'file' && isOpen(node.path, depth, total, flipped))
      flattenChanges(node.children, total, flipped, depth + 1, node.path, acc)
  }
  return acc
}

export function isOpen(path: string, depth: number, total: number, flipped: ReadonlySet<string>): boolean {
  return openByDefault(depth, total) !== flipped.has(path)
}
