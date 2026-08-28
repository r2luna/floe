import { test } from 'node:test'
import assert from 'node:assert/strict'
import { push } from './history.ts'

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
