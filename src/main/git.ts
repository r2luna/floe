import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  ChangedFile,
  CommitFileRef,
  RemoteBranch,
  RemoveBranchResult,
  RemovePreflight,
  ReviewCommit,
  Worktree
} from '../shared/types'
import { slugifyBranch } from '../shared/slug'
import { forgetWorktree, getReviewCheckpoint, setReviewCheckpoint } from './sessionStore'
import { cancelProvision } from './provisionRuns'

const exec = promisify(execFile)

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', ['-C', root, ...args])
  return stdout
}

// Like git(), but with the project's git hooks disabled. The merge flow drives
// commits itself, so a project's commit-time hooks (husky, CaptainHook, etc.)
// must not run — they often shell out to a toolchain (php, node) that isn't on
// the app's PATH and would fail the merge with a misleading "Command failed".
async function gitNoHooks(root: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', ['-C', root, '-c', 'core.hooksPath=/dev/null', ...args])
  return stdout
}

// Like git(), but tolerates a non-zero exit and returns whatever landed on
// stdout. `git diff --no-index` exits 1 whenever the files differ, so a plain
// git() would throw away the diff we actually want.
async function gitAllowFail(root: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await exec('git', ['-C', root, ...args])
    return stdout
  } catch (e) {
    const err = e as { stdout?: string }
    if (typeof err.stdout === 'string') return err.stdout
    throw e
  }
}

export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    return (await git(dir, ['rev-parse', '--is-inside-work-tree'])).trim() === 'true'
  } catch {
    return false
  }
}

export async function repoRoot(dir: string): Promise<string | null> {
  try {
    return (await git(dir, ['rev-parse', '--show-toplevel'])).trim() || null
  } catch {
    return null
  }
}

// gw conventions ----------------------------------------------------------

const sanitizeBranch = (branch: string): string => branch.replace(/\//g, '-')

async function branchExists(root: string, branch: string): Promise<boolean> {
  try {
    await git(root, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])
    return true
  } catch {
    return false
  }
}

// Detect the base branch the way gw does: origin/HEAD, then main/master,
// then the currently checked-out branch.
async function mainBranch(root: string): Promise<string> {
  try {
    const ref = (await git(root, ['symbolic-ref', 'refs/remotes/origin/HEAD'])).trim()
    const name = ref.replace('refs/remotes/origin/', '')
    if (name) return name
  } catch {
    /* no origin/HEAD */
  }
  for (const b of ['main', 'master']) {
    if (await branchExists(root, b)) return b
  }
  try {
    const cur = (await git(root, ['branch', '--show-current'])).trim()
    if (cur) return cur
  } catch {
    /* detached */
  }
  return 'HEAD'
}

/** The branch a worktree forks from when nobody named one. */
export async function defaultBranch(root: string): Promise<string> {
  return mainBranch(root)
}

/**
 * The worktree that has `branch` checked out, main or linked, or undefined.
 *
 * A branch checked out somewhere can only be moved from inside that tree: `git
 * checkout` of it anywhere else is refused, and so is `branch -f`.
 */
async function holderOf(root: string, branch: string): Promise<string | undefined> {
  const out = await git(root, ['worktree', 'list', '--porcelain']).catch(() => '')
  return parseWorktreePorcelain(out).find((e) => e.branch === branch)?.path
}

/**
 * Has `branch` landed on `base`? True when its tip is an ancestor of base.
 *
 * A branch with no commits of its own is trivially an ancestor too, so this
 * cannot tell "merged" from "never started" — the caller has to know the work
 * was finished before it asks.
 */
export async function isMergedInto(root: string, branch: string, base: string): Promise<boolean> {
  try {
    await git(root, ['merge-base', '--is-ancestor', branch, base])
    return true
  } catch {
    return false
  }
}

/**
 * Uncommitted work in a tree, not counting Floe's own `.gw-*` markers — those
 * are written by Floe into every tree it cuts, and are not anybody's work.
 */
export async function uncommittedWork(path: string): Promise<string[]> {
  const out = await git(path, ['status', '--porcelain']).catch(() => '')
  return out
    .split('\n')
    .map((l) => l.slice(3).trim())
    .filter((f) => f && !f.startsWith('.gw-'))
}

/** Point `branch` at `sha` again, if it no longer exists. True when the branch exists afterwards. */
export async function restoreBranch(root: string, branch: string, sha: string): Promise<boolean> {
  if (await branchExists(root, branch)) return true
  try {
    await git(root, ['branch', branch, sha])
    return true
  } catch {
    return false
  }
}

async function isDirty(path: string): Promise<boolean> {
  try {
    return (await git(path, ['status', '--porcelain'])).trim().length > 0
  } catch {
    return false
  }
}

function readNote(path: string): string | undefined {
  const file = join(path, '.gw-note')
  if (!existsSync(file)) return undefined
  return readFileSync(file, 'utf8').split('\n')[0].trim() || undefined
}

// The cached AI description for a worktree — a `.gw-desc` marker written by the
// Haiku pass (see generateWorktreeDesc). Absent until the worktree has a spec.md
// and the pass has run; regenerated when spec.md changes (mtime compare there).
function readDesc(path: string): string | undefined {
  const file = join(path, '.gw-desc')
  if (!existsSync(file)) return undefined
  return readFileSync(file, 'utf8').trim() || undefined
}

// Persisted navigation order for a repo's worktrees. `git worktree list` returns
// them alphabetically, so without this a freshly-created worktree could land
// anywhere (stealing the ⌘1/⌘2 slots). We keep an explicit list of paths under
// <root>/.worktrees/.order.json; new worktrees are appended (see createWorktree)
// so they always go to the end of the queue. The main worktree is pinned first
// separately and never recorded here.
function orderFile(root: string): string {
  return join(root, '.worktrees', '.order.json')
}

function readOrder(root: string): string[] {
  const file = orderFile(root)
  if (!existsSync(file)) return []
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'))
    return Array.isArray(data) ? data.filter((p): p is string => typeof p === 'string') : []
  } catch {
    return []
  }
}

function writeOrder(root: string, order: string[]): void {
  try {
    mkdirSync(join(root, '.worktrees'), { recursive: true })
    writeFileSync(orderFile(root), JSON.stringify(order, null, 2))
  } catch {
    // Best-effort: a missing order file just falls back to git's order.
  }
}

// Persist a new navigation order (the drag-and-drop reorder in the sidebar).
// `orderedPaths` is the non-main worktree paths in their new order; listWorktrees
// re-reads it, self-heals, and returns the freshly-sorted list.
export async function reorderWorktrees(root: string, orderedPaths: string[]): Promise<Worktree[]> {
  writeOrder(root, orderedPaths)
  return listWorktrees(root)
}

export function readBase(path: string): string | undefined {
  const file = join(path, '.gw-base')
  if (!existsSync(file)) return undefined
  return readFileSync(file, 'utf8').split('\n')[0].trim() || undefined
}

// Presence of a `.gw-nomerge` marker file blocks the guided merge for this
// worktree (same effect the main worktree gets for free). Toggled by setWorktreeBlocked.
function readBlocked(path: string): boolean {
  return existsSync(join(path, '.gw-nomerge'))
}

// Flip a worktree's merge-blocked flag by writing/removing its `.gw-nomerge`
// marker, then return the freshly-listed worktrees (mirrors reorderWorktrees).
export async function setWorktreeBlocked(root: string, target: string, blocked: boolean): Promise<Worktree[]> {
  const file = join(target, '.gw-nomerge')
  if (blocked) writeFileSync(file, '')
  else if (existsSync(file)) unlinkSync(file)
  return listWorktrees(root)
}

// Parse `git worktree list --porcelain` into path+branch pairs. Branch is the
// short ref name, or '(detached)' for a detached HEAD, or undefined if absent.
function parseWorktreePorcelain(stdout: string): Array<{ path: string; branch?: string }> {
  const entries: Array<{ path: string; branch?: string }> = []
  let current: { path: string; branch?: string } | null = null
  for (const line of stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current) entries.push(current)
      current = { path: line.slice('worktree '.length) }
    } else if (current && line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).replace('refs/heads/', '')
    } else if (current && line === 'detached') {
      current.branch = '(detached)'
    }
  }
  if (current) entries.push(current)
  return entries
}

// List worktrees honoring gw's layout — main repo first, then the rest
// (stored under <repo>/.worktrees/<branch>). Reads .gw-note for labels.
export async function listWorktrees(root: string): Promise<Worktree[]> {
  let stdout: string
  try {
    stdout = await git(root, ['worktree', 'list', '--porcelain'])
  } catch {
    return []
  }

  const entries = parseWorktreePorcelain(stdout)

  // No per-worktree `git status` here: the `dirty` flag has no consumer, and on a
  // repo with a large working diff `status --porcelain` per worktree was the bulk
  // of this call's latency — and this call gates landing on a session. (isDirty is
  // still used by the merge/remove preflights, which need it on demand.)
  const worktrees: Worktree[] = entries.map((e) => {
    const isMain = e.path === root
    return {
      path: e.path,
      branch: e.branch ?? '(unknown)',
      isMain,
      base: readBase(e.path),
      note: readNote(e.path),
      desc: readDesc(e.path),
      blocked: readBlocked(e.path)
    }
  })

  // Order: main worktree first, then the persisted navigation order. Worktrees
  // not yet in the order (created outside the app, or first run after this
  // feature shipped) keep git's relative order and are appended to the end.
  const stored = readOrder(root)
  const others = worktrees.filter((w) => !w.isMain)
  const reconciled = [
    ...stored.filter((p) => others.some((w) => w.path === p)),
    ...others.filter((w) => !stored.includes(w.path)).map((w) => w.path)
  ]
  // Self-heal the stored order (prune removed entries, record newly-seen ones).
  if (
    reconciled.length !== stored.length ||
    reconciled.some((p, i) => p !== stored[i])
  ) {
    writeOrder(root, reconciled)
  }

  const rank = (w: Worktree): number => {
    if (w.isMain) return -1
    const i = reconciled.indexOf(w.path)
    return i === -1 ? Number.MAX_SAFE_INTEGER : i
  }
  worktrees.sort((a, b) => rank(a) - rank(b))
  return worktrees
}

// Local branch names, for the unified new-worktree picker.
export async function listBranches(root: string): Promise<string[]> {
  try {
    const out = await git(root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])
    return out
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

// Remote branches not yet checked out locally, for the new-worktree picker.
// Picking one creates a local branch tracking `ref`. Branches that already
// exist locally are dropped (the local picker already offers them).
export async function listRemoteBranches(root: string): Promise<RemoteBranch[]> {
  try {
    const [remotesOut, localsOut] = await Promise.all([
      git(root, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes']),
      git(root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])
    ])
    const locals = new Set(
      localsOut
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
    )
    const seen = new Set<string>()
    const out: RemoteBranch[] = []
    for (const ref of remotesOut
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)) {
      // Skip the symbolic origin/HEAD pointer — it's an alias, not a branch.
      if (ref.endsWith('/HEAD')) continue
      // Strip the remote name (first path segment) to get the branch name.
      const name = ref.slice(ref.indexOf('/') + 1)
      // Already have it locally, or already offered from another remote.
      if (!name || locals.has(name) || seen.has(name)) continue
      seen.add(name)
      out.push({ name, ref })
    }
    return out
  } catch {
    return []
  }
}

export interface CreateWorktreeOptions {
  base?: string
  note?: string
  // Keep the branch name's original casing instead of lowercasing it. Used when
  // the caller has already shaped a convention-bearing name (e.g. "feat/DOS-219")
  // and the upper-case issue key must survive into the real git branch.
  preserveCase?: boolean
  // Re-point an *existing* branch at `base` instead of checking it out as it is.
  // For branches whose worktree was removed but that git kept: without this, the
  // branch is reused at its old commit and the chosen base is silently ignored,
  // so there's no way to rebuild the worktree on a different base. Destructive —
  // whatever was on the branch is dropped, so only ever set it on explicit intent.
  resetBranch?: boolean
}

// Create a worktree the gw way: <repo>/.worktrees/<sanitized-branch>, reuse an
// existing branch or create it from base, and record .gw-base / .gw-note. The
// per-stack setup that follows (.env, deps, Herd, commands) is run separately by
// the provisioner (provision.ts), which streams progress to the setup checklist.
export async function createWorktree(
  root: string,
  branch: string,
  options: CreateWorktreeOptions = {}
): Promise<Worktree[]> {
  // The name may arrive free-form (spaces, capitals, accents). Slug it so the
  // git branch and the directory are always valid — never let raw input reach git.
  const slug = slugifyBranch(branch, { preserveCase: options.preserveCase })
  if (!slug) {
    throw new Error(`Cannot derive a branch name from: "${branch}"`)
  }

  const worktreesDir = join(root, '.worktrees')
  mkdirSync(worktreesDir, { recursive: true })

  await git(root, ['worktree', 'prune']).catch(() => undefined)

  const target = join(worktreesDir, sanitizeBranch(slug))
  if (existsSync(target)) {
    throw new Error(`Worktree already exists: ${slug}`)
  }

  const base = options.base || (await mainBranch(root))

  if (await branchExists(root, slug)) {
    // `-B` force-moves the branch to `base` in the same command that adds the
    // worktree — atomic, so a failure can't leave the branch deleted.
    if (options.resetBranch) await git(root, ['worktree', 'add', '-B', slug, target, base])
    else await git(root, ['worktree', 'add', target, slug])
  } else {
    await git(root, ['worktree', 'add', '-b', slug, target, base])
  }

  writeFileSync(join(target, '.gw-base'), `${base}\n`)
  if (options.note) writeFileSync(join(target, '.gw-note'), `${options.note}\n`)

  // Append to the navigation order so a new worktree always lands at the end of
  // the queue, regardless of where git's alphabetical listing would place it.
  const order = readOrder(root).filter((p) => p !== target)
  order.push(target)
  writeOrder(root, order)

  return listWorktrees(root)
}

// Remove a worktree (never the main one). Force-removes so untracked files
// don't block it, then prunes.
export async function removeWorktree(root: string, target: string): Promise<Worktree[]> {
  if (target === root) throw new Error('Refusing to remove the main worktree')
  // Stop the install first: one still writing into the tree is what makes the
  // remove fail halfway and leave a folder behind.
  await cancelProvision(target)
  const known = await isWorktreeOf(root, target)
  try {
    await git(root, ['worktree', 'remove', '--force', target])
  } catch {
    /* the leftover is dealt with below */
  }
  dropLeftover(known, target)
  await git(root, ['worktree', 'prune']).catch(() => undefined)
  forgetWorktree(target)
  return listWorktrees(root)
}

/** Is `target` one of `root`'s worktrees? Checked before removal, while git still knows. */
async function isWorktreeOf(root: string, target: string): Promise<boolean> {
  const out = await git(root, ['worktree', 'list', '--porcelain']).catch(() => '')
  return parseWorktreePorcelain(out).some((e) => e.path === target && e.path !== root)
}

/**
 * Delete what `git worktree remove` left of a tree — but only a tree git listed
 * as this repo's worktree a moment ago. A path that was never one is somebody's
 * directory, and a remove that failed on it is not licence to delete it.
 */
function dropLeftover(known: boolean, target: string): void {
  if (!known || !existsSync(target)) return
  rmSync(target, { recursive: true, force: true })
}

// --- Granular remove steps (drive the guided remove panel) -----------------
// removeWorktree above always force-removes silently; these expose each step so
// the renderer can show what's dirty, ask before forcing, then ask before
// deleting the branch — all observable, like the guided merge.

// Inspect the worktree without touching it: its branch, whether it's dirty
// (with the porcelain change list for display), whether the branch is already
// merged into base (so we know `-d` vs `-D` when deleting it), and how many
// commits `-D` would throw away — the number the second checkpoint shows.
export async function removePreflight(root: string, target: string): Promise<RemovePreflight> {
  if (target === root) {
    return { ok: false, dirty: false, changes: [], hasBranch: false, merged: false, ahead: 0, message: 'Refusing to remove the main worktree' }
  }
  let branch = ''
  try {
    branch = (await git(target, ['branch', '--show-current'])).trim()
  } catch {
    return { ok: false, dirty: false, changes: [], hasBranch: false, merged: false, ahead: 0, message: 'Not a git worktree' }
  }

  let changes: string[] = []
  try {
    changes = (await git(target, ['status', '--porcelain']))
      .split('\n')
      .map((s) => s.replace(/\s+$/, ''))
      .filter(Boolean)
  } catch {
    /* leave empty */
  }

  let merged = false
  let ahead = 0
  let base: string | undefined
  if (branch) {
    base = readBase(target) || (await mainBranch(root))
    if (base !== branch) {
      try {
        merged = (await git(root, ['branch', '--merged', base]))
          .split('\n')
          .map((l) => l.replace(/^[*+]/, '').trim())
          .includes(branch)
      } catch {
        /* assume not merged */
      }
      // What deleting the branch would lose: its commits that base has not
      // got. Counted rather than inferred from `merged` — a rebased or
      // squash-merged branch reads as unmerged while every change is in base,
      // and the number is what lets the user tell those apart.
      if (!merged) {
        try {
          ahead = Number((await git(root, ['rev-list', '--count', `${base}..${branch}`])).trim()) || 0
        } catch {
          /* unknown: 0, and the checkpoint is skipped */
        }
      }
    }
  }

  return { ok: true, branch: branch || undefined, dirty: changes.length > 0, changes, hasBranch: !!branch, merged, ahead, base }
}

// Remove the worktree. `force` lets it go even with a dirty tree (the renderer
// only passes true after the user confirms). On failure, prune so a
// half-removed entry doesn't linger, then surface the original error.
export async function removeWorktreeGuided(root: string, target: string, force: boolean): Promise<Worktree[]> {
  if (target === root) throw new Error('Refusing to remove the main worktree')
  await cancelProvision(target)
  const known = await isWorktreeOf(root, target)
  const args = force ? ['worktree', 'remove', '--force', target] : ['worktree', 'remove', target]
  try {
    await git(root, args)
  } catch (e) {
    await git(root, ['worktree', 'prune']).catch(() => undefined)
    throw new Error(firstLine(e))
  }
  // Removed as far as git is concerned; ignored files an install was still
  // writing can outlive it.
  dropLeftover(known, target)
  forgetWorktree(target)
  return listWorktrees(root)
}

// Delete the branch once its worktree is gone. `force` (`-D`) is used when the
// branch isn't merged into base; otherwise a safe delete.
//
// "Safe" is measured against `base` when the caller names one. Git's own `-d`
// only checks the branch against HEAD of the tree it runs in — the root's, so
// master — and a branch the guided merge just fast-forwarded into a sibling
// base is fully merged there and still refused by `-d`. The check is done by
// hand and the delete itself is `-D`, which is the same guarantee `-d` gives,
// aimed at the right branch. Without a base, plain `-d` as before.
export async function deleteBranch(
  root: string,
  branch: string,
  force: boolean,
  base?: string
): Promise<RemoveBranchResult> {
  try {
    if (!force && base) {
      if (!(await isAncestor(root, branch, base)))
        return { ok: false, message: `The branch '${branch}' is not fully merged into '${base}'.` }
      await git(root, ['branch', '-D', branch])
      return { ok: true }
    }
    await git(root, ['branch', force ? '-D' : '-d', branch])
    return { ok: true }
  } catch (e) {
    return { ok: false, message: firstLine(e) }
  }
}

/** Is every commit of `branch` reachable from `base`? */
async function isAncestor(root: string, branch: string, base: string): Promise<boolean> {
  try {
    await git(root, ['merge-base', '--is-ancestor', branch, base])
    return true
  } catch {
    return false
  }
}

/**
 * Commit `paths` in a worktree, and nothing else. False when there was nothing
 * to commit — including a path that does not exist or is ignored.
 *
 * Hooks off: this is the board filing a lane's documents, and a project's
 * pre-commit (a full test suite, a formatter over the codebase) is for code a
 * person wrote, not for a markdown file the next lane is waiting on.
 */
export async function commitPaths(worktree: string, paths: string[], message: string): Promise<boolean> {
  try {
    await git(worktree, ['add', '-A', '--', ...paths])
  } catch {
    return false
  }
  const staged = (await git(worktree, ['diff', '--cached', '--name-only', '--', ...paths])).trim()
  if (!staged) return false
  // The pathspec again on the commit, so whatever else a lane left staged stays
  // staged and out of this commit.
  await gitNoHooks(worktree, ['commit', '-q', '-m', message, '--', ...paths])
  return true
}

/** A tracked file's content hash, or `deleted`. What `dirtySnapshot` records. */
async function contentHashes(worktree: string, paths: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  const present = paths.filter((p) => existsSync(join(worktree, p)))
  for (const p of paths) if (!present.includes(p)) out[p] = 'deleted'
  if (!present.length) return out
  const hashes = (await git(worktree, ['hash-object', '--', ...present])).trim().split('\n')
  present.forEach((p, i) => (out[p] = hashes[i] ?? ''))
  return out
}

/** Tracked files that differ from HEAD. */
async function trackedChanges(worktree: string): Promise<string[]> {
  const out = await git(worktree, ['diff', '--name-only', 'HEAD']).catch(() => '')
  return out.split('\n').map((s) => s.trim()).filter(Boolean)
}

/**
 * The tracked files that differ from HEAD right now, with their content hash.
 *
 * Taken when provisioning finishes: whatever it regenerated (a tooling file an
 * install rewrites) is recorded, so a merge later can tell that dirt from a
 * change a lane made.
 */
export async function dirtySnapshot(worktree: string): Promise<Record<string, string>> {
  return contentHashes(worktree, await trackedChanges(worktree))
}

/**
 * Put back every file from `snapshot` that is still exactly as provisioning left
 * it. A file anybody changed since is left alone — it is work, not dirt. Returns
 * the paths it restored.
 */
export async function restoreSnapshot(worktree: string, snapshot: Record<string, string>): Promise<string[]> {
  const changed = new Set(await trackedChanges(worktree))
  const candidates = Object.keys(snapshot).filter((p) => changed.has(p))
  if (!candidates.length) return []
  const now = await contentHashes(worktree, candidates)
  const untouched = candidates.filter((p) => now[p] === snapshot[p])
  if (untouched.length) await git(worktree, ['checkout', 'HEAD', '--', ...untouched])
  return untouched
}

export interface MergeResult {
  ok: boolean
  message?: string
  /**
   * Where base was before and after, on a merge that landed.
   *
   * Only the caller that merged without being asked needs these, but they are
   * read here because here is the only place that knows the base branch and can
   * see it before it moves. See `undoMerge`.
   */
  base?: string
  baseBefore?: string
  baseAfter?: string
}

/** The tip of a ref, or null when it does not resolve. */
async function shaOf(root: string, ref: string): Promise<string | null> {
  try {
    const sha = (await git(root, ['rev-parse', '--verify', `${ref}^{commit}`])).trim()
    return sha || null
  } catch {
    return null
  }
}

/**
 * Put a base branch back where it was before a merge landed on it.
 *
 * REFUSES when base has moved since. That is the whole design: an undo that
 * resets past whatever landed after is not an undo, it is a second accident —
 * and the board merges on its own, so the window between the merge and somebody
 * pressing undo is exactly the window another lane can finish in.
 *
 * The branch is moved, not reverted: the merge's own commits stay on the task
 * branch, so this un-lands the work rather than deleting it. A dirty main
 * worktree refuses too — resetting a checked-out branch under uncommitted
 * changes throws them away.
 */
export async function undoMerge(
  root: string,
  base: string,
  expected: string,
  to: string
): Promise<MergeResult> {
  const now = await shaOf(root, base)
  if (!now) return { ok: false, message: `"${base}" no longer resolves — nothing to put back` }
  if (now !== expected) {
    return {
      ok: false,
      message: `"${base}" has moved on since that merge — undo would throw away what landed after it`
    }
  }
  if (!(await shaOf(root, to))) {
    return { ok: false, message: `the commit "${base}" pointed at before the merge is gone` }
  }
  // Whichever tree has base checked out — the main one, or a feature's own.
  const holder = await holderOf(root, base)
  if (holder && (await isDirty(holder))) return { ok: false, message: dirtyHolderMessage(root, holder, base) }

  try {
    // Checked out: `reset --hard` in that tree is the only thing that moves it.
    // Not checked out: `branch -f` moves it without touching any tree.
    if (holder) await git(holder, ['reset', '--hard', to])
    else await git(root, ['branch', '-f', base, to])
  } catch (e) {
    return { ok: false, message: firstLine(e) }
  }
  return { ok: true, message: `"${base}" is back at ${to.slice(0, 8)}`, base, baseBefore: to, baseAfter: now }
}

// gw merge: bring the base branch into the worktree, then fast-forward base to
// the worktree branch (so base ends up with the work). Safe — refuses on dirty
// trees or conflicts (leaving you to resolve manually).
export async function mergeWorktree(root: string, target: string): Promise<MergeResult> {
  if (target === root) return { ok: false, message: 'Cannot merge the main worktree into itself' }

  let branch: string
  try {
    branch = (await git(target, ['branch', '--show-current'])).trim()
  } catch {
    return { ok: false, message: 'Not a git worktree' }
  }
  if (!branch) return { ok: false, message: 'Worktree is in a detached HEAD — checkout a branch first' }
  if (await isDirty(target)) return { ok: false, message: `"${branch}" has uncommitted changes — commit or stash first` }

  const base = readBase(target) || (await mainBranch(root))
  if (base === branch) return { ok: false, message: `Base and branch are both "${branch}"` }
  // Base is moved from inside whichever tree has it checked out, so that tree is
  // the one that has to be clean. Checked out nowhere, no tree is touched.
  const holder = await holderOf(root, base)
  if (holder && (await isDirty(holder))) return { ok: false, message: dirtyHolderMessage(root, holder, base) }

  // Read BEFORE the fast-forward moves it. After the merge this commit is only
  // reachable through the reflog, and an undo that had to mine the reflog for
  // its own starting point would be one more thing to get wrong.
  const baseBefore = await shaOf(root, base)

  // Merge base into the worktree branch.
  try {
    await git(target, ['merge', '--no-edit', base])
  } catch {
    await git(target, ['merge', '--abort']).catch(() => undefined)
    return { ok: false, message: `Conflicts merging "${base}" into "${branch}". Resolve them in the worktree, then commit.` }
  }

  // Fast-forward base to the (now up-to-date) worktree branch — in the tree that
  // holds base, never by checking base out somewhere it may already be in use.
  const ff = await mergeFastForward(root, base, branch)
  if (!ff.ok) {
    return { ok: false, message: `Merged "${base}" into "${branch}", but couldn't fast-forward "${base}". ${ff.message ?? ''}`.trim() }
  }

  const baseAfter = await shaOf(root, base)
  return {
    ok: true,
    message: `Merged "${branch}" → "${base}"`,
    base,
    ...(baseBefore ? { baseBefore } : {}),
    ...(baseAfter ? { baseAfter } : {})
  }
}

/** The refusal for a dirty tree holding base, in the words the main-tree case always used. */
function dirtyHolderMessage(root: string, holder: string, base: string): string {
  return holder === root
    ? 'The main worktree has uncommitted changes — commit or stash first'
    : `The worktree holding "${base}" (${holder}) has uncommitted changes — commit or stash first`
}

// --- Granular merge steps (drive the guided merge panel) -------------------
// The monolithic mergeWorktree above aborts on conflict; these expose each step
// so the renderer can stop on conflicts, hand them to Claude, pause for review,
// then commit and fast-forward — all observable.

export interface MergePreflight {
  ok: boolean
  base?: string
  branch?: string
  message?: string
}

// Same validations as mergeWorktree, but returns the resolved base/branch.
export async function mergePreflight(root: string, target: string): Promise<MergePreflight> {
  if (target === root) return { ok: false, message: 'Cannot merge the main worktree into itself' }
  let branch: string
  try {
    branch = (await git(target, ['branch', '--show-current'])).trim()
  } catch {
    return { ok: false, message: 'Not a git worktree' }
  }
  if (!branch) return { ok: false, message: 'Worktree is in a detached HEAD — checkout a branch first' }
  if (await isDirty(target)) return { ok: false, message: `"${branch}" has uncommitted changes — commit or stash first` }
  const base = readBase(target) || (await mainBranch(root))
  if (base === branch) return { ok: false, message: `Base and branch are both "${branch}"` }
  if (await isDirty(root)) return { ok: false, message: 'The main worktree has uncommitted changes — commit or stash first' }
  return { ok: true, base, branch }
}

// Stash a worktree's uncommitted changes (including untracked) so a merge
// preflight blocked on a dirty tree can proceed. Backs the merge panel's
// "stash & retry" action. Returns the error message on failure.
export async function mergeStash(path: string): Promise<{ ok: boolean; message?: string }> {
  try {
    await git(path, ['stash', 'push', '--include-untracked', '-m', 'floe: stash & retry merge'])
    return { ok: true }
  } catch (e) {
    return { ok: false, message: firstLine(e) }
  }
}

// The reason git gave, not the command it was given. execFile's message opens
// with "Command failed: git -C …", which names the step the panel already
// names and hides git's own line under it. That line is what the user needs.
const firstLine = (e: unknown): string => {
  if (!(e instanceof Error)) return String(e)
  const stderr = (e as { stderr?: unknown }).stderr
  const lines = [
    ...(typeof stderr === 'string' ? stderr.split('\n') : []),
    ...e.message.split('\n').filter((l) => !l.startsWith('Command failed:'))
  ]
  return lines.map((l) => l.trim()).find(Boolean) ?? e.message
}

async function unmergedFiles(target: string): Promise<string[]> {
  try {
    return (await git(target, ['diff', '--name-only', '--diff-filter=U']))
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

async function headInfo(target: string): Promise<{ commit: string; subject: string }> {
  try {
    const [commit, subject] = (await git(target, ['log', '-1', '--format=%h%x00%s'])).trim().split('\u0000')
    return { commit: commit ?? '', subject: subject ?? '' }
  } catch {
    return { commit: '', subject: '' }
  }
}

export interface LastCommit {
  sha: string
  subject: string
  files: string[]
}

// HEAD's short sha, subject, and which files it touched — the payload for the
// inline "committed" card. Returns null on an unborn HEAD (no commits yet).
export async function lastCommit(worktreePath: string): Promise<LastCommit | null> {
  try {
    const [sha, subject] = (await git(worktreePath, ['log', '-1', '--format=%h%x00%s'])).trim().split(' ')
    if (!sha) return null
    const names = (await git(worktreePath, ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'])).trim()
    return { sha, subject: subject ?? '', files: names ? names.split('\n') : [] }
  } catch {
    return null
  }
}

export interface MergeBaseResult {
  status: 'clean' | 'conflicts' | 'uptodate' | 'error'
  conflicts?: string[]
  commit?: string
  subject?: string
  message?: string
}

// Merge base into the worktree branch — leaving conflicts in place (no abort).
export async function mergeBase(target: string, base: string): Promise<MergeBaseResult> {
  let out: string
  try {
    out = await gitNoHooks(target, ['merge', '--no-edit', base])
  } catch (e) {
    const conflicts = await unmergedFiles(target)
    if (conflicts.length) return { status: 'conflicts', conflicts }
    await git(target, ['merge', '--abort']).catch(() => undefined)
    return { status: 'error', message: firstLine(e) }
  }
  if (/Already up to date/i.test(out)) return { status: 'uptodate' }
  const { commit, subject } = await headInfo(target)
  return { status: 'clean', commit, subject }
}

export interface MergeResolveCheck {
  resolved: boolean
  conflicts: string[] // files still holding conflict markers
}

// After Claude edits the files, decide if the conflict is resolved. If a file no
// longer has markers but wasn't `git add`ed, stage it; only files that still
// carry markers count as unresolved.
export async function mergeResolveCheck(target: string): Promise<MergeResolveCheck> {
  let unmerged = await unmergedFiles(target)
  if (!unmerged.length) return { resolved: true, conflicts: [] }
  const withMarkers: string[] = []
  for (const f of unmerged) {
    try {
      if (/^<{7} |^={7}$|^>{7} /m.test(readFileSync(join(target, f), 'utf8'))) withMarkers.push(f)
    } catch {
      withMarkers.push(f)
    }
  }
  if (withMarkers.length === 0) {
    await git(target, ['add', ...unmerged]).catch(() => undefined)
    unmerged = await unmergedFiles(target)
    return { resolved: unmerged.length === 0, conflicts: unmerged }
  }
  return { resolved: false, conflicts: withMarkers }
}

export interface MergeCommitResult {
  ok: boolean
  commit?: string
  subject?: string
  message?: string
}

// Complete the in-progress merge commit (after conflicts are resolved + staged).
export async function mergeCommit(target: string): Promise<MergeCommitResult> {
  const remaining = await unmergedFiles(target)
  if (remaining.length) return { ok: false, message: `Still ${remaining.length} unresolved file(s)` }
  try {
    await git(target, ['add', '-A'])
    await gitNoHooks(target, ['commit', '--no-edit'])
  } catch (e) {
    return { ok: false, message: firstLine(e) }
  }
  const { commit, subject } = await headInfo(target)
  return { ok: true, commit, subject }
}

export interface MergeFfResult {
  ok: boolean
  baseCommit?: string
  message?: string
}

// Fast-forward base to the branch. If base is checked out in ANY worktree (main
// or a linked one), merge --ff-only inside that worktree — `git branch -f` is
// refused for a branch in use. Only when no worktree holds base do we move the
// ref directly (no disruptive checkout).
export async function mergeFastForward(root: string, base: string, branch: string): Promise<MergeFfResult> {
  try {
    const entries = parseWorktreePorcelain(await git(root, ['worktree', 'list', '--porcelain']))
    const holder = entries.find((e) => e.branch === base)
    if (holder) {
      await git(holder.path, ['merge', '--ff-only', branch])
    } else {
      try {
        await git(root, ['merge-base', '--is-ancestor', base, branch])
      } catch {
        return { ok: false, message: `"${base}" is not a fast-forward of "${branch}"` }
      }
      await git(root, ['branch', '-f', base, branch])
    }
  } catch (e) {
    return { ok: false, message: firstLine(e) }
  }
  const baseCommit = (await git(root, ['rev-parse', '--short', base])).trim()
  return { ok: true, baseCommit }
}

// review (changed files + per-file diff) ----------------------------------

// The ref a review diffs against: the merge-base of the worktree's base branch
// (.gw-base, else detected main) and HEAD. Using the merge-base means we show
// exactly what this branch added — committed and uncommitted — without folding
// in changes that landed on base after we branched. Falls back to the base
// branch name (then HEAD) when no merge-base can be computed.
export async function reviewBase(worktreePath: string): Promise<string> {
  // A "Clear changes list" checkpoint wins: diff against that commit so work
  // committed before it drops out of the review (new commits + uncommitted
  // edits still show). Ignore a stale checkpoint whose commit is gone.
  const checkpoint = getReviewCheckpoint(worktreePath)
  if (checkpoint) {
    try {
      await git(worktreePath, ['cat-file', '-e', `${checkpoint}^{commit}`])
      return checkpoint
    } catch {
      /* checkpoint commit no longer exists — fall back to the branch base */
    }
  }
  const recorded = readBase(worktreePath)
  // No recorded base (a project's own checkout, not a Floe worktree): review what
  // hasn't shipped — unpushed commits + edits — against the branch's upstream.
  // Diffing a long-lived branch like `develop` against main would list every
  // commit it ever made. No upstream → the main-branch fallback below.
  if (!recorded) {
    try {
      const mb = (await git(worktreePath, ['merge-base', '@{upstream}', 'HEAD'])).trim()
      if (mb) return mb
    } catch {
      /* no upstream */
    }
  }
  const base = recorded || (await mainBranch(worktreePath))
  try {
    const mb = (await git(worktreePath, ['merge-base', base, 'HEAD'])).trim()
    if (mb) return mb
  } catch {
    /* unborn HEAD / unknown base */
  }
  return base
}

// Aggregate +added / −deleted for a worktree's whole diff against its review
// base — one `git diff --shortstat`, for the sidebar/switcher "+310 −64" readout.
// Untracked files aren't in the diff so they don't count; good enough for a glance.
// ponytail: shortstat over summing per-file numstat — one cheap call, no file list.
export async function worktreeDiffStat(worktreePath: string): Promise<{ additions: number; deletions: number }> {
  try {
    const base = await reviewBase(worktreePath)
    const out = await git(worktreePath, ['diff', '--shortstat', base])
    const add = /(\d+) insertion/.exec(out)
    const del = /(\d+) deletion/.exec(out)
    return { additions: add ? Number(add[1]) : 0, deletions: del ? Number(del[1]) : 0 }
  } catch {
    return { additions: 0, deletions: 0 }
  }
}

// "Clear changes list": pin the review to the current HEAD so everything
// committed up to now leaves the Changes panel, giving a clean slate for new
// work. Purely a review marker — no reset, no clean, no file is touched, and
// uncommitted/untracked edits stay exactly as they are. Reports whether a
// checkpoint was actually set (false on an unborn HEAD: nothing to pin past).
export async function clearReview(worktreePath: string): Promise<boolean> {
  let head: string
  try {
    head = (await git(worktreePath, ['rev-parse', 'HEAD'])).trim()
  } catch {
    return false // unborn HEAD — no commit to checkpoint against
  }
  if (!head) return false
  setReviewCheckpoint(worktreePath, head)
  return true
}

// Undo a clear: drop the checkpoint so the panel reviews the whole branch
// against its base again.
export function restoreReview(worktreePath: string): void {
  setReviewCheckpoint(worktreePath, undefined)
}

// Whether the worktree's Changes panel is currently pinned to a checkpoint
// (i.e. it was cleared), so the UI can offer "restore" instead of "clear".
export function hasReviewCheckpoint(worktreePath: string): boolean {
  return Boolean(getReviewCheckpoint(worktreePath))
}

// A content signature for the working-tree file: size + mtime. Deleted files
// have no working copy, so they get a stable marker (they can't "change again"
// short of being recreated). Used to expire "viewed" marks when a file changes.
function fingerprint(worktreePath: string, relPath: string, status: ChangedFile['status']): string {
  if (status === 'deleted') return 'deleted'
  try {
    const st = statSync(join(worktreePath, relPath))
    return `${st.size}:${Math.round(st.mtimeMs)}`
  } catch {
    return ''
  }
}

// Every file that differs from the review base: tracked changes (committed +
// uncommitted) via `git diff`, plus untracked files via `ls-files --others`.
export async function changedFiles(worktreePath: string): Promise<ChangedFile[]> {
  const base = await reviewBase(worktreePath)
  const map = new Map<string, ChangedFile>()

  // Tracked files that still differ from HEAD (staged + unstaged) — i.e. not yet
  // committed. Everything else in the branch diff is already committed. On an
  // unborn HEAD this throws; we leave `headKnown` false so nothing is claimed
  // committed (there are no commits to attribute it to).
  const uncommitted = new Set<string>()
  let headKnown = false
  try {
    const head = await git(worktreePath, ['diff', '--name-only', 'HEAD'])
    headKnown = true
    for (const p of head.split('\n').map((s) => s.trim()).filter(Boolean)) uncommitted.add(p)
  } catch {
    /* unborn HEAD — treat everything as not-yet-committed */
  }

  try {
    const status = await git(worktreePath, ['diff', '--name-status', '--no-renames', base])
    for (const line of status.split('\n')) {
      if (!line.trim()) continue
      const tab = line.indexOf('\t')
      if (tab < 0) continue
      const code = line.slice(0, tab)
      const relPath = line.slice(tab + 1).trim()
      if (!relPath) continue
      const fileStatus = code.startsWith('A') ? 'added' : code.startsWith('D') ? 'deleted' : 'modified'
      map.set(relPath, {
        relPath,
        status: fileStatus,
        additions: 0,
        deletions: 0,
        fingerprint: fingerprint(worktreePath, relPath, fileStatus),
        committed: headKnown && !uncommitted.has(relPath)
      })
    }
  } catch {
    /* base may be unresolved on a fresh repo */
  }

  try {
    const numstat = await git(worktreePath, ['diff', '--numstat', '--no-renames', base])
    for (const line of numstat.split('\n')) {
      if (!line.trim()) continue
      const parts = line.split('\t')
      if (parts.length < 3) continue
      const [adds, dels] = parts
      const relPath = parts.slice(2).join('\t').trim()
      const entry = map.get(relPath)
      if (entry) {
        entry.additions = adds === '-' ? 0 : Number(adds) || 0
        entry.deletions = dels === '-' ? 0 : Number(dels) || 0
      }
    }
  } catch {
    /* counts are best-effort */
  }

  try {
    const others = await git(worktreePath, ['ls-files', '--others', '--exclude-standard'])
    for (const relPath of others.split('\n').map((s) => s.trim()).filter(Boolean)) {
      if (map.has(relPath)) continue
      map.set(relPath, {
        relPath,
        status: 'untracked',
        additions: 0,
        deletions: 0,
        fingerprint: fingerprint(worktreePath, relPath, 'untracked'),
        committed: false
      })
    }
  } catch {
    /* no untracked files */
  }

  return [...map.values()].sort((a, b) => a.relPath.localeCompare(b.relPath))
}

// The unified diff for a single file, relative to the review base. Untracked
// files have no diff against base, so they're diffed against /dev/null instead
// (rendering as all-additions, like GitHub shows a brand-new file).
//
// `context` is git's -U: how many unchanged lines surround each hunk. The code
// view wants git's default three; the prose view asks for a number larger than
// any file so the patch comes back as ONE hunk spanning the whole document —
// prose cut into three-line neighbourhoods reads as fragments, not as a file.
export async function fileDiff(
  worktreePath: string,
  relPath: string,
  context?: number
): Promise<string> {
  const base = await reviewBase(worktreePath)
  const width = context === undefined ? [] : [`-U${Math.max(0, Math.trunc(context))}`]
  try {
    const out = await git(worktreePath, ['diff', ...width, base, '--', relPath])
    if (out.trim()) return out
  } catch {
    /* fall through to the untracked path */
  }
  try {
    return await gitAllowFail(worktreePath, [
      'diff',
      '--no-index',
      ...width,
      '--',
      '/dev/null',
      relPath
    ])
  } catch {
    return ''
  }
}

// The commits this branch added since the review base (base..HEAD, newest first),
// each with the files it touched and their +/- counts. Powers the "Commit Story"
// timeline: reading it top-to-bottom follows the reasoning line of the branch.
// Two cheap `git log` passes (status letters, then numstat) merged by hash —
// `--no-renames` in both keeps the file paths aligned (renames read as del+add,
// matching changedFiles). Merge commits carry no diff, so their `files` is empty.
const RS = '\x1e' // record separator — prefixes each commit header line
const US = '\x1f' // unit separator — between commit header fields

export async function reviewCommits(worktreePath: string): Promise<ReviewCommit[]> {
  const base = await reviewBase(worktreePath)
  const range = `${base}..HEAD`
  let statusOut: string
  try {
    statusOut = await git(worktreePath, [
      'log',
      range,
      '--no-color',
      '--no-renames',
      `--format=${RS}%h${US}%an${US}%ar${US}%p${US}%s`,
      '--name-status'
    ])
  } catch {
    return [] // unborn HEAD, or base unresolved on a fresh repo
  }

  const byHash = new Map<string, ReviewCommit>()
  const order: string[] = []
  let cur: ReviewCommit | null = null
  for (const line of statusOut.split('\n')) {
    if (line.startsWith(RS)) {
      const [hash, author, relDate, parents, subject] = line.slice(1).split(US)
      cur = {
        hash: hash ?? '',
        subject: subject ?? '',
        author: author ?? '',
        relDate: relDate ?? '',
        isMerge: (parents ?? '').trim().includes(' '),
        additions: 0,
        deletions: 0,
        files: []
      }
      byHash.set(cur.hash, cur)
      order.push(cur.hash)
    } else if (cur && line.trim()) {
      const parts = line.split('\t')
      const relPath = parts[parts.length - 1]
      if (!relPath) continue
      const code = parts[0][0]
      const status: CommitFileRef['status'] = code === 'A' ? 'added' : code === 'D' ? 'deleted' : 'modified'
      cur.files.push({ relPath, status, additions: 0, deletions: 0 })
    }
  }

  // Second pass fills the +/- counts (numstat) and per-commit totals.
  try {
    const numOut = await git(worktreePath, ['log', range, '--no-color', '--no-renames', `--format=${RS}%h`, '--numstat'])
    let c: ReviewCommit | null = null
    for (const line of numOut.split('\n')) {
      if (line.startsWith(RS)) {
        c = byHash.get(line.slice(1)) ?? null
        continue
      }
      if (!c || !line.trim()) continue
      const [adds, dels, ...rest] = line.split('\t')
      const relPath = rest.join('\t')
      const a = adds === '-' ? 0 : Number(adds) || 0
      const d = dels === '-' ? 0 : Number(dels) || 0
      const f = c.files.find((x) => x.relPath === relPath)
      if (f) {
        f.additions = a
        f.deletions = d
      }
      c.additions += a
      c.deletions += d
    }
  } catch {
    /* counts are best-effort */
  }

  return order.map((h) => byHash.get(h)).filter((c): c is ReviewCommit => Boolean(c))
}

// The diff a single commit introduced for one file. `git show --format=` prints
// just the patch (no commit header). Used by the Commit Story detail pane.
export async function commitFileDiff(worktreePath: string, hash: string, relPath: string): Promise<string> {
  try {
    return await git(worktreePath, ['show', '--no-color', '--no-renames', '--format=', hash, '--', relPath])
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------------------
// Snapshots — what a worktree held at one moment, without committing it
// ---------------------------------------------------------------------------

/**
 * The worktree's content right now, as a tree id — committed or not.
 *
 * The colony's step report diffs one step's end against its start, and a lane
 * may commit, stage or leave everything loose; a tree of the files on disk is
 * the one thing that means the same in all three. Built through a THROWAWAY
 * index so the lane's own staging area is never touched, and from HEAD first so
 * `add -A` only hashes what changed. Ignored files stay out, as they would in a
 * commit.
 *
 * The objects land in the repository's store unreferenced. That is fine for
 * what reads them: the report is written when the card reaches done, long
 * before a prune could reach them.
 */
export async function snapshotTree(path: string): Promise<string> {
  const index = join(tmpdir(), `floe-snapshot-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_INDEX_FILE: index }
  // A git hook exports these, and either one would point the snapshot at a
  // different repository or index than the worktree it was asked about.
  delete env.GIT_DIR
  delete env.GIT_WORK_TREE
  const run = async (args: string[]): Promise<string> => (await exec('git', ['-C', path, ...args], { env })).stdout
  try {
    // An unborn HEAD has nothing to start from; `add -A` builds the whole tree.
    await run(['read-tree', 'HEAD']).catch(() => undefined)
    await run(['add', '-A'])
    return (await run(['write-tree'])).trim()
  } finally {
    rmSync(index, { force: true })
  }
}

export interface TreeDiffFile {
  path: string
  added: number
  deleted: number
  binary: boolean
  /** The file's patch, cut at `maxPatch` characters across the whole diff. */
  patch: string
  truncated?: boolean
}

/**
 * What changed between two snapshots, per file, with each file's patch.
 *
 * `maxPatch` caps the patch text across ALL files, not per file: the report
 * embeds every step's diff, and one step that regenerated a lockfile should not
 * make the page unopenable. Counts are always complete; only patches are cut.
 */
export async function treeDiff(path: string, from: string, to: string, maxPatch = 200_000): Promise<TreeDiffFile[]> {
  if (from === to) return []
  const files: TreeDiffFile[] = []
  const numstat = await git(path, ['diff', '--numstat', '--no-renames', from, to])
  for (const line of numstat.split('\n')) {
    if (!line.trim()) continue
    const [adds, dels, ...rest] = line.split('\t')
    files.push({
      path: rest.join('\t'),
      added: adds === '-' ? 0 : Number(adds) || 0,
      deleted: dels === '-' ? 0 : Number(dels) || 0,
      binary: adds === '-',
      patch: ''
    })
  }
  if (!files.length) return files

  const raw = (await exec('git', ['-C', path, 'diff', '--no-color', '--no-renames', from, to], { maxBuffer: 64 * 1024 * 1024 })).stdout
  const byPath = new Map(files.map((f) => [f.path, f]))
  let budget = maxPatch
  for (const chunk of raw.split(/^(?=diff --git )/m)) {
    const m = /^diff --git a\/(.+?) b\//.exec(chunk)
    const file = m ? byPath.get(m[1]) : undefined
    if (!file) continue
    if (budget <= 0) {
      file.truncated = true
      continue
    }
    file.patch = chunk.slice(0, budget)
    if (chunk.length > budget) file.truncated = true
    budget -= chunk.length
  }
  return files
}
