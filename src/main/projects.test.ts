import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installHook } from './config/hook.test-helper.ts'

// The store is XDG-aware, so a temp XDG_CONFIG_HOME gives the real module graph
// a real directory to write projects into — no filesystem mocking. The hook is
// the shared one: rewrite extensionless relative specifiers and stub `electron`
// (projects.ts reaches `dialog`, which a `node --test` process does not have).
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'floe-cfg-'))
installHook()

const projects = await import('./projects.ts')
const store = await import('./config/projectStore.ts')

function reset(): void {
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'floe-cfg-'))
  store.invalidateProjects()
}

/**
 * A real repository, since addProjectByPath asks git whether it is one.
 *
 * Realpath'd because on macOS the temp dir is under the `/var` → `/private/var`
 * symlink, and `git rev-parse --show-toplevel` answers with the resolved path —
 * so the un-resolved one would never match what was stored.
 */
function repo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'floe-repo-')))
  execFileSync('git', ['init', '-q', dir])
  return dir
}

// `created` is what tells a fresh project from one Floe already had — the
// renderer starts the command-setup flow on it, and without the flag a re-add
// looks exactly like a first add at the call site.
test('a project Floe has never seen comes back created', async () => {
  reset()
  const dir = repo()
  const res = await projects.addProjectByPath(dir)
  assert.equal(res.error, undefined)
  assert.equal(res.created, true)
  assert.equal(res.project?.path, dir)
})

test('re-adding the same project is not created', async () => {
  reset()
  const dir = repo()
  await projects.addProjectByPath(dir)
  store.invalidateProjects()

  const again = await projects.addProjectByPath(dir, 'Somewhere else')
  assert.equal(again.created, false)
  assert.equal(again.project?.path, dir)
  // The group it was filed under is kept: a re-add is not a re-file.
  assert.notEqual(again.project?.group, 'Somewhere else')
})

test('a subdirectory of a repo is added as the repo root, once', async () => {
  reset()
  const dir = repo()
  const sub = join(dir, 'packages', 'app')
  mkdirSync(sub, { recursive: true })
  writeFileSync(join(sub, 'index.ts'), '')

  const first = await projects.addProjectByPath(dir)
  store.invalidateProjects()
  const second = await projects.addProjectByPath(sub)

  assert.equal(first.created, true)
  assert.equal(second.created, false, 'the root was already stored')
  assert.equal(second.project?.path, first.project?.path)
})

test('a path that is not a repository is refused, and says nothing about created', async () => {
  reset()
  const dir = mkdtempSync(join(tmpdir(), 'floe-plain-'))
  const res = await projects.addProjectByPath(dir)
  assert.match(res.error ?? '', /not a git repository/)
  assert.equal(res.created, undefined)
  assert.equal(res.project, undefined)
})
