import assert from 'node:assert/strict'
import test from 'node:test'
import { describeWhen, keyHint } from './keyHints.ts'
import { DEFAULT_KEYMAP } from '../../shared/defaultKeymap.ts'

test('a when clause reads as the panel it names', () => {
  assert.equal(describeWhen('panel == "files"'), 'files')
  assert.equal(describeWhen('panel != "chat"'), 'not chat')
  assert.equal(describeWhen('panel in ["diff", "file"]'), 'diff, file')
  assert.equal(describeWhen('panel in ["diff", "file"] and selecting'), 'diff, file, selecting')
  assert.equal(describeWhen('typing'), 'typing')
  assert.equal(describeWhen('stack-below'), 'stacked')
  assert.equal(describeWhen(undefined), undefined)
})

test('the chip is the first binding that fires, the pane has them all', () => {
  const hint = keyHint(DEFAULT_KEYMAP, 'panel.goto', 'active')
  assert.equal(hint?.chip, '⌘A', 'the context-free chord comes first in the keymap')
  assert.match(hint?.all ?? '', /⌘A \/ L · projects \/ H · worktrees/)
})

test('an argument narrows to its own binds, and a bare command to the bare ones', () => {
  assert.equal(keyHint(DEFAULT_KEYMAP, 'panel.goto', 'files')?.chip, '⌘K F')
  assert.equal(keyHint(DEFAULT_KEYMAP, 'panel.goto'), undefined, 'every panel.goto bind carries an arg')
  assert.equal(keyHint(DEFAULT_KEYMAP, 'worktree.focusAt', '2')?.chip, '⌘3')
})

test('a bare letter that only means something in one panel says so', () => {
  assert.equal(keyHint(DEFAULT_KEYMAP, 'project.add')?.chip, 'N · projects')
  assert.equal(keyHint(DEFAULT_KEYMAP, 'find.prev'), undefined, 'unbound on purpose')
})
