import assert from 'node:assert/strict'
import test from 'node:test'
import { WIDE_AT, isNarrow } from './useNarrow.ts'

// The devices the breakpoint exists for. A fold has to land on BOTH sides of
// it — that is the whole reason the number is 1000 and not 700.
test('phones, folded folds and portrait tablets get one panel', () => {
  assert.equal(isNarrow(344), true, 'fold, closed')
  assert.equal(isNarrow(390), true, 'iPhone 14/15')
  assert.equal(isNarrow(430), true, 'iPhone Pro Max')
  assert.equal(isNarrow(904), true, 'fold open, portrait')
  assert.equal(isNarrow(820), true, 'tablet, portrait')
})

test('a fold open in landscape gets the desktop lane', () => {
  assert.equal(isNarrow(1104), false)
  assert.equal(isNarrow(1440), false)
})

test('the boundary belongs to the wide side', () => {
  assert.equal(isNarrow(WIDE_AT - 1), true)
  assert.equal(isNarrow(WIDE_AT), false)
})
