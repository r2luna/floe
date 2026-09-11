import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mergeSlice, topSessions } from './useActiveSessions.ts'
import type { ActiveSession } from '../../shared/types'

const row = (id: string, at: number, backend?: string): ActiveSession => ({
  projectPath: `/p/${id}`,
  projectName: id,
  worktreePath: `/p/${id}`,
  branch: 'main',
  sessionId: id,
  title: id,
  lastActivityAt: at,
  running: false,
  needsYou: false,
  backend
})

test('the union is cut AFTER it is sorted, or the newest rows are what it drops', () => {
  const rows = [row('old', 1), row('new', 3), row('mid', 2)]
  assert.deepEqual(
    topSessions(rows, 2).map((s) => s.sessionId),
    ['new', 'mid']
  )
  assert.deepEqual(topSessions(rows, 0), [])
})

test("a machine's answer replaces its own rows and leaves every other machine's", () => {
  const prev = [row('a1', 5, 'local'), row('b1', 4, 'link')]
  // link answered again, and its old session is gone from the answer: a session
  // that ended has to leave the list, not linger as the newest thing there.
  const next = mergeSlice(prev, [row('b2', 6)], 'link')
  assert.deepEqual(
    topSessions(next, 10).map((s) => s.sessionId),
    ['b2', 'a1']
  )
  // The slice is tagged with the machine that answered — nothing else knows.
  assert.equal(next.find((s) => s.sessionId === 'b2')?.backend, 'link')
})

test('a machine answering with nothing empties its own rows only', () => {
  const prev = [row('a1', 5, 'local'), row('b1', 4, 'link')]
  assert.deepEqual(
    mergeSlice(prev, [], 'link').map((s) => s.sessionId),
    ['a1']
  )
})
