import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// git.ts uses extensionless relative imports (and its graph touches `electron`),
// neither of which raw Node ESM resolves. Register the same in-memory hook the
// mcpServer test uses: rewrite `./x` → `./x.ts` and stub `electron`.
const hookSource = `
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
export async function resolve(specifier, context, next) {
  if (specifier === 'electron') return { url: 'stub:electron', shortCircuit: true, format: 'module' }
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\\.[a-z]+$/i.test(specifier)) {
    try {
      const base = context.parentURL ? new URL(specifier, context.parentURL) : pathToFileURL(specifier)
      const tsPath = fileURLToPath(base) + '.ts'
      if (existsSync(tsPath)) return next(specifier + '.ts', context)
    } catch {}
  }
  return next(specifier, context)
}
export async function load(url, context, next) {
  if (url === 'stub:electron') {
    return { format: 'module', shortCircuit: true, source: "export const app = { getPath: () => '/tmp' }; export default {};" }
  }
  return next(url, context)
}
`
register('data:text/javascript,' + encodeURIComponent(hookSource), import.meta.url)
void existsSync
void fileURLToPath
void pathToFileURL

const { createWorktree, mergeFastForward } = await import('./git.ts')

const g = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()

// base ('main') is checked out in a LINKED worktree, not root. mergeFastForward
// must FF it via `merge --ff-only` inside that worktree, not `branch -f` (which
// git refuses for a branch in use). Regression for the "cannot force update the
// branch used by worktree" bug.
test('fast-forwards base checked out in a linked worktree', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rookery-git-'))
  try {
    g(root, 'init', '-q', '-b', 'trunk')
    g(root, 'config', 'user.email', 't@t')
    g(root, 'config', 'user.name', 't')
    writeFileSync(join(root, 'a'), '1')
    g(root, 'add', '-A')
    g(root, 'commit', '-q', '-m', 'c1')
    g(root, 'branch', 'main')
    g(root, 'checkout', '-q', '-b', 'feat')
    writeFileSync(join(root, 'a'), '2')
    g(root, 'commit', '-q', '-am', 'c2')
    const featHead = g(root, 'rev-parse', 'HEAD')

    // Put 'main' (the base) in a linked worktree so root is NOT on it.
    const linked = join(root, '.worktrees', 'main')
    g(root, 'worktree', 'add', '-q', linked, 'main')

    const res = await mergeFastForward(root, 'main', 'feat')
    assert.equal(res.ok, true, res.message)
    assert.equal(g(root, 'rev-parse', 'main'), featHead)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// A branch left behind by a removed worktree is reused as-is by default, so its
// old base sticks. `resetBranch` is the only way to rebuild it somewhere else —
// regression for "não consigo trocar a base do worktree".
test('createWorktree reuses an existing branch, or resets it onto a new base', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rookery-git-'))
  try {
    g(root, 'init', '-q', '-b', 'trunk')
    g(root, 'config', 'user.email', 't@t')
    g(root, 'config', 'user.name', 't')
    writeFileSync(join(root, 'a'), '1')
    g(root, 'add', '-A')
    g(root, 'commit', '-q', '-m', 'c1')

    // 'other' is the new base; 'feat' is the leftover branch, one commit ahead.
    g(root, 'branch', 'other')
    g(root, 'checkout', '-q', '-b', 'feat')
    writeFileSync(join(root, 'a'), '2')
    g(root, 'commit', '-q', '-am', 'c2')
    const featHead = g(root, 'rev-parse', 'feat')
    const otherHead = g(root, 'rev-parse', 'other')
    g(root, 'checkout', '-q', 'trunk')

    // Default: the branch is checked out where it already was — base ignored.
    await createWorktree(root, 'feat', { base: 'other' })
    const wt = join(root, '.worktrees', 'feat')
    assert.equal(g(wt, 'rev-parse', 'HEAD'), featHead)

    g(root, 'worktree', 'remove', '--force', wt)

    // resetBranch: same branch name, rebuilt on 'other'.
    await createWorktree(root, 'feat', { base: 'other', resetBranch: true })
    assert.equal(g(wt, 'rev-parse', 'HEAD'), otherHead)
    assert.equal(g(root, 'rev-parse', 'feat'), otherHead)
    assert.equal(readFileSync(join(wt, '.gw-base'), 'utf8').trim(), 'other')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
