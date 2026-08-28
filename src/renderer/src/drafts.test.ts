import { test } from 'node:test'
import assert from 'node:assert/strict'
import { put } from './drafts.ts'

test('a draft is kept under its own key', () => {
  assert.deepEqual(put({}, 's1', 'meio escrito'), { s1: 'meio escrito' })
})

test('sending clears it instead of leaving a blank behind', () => {
  assert.deepEqual(put({ s1: 'texto', s2: 'outro' }, 's1', ''), { s2: 'outro' })
})

test('editing keeps other sessions untouched', () => {
  assert.deepEqual(put({ s1: 'a', s2: 'b' }, 's1', 'a2'), { s2: 'b', s1: 'a2' })
})

test('old drafts fall off the end', () => {
  let d: Record<string, string> = {}
  for (let i = 0; i < 55; i++) d = put(d, `s${i}`, 'x')
  assert.equal(Object.keys(d).length, 50)
  assert.equal('s0' in d, false)
  assert.equal('s54' in d, true)
})
