import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseStatus } from './gitStatus.ts'

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
