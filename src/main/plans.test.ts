import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readImplementPhases, findSpecSummarySource } from './plans.ts'

// Build a throwaway worktree with `specs/<dir>/tasks.md` files, run the body,
// then clean up. Keeps each case isolated from the real filesystem.
function withWorktree(files: Record<string, string>, body: (worktreePath: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'floe-plans-'))
  try {
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(root, rel)
      mkdirSync(join(abs, '..'), { recursive: true })
      writeFileSync(abs, content)
    }
    body(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const SAMPLE = `# Tasks: Offboard a User

## Format: \`[ID] [P?] [Story] Description\`

- **[P]**: legend bullet, not a task — has no checkbox

## Phase 1: Setup (Shared Schema & Model)

- [x] T001 Create migration
- [X] T002 [P] Edit the model

## Phase 2: User Story 1 — Offboard (P1) 🎯 MVP

### Tests (write first)

- [x] T003 [P] [US1] Write the failing test

### Implementation

- [ ] T004 [US1] Make it green
- [ ] T005 [US1] Wire the view

## Dependencies & Execution Order

- T004 blocks T005 (prose bullet, not a checkbox)
`

test('readImplementPhases parses phases, tallies boxes, and strips the "Phase N:" prefix', () => {
  withWorktree({ 'specs/feat-OFF-1/tasks.md': SAMPLE }, (root) => {
    const phases = readImplementPhases(root, 'feat/OFF-1')
    assert.deepEqual(phases, [
      { title: 'Setup (Shared Schema & Model)', done: 2, total: 2 },
      { title: 'User Story 1 — Offboard (P1) 🎯 MVP', done: 1, total: 3 }
    ])
  })
})

test('readImplementPhases drops sections without checkboxes (Format preamble, Dependencies notes)', () => {
  withWorktree({ 'specs/feat-OFF-1/tasks.md': SAMPLE }, (root) => {
    const titles = readImplementPhases(root, 'feat-OFF-1').map((p) => p.title)
    assert.ok(!titles.some((t) => /Format|Dependencies/.test(t)))
    assert.equal(titles.length, 2)
  })
})

test('readImplementPhases returns [] when there is no tasks.md', () => {
  withWorktree({ 'specs/feat-OFF-1/spec.md': '# spec only' }, (root) => {
    assert.deepEqual(readImplementPhases(root, 'feat-OFF-1'), [])
  })
})

test('readImplementPhases returns [] when there is no specs directory at all', () => {
  withWorktree({ 'README.md': '# nothing here' }, (root) => {
    assert.deepEqual(readImplementPhases(root, 'feat-OFF-1'), [])
  })
})

test('findSpecSummarySource picks the branch-matched spec, never borrows another', () => {
  withWorktree(
    {
      'specs/update-pest-v5/spec.md': '# Jobs module MVP',
      'specs/feat-DOS-292/spec.md': '# The 292 feature'
    },
    (root) => {
      // A branch with a matching folder gets its own spec.
      assert.ok(findSpecSummarySource(root, 'feat/DOS-292')?.path.includes('feat-DOS-292'))
      // A branch with NO matching folder gets null — not the most-recent stranger.
      assert.equal(findSpecSummarySource(root, 'fix/dos-999'), null)
    }
  )
})

test('readImplementPhases fuzzy-matches the branch to its spec folder among several', () => {
  withWorktree(
    {
      'specs/feat-DOS-1/tasks.md': '## Phase 1: A\n- [x] T001 done\n',
      'specs/feat-DOS-2/tasks.md': '## Phase 1: B\n- [ ] T001 todo\n'
    },
    (root) => {
      const phases = readImplementPhases(root, 'feat/DOS-2')
      assert.deepEqual(phases, [{ title: 'B', done: 0, total: 1 }])
    }
  )
})
