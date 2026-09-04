import assert from 'node:assert/strict'
import test from 'node:test'
import { sessionMentions } from './useMenuItems.ts'
import type { WorktreeRow } from './useWorktrees.ts'

const row = (branch: string, titles: string[]): WorktreeRow =>
  ({
    worktree: { path: `/w/${branch}`, branch },
    sessions: titles.map((title, i) => ({ id: `s${branch}${i}`, title, mtime: 0, active: false }))
  }) as WorktreeRow

test('sessions of the same name are one row', () => {
  const rows = [row('master', ['Release new Floe version', 'Release new Floe version'])]
  assert.deepEqual(
    sessionMentions(rows).map((m) => m.id),
    ['#Release-new-Floe-version']
  )
})

test('the same title in two worktrees is still one row', () => {
  const rows = [row('master', ['Ship it']), row('feature', ['Ship it', 'Other'])]
  assert.deepEqual(
    sessionMentions(rows).map((m) => m.id),
    ['#Ship-it', '#Other']
  )
})

test('a row carries the title and the branch it lives on', () => {
  assert.deepEqual(sessionMentions([row('master', ['Ship it'])]), [
    { id: '#Ship-it', title: 'Ship it', detail: 'master', group: 'sessions' }
  ])
})
