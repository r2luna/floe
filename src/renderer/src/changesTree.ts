import type { ChangedFile } from '../../shared/types'

/**
 * The changes list, grouped by directory.
 *
 * A branch that touches hundreds of files under one folder reads as hundreds of
 * rows sharing a prefix too long to show the names. As a tree it reads as a
 * handful of folders you open one at a time.
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

export interface ChangeLeaf {
  type: 'file'
  path: string
  name: string
  file: ChangedFile
}

export type ChangeNode = ChangeDir | ChangeLeaf

export interface ChangeRow {
  node: ChangeNode
  depth: number
  /** The directory row this one sits under, '' at the top. */
  parent: string
}

/**
 * Up to this many files, every folder starts open — the whole list fits on
 * screen and a click to see it would be a click for nothing.
 */
export const OPEN_ALL_UP_TO = 40

export function buildChangeTree(files: ChangedFile[]): ChangeNode[] {
  const root: ChangeDir = { type: 'dir', path: '', name: '', files: 0, additions: 0, deletions: 0, children: [] }
  for (const file of files) {
    const parts = file.relPath.split('/')
    let dir = root
    for (let i = 0; i < parts.length - 1; i++) {
      const path = parts.slice(0, i + 1).join('/')
      let next = dir.children.find((c): c is ChangeDir => c.type === 'dir' && c.path === path)
      if (!next) {
        next = { type: 'dir', path, name: parts[i], files: 0, additions: 0, deletions: 0, children: [] }
        dir.children.push(next)
      }
      dir = next
    }
    dir.children.push({ type: 'file', path: file.relPath, name: parts[parts.length - 1], file })
  }
  return finish(root).children
}

// Totals, the single-child fold and the order — one bottom-up pass.
function finish(dir: ChangeDir): ChangeDir {
  dir.children = dir.children.map((c) => (c.type === 'dir' ? fold(finish(c)) : c))
  for (const c of dir.children) {
    const [n, add, del] = c.type === 'dir' ? [c.files, c.additions, c.deletions] : [1, c.file.additions, c.file.deletions]
    dir.files += n
    dir.additions += add
    dir.deletions += del
  }
  // Folders first, then files, each by name — the order the files tree uses.
  dir.children.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1))
  return dir
}

// A folder whose only child is a folder carries no choice to make: merge it
// into its child so `docs/design/projects` is one row, not three to open.
function fold(dir: ChangeDir): ChangeDir {
  const only = dir.children.length === 1 ? dir.children[0] : undefined
  return only?.type === 'dir' ? { ...only, name: `${dir.name}/${only.name}` } : dir
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
    if (node.type === 'dir' && isOpen(node.path, depth, total, flipped))
      flattenChanges(node.children, total, flipped, depth + 1, node.path, acc)
  }
  return acc
}

export function isOpen(path: string, depth: number, total: number, flipped: ReadonlySet<string>): boolean {
  return openByDefault(depth, total) !== flipped.has(path)
}
