import assert from 'node:assert/strict'
import test from 'node:test'
import { moveTargets, stepGroup } from './projectMove.ts'

test('moveTargets lists the drawn groups first, then the empty ones', () => {
  const targets = moveTargets([{ name: 'Projects' }, { name: 'Work' }], ['Work', 'Archive'])
  assert.deepEqual(targets, ['Projects', 'Work', 'Archive'])
})

test('moveTargets always offers the default group, even with nothing in it', () => {
  assert.deepEqual(moveTargets([{ name: 'Work' }], []), ['Projects', 'Work'])
})

test('moveTargets never lists a group twice', () => {
  // The regression: `Projects` came from the default AND from the group list,
  // which drew the heading twice and the carried row with it.
  const targets = moveTargets(
    [{ name: 'Projects' }, { name: 'DevSquad' }],
    ['Projects', 'DevSquad', 'Archive']
  )
  assert.deepEqual(targets, ['Projects', 'DevSquad', 'Archive'])
  assert.equal(new Set(targets).size, targets.length)
})

test('stepGroup clamps at both ends', () => {
  const targets = ['a', 'b', 'c']
  assert.equal(stepGroup(targets, 'a', 1), 'b')
  assert.equal(stepGroup(targets, 'a', -1), 'a')
  assert.equal(stepGroup(targets, 'c', 1), 'c')
})

test('stepGroup falls back to the first target when the group is gone', () => {
  assert.equal(stepGroup(['a', 'b'], 'vanished', 1), 'a')
})
