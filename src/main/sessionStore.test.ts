import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Same loader hook as git.test.ts: extensionless relative imports + an `electron` stub.
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

const { setSharedDataDir } = await import('./dataDir.ts')
const { forgetWorktree, pruneMissingWorktrees, getCreatedSessionClaudeId, linkCreatedSession } =
  await import('./sessionStore.ts')

const dataDir = mkdtempSync(join(tmpdir(), 'floe-store-'))
setSharedDataDir(dataDir)

interface StoreShape {
  meta: Record<string, { title?: string }>
  created: Array<{ id: string; worktreePath: string; claudeId?: string }>
  view: {
    worktreeByProject: Record<string, string>
    viewByWorktree: Record<string, unknown>
    agentByWorktree: Record<string, string>
    projectUi: Record<string, unknown>
    worktreeUi: Record<string, unknown>
  }
  prefs: Record<string, unknown>
  reviewCheckpoints: Record<string, string>
}

function seed(root: string, wt: string): void {
  const store: StoreShape = {
    meta: { 'claude-gone': { title: 'old' }, 'claude-keep': { title: 'kept' } },
    created: [
      { id: 's1', worktreePath: wt, claudeId: 'claude-gone' },
      { id: 's2', worktreePath: join(root, '.worktrees', 'other'), claudeId: 'claude-keep' }
    ],
    view: {
      worktreeByProject: { [root]: wt },
      viewByWorktree: { [wt]: { kind: 'agent', key: 's1' } },
      agentByWorktree: { [wt]: 's1' },
      projectUi: {},
      worktreeUi: { [wt]: { rightVisible: true } }
    },
    prefs: {},
    reviewCheckpoints: { [wt]: 'deadbeef' }
  }
  writeFileSync(join(dataDir, 'sessions.json'), JSON.stringify(store))
}

const readStore = (): StoreShape => JSON.parse(readFileSync(join(dataDir, 'sessions.json'), 'utf8'))

test('forgetWorktree drops every trace of a removed worktree', () => {
  const root = mkdtempSync(join(tmpdir(), 'floe-repo-'))
  try {
    const wt = join(root, '.worktrees', 'feat')
    seed(root, wt)
    forgetWorktree(wt)
    const s = readStore()
    assert.deepEqual(
      s.created.map((c) => c.id),
      ['s2']
    )
    assert.equal('claude-gone' in s.meta, false)
    assert.equal('claude-keep' in s.meta, true)
    assert.equal(wt in s.view.viewByWorktree, false)
    assert.equal(wt in s.view.agentByWorktree, false)
    assert.equal(wt in s.view.worktreeUi, false)
    assert.equal(wt in s.reviewCheckpoints, false)
    assert.equal(root in s.view.worktreeByProject, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('pruneMissingWorktrees only prunes when the repo is still on disk', () => {
  const root = mkdtempSync(join(tmpdir(), 'floe-repo-'))
  try {
    // Repo present, worktree gone -> pruned.
    const wt = join(root, '.worktrees', 'feat')
    mkdirSync(join(root, '.worktrees', 'other'), { recursive: true })
    seed(root, wt)
    pruneMissingWorktrees()
    assert.deepEqual(
      readStore().created.map((c) => c.id),
      ['s2']
    )

    // Repo itself gone (moved/unmounted) -> history kept.
    const gone = join(tmpdir(), 'floe-repo-vanished')
    seed(gone, join(gone, '.worktrees', 'feat'))
    pruneMissingWorktrees()
    assert.equal(readStore().created.length, 2)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a session key resolves by claude id, including superseded ones', () => {
  const root = mkdtempSync(join(tmpdir(), 'floe-repo-'))
  try {
    const wt = join(root, '.worktrees', 'feat')
    seed(root, wt)
    // The renderer keys an open panel by claudeId, not by the store id.
    assert.equal(getCreatedSessionClaudeId('claude-gone'), 'claude-gone')
    // `--resume` forked into a new id; the panel still sends the old key.
    linkCreatedSession('claude-gone', 'claude-fork')
    assert.equal(getCreatedSessionClaudeId('claude-gone'), 'claude-fork')
    assert.equal(getCreatedSessionClaudeId('claude-fork'), 'claude-fork')
    assert.equal(getCreatedSessionClaudeId('s1'), 'claude-fork')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
