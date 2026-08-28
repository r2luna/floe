import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  upsertComment,
  dropComment,
  stampSent,
  anchorHolds,
  isValidComment
} from './threadComments.ts'
import type { ThreadComment } from './types.ts'

function note(over: Partial<ThreadComment> = {}): ThreadComment {
  return {
    id: 'n1',
    sessionKey: 's1',
    itemIndex: 3,
    start: 5,
    end: 16,
    quote: 'placeholder',
    body: 'documenta isso?',
    ...over
  }
}

test('upsert appends a new note', () => {
  const out = upsertComment([note({ id: 'a' })], note({ id: 'b' }))
  assert.deepEqual(
    out.map((c) => c.id),
    ['a', 'b']
  )
})

// The composer re-saves while the user edits; appending would leave duplicates
// stacked on one passage.
test('upsert replaces a note carrying the same id', () => {
  const out = upsertComment([note({ id: 'a', body: 'first' })], note({ id: 'a', body: 'second' }))
  assert.equal(out.length, 1)
  assert.equal(out[0].body, 'second')
})

test('drop removes only the named note', () => {
  const out = dropComment([note({ id: 'a' }), note({ id: 'b' })], 'a')
  assert.deepEqual(
    out.map((c) => c.id),
    ['b']
  )
})

test('drop is a no-op for an unknown id', () => {
  const list = [note({ id: 'a' })]
  assert.deepEqual(dropComment(list, 'zzz'), list)
})

// The behaviour that separates this from submitReview()/submitPlanReview().
test('stampSent keeps every note and stamps only the named ones', () => {
  const list = [note({ id: 'a' }), note({ id: 'b' }), note({ id: 'c' })]
  const out = stampSent(list, ['a', 'c'], 1700)

  assert.equal(out.length, 3, 'sent notes are kept, never drained')
  assert.equal(out.find((c) => c.id === 'a')?.sentAt, 1700)
  assert.equal(out.find((c) => c.id === 'c')?.sentAt, 1700)
  assert.equal(out.find((c) => c.id === 'b')?.sentAt, undefined, 'untouched note stays pending')
})

test('stampSent with no ids returns the list untouched', () => {
  const list = [note({ id: 'a' })]
  assert.equal(stampSent(list, [], 1700), list)
})

test('stampSent does not re-stamp a note that was already sent', () => {
  const out = stampSent([note({ id: 'a', sentAt: 100 })], ['b'], 1700)
  assert.equal(out[0].sentAt, 100)
})

test('anchor holds when the block still reads the same at the offsets', () => {
  //                             0123456789...
  const block = 'mostra placeholder itálico'
  const c = note({ start: 7, end: 18, quote: 'placeholder' })
  assert.equal(block.slice(7, 18), 'placeholder', 'fixture sanity')
  assert.equal(anchorHolds(c, block), true)
})

test('anchor drifts when the text shifted under the offsets', () => {
  const c = note({ start: 5, end: 16, quote: 'placeholder' })
  assert.equal(anchorHolds(c, 'MUITO mais texto antes do placeholder'), false)
})

test('anchor drifts when the block got truncated past the offsets', () => {
  const c = note({ start: 5, end: 16, quote: 'placeholder' })
  assert.equal(anchorHolds(c, 'curto'), false)
})

// --- isValidComment (the IPC trust boundary) -------------------------------

test('a well-formed note passes', () => {
  assert.equal(isValidComment(note()), true)
  assert.equal(isValidComment(note({ sentAt: 1_700_000_000_000 })), true)
  assert.equal(isValidComment(note({ quote: '', start: 0, end: 0 })), true)
})

// The one that mattered: an id-less note slips past upsertComment's filter,
// appends, and can then never be dropped — every transform keys on the id.
test('a note without an id is rejected', () => {
  assert.equal(isValidComment({ ...note(), id: '' }), false)
  assert.equal(isValidComment({ ...note(), id: undefined }), false)
  assert.equal(isValidComment({ ...note(), id: 42 }), false)
})

test('a note without a session key is rejected', () => {
  assert.equal(isValidComment({ ...note(), sessionKey: '' }), false)
})

test('an empty body is rejected — there is nothing to say', () => {
  assert.equal(isValidComment({ ...note(), body: '' }), false)
})

test('nonsense offsets are rejected', () => {
  assert.equal(isValidComment({ ...note(), start: -1 }), false)
  assert.equal(isValidComment({ ...note(), start: 20, end: 5 }), false, 'inverted span')
  assert.equal(isValidComment({ ...note(), itemIndex: 1.5 }), false)
  assert.equal(isValidComment({ ...note(), end: NaN }), false)
  assert.equal(isValidComment({ ...note(), itemIndex: '3' }), false)
})

test('oversized text is rejected so one session cannot bloat the store', () => {
  assert.equal(isValidComment({ ...note(), body: 'x'.repeat(20_001) }), false)
  assert.equal(isValidComment({ ...note(), quote: 'x'.repeat(20_001) }), false)
  assert.equal(isValidComment({ ...note(), body: 'x'.repeat(20_000) }), true)
})

test('non-objects are rejected', () => {
  for (const bad of [null, undefined, 'note', 7, []]) {
    assert.equal(isValidComment(bad), false, String(bad))
  }
})
