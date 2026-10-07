import assert from 'node:assert/strict'
import test from 'node:test'
import { describeWhen, keyHint, panelKeys, scopedTo, shortTitle } from './keyHints.ts'
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

test('a panel footer takes the bare panel scopes and nothing conditional', () => {
  assert.equal(scopedTo('panel == "files"', 'files'), true)
  assert.equal(scopedTo('panel in ["tasks", "task"]', 'task'), true)
  assert.equal(scopedTo('panel == "files" or panel == "diff"', 'diff'), true)
  assert.equal(scopedTo('panel != "files"', 'files'), false)
  assert.equal(scopedTo('panel == "worktrees" and marked', 'worktrees'), false)
  assert.equal(scopedTo(undefined, 'files'), false)
})

test('a title shrinks to footer size', () => {
  assert.equal(shortTitle('Task status up (idea → shaping → ready)'), 'task status up')
  assert.equal(shortTitle('Reset keybindings to defaults…'), 'reset keybindings to defaults')
  assert.equal(shortTitle('MCP: add server'), 'MCP: add server')
})

test('the footer lists one panel\'s keys, merged per command, hidden ones dropped', () => {
  const binds = [
    { key: 'n', command: 'tasks.new', when: 'panel in ["tasks", "task"]' },
    { key: 'j', command: 'list.down', when: 'panel == "tasks"' },
    { key: 'k', command: 'list.down', when: 'panel == "tasks"' },
    { key: 'shift+l', command: 'move', when: 'panel == "tasks"' },
    { key: 'super+enter', command: 'send', when: 'panel == "tasks"' },
    { key: 'h', command: 'secret', when: 'panel == "tasks"' },
    { key: 'super+k', command: 'palette.chord' },
    { key: 'd', command: 'draw.delete', when: 'panel == "draw"' }
  ]
  const titles: Record<string, string> = {
    'tasks.new': 'New task',
    'list.down': 'Down',
    move: 'Move',
    send: 'Send',
    'draw.delete': 'Delete'
  }
  const keys = panelKeys(binds, 'tasks', (c) => titles[c] ?? null)
  assert.deepEqual(keys, [
    { keys: 'n', label: 'new task' },
    { keys: 'j k', label: 'down' },
    { keys: 'L', label: 'move' },
    { keys: '⌘↵', label: 'send' }
  ])
})

test('every panel the default keymap scopes keys to gets a footer', () => {
  const keys = panelKeys(DEFAULT_KEYMAP, 'tasks', (c) => c)
  assert.ok(keys.some((k) => k.label === 'tasks.new'))
  assert.ok(keys.some((k) => k.label === 'tasks.toggleDone'))
  assert.ok(!keys.some((k) => k.label === 'tasks.detach'), 'x is the open task\'s, not the list\'s')
})
