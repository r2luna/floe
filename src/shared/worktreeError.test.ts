import test from 'node:test'
import assert from 'node:assert/strict'
import { diagnoseWorktreeFailure } from './worktreeError.ts'

// The real thing, as it arrives in the renderer: Electron's prefix, execFile's
// prefix, then git.
const ipc = (fatal: string): string =>
  `Error invoking remote method 'worktrees:create': Error: Command failed: git -C /repo worktree add -b x /repo/.worktrees/x master\n${fatal}`

test('a parent branch blocking its namespace explains itself and offers a flat name', () => {
  const failure = diagnoseWorktreeFailure(
    'feat/dos-388-plan',
    ipc(
      "fatal: cannot lock ref 'refs/heads/feat/dos-388-plan': 'refs/heads/feat' exists; cannot create 'refs/heads/feat/dos-388-plan'"
    )
  )
  assert.match(failure.why, /The branch feat already exists/)
  assert.match(failure.why, /feat\//)
  assert.equal(failure.suggestion, 'feat-dos-388-plan')
  // git's line survives whole, without the two wrappers around it.
  assert.match(failure.raw, /^fatal: cannot lock ref/)
  assert.doesNotMatch(failure.raw, /remote method|Command failed/)
})

test('a child branch blocking its parent has no flat name to offer', () => {
  const failure = diagnoseWorktreeFailure(
    'bug',
    "fatal: cannot lock ref 'refs/heads/bug': 'refs/heads/bug/y' exists; cannot create 'refs/heads/bug'"
  )
  assert.match(failure.why, /The branch bug\/y already exists, so bug cannot/)
  assert.equal(failure.suggestion, undefined)
})

test('a branch already checked out points at the worktree that holds it', () => {
  const failure = diagnoseWorktreeFailure(
    'plugin-ui',
    ipc("fatal: 'plugin-ui' is already used by worktree at '/repo/.worktrees/plugin-ui'")
  )
  assert.equal(
    failure.why,
    'The branch plugin-ui is already checked out at /repo/.worktrees/plugin-ui.'
  )
  assert.equal(failure.suggestion, undefined)
})

test('a base that does not exist names the base, not the branch', () => {
  const failure = diagnoseWorktreeFailure('dos-390', ipc('fatal: invalid reference: release-2.4'))
  assert.equal(failure.why, 'There is no ref named release-2.4 here to branch from.')
})

test('a name git will not take says so', () => {
  const failure = diagnoseWorktreeFailure('bad..name', ipc("fatal: 'bad..name' is not a valid branch name"))
  assert.match(failure.why, /will not accept bad\.\.name/)
})

test("createWorktree's own throws are already the sentence — no raw line under them", () => {
  const failure = diagnoseWorktreeFailure(
    'dos-390',
    "Error invoking remote method 'worktrees:create': Error: Worktree already exists: dos-390"
  )
  assert.equal(failure.why, 'Worktree already exists: dos-390')
  assert.equal(failure.raw, '')
})

test('an unrecognised failure still shows git, never nothing', () => {
  const failure = diagnoseWorktreeFailure('x', ipc('fatal: could not read Username for https://x'))
  assert.equal(failure.why, 'git refused to create the worktree.')
  assert.equal(failure.raw, 'fatal: could not read Username for https://x')
})

test('a failure with no git line at all falls back to the last line, unwrapped', () => {
  const failure = diagnoseWorktreeFailure('x', "Error invoking remote method 'worktrees:create': Error: EACCES")
  assert.equal(failure.raw, 'EACCES')
})

test('a flat name is only suggested when flattening changes something', () => {
  // No slash to flatten: git hit the clash through a ref the user did not type.
  const failure = diagnoseWorktreeFailure(
    'feat',
    "fatal: cannot lock ref 'refs/heads/feat/a/b': 'refs/heads/feat' exists; cannot create 'refs/heads/feat/a/b'"
  )
  assert.equal(failure.suggestion, undefined)
})
