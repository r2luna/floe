import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { definesName, definitionPatterns, findDefinitions, parseDefinitions, rankDefinitions } from './definitions.ts'
import { makeGitRepo } from './gitFixture.test-helper.ts'

// findDefinitions spawns `git grep` with the ambient environment — see files.test.ts.
for (const key of Object.keys(process.env)) if (key.startsWith('GIT_')) delete process.env[key]
process.env.GIT_CEILING_DIRECTORIES = [tmpdir(), realpathSync(tmpdir())].join(':')

const defines = (line: string, name: string): boolean => definesName(line, definitionPatterns(name))

test('definesName recognises types, functions, bindings and methods', () => {
  for (const line of [
    'export class Foo extends Bar {',
    'interface Foo {',
    'type Foo = string',
    'pub struct Foo {',
    'export async function Foo(a: string) {',
    'def Foo(self):',
    'func (s *Server) Foo() error {',
    'fn Foo() -> u8 {',
    'export const Foo = memo(() => null)',
    '  Foo = async (x) => {',
    '  Foo: (x: number) => x,',
    '  async Foo(a: string): Promise<void> {',
    '  public void Foo(int a) {',
    '    public function Foo(): void'
  ])
    assert.equal(defines(line, 'Foo'), true, line)
})

test('definesName rejects uses of the name', () => {
  for (const line of [
    'new Foo()',
    '  Foo(bar)',
    'const x = Foo(1)',
    'import { Foo } from "./foo"',
    'return Foo',
    'class FooBar {',
    'const $Foo = 1',
    'if (Foo(x)) {'
  ])
    assert.equal(defines(line, 'Foo'), false, line)
})

test('definesName handles a $ in the name', () => {
  assert.equal(defines('const $el = 1', '$el'), true)
  assert.equal(defines('const $elx = 1', '$el'), false)
})

test('definesName skips a minified line', () => {
  assert.equal(defines(`function Foo() {${' '.repeat(500)}}`, 'Foo'), false)
})

test('parseDefinitions keeps definitions and survives a colon in the path', () => {
  const out = 'a:b.ts\x001\x00class Foo {}\na:b.ts\x002\x00new Foo()\n'
  assert.deepEqual(parseDefinitions(out, 'Foo'), [{ path: 'a:b.ts', line: 1, text: 'class Foo {}' }])
})

test('rankDefinitions puts the reading file first and keeps order otherwise', () => {
  const defs = [
    { path: 'a.ts', line: 3, text: '' },
    { path: 'b.ts', line: 1, text: '' },
    { path: 'b.ts', line: 9, text: '' }
  ]
  assert.deepEqual(
    rankDefinitions(defs, 'b.ts').map((d) => `${d.path}:${d.line}`),
    ['b.ts:1', 'b.ts:9', 'a.ts:3']
  )
})

test('findDefinitions greps the worktree, untracked files included', async () => {
  const repo = makeGitRepo()
  try {
    repo.write('src/foo.ts', 'export class Foo {}\n')
    repo.write('src/use.ts', 'import { Foo } from "./foo"\nnew Foo()\n')
    repo.commit('init')
    repo.write('src/extra.ts', 'function Foo() {}\n')
    repo.git('reset', 'src/extra.ts')
    const defs = await findDefinitions(repo.dir, 'Foo', 'src/extra.ts')
    assert.deepEqual(
      defs.map((d) => `${d.path}:${d.line}`),
      ['src/extra.ts:1', 'src/foo.ts:1']
    )
  } finally {
    repo.cleanup()
  }
})

test('findDefinitions answers nothing for a non-identifier or a non-repo', async () => {
  const repo = makeGitRepo()
  const plain = mkdtempSync(join(tmpdir(), 'floe-defs-'))
  try {
    assert.deepEqual(await findDefinitions(repo.dir, 'a b'), [])
    assert.deepEqual(await findDefinitions(repo.dir, 'Missing'), [])
    assert.deepEqual(await findDefinitions(plain, 'Foo'), [])
  } finally {
    repo.cleanup()
    rmSync(plain, { recursive: true, force: true })
  }
})
