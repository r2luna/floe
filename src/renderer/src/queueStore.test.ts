import assert from 'node:assert/strict'
import test, { beforeEach } from 'node:test'
import type { Queued } from './queue.ts'
import {
  claimBatch,
  queueOf,
  releaseBoundary,
  resetQueues,
  subscribeQueue,
  updateQueue
} from './queueStore.ts'

const q = (text: string, linked = false): Queued => ({ id: text, text, linked })

beforeEach(resetQueues)

test('a queue is filed under its session, not under the panel that typed it', () => {
  // The bug: switching chats unmounts the panel, and a queue in its state went
  // with it. Here the writer is gone and the reader is a different call.
  updateQueue('s1', () => [q('depois')])
  assert.deepEqual(
    queueOf('s1').map((x) => x.text),
    ['depois']
  )
  assert.equal(queueOf('s2').length, 0, 'another session sees nothing')
})

test('an unchanged queue is the same array, so a subscriber can compare by identity', () => {
  updateQueue('s1', () => [q('a')])
  const before = queueOf('s1')
  updateQueue('s1', (prev) => prev)
  assert.equal(queueOf('s1'), before)
  assert.equal(queueOf('nope'), queueOf('nope'), 'and so is the empty one')
})

test('emptying a queue drops the entry instead of keeping a blank one', () => {
  updateQueue('s1', () => [q('a')])
  updateQueue('s1', () => [])
  assert.equal(queueOf('s1').length, 0)
})

test('writes notify, no-ops do not', () => {
  let n = 0
  const off = subscribeQueue(() => n++)
  updateQueue('s1', () => [q('a')])
  updateQueue('s1', (prev) => prev)
  off()
  updateQueue('s1', () => [q('b')])
  assert.equal(n, 1)
})

test('a boundary is claimed once: the second viewer of the same session gets nothing', () => {
  updateQueue('s1', () => [q('one'), q('two')])
  const first = claimBatch('s1')
  assert.equal(first?.text, 'one')
  assert.equal(claimBatch('s1'), null, 'two panels, one turn end, one delivery')
  assert.deepEqual(
    queueOf('s1').map((x) => x.text),
    ['two'],
    'the rest waits for the next boundary'
  )
})

test('the next boundary opens once the turn has started', () => {
  updateQueue('s1', () => [q('one'), q('two')])
  claimBatch('s1')
  releaseBoundary('s1')
  assert.equal(claimBatch('s1')?.text, 'two')
})

test('a claim on an empty queue does not lock the boundary', () => {
  assert.equal(claimBatch('s1'), null)
  updateQueue('s1', () => [q('late')])
  assert.equal(claimBatch('s1')?.text, 'late')
})

test('a linked run rides along in the claim, exactly as takeBatch rules', () => {
  updateQueue('s1', () => [q('first'), q('and this', true), q('later')])
  assert.equal(claimBatch('s1')?.text, 'first\n\nand this')
  assert.deepEqual(
    queueOf('s1').map((x) => x.text),
    ['later']
  )
})

test('locks are per session', () => {
  updateQueue('s1', () => [q('a')])
  updateQueue('s2', () => [q('b')])
  claimBatch('s1')
  assert.equal(claimBatch('s2')?.text, 'b')
})
