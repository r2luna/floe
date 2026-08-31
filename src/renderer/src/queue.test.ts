import assert from 'node:assert/strict'
import test from 'node:test'
import { takeBatch, type Queued } from './queue.ts'

const q = (text: string, linked = false): Queued => ({ id: text, text, linked })

test('an empty queue has nothing to send', () => {
  assert.equal(takeBatch([]), null)
})

test('one message per boundary', () => {
  // The rule that keeps every turn a clean request and response: the queue does
  // not flush in one shot just because the model went idle.
  const out = takeBatch([q('one'), q('two'), q('three')])!
  assert.equal(out.text, 'one')
  assert.deepEqual(
    out.rest.map((r) => r.text),
    ['two', 'three']
  )
})

test('a run of linked messages goes out as one', () => {
  const out = takeBatch([q('first'), q('and this', true), q('and this too', true), q('later')])!
  assert.equal(out.text, 'first\n\nand this\n\nand this too')
  assert.deepEqual(
    out.rest.map((r) => r.text),
    ['later']
  )
})

test('the run stops at the first unlinked message', () => {
  const out = takeBatch([q('a'), q('b', true), q('c'), q('d', true)])!
  assert.equal(out.text, 'a\n\nb')
  assert.deepEqual(
    out.rest.map((r) => r.text),
    ['c', 'd']
  )
})

test('a linked flag on the head is ignored', () => {
  // Nothing above it in this batch to link to — it must not swallow the next
  // message on the strength of a flag that no longer means anything.
  const out = takeBatch([q('head', true), q('next')])!
  assert.equal(out.text, 'head')
  assert.equal(out.rest.length, 1)
})

test('attachments ride with the batch that carries their text', () => {
  const img = (id: string): Queued['images'] => [{ id, mediaType: 'image/png', data: 'x' }]
  const out = takeBatch([
    { ...q('a'), images: img('1') },
    { ...q('b', true), images: img('2') },
    { ...q('c'), images: img('3') }
  ])!
  assert.deepEqual(
    out.images!.map((i) => i.id),
    ['1', '2']
  )
  // The unlinked message keeps its own image for its own turn.
  assert.deepEqual(out.rest[0].images?.map((i) => i.id), ['3'])
})
