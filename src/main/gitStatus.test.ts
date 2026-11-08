import { test } from 'node:test'
import assert from 'node:assert/strict'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { headBranch, parseDistance, parseStatus, worktreeStatus } from './gitStatus.ts'
import { makeGitRepo } from './gitFixture.test-helper.ts'

// worktreeStatus spawns its own git with THIS process's environment, so the
// walls go up here too: no inherited GIT_DIR, no walking up past the fixtures.
for (const key of Object.keys(process.env)) if (key.startsWith('GIT_')) delete process.env[key]
process.env.GIT_CEILING_DIRECTORIES = realpathSync(tmpdir())
process.env.GIT_CONFIG_GLOBAL = '/dev/null'
process.env.GIT_CONFIG_SYSTEM = '/dev/null'

test('parseStatus counts files by what happened to them, not by staging', () => {
  const out = [
    '## feat/x...origin/feat/x [ahead 2, behind 3]',
    'A  src/new.ts',
    '?? src/untracked.ts',
    ' M src/edited.ts',
    'M  src/staged-edit.ts',
    ' D src/gone.ts',
    ''
  ].join('\n')
  assert.deepEqual(parseStatus(out), {
    added: 2, // staged-new and untracked are both "a file to commit"
    modified: 2,
    deleted: 1,
    ahead: 2,
    behind: 3,
    upstream: true
  })
})

test('parseStatus reads a branch with no upstream as nothing to push TO', () => {
  const s = parseStatus('## feat/local\n')
  assert.equal(s.upstream, false)
  assert.equal(s.ahead, 0)
  assert.equal(s.behind, 0)
})

// `[ahead 2]` alone (never pushed a merge back) must not leave `behind` unset.
test('parseStatus handles ahead without behind', () => {
  const s = parseStatus('## main...origin/main [ahead 2]\n')
  assert.deepEqual([s.ahead, s.behind, s.upstream], [2, 0, true])
})

test('parseStatus reports a clean, in-sync worktree as all zeroes', () => {
  assert.deepEqual(parseStatus('## main...origin/main\n'), {
    added: 0,
    modified: 0,
    deleted: 0,
    ahead: 0,
    behind: 0,
    upstream: true
  })
})

test('headBranch reads the branch off the status header', () => {
  assert.equal(headBranch('## feat/x...origin/feat/x [ahead 2]\n M a.ts\n'), 'feat/x')
  assert.equal(headBranch('## feat/local\n'), 'feat/local')
  assert.equal(headBranch('## No commits yet on main\n'), 'main')
  assert.equal(headBranch('## HEAD (no branch)\n'), undefined)
  assert.equal(headBranch(''), undefined)
})

test('parseDistance reads rev-list --left-right as behind, then ahead', () => {
  assert.deepEqual(parseDistance('4\t3\n'), { behind: 4, ahead: 3 })
  assert.equal(parseDistance('fatal: bad revision'), undefined)
})

test('worktreeStatus measures a branch against the base it merges into', async () => {
  const repo = makeGitRepo()
  try {
    repo.write('a.txt', 'a')
    repo.commit('base')
    repo.git('checkout', '-q', '-b', 'feat')
    repo.write('b.txt', 'b')
    repo.commit('one')
    repo.write('c.txt', 'c')
    repo.commit('two')
    const base = 'main'

    const status = await worktreeStatus(repo.dir, base)
    assert.deepEqual(status?.base, { name: base, ahead: 2, behind: 0 })

    // On its own base there is nothing to merge into, and no field to say so.
    repo.git('checkout', '-q', base)
    assert.equal((await worktreeStatus(repo.dir, base))?.base, undefined)

    // A base git cannot resolve leaves the field out, not the whole row.
    const unknown = await worktreeStatus(repo.dir, 'no-such-branch')
    assert.equal(unknown?.base, undefined)
    assert.equal(unknown?.added, 0)
  } finally {
    repo.cleanup()
  }
})
