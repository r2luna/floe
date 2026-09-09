import { test } from 'node:test'
import assert from 'node:assert/strict'
import { push, put } from './history.ts'

test('push skips blanks and repeats, keeps order', () => {
  let list: string[] = []
  list = push(list, 'one')
  list = push(list, '   ')
  list = push(list, 'one')
  list = push(list, 'two')
  assert.deepEqual(list, ['one', 'two'])
})

test('push caps at 100, newest kept', () => {
  let list: string[] = []
  for (let i = 0; i < 105; i++) list = push(list, `m${i}`)
  assert.equal(list.length, 100)
  assert.equal(list[0], 'm5')
  assert.equal(list[99], 'm104')
})

test('put keeps one list per worktree', () => {
  let all = put({}, '/wt/a', 'from a')
  all = put(all, '/wt/b', 'from b')
  all = put(all, '/wt/a', 'more a')
  assert.deepEqual(all['/wt/a'], ['from a', 'more a'])
  assert.deepEqual(all['/wt/b'], ['from b'])
})

test('put ignores a blank message', () => {
  const all = { '/wt/a': ['one'] }
  assert.equal(put(all, '/wt/a', '  '), all)
  assert.deepEqual(put(all, '/wt/b', '  '), all)
})

test('put caps at 40 worktrees, least recently used dropped', () => {
  let all: Record<string, string[]> = {}
  for (let i = 0; i < 41; i++) all = put(all, `/wt/${i}`, 'hi')
  // Touching /wt/1 again makes it the newest, so the next write evicts /wt/2.
  all = put(all, '/wt/1', 'again')
  all = put(all, '/wt/new', 'hi')
  assert.equal(Object.keys(all).length, 40)
  assert.equal(all['/wt/0'], undefined)
  assert.equal(all['/wt/2'], undefined)
  assert.deepEqual(all['/wt/1'], ['hi', 'again'])
})
