import { test } from 'node:test'
import assert from 'node:assert/strict'
import { keep, put, type Pending } from './drafts.ts'
import type { ImageAttachment } from '../../shared/types.ts'

const img = (id: string): ImageAttachment => ({ id, mediaType: 'image/png', data: 'x' })

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

test('a pasted image is kept under the draft it was pasted into', () => {
  const store = new Map<string, Pending>()
  keep(store, 's1', { images: [img('a1')], files: [], pastes: [] })
  assert.deepEqual(store.get('s1')?.images.map((i) => i.id), ['a1'])
})

test('sending clears the chips instead of leaving an empty entry', () => {
  const store = new Map<string, Pending>()
  keep(store, 's1', { images: [img('a1')], files: [], pastes: [] })
  keep(store, 's1', { images: [], files: [], pastes: [] })
  assert.equal(store.has('s1'), false)
})

test('old attachments fall off the end', () => {
  const store = new Map<string, Pending>()
  for (let i = 0; i < 15; i++) keep(store, `s${i}`, { images: [img(`a${i}`)], files: [], pastes: [] })
  assert.equal(store.size, 10)
  assert.equal(store.has('s0'), false)
  assert.equal(store.has('s14'), true)
})
