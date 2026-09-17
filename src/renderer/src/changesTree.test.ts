import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ChangedFile } from '../../shared/types'
import { buildChangeTree, flattenChanges, OPEN_ALL_UP_TO } from './changesTree.ts'

const file = (relPath: string, additions = 0, deletions = 0): ChangedFile => ({
  relPath,
  status: 'modified',
  additions,
  deletions,
  fingerprint: '',
  committed: false
})

const names = (rows: ReturnType<typeof flattenChanges>) =>
  rows.map((r) => `${'  '.repeat(r.depth)}${r.node.name}`)

test('folders come first, single-child chains fold into one row, totals roll up', () => {
  const tree = buildChangeTree([
    file('z.txt', 1),
    file('docs/design/projects/hub/a.md', 3, 1),
    file('docs/design/projects/os/b.md', 2),
    file('.floe/config.toml')
  ])
  assert.deepEqual(names(flattenChanges(tree, 4, new Set())), [
    '.floe',
    '  config.toml',
    'docs/design/projects',
    '  hub',
    '    a.md',
    '  os',
    '    b.md',
    'z.txt'
  ])
  const docs = tree[1]
  assert.equal(docs.type === 'dir' && docs.path, 'docs/design/projects')
  assert.deepEqual(docs.type === 'dir' && [docs.files, docs.additions, docs.deletions], [2, 5, 1])
})

test('a folder holding one file is not folded — only folder-into-folder is', () => {
  const tree = buildChangeTree([file('src/a.ts'), file('b.ts')])
  assert.deepEqual(names(flattenChanges(tree, 2, new Set())), ['src', '  a.ts', 'b.ts'])
})

test('a large list opens only the top level; flipping a path overrides its default', () => {
  const many = Array.from({ length: OPEN_ALL_UP_TO + 1 }, (_, i) => file(`app/m${i % 2}/f${i}.ts`))
  const tree = buildChangeTree(many)
  assert.deepEqual(names(flattenChanges(tree, many.length, new Set())), ['app', '  m0', '  m1'])

  const rows = flattenChanges(tree, many.length, new Set(['app/m1', 'app']))
  assert.deepEqual(names(rows), ['app'], 'closing the top folder hides the flipped one inside it')

  const opened = flattenChanges(tree, many.length, new Set(['app/m1']))
  assert.equal(opened.filter((r) => r.parent === 'app/m1').length, 20)
  assert.equal(opened.find((r) => r.node.name === 'm1')?.parent, 'app')
})
