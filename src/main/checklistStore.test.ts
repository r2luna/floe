import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installHook } from './config/hook.test-helper.ts'
import type { ChecklistItem } from '../shared/checklist.ts'

installHook()

const data = mkdtempSync(join(tmpdir(), 'floe-checklists-'))
process.env.XDG_CONFIG_HOME = data
process.env.FLOE_TEST_USERDATA = data

const { getChecklist, saveChecklist } = await import('./checklistStore.ts')

const list: ChecklistItem[] = [
  { text: 'Map', status: 'completed' },
  { text: 'Build', active: 'Building', status: 'in_progress' }
]

test('a list reads back as it was saved, and each session has its own', () => {
  saveChecklist('a', list)
  saveChecklist('b', [{ text: 'Other', status: 'pending' }])
  assert.deepEqual(getChecklist('a'), list)
  assert.equal(getChecklist('b')[0]?.text, 'Other')
})

test('no list reads as empty', () => {
  assert.deepEqual(getChecklist('never-saved'), [])
})

test('an empty list removes the file, and removing nothing is fine', () => {
  saveChecklist('c', list)
  saveChecklist('c', [])
  assert.deepEqual(getChecklist('c'), [])
  assert.equal(existsSync(join(data, 'checklists', 'c.json')), false)
  saveChecklist('c', [])
})

test('a key cannot name a path outside the directory', () => {
  saveChecklist('../../escape', list)
  assert.deepEqual(getChecklist('../../escape'), list)
  assert.equal(existsSync(join(data, '..', '..', 'escape.json')), false)
  assert.ok(readdirSync(join(data, 'checklists')).includes('..%2F..%2Fescape.json'))
})

test('a corrupt or foreign file reads as no list', () => {
  mkdirSync(join(data, 'checklists'), { recursive: true })
  writeFileSync(join(data, 'checklists', 'bad.json'), '{ not json')
  writeFileSync(join(data, 'checklists', 'odd.json'), '{"items":[]}')
  assert.deepEqual(getChecklist('bad'), [])
  assert.deepEqual(getChecklist('odd'), [])
})
