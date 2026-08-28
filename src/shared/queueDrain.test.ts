import { test } from 'node:test'
import assert from 'node:assert/strict'
import { takeLinkedGroup } from './queueDrain.ts'
import type { QueuedMessage } from './types.ts'

const m = (id: string, text: string, extra: Partial<QueuedMessage> = {}): QueuedMessage => ({
  id,
  text,
  ...extra
})

test('empty queue drains nothing', () => {
  assert.equal(takeLinkedGroup([]), null)
})

test('unlinked head fires alone, rest stays queued', () => {
  const step = takeLinkedGroup([m('a', 'A'), m('b', 'B')])
  assert.equal(step?.text, 'A')
  assert.deepEqual(
    step?.rest.map((r) => r.id),
    ['b']
  )
})

test('a contiguous linked run merges into one send', () => {
  const step = takeLinkedGroup([m('a', 'A'), m('b', 'B', { linked: true }), m('c', 'C', { linked: true }), m('d', 'D')])
  assert.equal(step?.text, 'A\n\nB\n\nC')
  assert.deepEqual(
    step?.rest.map((r) => r.id),
    ['d']
  )
})

test('link stops at the first unlinked item', () => {
  const step = takeLinkedGroup([m('a', 'A'), m('b', 'B', { linked: true }), m('c', 'C'), m('d', 'D', { linked: true })])
  assert.equal(step?.text, 'A\n\nB')
  assert.deepEqual(
    step?.rest.map((r) => r.id),
    ['c', 'd']
  )
})

test('head model + merged attachments carry through', () => {
  const step = takeLinkedGroup([
    m('a', 'A', { modelOverride: 'sonnet', images: [{ mediaType: 'image/png', data: 'x' } as never] }),
    m('b', 'B', { linked: true, files: [{ name: 'f', kind: 'text', data: 'y' } as never] })
  ])
  assert.equal(step?.modelOverride, 'sonnet')
  assert.equal(step?.images.length, 1)
  assert.equal(step?.files.length, 1)
})
