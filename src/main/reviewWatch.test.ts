import test from 'node:test'
import assert from 'node:assert/strict'
import { installHook } from './config/hook.test-helper.ts'

installHook()

const { isNoise, isTreeNoise } = await import('./reviewWatch.ts')

test('the git dir and node_modules reach neither panel', () => {
  for (const path of ['.git', '.git/index', 'node_modules', 'node_modules/x/y.js', 'a/node_modules/b']) {
    assert.equal(isTreeNoise(path), true, path)
    assert.equal(isNoise(path), true, path)
  }
})

test('.floe moves no diff but is a file in the tree', () => {
  // The bug this split exists for: an agent writing a plan must appear in the
  // tree without costing the Changes list a git call.
  assert.equal(isNoise('.floe/plans/2026-08-29.md'), true)
  assert.equal(isTreeNoise('.floe/plans/2026-08-29.md'), false)
})

test('ordinary source files reach both', () => {
  assert.equal(isNoise('src/main/files.ts'), false)
  assert.equal(isTreeNoise('src/main/files.ts'), false)
})

test('an unnamed event refreshes both rather than being dropped', () => {
  assert.equal(isNoise(null), false)
  assert.equal(isTreeNoise(null), false)
})
