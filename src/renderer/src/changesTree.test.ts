import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ChangedFile, SubmoduleState } from '../../shared/types'
import { buildChangeTree, countRepos, flattenChanges, OPEN_ALL_UP_TO, repoRef, type ChangeRepo } from './changesTree.ts'

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

const repo = (path: string, parent: string, extra: Partial<SubmoduleState> = {}): SubmoduleState => ({
  path,
  parent,
  branch: 'main',
  head: 'bbbbbbb1111',
  recorded: 'bbbbbbb1111',
  ahead: 0,
  ...extra
})

const inRepo = (relPath: string, repo: string, committed = false): ChangedFile => ({ ...file(relPath, 1), repo, committed })

test('a submodule is a repo row under its holder, its files named from its own root', () => {
  const tree = buildChangeTree(
    [file('o.txt'), inRepo('app/src/i.ts', 'app', true), inRepo('app/src/j.ts', 'app'), inRepo('app/packages/ui/new.txt', 'app/packages/ui')],
    [repo('app/packages/ui', 'app'), repo('app', '')]
  )
  assert.deepEqual(names(flattenChanges(tree, 4, new Set())), [
    'o.txt',
    'app',
    '  src',
    '    i.ts',
    '    j.ts',
    '  packages/ui',
    '    new.txt'
  ])
  const app = tree[1] as ChangeRepo
  assert.equal(app.type, 'repo')
  assert.deepEqual([app.files, app.additions, app.uncommitted], [3, 3, 1], 'totals roll up through the nested repo; dirty counts its own files')
  const rows = flattenChanges(tree, 4, new Set())
  assert.equal(rows.find((r) => r.node.name === 'i.ts')?.node.path, 'app/src/i.ts', 'a leaf keeps the worktree path for o/e/diff')
  assert.equal(rows.find((r) => r.node.name === 'new.txt')?.parent, 'app/packages/ui')
  assert.equal(rows.find((r) => r.node.name === 'src')?.node.path, 'app/src', 'folders inside a repo key on the worktree path')
  assert.equal(countRepos(tree), 2)
})

test('a clean repo at its recorded commit is not a row; a moved pointer is, even with no files', () => {
  const still = buildChangeTree([file('o.txt')], [repo('vendor/x', '')])
  assert.deepEqual(names(flattenChanges(still, 1, new Set())), ['o.txt'])

  const moved = buildChangeTree([file('o.txt')], [repo('vendor/x', '', { head: 'cccccccc222' })])
  assert.deepEqual(names(flattenChanges(moved, 1, new Set())), ['o.txt', 'vendor/x'])

  // A clean, unmoved holder stays for the moved repo inside it.
  const nested = buildChangeTree([], [repo('app', ''), repo('app/lib', 'app', { ahead: 2, head: 'cccccccc222' })])
  assert.deepEqual(names(flattenChanges(nested, 0, new Set())), ['app', '  lib'])
})

test('flat keeps the repos and drops the folders', () => {
  const tree = buildChangeTree(
    [file('docs/a.md'), file('docs/b.md'), inRepo('app/src/i.ts', 'app')],
    [repo('app', '')],
    true
  )
  assert.deepEqual(names(flattenChanges(tree, 3, new Set())), ['docs/a.md', 'docs/b.md', 'app', '  src/i.ts'])
})

test('repoRef reads the branch, the distance from the recorded commit and the dirt', () => {
  const node = (state: SubmoduleState, uncommitted = 0): ChangeRepo => ({
    type: 'repo', path: state.path, name: state.path, state, files: 0, additions: 0, deletions: 0, uncommitted, children: []
  })
  assert.deepEqual(repoRef(node(repo('app', ''), 1)), { text: 'main · dirty', moved: false })
  assert.deepEqual(repoRef(node(repo('app', ''))), { text: 'main · clean', moved: false })
  assert.deepEqual(repoRef(node(repo('app', '', { ahead: 2, head: 'cccccccc222' }))), { text: 'main · +2 commits · clean', moved: true })
  assert.deepEqual(repoRef(node(repo('app', '', { ahead: 1, head: 'cccccccc222' }), 3)), { text: 'main · +1 commit · dirty', moved: true })
  // Rewound or diverged: nothing ahead, but not where the parent left it.
  assert.deepEqual(repoRef(node(repo('app', '', { head: 'cccccccc222' }))), { text: 'bbbbbbb → ccccccc · clean', moved: true })
  // Detached: the commit stands in for the branch.
  assert.deepEqual(repoRef(node(repo('app', '', { branch: undefined }))), { text: 'bbbbbbb · clean', moved: false })
})
