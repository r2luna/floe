import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeGitRepo, type GitFixture } from './gitFixture.test-helper.ts'
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
 * Through the shared fixture, never a bare `git init`: a git spawn inherits the
 * caller's cwd and GIT_* environment, and one that escapes writes to Floe's own
 * history. The fixture pins all three and verifies where git landed. Its path is
 * already realpath'd, which matters because `git rev-parse --show-toplevel`
 * answers with /private/var on macOS while mkdtemp returns /var.
 */
const fixtures: GitFixture[] = []
after(() => {
  for (const f of fixtures) f.cleanup()
})

function repo(): string {
  const fixture = makeGitRepo('floe-repo-')
  fixtures.push(fixture)
  return fixture.dir
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

// The dialog's preview pane runs on this. Its whole promise is that it answers
// with what the add WOULD do, so these assert the two in step.
test('probePath answers for a repo before it is added', async () => {
  reset()
  const dir = repo()
  const probe = await projects.probePath(dir)
  assert.equal(probe.exists, true)
  assert.equal(probe.isRepo, true)
  assert.equal(probe.root, dir)
  assert.equal(probe.added, false, 'nothing has been added yet')
  assert.equal(probe.group, undefined)
})

test('probePath reports a project Floe already has, and its group', async () => {
  reset()
  const dir = repo()
  await projects.addProjectByPath(dir, 'Work')
  store.invalidateProjects()

  const probe = await projects.probePath(dir)
  assert.equal(probe.added, true)
  assert.equal(probe.group, 'Work')
})

test('probePath separates "nothing there" from "there, but not a repo"', async () => {
  reset()
  const missing = await projects.probePath(join(tmpdir(), 'floe-not-here-at-all'))
  assert.equal(missing.exists, false)
  assert.equal(missing.isRepo, false)

  const plain = realpathSync(mkdtempSync(join(tmpdir(), 'floe-plain-')))
  const notRepo = await projects.probePath(plain)
  assert.equal(notRepo.exists, true)
  assert.equal(notRepo.isRepo, false, 'a folder is not a repository')
})

// A path pointing INSIDE a repo is added as the repo root; the pane has to name
// that root, or it would describe a project that is never created.
test('probePath resolves a subdirectory to the repo root', async () => {
  reset()
  const dir = repo()
  const sub = join(dir, 'packages', 'app')
  mkdirSync(sub, { recursive: true })

  const probe = await projects.probePath(sub)
  assert.equal(probe.root, dir)
  assert.equal(probe.path, sub, 'it still says which path was asked about')
})

// Groups have no directory of their own — the list lives in floe.toml and the
// membership lives on each project — so a rename has to move both halves or the
// sidebar shows a group nobody is in next to projects filed under a dead name.
test('renameGroup moves the group and every project filed under it', () => {
  reset()
  projects.addGroup('Old')
  store.createProject('/code/one', { group: 'Old' })
  store.createProject('/code/two', { group: 'Projects' })
  store.invalidateProjects()

  const { groups, projects: after } = projects.renameGroup('Old', 'New')
  assert.equal(groups.includes('New'), true)
  assert.equal(groups.includes('Old'), false)
  assert.equal(after.find((p) => p.path === '/code/one')?.group, 'New')
  assert.equal(after.find((p) => p.path === '/code/two')?.group, 'Projects') // untouched
})

test('renaming onto an existing group merges into it rather than duplicating the name', () => {
  reset()
  projects.addGroup('A')
  projects.addGroup('B')
  store.createProject('/code/one', { group: 'A' })
  store.createProject('/code/two', { group: 'B' })
  store.invalidateProjects()

  const { groups, projects: after } = projects.renameGroup('A', 'B')
  assert.deepEqual(groups.filter((g) => g === 'B'), ['B']) // one B, not two
  assert.equal(groups.includes('A'), false)
  assert.equal(after.find((p) => p.path === '/code/one')?.group, 'B')
})

// The default is a fixed slot deleteGroup moves orphans into, and a rename to a
// name nobody has is a no-op the UI must not act on.
test('renameGroup refuses the default, a blank name, a no-op and an unknown group', () => {
  reset()
  projects.addGroup('Old')
  store.createProject('/code/one', { group: 'Old' })
  store.invalidateProjects()

  for (const [from, to] of [['Projects', 'Anything'], ['Old', '  '], ['Old', 'Old'], ['Ghost', 'New']]) {
    const { groups, projects: after } = projects.renameGroup(from, to)
    assert.equal(groups.includes('Old'), true, `${from} -> ${to} should change nothing`)
    assert.equal(groups.includes('Anything'), false)
    assert.equal(after.find((p) => p.path === '/code/one')?.group, 'Old')
  }
})
