import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pickFlow, type MergeFlow } from './useMerge.ts'

const ROOT = '/repo'

function flow(worktreePath: string, over: Partial<MergeFlow> = {}): MergeFlow {
  return {
    root: ROOT,
    worktreePath,
    branch: worktreePath.split('/').pop() ?? '',
    base: 'master',
    steps: [{ id: 'preflight', title: 'Preflight checks', status: 'running' }],
    awaiting: null,
    done: false,
    cancelled: false,
    startedAt: 1,
    ...over
  }
}

const map = (...fs: MergeFlow[]): Record<string, MergeFlow> =>
  Object.fromEntries(fs.map((f) => [f.worktreePath, f]))

test('the branch you are in is the checklist you see', () => {
  // The bug this exists for: a merge that failed on one branch held the panel,
  // so merging any other branch was impossible until it was dealt with.
  const stuck = flow('/wt/a', {
    startedAt: 2,
    steps: [{ id: 'preflight', title: 'Preflight checks', status: 'error', detail: 'uncommitted changes' }]
  })
  const { flow: shown } = pickFlow(map(stuck, flow('/wt/b', { startedAt: 1 })), ROOT, '/wt/b')
  assert.equal(shown?.branch, 'b')
})

test('a tree with no merge of its own falls back to the newest one running', () => {
  const { flow: shown } = pickFlow(
    map(flow('/wt/a', { startedAt: 1 }), flow('/wt/b', { startedAt: 9 })),
    ROOT,
    '/wt/idle'
  )
  assert.equal(shown?.branch, 'b')
})

test('the finished merge stays up after its own worktree is gone', () => {
  // Cleanup deletes the tree, so the selection moves off it: without the
  // fallback the all-green checklist would vanish on the last step.
  const { flow: shown } = pickFlow(map(flow('/wt/a', { done: true })), ROOT, '/repo')
  assert.equal(shown?.branch, 'a')
})

test('another project never shows through', () => {
  const other = flow('/wt/x', { root: '/elsewhere' })
  const { flow: shown, mine } = pickFlow(map(other), ROOT, '/wt/x')
  assert.equal(shown, null)
  assert.deepEqual(mine, [])
})

test('the others line lists the project flows newest first', () => {
  const { mine } = pickFlow(
    map(flow('/wt/a', { startedAt: 1 }), flow('/wt/b', { startedAt: 3 }), flow('/wt/c', { startedAt: 2 })),
    ROOT,
    '/wt/a'
  )
  assert.deepEqual(mine.map((f) => f.branch), ['b', 'c', 'a'])
})

test('nothing running is nothing shown', () => {
  assert.deepEqual(pickFlow({}, ROOT, '/wt/a'), { flow: null, mine: [] })
})
