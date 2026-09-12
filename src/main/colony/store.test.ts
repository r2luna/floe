import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installHook } from '../config/hook.test-helper.ts'

installHook()

const dir = mkdtempSync(join(tmpdir(), 'colony-'))
const { setSharedDataDir } = await import('../dataDir.ts')
setSharedDataDir(dir)

const {
  addTask,
  colonySessionIds,
  freeName,
  getTask,
  listTasks,
  patchTask,
  recordVisit,
  removeTask,
  setNanny,
  taskForSession
} = await import('./store.ts')

test('a task starts in the backlog with no worktree — a card nobody released costs nothing', () => {
  const t = addTask({ project: '/p', name: 'Backgrounded Polling', brief: 'drops events' })
  assert.equal(t.stage, 'inbox')
  assert.equal(t.status, 'holding')
  assert.equal(t.worktreePath, undefined)
  // The name is slugged, because it is also the branch's last segment.
  assert.equal(t.name, 'backgrounded-polling')
})

test('two tasks never share a name — the name IS the worktree', () => {
  addTask({ project: '/p', name: 'same-thing', brief: '' })
  const second = addTask({ project: '/p', name: 'same-thing', brief: '' })
  assert.equal(second.name, 'same-thing-2')
  assert.equal(freeName('/p', 'same-thing'), 'same-thing-3')
  // Another project's board is a different board.
  assert.equal(freeName('/other', 'same-thing'), 'same-thing')
})

test('the board is partitioned by project', () => {
  addTask({ project: '/other', name: 'elsewhere', brief: '' })
  assert.equal(listTasks('/other').length, 1)
  assert.ok(listTasks('/p').length >= 3)
})

test('a finished lane records its verdict and moves the card in one write', () => {
  const t = addTask({ project: '/p', name: 'moving', brief: '' })
  patchTask(t.id, { sessionId: 'sess-1', stage: 'coder', status: 'working' })
  recordVisit(t.id, { at: 1, stage: 'coder', verdict: 'pass' }, { stage: 'qa', status: 'holding', passes: 1 })
  const after = getTask(t.id)
  assert.equal(after?.stage, 'qa')
  assert.equal(after?.passes, 1)
  assert.deepEqual(after?.visits, [{ at: 1, stage: 'coder', verdict: 'pass' }])
  // A finished turn finds its card by the session it ran in.
  assert.equal(taskForSession('sess-1')?.id, t.id)
})

test('removing a task takes it off the board and nothing else', () => {
  const t = addTask({ project: '/p', name: 'gone', brief: '' })
  removeTask(t.id)
  assert.equal(getTask(t.id), undefined)
})

test('the colony owns every step a card ran, not just the one running now', () => {
  const t = addTask({ project: '/owned', name: 'stepped', brief: '' })
  patchTask(t.id, { sessionId: 'step-2' })
  // Step one already finished and moved to the card's history — its session is
  // still the colony's, and the list that hides lanes has to hide it too.
  recordVisit(t.id, { at: 1, stage: 'coder', sessionId: 'step-1', verdict: 'pass' }, {})
  setNanny('/owned', 'nanny-1')

  const ids = colonySessionIds()
  assert.ok(ids.has('step-2'))
  assert.ok(ids.has('step-1'))
  assert.ok(ids.has('nanny-1'))
  // A session nobody put on a board is the user's own.
  assert.equal(ids.has('mine'), false)
})
