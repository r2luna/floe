import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
  truncateSync
} from 'node:fs'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyFileOps, listDir, readFileContent, resolveWikiLink, searchableFiles } from './files.ts'
import { makeGitRepo } from './gitFixture.test-helper.ts'

// `searchableFiles` spawns `git ls-files` with the ambient environment, and this
// suite can run from the pre-commit hook, which exports GIT_DIR and
// GIT_INDEX_FILE — it would then answer for Floe's own repository instead of the
// fixture. Drop every inherited GIT_* and stop the upward walk at the tmpdir the
// fixtures live in. (Fixture-side git goes through makeGitRepo, which pins its
// own spawns the same way.)
for (const key of Object.keys(process.env)) if (key.startsWith('GIT_')) delete process.env[key]
process.env.GIT_CEILING_DIRECTORIES = [tmpdir(), realpathSync(tmpdir())].join(':')

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

test('searchableFiles walks a plain directory, skipping the heavy ones', async () => {
  const root = mkdtempSync(join(tmpdir(), 'floe-files-walk-'))
  try {
    for (const rel of ['src/App.tsx', 'README.md', 'node_modules/pkg/index.js', '.git/config']) {
      const abs = join(root, rel)
      mkdirSync(join(abs, '..'), { recursive: true })
      writeFileSync(abs, '')
    }
    // Not a repo, so `git ls-files` cannot answer and the walk does.
    assert.deepEqual(await searchableFiles(root), ['README.md', 'src/App.tsx'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('searchableFiles in a repo leaves out what .gitignore names', async () => {
  const repo = makeGitRepo('floe-files-repo-')
  try {
    writeFileSync(join(repo.dir, '.gitignore'), 'dist\n')
    mkdirSync(join(repo.dir, 'dist'), { recursive: true })
    writeFileSync(join(repo.dir, 'dist', 'bundle.js'), '')
    writeFileSync(join(repo.dir, 'kept.ts'), '')
    const files = await searchableFiles(repo.dir)
    assert.ok(files.includes('kept.ts'))
    assert.ok(!files.some((f) => f.startsWith('dist/')), 'ignored files stay out of the palette')
  } finally {
    repo.cleanup()
  }
})

// --- readFileContent --------------------------------------------------------

const NUL = String.fromCharCode(0)

test('readFileContent returns UTF-8 text', () => {
  withWorktree({ 'a.md': '# olá' }, (root) => {
    assert.deepEqual(readFileContent(root, 'a.md'), { kind: 'text', text: '# olá' })
  })
})

test('readFileContent inlines a known image as a data URL', () => {
  withWorktree({}, (root) => {
    writeFileSync(join(root, 'logo.PNG'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    // The extension is matched case-insensitively, and the mime comes from it.
    assert.deepEqual(readFileContent(root, 'logo.PNG'), {
      kind: 'image',
      dataUrl: 'data:image/png;base64,iVBORw=='
    })
  })
})

test('readFileContent hands a PDF to the Chromium viewer', () => {
  withWorktree({ 'doc.pdf': '%PDF-1.4' }, (root) => {
    assert.deepEqual(readFileContent(root, 'doc.pdf'), {
      kind: 'pdf',
      dataUrl: `data:application/pdf;base64,${Buffer.from('%PDF-1.4').toString('base64')}`
    })
  })
})

test('readFileContent calls a NUL byte in the first chunk binary', () => {
  withWorktree({ 'a.out': `ELF${NUL}${NUL}` }, (root) => {
    assert.deepEqual(readFileContent(root, 'a.out'), { kind: 'binary' })
    // Past the sniffed window it is text again — the check is a heuristic on
    // the head, not a scan of the whole file.
    writeFileSync(join(root, 'late.txt'), Buffer.concat([Buffer.alloc(9000, 0x61), Buffer.from([0])]))
    assert.equal(readFileContent(root, 'late.txt').kind, 'text')
  })
})

test('readFileContent reports a missing file as binary rather than throwing', () => {
  withWorktree({}, (root) => {
    assert.deepEqual(readFileContent(root, 'nope.txt'), { kind: 'binary' })
  })
})

test('readFileContent reports an unreadable image as binary', () => {
  withWorktree({}, (root) => {
    // A directory named like an image: stat succeeds, the read does not.
    mkdirSync(join(root, 'trap.png'))
    assert.deepEqual(readFileContent(root, 'trap.png'), { kind: 'binary' })
  })
})

test('readFileContent refuses to leave the worktree or read a control-char name', () => {
  withWorktree({ 'x.txt': 'hi' }, (root) => {
    assert.throws(() => readFileContent(root, '../../etc/passwd'), /outside the worktree/)
    assert.throws(() => readFileContent(root, `a${NUL}b.txt`), /control characters/)
  })
})

test('readFileContent refuses to slurp oversized files', () => {
  withWorktree({}, (root) => {
    // Sparse, so the ceilings are exercised without writing 50MB.
    const cases: [string, number][] = [
      ['big.txt', 6 * 1024 * 1024],
      ['big.png', 6 * 1024 * 1024],
      ['big.pdf', 51 * 1024 * 1024],
      ['big.pptx', 51 * 1024 * 1024]
    ]
    for (const [name, size] of cases) {
      writeFileSync(join(root, name), '')
      truncateSync(join(root, name), size)
      assert.deepEqual(readFileContent(root, name), { kind: 'binary' }, name)
    }
  })
})

test('readFileContent calls an unreadable .pptx binary instead of throwing', () => {
  withWorktree({ 'deck.pptx': 'not a zip' }, (root) => {
    assert.deepEqual(readFileContent(root, 'deck.pptx'), { kind: 'binary' })
  })
})

// --- resolveWikiLink --------------------------------------------------------

test('resolveWikiLink appends .md before trying the name verbatim', () => {
  withWorktree({ 'Notes/Target.md': '', 'Notes/Target': '' }, (root) => {
    assert.equal(resolveWikiLink(root, 'Notes/from.md', 'Notes/Target'), 'Notes/Target.md')
  })
})

test('resolveWikiLink falls back to the verbatim target', () => {
  withWorktree({ 'img/diagram.png': '' }, (root) => {
    assert.equal(resolveWikiLink(root, 'from.md', 'img/diagram.png'), 'img/diagram.png')
  })
})

test('resolveWikiLink honours an explicit markdown extension', () => {
  withWorktree({ 'a.markdown': '' }, (root) => {
    assert.equal(resolveWikiLink(root, 'from.md', 'a.markdown'), 'a.markdown')
  })
})

test('resolveWikiLink strips anchors, and a bare anchor stays in the note', () => {
  withWorktree({ 'Target.md': '' }, (root) => {
    assert.equal(resolveWikiLink(root, 'from.md', 'Target#Heading'), 'Target.md')
    assert.equal(resolveWikiLink(root, 'from.md', 'Target^block-id'), 'Target.md')
    assert.equal(resolveWikiLink(root, 'sub/from.md', '  #Heading'), 'sub/from.md')
  })
})

test('resolveWikiLink returns null instead of throwing on anything unresolvable', () => {
  withWorktree({ 'a.md': '' }, (root) => {
    assert.equal(resolveWikiLink(root, 'from.md', 'Missing'), null)
    // Escapes and control chars throw inside safeResolve; the link just fails.
    assert.equal(resolveWikiLink(root, 'from.md', '../../../etc/passwd'), null)
    assert.equal(resolveWikiLink(root, 'from.md', `a${NUL}b`), null)
  })
})

test('resolveWikiLink will not resolve to a directory', () => {
  withWorktree({}, (root) => {
    mkdirSync(join(root, 'folder'))
    assert.equal(resolveWikiLink(root, 'from.md', 'folder'), null)
  })
})
