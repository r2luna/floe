import assert from 'node:assert/strict'
import test from 'node:test'
import { topBarState } from './topBarState.ts'
import type { Worktree, WorktreeStatus } from '../../shared/types'

const feat: Worktree = { branch: 'topbar', path: '/r/.worktrees/topbar', isMain: false }
const clean: WorktreeStatus = { added: 0, modified: 0, deleted: 0, ahead: 0, behind: 0, upstream: true }

test('uncommitted files come first: merge waits for the commit', () => {
  const s = topBarState(feat, { ...clean, added: 2, modified: 5, deleted: 1, base: { name: 'master', ahead: 3, behind: 0 } })
  assert.deepEqual(s.dirty, { added: 2, modified: 5, deleted: 1 })
  assert.equal(s.merge, 'commit-first')
})

test('a clean branch with commits the base lacks is ready to merge', () => {
  const s = topBarState(feat, { ...clean, ahead: 3, base: { name: 'master', ahead: 3, behind: 4 } })
  assert.equal(s.dirty, undefined)
  assert.equal(s.merge, 'ready')
  assert.equal(s.push, 3)
  assert.deepEqual(s.base, { name: 'master', ahead: 3, behind: 4 })
})

test('a clean branch level with its base has nothing to merge', () => {
  assert.equal(topBarState(feat, { ...clean, base: { name: 'master', ahead: 0, behind: 2 } }).merge, 'nothing')
})

test('the main worktree and a blocked one never offer a merge', () => {
  assert.equal(topBarState({ ...feat, isMain: true }, { ...clean, added: 1 }).merge, 'main')
  assert.equal(topBarState({ ...feat, blocked: true }, clean).merge, 'blocked')
})

test('no status yet, or no base git could resolve, says nothing about merging', () => {
  assert.equal(topBarState(feat, undefined).merge, 'unknown')
  assert.equal(topBarState(feat, clean).merge, 'unknown')
  assert.equal(topBarState(feat, { ...clean, added: 3 }).merge, 'unknown')
  assert.equal(topBarState(undefined, undefined).push, 0)
})
