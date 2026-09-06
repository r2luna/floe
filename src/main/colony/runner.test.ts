import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installHook } from '../config/hook.test-helper.ts'

installHook()

const { taskDirFor } = await import('./runner.ts')

test('a lane reads and writes specs/<branch with slashes flattened>/', () => {
  // LANE-CONTRACT states this rule to the agent; the board has to compute the
  // same path, or the brief is written where nobody looks for it.
  assert.equal(taskDirFor('feature/DOS-12'), 'specs/feature-DOS-12')
  assert.equal(taskDirFor('fix/backgrounded-polling'), 'specs/fix-backgrounded-polling')
  assert.equal(taskDirFor('plain'), 'specs/plain')
})
