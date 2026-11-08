import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  addCreatedTask,
  applyTaskUpdate,
  checklistOpen,
  checklistRow,
  checklistSummary,
  fromTodoWrite,
  type ChecklistItem
} from './checklist.ts'

const list: ChecklistItem[] = [
  { id: '1', text: 'Map', status: 'completed' },
  { id: '2', text: 'Build', active: 'Building', status: 'in_progress' },
  { id: '3', text: 'Ship', status: 'pending' }
]

test('the summary counts completed steps and names the live one', () => {
  assert.equal(checklistSummary(list), '1 of 3 · Building')
  assert.equal(checklistSummary([{ text: 'Ship', status: 'in_progress' }]), '0 of 1 · Ship')
  assert.equal(checklistSummary([{ text: 'Ship', status: 'completed' }]), '1 of 1')
})

test('a whole-list tool reads as its progress, and no other tool does', () => {
  assert.equal(checklistRow('mcp__floe__set_checklist', { items: list }), '1 of 3 · Building')
  assert.equal(checklistRow('set_checklist', { items: list }), '1 of 3 · Building')
  assert.equal(checklistRow('TodoWrite', { todos: [{ content: 'Fix', status: 'completed' }] }), '1 of 1')
  assert.equal(checklistRow('set_checklist', {}), undefined)
  assert.equal(checklistRow('Read', { items: list }), undefined)
  assert.equal(checklistRow(undefined, null), undefined)
})

test('a list is open while anything is pending or running', () => {
  assert.equal(checklistOpen(list), true)
  assert.equal(checklistOpen([{ text: 'a', status: 'completed' }, { text: 'b', status: 'cancelled' }]), false)
  assert.equal(checklistOpen([]), false)
})

test('TodoWrite replaces the whole list and skips what it cannot read', () => {
  assert.deepEqual(
    fromTodoWrite({
      todos: [
        { content: 'Fix', activeForm: 'Fixing', status: 'in_progress' },
        { content: 'Odd status', status: 'nope' },
        { status: 'pending' }
      ]
    }),
    [
      { text: 'Fix', active: 'Fixing', status: 'in_progress' },
      { text: 'Odd status', active: undefined, status: 'pending' }
    ]
  )
  assert.deepEqual(fromTodoWrite(null), [])
  assert.deepEqual(fromTodoWrite({ todos: 'no' }), [])
})

test('TaskCreate appends a pending item under the id from its result', () => {
  assert.deepEqual(addCreatedTask([], '7', { subject: 'Fix', activeForm: 'Fixing' }), [
    { id: '7', text: 'Fix', active: 'Fixing', status: 'pending' }
  ])
  assert.deepEqual(addCreatedTask([], '7', { subject: 'Fix', active_form: 'Fixing' }), [
    { id: '7', text: 'Fix', active: 'Fixing', status: 'pending' }
  ])
  assert.deepEqual(addCreatedTask(list, '9', {}), list)
  assert.deepEqual(addCreatedTask(list, '9', null), list)
})

test('TaskUpdate patches by id, whichever spelling the model used', () => {
  for (const key of ['taskId', 'id', 'task_id']) {
    const next = applyTaskUpdate(list, { [key]: '3', status: 'in_progress' })
    assert.equal(next[2]?.status, 'in_progress')
    assert.equal(next[1]?.status, 'in_progress')
  }
})

test('TaskUpdate can rename and relabel, and leaves a bad status alone', () => {
  const next = applyTaskUpdate(list, { taskId: '2', subject: 'Rebuild', active_form: 'Rebuilding', status: 'odd' })
  assert.deepEqual(next[1], { id: '2', text: 'Rebuild', active: 'Rebuilding', status: 'in_progress' })
})

test('TaskUpdate drops a deleted item and ignores an unknown or missing id', () => {
  assert.deepEqual(applyTaskUpdate(list, { taskId: '1', status: 'deleted' }).map((i) => i.id), ['2', '3'])
  assert.deepEqual(applyTaskUpdate(list, { taskId: '42', status: 'completed' }), list)
  assert.deepEqual(applyTaskUpdate(list, { status: 'completed' }), list)
  assert.deepEqual(applyTaskUpdate(list, null), list)
})
