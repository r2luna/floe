import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WebContents } from 'electron'
import { listPlans, readImplementPhases, findSpecSummarySource, watchPlans } from './plans.ts'

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

// Stamp a fixed mtime so "newest first" is asserted on a known order rather than
// on how fast the machine wrote three files.
function stamp(path: string, seconds: number): void {
  utimesSync(path, seconds, seconds)
}

test('listPlans returns the .floe/plans markdown, newest first', () => {
  withWorktree(
    {
      '.floe/plans/old.md': '# old',
      '.floe/plans/new.md': '# new',
      '.floe/plans/notes.txt': 'not a plan',
      '.floe/plans/drafts/nested.md': '# a directory, not a plan'
    },
    (root) => {
      stamp(join(root, '.floe/plans/old.md'), 1_000)
      stamp(join(root, '.floe/plans/new.md'), 2_000)
      const plans = listPlans(root)
      assert.deepEqual(plans.map((p) => p.name), ['new.md', 'old.md'])
      assert.equal(plans[0].relPath, '.floe/plans/new.md')
      assert.equal(plans[0].mtime, 2_000_000)
    }
  )
})

test('a worktree with no plans directory lists nothing rather than throwing', () => {
  withWorktree({ 'README.md': '# hi' }, (root) => {
    assert.deepEqual(listPlans(root), [])
  })
})

// The panel shows the branch's spec docs above the gitignored scratch plans, so
// the order of the two groups is part of the contract.
test('listPlans puts the branch spec docs ahead of the .floe/plans ones', () => {
  withWorktree(
    {
      'specs/002-dos-202-offboard/spec.md': '# spec',
      '.floe/plans/scratch.md': '# scratch'
    },
    (root) => {
      const plans = listPlans(root, 'feature/dos-202-offboard')
      assert.deepEqual(plans.map((p) => p.relPath), [
        'specs/002-dos-202-offboard/spec.md',
        '.floe/plans/scratch.md'
      ])
      // Without a branch the caller only asked about the scratch plans.
      assert.deepEqual(listPlans(root).map((p) => p.relPath), ['.floe/plans/scratch.md'])
    }
  )
})

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

test('watchPlans pre-creates the plans dir and reports writes on the active worktree only', async () => {
  const root = mkdtempSync(join(tmpdir(), 'floe-plans-'))
  const other = mkdtempSync(join(tmpdir(), 'floe-plans-'))
  const sent: Array<{ channel: string; payload: { worktreePath: string } }> = []
  const wc = {
    isDestroyed: () => false,
    send: (channel: string, payload: { worktreePath: string }) => sent.push({ channel, payload })
  } as unknown as WebContents
  try {
    watchPlans(wc, root)
    await wait(200)
    // The directory exists because watchPlans made it, before any plan was written.
    writeFileSync(join(root, '.floe/plans/a.md'), '# a')
    await wait(500)
    assert.ok(sent.length > 0, 'a plan written should reach the panel')
    assert.ok(sent.every((s) => s.channel === 'plans:event' && s.payload.worktreePath === root))

    // One watcher, retargeted: switching worktree has to drop the old one, or the
    // panel would keep repainting for a worktree nobody is looking at.
    watchPlans(wc, other)
    await wait(200)
    const before = sent.length
    writeFileSync(join(root, '.floe/plans/b.md'), '# b')
    await wait(500)
    assert.equal(sent.length, before)
  } finally {
    // A path that cannot hold a plans dir closes the live watcher and opens none,
    // so nothing is left holding this process open.
    const file = join(mkdtempSync(join(tmpdir(), 'floe-plans-')), 'a-file')
    writeFileSync(file, '')
    watchPlans(wc, file)
    rmSync(root, { recursive: true, force: true })
    rmSync(other, { recursive: true, force: true })
  }
})
