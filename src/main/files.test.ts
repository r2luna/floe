import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyFileOps, listDir } from './files.ts'

function withWorktree(files: Record<string, string>, body: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'floe-files-'))
  try {
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(root, rel)
      mkdirSync(join(abs, '..'), { recursive: true })
      writeFileSync(abs, content)
    }
    body(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('create file, nested create, and create dir', () => {
  withWorktree({}, (root) => {
    const errs = applyFileOps(root, [
      { kind: 'create', path: 'a.txt' },
      { kind: 'create', path: 'sub/deep/b.txt' },
      { kind: 'create', path: 'dir/' }
    ])
    assert.deepEqual(errs, [])
    assert.ok(existsSync(join(root, 'a.txt')))
    assert.ok(existsSync(join(root, 'sub/deep/b.txt')))
    assert.ok(existsSync(join(root, 'dir')))
  })
})

test('rename moves into a new directory, deletes the source', () => {
  withWorktree({ 'x.txt': 'hi' }, (root) => {
    const errs = applyFileOps(root, [{ kind: 'rename', from: 'x.txt', to: 'nested/y.txt' }])
    assert.deepEqual(errs, [])
    assert.ok(!existsSync(join(root, 'x.txt')))
    assert.equal(readFileSync(join(root, 'nested/y.txt'), 'utf8'), 'hi')
  })
})

test('copy duplicates without removing the source', () => {
  withWorktree({ 'x.txt': 'hi' }, (root) => {
    const errs = applyFileOps(root, [{ kind: 'copy', from: 'x.txt', to: 'copy.txt' }])
    assert.deepEqual(errs, [])
    assert.ok(existsSync(join(root, 'x.txt')))
    assert.equal(readFileSync(join(root, 'copy.txt'), 'utf8'), 'hi')
  })
})

test('delete removes a directory recursively', () => {
  withWorktree({ 'd/a.txt': '1', 'd/e/b.txt': '2' }, (root) => {
    const errs = applyFileOps(root, [{ kind: 'delete', path: 'd' }])
    assert.deepEqual(errs, [])
    assert.ok(!existsSync(join(root, 'd')))
  })
})

test('refuses to clobber and to escape the worktree', () => {
  withWorktree({ 'x.txt': 'hi', 'y.txt': 'yo' }, (root) => {
    const errs = applyFileOps(root, [
      { kind: 'rename', from: 'x.txt', to: 'y.txt' }, // dest exists
      { kind: 'create', path: '../escape.txt' } // outside worktree
    ])
    assert.equal(errs.length, 2)
    assert.equal(readFileSync(join(root, 'x.txt'), 'utf8'), 'hi')
    assert.ok(!existsSync(join(root, '..', 'escape.txt')))
  })
})

test('listDir reads one level, hides nothing but .git, and stays in the worktree', () => {
  withWorktree(
    {
      '.env': 'SECRET=1',
      '.gitignore': 'node_modules\n.env\n',
      '.git/config': '',
      'node_modules/pkg/index.js': '',
      'src/main.ts': ''
    },
    (root) => {
      const rootNames = listDir(root).map((n) => n.name)
      // Gitignored entries are listed: a file tree is where you go to find them.
      assert.deepEqual(rootNames, ['node_modules', 'src', '.env', '.gitignore'])
      // One level only — the cost of a directory is paid when it is opened.
      assert.deepEqual(
        listDir(root).map((n) => n.children),
        [undefined, undefined, undefined, undefined]
      )
      assert.deepEqual(listDir(root, 'node_modules').map((n) => n.relPath), ['node_modules/pkg'])
      assert.throws(() => listDir(root, '../..'))
    }
  )
})
