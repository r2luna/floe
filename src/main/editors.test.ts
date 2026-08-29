import test from 'node:test'
import assert from 'node:assert/strict'
import { installHook } from './config/hook.test-helper.ts'

installHook()

const { KNOWN_EDITORS, editKeys, editorSpec, spawnArgs } = await import('./editors.ts')

test('a known id resolves to its spec, by id or by binary name', () => {
  assert.equal(editorSpec('vscode').bin, 'code')
  assert.equal(editorSpec('code').id, 'vscode')
  assert.equal(editorSpec(' nvim ').id, 'nvim')
})

test('an unknown command is a terminal editor by that name', () => {
  const spec = editorSpec('micro')
  assert.deepEqual({ id: spec.id, bin: spec.bin, terminal: spec.terminal }, {
    id: 'micro',
    bin: 'micro',
    terminal: true
  })
})

test('only the GUI editors are launched outside the panel', () => {
  const terminal = KNOWN_EDITORS.filter((e) => e.terminal).map((e) => e.id)
  const gui = KNOWN_EDITORS.filter((e) => !e.terminal).map((e) => e.id)
  assert.deepEqual(terminal, ['nvim', 'vim', 'helix'])
  assert.deepEqual(gui, ['vscode', 'zed', 'sublime'])
})

test('GUI editors are aimed at the file and its line', () => {
  const code = editorSpec('vscode')
  assert.deepEqual(code.args?.('src/a.ts', 12), ['--goto', 'src/a.ts:12'])
  assert.deepEqual(code.args?.('src/a.ts', null), ['--goto', 'src/a.ts'])
  assert.deepEqual(editorSpec('zed').args?.('src/a.ts', 12), ['src/a.ts:12'])
  assert.deepEqual(editorSpec('sublime').args?.('src/a.ts', null), ['src/a.ts'])
})

test('a fresh vim-like is spawned on the line, with -- ending the options', () => {
  assert.deepEqual(spawnArgs(editorSpec('nvim'), 'src/a.ts', 12), ['+12', '--', 'src/a.ts'])
  assert.deepEqual(spawnArgs(editorSpec('nvim'), 'src/a.ts', null), ['--', 'src/a.ts'])
  // A file named like a flag cannot become one.
  assert.deepEqual(spawnArgs(editorSpec('nvim'), '-c', null), ['--', '-c'])
  // helix has no +line; the line rides in the path.
  assert.deepEqual(spawnArgs(editorSpec('helix'), 'src/a.ts', 12), ['--', 'src/a.ts:12'])
  // No file: the editor opens on nothing rather than on a stray argument.
  assert.deepEqual(spawnArgs(editorSpec('nvim'), null, 12), [])
})

test('a running vim-like is told to edit the next file, escaping the path', () => {
  assert.equal(
    editKeys(editorSpec('nvim'), 'src/a.ts', 12),
    "\x1b:execute 'edit ' . fnameescape('src/a.ts')\r\x1b:12\r"
  )
  // A quote in the filename is doubled, so it cannot end the vimscript string.
  assert.equal(
    editKeys(editorSpec('vim'), "src/it's.ts", null),
    "\x1b:execute 'edit ' . fnameescape('src/it''s.ts')\r"
  )
})

test('an editor we have no command for is never typed into', () => {
  assert.equal(editKeys(editorSpec('micro'), 'src/a.ts', 12), null)
})
