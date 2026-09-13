import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installHook } from './config/hook.test-helper.ts'
import { makeGitRepo, type GitFixture } from './gitFixture.test-helper.ts'

// Every `git` this file runs itself goes through makeGitRepo(), which pins cwd,
// drops inherited GIT_* and refuses to hand back a fixture that resolved to
// another repository. But the functions under test spawn their own git and
// inherit THIS process's environment, so the same walls have to go up here:
// a GIT_DIR/GIT_INDEX_FILE left by a pre-commit hook would point git.ts at
// Floe's own history no matter which path we pass it.
for (const key of Object.keys(process.env)) if (key.startsWith('GIT_')) delete process.env[key]
const TMP = realpathSync(tmpdir())
// Nothing git.ts spawns may walk up past the directory the fixtures live in.
process.env.GIT_CEILING_DIRECTORIES = TMP
process.env.GIT_CONFIG_GLOBAL = '/dev/null'
process.env.GIT_CONFIG_SYSTEM = '/dev/null'

// reviewBase() reads a checkpoint from sessionStore, which persists into
// electron's userData — point that at a throwaway dir, not the real store.
const userData = mkdtempSync(join(TMP, 'floe-git-userdata-'))
process.env.FLOE_TEST_USERDATA = userData
process.on('exit', () => rmSync(userData, { recursive: true, force: true }))

installHook()

const {
  changedFiles,
  createWorktree,
  fileDiff,
  listRemoteBranches,
  mergeFastForward,
  mergePreflight,
  mergeResolveCheck,
  mergeWorktree,
  removePreflight,
  undoMerge,
  reviewCommits
} = await import('./git.ts')

// A fixture with its first commit in place. `.gitignore` hides `.worktrees/`
// and the `.gw-*` markers so a repo that has linked worktrees and a written
// base still reads clean — every preflight below refuses to act on a dirty tree.
function seededRepo(prefix: string): GitFixture {
  const fx = makeGitRepo(prefix)
  fx.write('.gitignore', '.worktrees/\n.gw-*\n')
  fx.write('a.txt', 'a1\n')
  fx.write('b.txt', 'b1\n')
  fx.commit('c0')
  return fx
}

// A linked worktree on a fresh branch off 'main' — the shape createWorktree makes.
function addWorktree(fx: GitFixture, branch: string): string {
  const target = join(fx.dir, '.worktrees', branch)
  fx.git('worktree', 'add', '-q', '-b', branch, target, 'main')
  return target
}

// A directory that is deliberately NOT a repository. Real-pathed so the ceiling
// above actually applies to it.
function bareDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(TMP, prefix)))
}

// base is checked out in a LINKED worktree, not root. mergeFastForward must FF
// it via `merge --ff-only` inside that worktree, not `branch -f` (which git
// refuses for a branch in use). Regression for the "cannot force update the
// branch used by worktree" bug.
test('fast-forwards base checked out in a linked worktree', async () => {
  const fx = seededRepo('floe-git-ff-')
  try {
    fx.git('branch', 'base')
    fx.git('checkout', '-q', '-b', 'feat')
    fx.write('a.txt', 'a2\n')
    fx.commit('c2')
    const featHead = fx.git('rev-parse', 'HEAD')

    // Put 'base' in a linked worktree so root is NOT on it.
    fx.git('worktree', 'add', '-q', join(fx.dir, '.worktrees', 'base'), 'base')

    const res = await mergeFastForward(fx.dir, 'base', 'feat')
    assert.equal(res.ok, true, res.message)
    assert.equal(fx.git('rev-parse', 'base'), featHead)
  } finally {
    fx.cleanup()
  }
})

// A branch left behind by a removed worktree is reused as-is by default, so its
// old base sticks. `resetBranch` is the only way to rebuild it somewhere else —
// regression for "não consigo trocar a base do worktree".
test('createWorktree reuses an existing branch, or resets it onto a new base', async () => {
  const fx = seededRepo('floe-git-create-')
  try {
    // 'other' is the new base; 'feat' is the leftover branch, one commit ahead.
    fx.git('branch', 'other')
    fx.git('checkout', '-q', '-b', 'feat')
    fx.write('a.txt', 'a2\n')
    fx.commit('c2')
    const featHead = fx.git('rev-parse', 'feat')
    const otherHead = fx.git('rev-parse', 'other')
    fx.git('checkout', '-q', 'main')

    // Default: the branch is checked out where it already was — base ignored.
    await createWorktree(fx.dir, 'feat', { base: 'other' })
    const wt = join(fx.dir, '.worktrees', 'feat')
    assert.equal(fx.git('-C', wt, 'rev-parse', 'HEAD'), featHead)

    fx.git('worktree', 'remove', '--force', wt)

    // resetBranch: same branch name, rebuilt on 'other'.
    await createWorktree(fx.dir, 'feat', { base: 'other', resetBranch: true })
    assert.equal(fx.git('-C', wt, 'rev-parse', 'HEAD'), otherHead)
    assert.equal(fx.git('rev-parse', 'feat'), otherHead)
    assert.equal(readFileSync(join(wt, '.gw-base'), 'utf8').trim(), 'other')
  } finally {
    fx.cleanup()
  }
})

// The prose view reads a document, so it asks for a context wider than the file
// and gets one hunk spanning it. Without the width, a reworded sentence comes
// back as three lines of neighbours and nothing else — fragments, not a file.
test('fileDiff widens its context on request', async () => {
  const fx = makeGitRepo('floe-git-diff-')
  try {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`)
    fx.write('notes.md', lines.join('\n') + '\n')
    fx.commit('c1')

    lines[20] = 'line 21, reworded'
    writeFileSync(join(fx.dir, 'notes.md'), lines.join('\n') + '\n')

    const narrow = await fileDiff(fx.dir, 'notes.md')
    assert.ok(narrow.includes('line 21, reworded'), 'the change is in both')
    assert.ok(!narrow.includes('line 1\n'), 'git default keeps its three lines of context')

    const whole = await fileDiff(fx.dir, 'notes.md', 100000)
    assert.ok(whole.includes(' line 1\n'), 'the whole document came back')
    assert.ok(whole.includes(' line 40'), 'including the far end of it')
    assert.equal(whole.match(/^@@ /gm)?.length, 1, 'as one hunk')
  } finally {
    fx.cleanup()
  }
})

// --- listRemoteBranches ----------------------------------------------------

// The picker only offers a remote branch that isn't already reachable locally,
// and never the same name twice when two remotes carry it.
test('listRemoteBranches drops local branches and cross-remote duplicates', async () => {
  const upstream = seededRepo('floe-git-upstream-')
  const fx = makeGitRepo('floe-git-remotes-')
  try {
    upstream.git('branch', 'feature-a')
    upstream.git('branch', 'shared')

    // Two remotes on the same upstream: every branch arrives twice.
    fx.git('remote', 'add', 'origin', upstream.dir)
    fx.git('remote', 'add', 'mirror', upstream.dir)
    fx.git('fetch', '-q', 'origin')
    fx.git('fetch', '-q', 'mirror')
    fx.git('remote', 'set-head', 'origin', 'main')
    fx.git('remote', 'set-head', 'mirror', 'main')
    // 'shared' exists locally, so it must not be offered.
    fx.git('branch', 'shared', 'refs/remotes/origin/shared')

    const branches = await listRemoteBranches(fx.dir)
    const names = branches.map((b) => b.name).sort()
    assert.ok(names.includes('feature-a'), 'a remote-only branch is offered')
    assert.ok(names.includes('main'))
    assert.ok(!names.includes('shared'), 'already checked out locally')
    assert.equal(new Set(names).size, names.length, 'one entry per name')
    for (const b of branches) {
      if (!b.ref.includes('/')) continue
      assert.match(b.ref, /^(origin|mirror)\//, 'ref keeps the remote prefix')
      assert.equal(b.ref.slice(b.ref.indexOf('/') + 1), b.name)
    }

    // Current behaviour, pinned rather than endorsed: the `/HEAD` guard never
    // fires, because git shortens `refs/remotes/origin/HEAD` to plain `origin`.
    // So each remote's symbolic HEAD is offered as a branch named after it.
    assert.deepEqual(names, ['feature-a', 'main', 'mirror', 'origin'])
  } finally {
    upstream.cleanup()
    fx.cleanup()
  }
})

test('listRemoteBranches returns [] outside a repo', async () => {
  const dir = bareDir('floe-git-norepo-')
  try {
    assert.deepEqual(await listRemoteBranches(dir), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// --- mergePreflight --------------------------------------------------------

test('mergePreflight refuses the main worktree and non-worktrees', async () => {
  const fx = seededRepo('floe-git-pre1-')
  const plain = bareDir('floe-git-plain-')
  try {
    assert.deepEqual(await mergePreflight(fx.dir, fx.dir), {
      ok: false,
      message: 'Cannot merge the main worktree into itself'
    })
    assert.deepEqual(await mergePreflight(fx.dir, plain), { ok: false, message: 'Not a git worktree' })
  } finally {
    fx.cleanup()
    rmSync(plain, { recursive: true, force: true })
  }
})

test('mergePreflight blocks detached HEAD, dirty trees and base === branch', async () => {
  const fx = seededRepo('floe-git-pre2-')
  try {
    const feat = addWorktree(fx, 'feat')

    // Clean, and distinct from base — the one shape that passes.
    assert.deepEqual(await mergePreflight(fx.dir, feat), { ok: true, base: 'main', branch: 'feat' })

    // .gw-base wins over detection, so pointing it at the branch itself is the
    // "base and branch are the same" case.
    writeFileSync(join(feat, '.gw-base'), 'feat\n')
    assert.deepEqual(await mergePreflight(fx.dir, feat), {
      ok: false,
      message: 'Base and branch are both "feat"'
    })
    rmSync(join(feat, '.gw-base'))

    // A dirty worktree is refused before anything is merged.
    writeFileSync(join(feat, 'a.txt'), 'dirty\n')
    assert.deepEqual(await mergePreflight(fx.dir, feat), {
      ok: false,
      message: '"feat" has uncommitted changes — commit or stash first'
    })
    fx.git('-C', feat, 'checkout', '--', 'a.txt')

    // ...and so is a dirty main worktree, since the fast-forward lands there.
    writeFileSync(join(fx.dir, 'a.txt'), 'dirty\n')
    assert.deepEqual(await mergePreflight(fx.dir, feat), {
      ok: false,
      message: 'The main worktree has uncommitted changes — commit or stash first'
    })
    fx.git('checkout', '--', 'a.txt')

    fx.git('-C', feat, 'checkout', '-q', '--detach')
    assert.deepEqual(await mergePreflight(fx.dir, feat), {
      ok: false,
      message: 'Worktree is in a detached HEAD — checkout a branch first'
    })
  } finally {
    fx.cleanup()
  }
})

// --- removePreflight -------------------------------------------------------

test('removePreflight reports branch, dirt and merged state', async () => {
  const fx = seededRepo('floe-git-remove-')
  const plain = bareDir('floe-git-rmplain-')
  try {
    assert.deepEqual(await removePreflight(fx.dir, fx.dir), {
      ok: false,
      dirty: false,
      changes: [],
      hasBranch: false,
      merged: false,
      ahead: 0,
      message: 'Refusing to remove the main worktree'
    })
    assert.deepEqual(await removePreflight(fx.dir, plain), {
      ok: false,
      dirty: false,
      changes: [],
      hasBranch: false,
      merged: false,
      ahead: 0,
      message: 'Not a git worktree'
    })

    const feat = addWorktree(fx, 'feat')
    writeFileSync(join(feat, 'c.txt'), 'c\n')
    fx.git('-C', feat, 'add', '-A')
    fx.git('-C', feat, 'commit', '-q', '-m', 'c1')

    // Ahead of base and clean: safe to remove, but the branch would need `-D`.
    const ahead = await removePreflight(fx.dir, feat)
    assert.equal(ahead.ok, true)
    assert.equal(ahead.branch, 'feat')
    assert.equal(ahead.hasBranch, true)
    assert.equal(ahead.dirty, false)
    assert.deepEqual(ahead.changes, [])
    assert.equal(ahead.merged, false, 'not in `branch --merged main` yet')
    // The second checkpoint's number: what `-D` would throw away, and against what.
    assert.equal(ahead.ahead, 1, 'one commit base has not got')
    assert.equal(ahead.base, 'main')

    // Uncommitted work is listed verbatim, so the panel can show it.
    writeFileSync(join(feat, 'd.txt'), 'd\n')
    const dirty = await removePreflight(fx.dir, feat)
    assert.equal(dirty.dirty, true)
    assert.deepEqual(dirty.changes, ['?? d.txt'])
    rmSync(join(feat, 'd.txt'))

    // Once base contains it, a safe `-d` is enough.
    fx.git('merge', '-q', '--no-edit', 'feat')
    const merged = await removePreflight(fx.dir, feat)
    assert.equal(merged.merged, true)
    assert.equal(merged.dirty, false)
    assert.equal(merged.ahead, 0, 'nothing to lose once base has it')
  } finally {
    fx.cleanup()
    rmSync(plain, { recursive: true, force: true })
  }
})

// --- mergeWorktree ---------------------------------------------------------

test('mergeWorktree merges the branch and fast-forwards base', async () => {
  const fx = seededRepo('floe-git-merge-')
  try {
    const feat = addWorktree(fx, 'feat')
    writeFileSync(join(feat, 'c.txt'), 'c\n')
    fx.git('-C', feat, 'add', '-A')
    fx.git('-C', feat, 'commit', '-q', '-m', 'work')

    // base moved too, so this is a real merge, not a no-op.
    fx.write('b.txt', 'b2\n')
    fx.commit('base moved')

    const before = fx.git('rev-parse', 'main')
    const res = await mergeWorktree(fx.dir, feat)
    assert.equal(res.ok, true)
    assert.equal(res.message, 'Merged "feat" → "main"')
    assert.equal(fx.git('rev-parse', 'main'), fx.git('-C', feat, 'rev-parse', 'feat'), 'base was fast-forwarded')
    assert.equal(readFileSync(join(fx.dir, 'c.txt'), 'utf8'), 'c\n', 'the work landed on main')
    // Where base was and where it ended up — what makes an unasked-for merge
    // reversible. Read before the fast-forward, because after it the old commit
    // is only reachable through the reflog.
    assert.equal(res.base, 'main')
    assert.equal(res.baseBefore, before)
    assert.equal(res.baseAfter, fx.git('rev-parse', 'main'))
  } finally {
    fx.cleanup()
  }
})

test('undoMerge puts base back, and refuses once base has moved on', async () => {
  const fx = seededRepo('floe-git-undo-')
  try {
    const feat = addWorktree(fx, 'feat')
    writeFileSync(join(feat, 'c.txt'), 'c\n')
    fx.git('-C', feat, 'add', '-A')
    fx.git('-C', feat, 'commit', '-q', '-m', 'work')

    const res = await mergeWorktree(fx.dir, feat)
    assert.equal(res.ok, true)
    const { base, baseBefore, baseAfter } = res as Required<typeof res>

    // Something else landed after the merge. Undo now would throw it away, so
    // it refuses — that refusal is the only thing that makes auto-merge safe.
    fx.write('d.txt', 'd\n')
    fx.commit('somebody else')
    const moved = await undoMerge(fx.dir, base, baseAfter, baseBefore)
    assert.equal(moved.ok, false)
    assert.match(moved.message ?? '', /moved on/)
    assert.equal(readFileSync(join(fx.dir, 'c.txt'), 'utf8'), 'c\n', 'the refusal changed nothing')

    // Back to the state right after the merge: now it is the last thing that
    // happened, so it can be taken back.
    fx.git('reset', '--hard', baseAfter)
    const undone = await undoMerge(fx.dir, base, baseAfter, baseBefore)
    assert.equal(undone.ok, true)
    assert.equal(fx.git('rev-parse', base), baseBefore, 'base is back where it was')
    assert.equal(existsSync(join(fx.dir, 'c.txt')), false, 'the work is off main')
    // And it is still ON the branch — this un-lands the work, it does not delete it.
    assert.equal(fx.git('-C', feat, 'rev-parse', 'feat'), baseAfter)
  } finally {
    fx.cleanup()
  }
})

test('mergeWorktree refuses the main worktree and a dirty branch', async () => {
  const fx = seededRepo('floe-git-merge2-')
  try {
    assert.deepEqual(await mergeWorktree(fx.dir, fx.dir), {
      ok: false,
      message: 'Cannot merge the main worktree into itself'
    })

    const feat = addWorktree(fx, 'feat')
    writeFileSync(join(feat, 'a.txt'), 'dirty\n')
    assert.deepEqual(await mergeWorktree(fx.dir, feat), {
      ok: false,
      message: '"feat" has uncommitted changes — commit or stash first'
    })
  } finally {
    fx.cleanup()
  }
})

// Conflicts must leave the worktree exactly as it was: mergeWorktree aborts and
// reports, so the work can go through the guided panel instead.
test('mergeWorktree aborts on conflict and leaves the worktree clean', async () => {
  const fx = seededRepo('floe-git-conflict-')
  try {
    const feat = conflictingBranch(fx)

    const res = await mergeWorktree(fx.dir, feat)
    assert.equal(res.ok, false)
    assert.match(res.message ?? '', /^Conflicts merging "main" into "feat"/)
    assert.equal(fx.git('-C', feat, 'status', '--porcelain'), '', 'the merge was aborted')
    assert.equal(readFileSync(join(feat, 'a.txt'), 'utf8'), 'from feat\n')
  } finally {
    fx.cleanup()
  }
})

// The merge into the branch can succeed while the fast-forward cannot run:
// checking base out in root is refused when another worktree already holds it.
test('mergeWorktree reports a merge that landed but could not fast-forward', async () => {
  const fx = seededRepo('floe-git-noff-')
  try {
    fx.git('branch', 'trunk')
    fx.git('worktree', 'add', '-q', join(fx.dir, '.worktrees', 'trunk'), 'trunk')
    const feat = addWorktree(fx, 'feat')
    writeFileSync(join(feat, '.gw-base'), 'trunk\n')
    writeFileSync(join(feat, 'c.txt'), 'c\n')
    fx.git('-C', feat, 'add', 'c.txt')
    fx.git('-C', feat, 'commit', '-q', '-m', 'work')

    const res = await mergeWorktree(fx.dir, feat)
    assert.equal(res.ok, false)
    assert.match(res.message ?? '', /^Merged "trunk" into "feat", but couldn't fast-forward "trunk"\./)
    assert.equal(fx.git('rev-parse', 'trunk'), fx.git('rev-parse', 'main'), 'trunk did not move')
  } finally {
    fx.cleanup()
  }
})

// --- mergeResolveCheck -----------------------------------------------------

// A 'feat' worktree whose a.txt conflicts with main's.
function conflictingBranch(fx: GitFixture): string {
  const feat = addWorktree(fx, 'feat')
  writeFileSync(join(feat, 'a.txt'), 'from feat\n')
  fx.git('-C', feat, 'commit', '-q', '-am', 'feat edit')
  fx.write('a.txt', 'from main\n')
  fx.commit('main edit')
  return feat
}

// ...with that conflicted merge actually in progress.
function conflictedMerge(fx: GitFixture): string {
  const feat = conflictingBranch(fx)
  let conflicted = false
  try {
    fx.git('-C', feat, 'merge', '--no-edit', 'main')
  } catch {
    conflicted = true
  }
  assert.ok(conflicted, 'the fixture is only useful if the merge really failed')
  return feat
}

test('mergeResolveCheck is resolved when nothing is unmerged', async () => {
  const fx = seededRepo('floe-git-resolve0-')
  try {
    const feat = addWorktree(fx, 'feat')
    assert.deepEqual(await mergeResolveCheck(feat), { resolved: true, conflicts: [] })
  } finally {
    fx.cleanup()
  }
})

// A file still carrying markers is unresolved; once the markers are gone the
// check stages it itself, so the caller never has to `git add`.
test('mergeResolveCheck reports markers, then stages the fixed file', async () => {
  const fx = seededRepo('floe-git-resolve1-')
  try {
    const feat = conflictedMerge(fx)
    assert.match(readFileSync(join(feat, 'a.txt'), 'utf8'), /^<{7} /m, 'the merge really conflicted')

    assert.deepEqual(await mergeResolveCheck(feat), { resolved: false, conflicts: ['a.txt'] })

    writeFileSync(join(feat, 'a.txt'), 'resolved\n')
    assert.deepEqual(await mergeResolveCheck(feat), { resolved: true, conflicts: [] })
    assert.equal(fx.git('-C', feat, 'diff', '--name-only', '--diff-filter=U'), '', 'the file was staged for us')
    assert.match(fx.git('-C', feat, 'status', '--porcelain'), /^M {2}a\.txt$/m)
  } finally {
    fx.cleanup()
  }
})

// A conflicted file that vanished can't be read — treat it as unresolved rather
// than silently staging a deletion.
test('mergeResolveCheck counts an unreadable conflicted file as unresolved', async () => {
  const fx = seededRepo('floe-git-resolve2-')
  try {
    const feat = conflictedMerge(fx)
    rmSync(join(feat, 'a.txt'))
    assert.deepEqual(await mergeResolveCheck(feat), { resolved: false, conflicts: ['a.txt'] })
  } finally {
    fx.cleanup()
  }
})

// --- changedFiles ----------------------------------------------------------

test('changedFiles covers committed, uncommitted, deleted, binary and untracked', async () => {
  const fx = seededRepo('floe-git-changed-')
  try {
    fx.write('mod.txt', 'm1\nm2\n')
    fx.commit('fixtures')

    fx.git('checkout', '-q', '-b', 'feat')
    // Committed on the branch: an add, a delete, a modify and a binary.
    fx.write('new.txt', 'n1\nn2\n')
    fx.write('mod.txt', 'm1\nchanged\n')
    writeFileSync(join(fx.dir, 'bin.dat'), Buffer.from([0, 1, 2, 0, 255]))
    rmSync(join(fx.dir, 'b.txt'))
    fx.commit('branch work')

    // Not committed: an edit and a brand-new file.
    writeFileSync(join(fx.dir, 'a.txt'), 'a2\n')
    writeFileSync(join(fx.dir, 'untracked.txt'), 'u\n')

    const files = await changedFiles(fx.dir)
    const by = new Map(files.map((f) => [f.relPath, f]))
    assert.deepEqual(
      files.map((f) => f.relPath),
      ['a.txt', 'b.txt', 'bin.dat', 'mod.txt', 'new.txt', 'untracked.txt'],
      'sorted by path'
    )

    assert.deepEqual(by.get('new.txt'), {
      relPath: 'new.txt',
      status: 'added',
      additions: 2,
      deletions: 0,
      fingerprint: by.get('new.txt')!.fingerprint,
      committed: true
    })
    assert.equal(by.get('b.txt')!.status, 'deleted')
    assert.equal(by.get('b.txt')!.deletions, 1)
    assert.equal(by.get('b.txt')!.fingerprint, 'deleted', 'a deleted file has no working copy to sign')
    assert.equal(by.get('mod.txt')!.status, 'modified')
    assert.equal(by.get('mod.txt')!.additions, 1)
    assert.equal(by.get('mod.txt')!.deletions, 1)
    assert.equal(by.get('mod.txt')!.committed, true)

    // Binary files report '-' in numstat; that must read as 0, not NaN.
    assert.equal(by.get('bin.dat')!.additions, 0)
    assert.equal(by.get('bin.dat')!.deletions, 0)
    assert.equal(by.get('bin.dat')!.status, 'added')

    // Still in the working tree only.
    assert.equal(by.get('a.txt')!.committed, false)
    assert.equal(by.get('a.txt')!.status, 'modified')
    assert.equal(by.get('untracked.txt')!.status, 'untracked')
    assert.equal(by.get('untracked.txt')!.committed, false)
    assert.equal(by.get('untracked.txt')!.additions, 0)

    // size:mtime, so a later edit expires the "viewed" mark.
    assert.match(by.get('a.txt')!.fingerprint, /^\d+:\d+$/)
  } finally {
    fx.cleanup()
  }
})

// On an unborn HEAD every git call but `ls-files --others` fails; the panel must
// still list the files the first commit is about to be made from.
test('changedFiles lists untracked files on a repo with no commits', async () => {
  const fx = makeGitRepo('floe-git-unborn-')
  try {
    writeFileSync(join(fx.dir, 'first.txt'), 'x\n')

    const files = await changedFiles(fx.dir)
    assert.equal(files.length, 1)
    assert.equal(files[0].relPath, 'first.txt')
    assert.equal(files[0].status, 'untracked')
    assert.equal(files[0].committed, false, 'nothing can be committed yet')
  } finally {
    fx.cleanup()
  }
})

test('changedFiles returns [] outside a repo', async () => {
  const dir = bareDir('floe-git-changed-norepo-')
  try {
    writeFileSync(join(dir, 'loose.txt'), 'x\n')
    assert.deepEqual(await changedFiles(dir), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// --- reviewCommits ---------------------------------------------------------

test('reviewCommits builds the branch story with per-file counts', async () => {
  const fx = seededRepo('floe-git-commits-')
  try {
    fx.git('checkout', '-q', '-b', 'side')
    fx.write('side.txt', 's1\ns2\ns3\n')
    fx.commit('side work')

    fx.git('checkout', '-q', '-b', 'feat', 'main')
    fx.write('new.txt', 'n1\nn2\n')
    writeFileSync(join(fx.dir, 'bin.dat'), Buffer.from([0, 1, 2, 0, 255]))
    rmSync(join(fx.dir, 'b.txt'))
    fx.commit('feat work')
    const featWork = fx.git('rev-parse', '--short', 'HEAD')

    fx.git('merge', '-q', '--no-ff', '--no-edit', 'side', '-m', 'merge side')
    const mergeSha = fx.git('rev-parse', '--short', 'HEAD')

    const commits = await reviewCommits(fx.dir)
    assert.equal(commits.length, 3, 'the merge plus both sides, since the review base is main')

    // Newest first: the merge commit leads.
    assert.equal(commits[0].hash, mergeSha)
    assert.equal(commits[0].subject, 'merge side')
    assert.equal(commits[0].isMerge, true)
    assert.deepEqual(commits[0].files, [], 'a merge carries no diff of its own')
    assert.equal(commits[0].additions, 0)
    assert.equal(commits[0].deletions, 0)

    const work = commits.find((c) => c.hash === featWork)!
    assert.equal(work.subject, 'feat work')
    assert.equal(work.author, 'Fixture')
    assert.equal(work.isMerge, false)
    assert.ok(work.relDate.length > 0, 'a relative date for the timeline')
    assert.deepEqual(
      [...work.files].sort((a, b) => a.relPath.localeCompare(b.relPath)),
      [
        { relPath: 'b.txt', status: 'deleted', additions: 0, deletions: 1 },
        // Binary: numstat says '-', which must read as 0.
        { relPath: 'bin.dat', status: 'added', additions: 0, deletions: 0 },
        { relPath: 'new.txt', status: 'added', additions: 2, deletions: 0 }
      ]
    )
    assert.equal(work.additions, 2, 'commit totals sum the files')
    assert.equal(work.deletions, 1)

    const side = commits.find((c) => c.subject === 'side work')!
    assert.deepEqual(side.files, [{ relPath: 'side.txt', status: 'added', additions: 3, deletions: 0 }])
    assert.equal(side.additions, 3)
    assert.equal(side.deletions, 0)
  } finally {
    fx.cleanup()
  }
})

test('reviewCommits returns [] on a repo with no commits', async () => {
  const fx = makeGitRepo('floe-git-commits0-')
  try {
    assert.deepEqual(await reviewCommits(fx.dir), [])
  } finally {
    fx.cleanup()
  }
})
