import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installHook } from './hook.test-helper.ts'

// configDir() is XDG-aware, so pointing XDG_CONFIG_HOME at a temp dir gives the
// real module graph a real directory to work in — no filesystem mocking.
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'floe-cfg-'))
installHook()

const store = await import('./projectStore.ts')

function reset(): string {
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'floe-cfg-'))
  store.invalidateProjects()
  return process.env.XDG_CONFIG_HOME
}

/** Write a project directory by hand, the way a user or an agent would. */
function project(dirName: string, body: string): string {
  const dir = join(store.projectsDir(), dirName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.toml'), body)
  store.invalidateProjects()
  return dir
}

test('a project written by hand is read back whole', () => {
  reset()
  project('hln-web', 'path = "/code/hln-web"\ngroup = "DEVSQUAD"\nname = "Helinet"\npinned = true\n')
  const { projects, errors } = store.scanProjects()
  assert.deepEqual(errors, [])
  assert.equal(projects.length, 1)
  assert.equal(projects[0].path, '/code/hln-web')
  assert.equal(projects[0].group, 'DEVSQUAD')
  assert.equal(projects[0].name, 'Helinet')
  assert.equal(projects[0].pinned, true)
})

test('a missing projects dir is no projects, not a crash', () => {
  reset()
  assert.deepEqual(store.scanProjects().projects, [])
})

test('the [env] block is optional and validated when present', () => {
  reset()
  project(
    'app',
    'path = "/code/app"\n\n[env]\nmode = "container"\nruntime = "laravel"\nphp = "8.3"\npackage-manager = "bun"\ndb = "postgres"\n'
  )
  const env = store.scanProjects().projects[0].env
  assert.equal(env?.php, '8.3')
  assert.equal(env?.packageManager, 'bun')
  assert.equal(env?.db, 'postgres')
  assert.equal(env?.dbAdmin, true, 'defaults on, as documented')
})

test('a bad php version is reported and falls back, keeping the project', () => {
  reset()
  project('app', 'path = "/code/app"\n\n[env]\nphp = "8.1"\n')
  const { projects, errors } = store.scanProjects()
  assert.equal(projects.length, 1, 'one bad key does not lose the project')
  assert.equal(projects[0].env?.php, '8.4')
  assert.match(errors[0].reason, /8\.2, 8\.3, 8\.4, 8\.5/)
  assert.equal(errors[0].line, 4)
})

test('a config with no path is skipped, named, and never guessed at', () => {
  reset()
  project('mystery', 'group = "DEV"\n')
  const { projects, errors } = store.scanProjects()
  assert.deepEqual(projects, [])
  assert.equal(errors.length, 1)
  assert.match(errors[0].reason, /path is required/)
})

test('two directories claiming one path: first wins, second is named', () => {
  reset()
  project('a-copy', 'path = "/code/app"\n')
  project('b-original', 'path = "/code/app"\n')
  const { projects, errors } = store.scanProjects()
  assert.equal(projects.length, 1)
  assert.equal(errors.length, 1)
  assert.match(errors[0].reason, /duplicate project path/)
  assert.match(errors[0].file, /b-original/, 'the alphabetically later one is the one dropped')
})

test('a file that does not parse loses only its own project', () => {
  reset()
  project('good', 'path = "/code/good"\n')
  project('bad', 'path = "/code/bad\n')
  const { projects, errors } = store.scanProjects()
  assert.deepEqual(projects.map((p) => p.path), ['/code/good'])
  assert.equal(errors.length, 1)
})

test('pinned projects come first, the rest alphabetically', () => {
  reset()
  project('c', 'path = "/code/c"\n')
  project('a', 'path = "/code/a"\n')
  project('z', 'path = "/code/z"\npinned = true\n')
  assert.deepEqual(store.scanProjects().projects.map((p) => p.path), ['/code/z', '/code/a', '/code/c'])
})

test('a leading ~ resolves against $HOME, so the file stays portable', () => {
  reset()
  project('app', 'path = "~/code/app"\n')
  assert.equal(store.scanProjects().projects[0].path, join(process.env.HOME!, 'code/app'))
})

test('createProject writes a documented file that reads back', () => {
  reset()
  const created = store.createProject('/code/new-app', { group: 'OPS', name: 'New' })
  assert.equal(created.path, '/code/new-app')
  assert.equal(created.group, 'OPS')
  const raw = readFileSync(join(created.dir, 'config.toml'), 'utf8')
  assert.ok(raw.includes('# | Identity'), 'the block comments are in the generated file')
  assert.ok(raw.includes('path  = "/code/new-app"'))
})

test('createProject is idempotent for a path already configured', () => {
  reset()
  const a = store.createProject('/code/app')
  const b = store.createProject('/code/app')
  assert.equal(a.dir, b.dir)
  assert.equal(store.scanProjects().projects.length, 1)
})

test('two projects with the same basename get distinct directories', () => {
  reset()
  const a = store.createProject('/code/00.projects/os')
  const b = store.createProject('/code/03.clients/os')
  assert.notEqual(a.dir, b.dir)
  assert.match(b.dir, /clients-os$/)
  assert.equal(store.scanProjects().projects.length, 2)
})

test('renaming a project directory changes nothing — path is the identity', () => {
  reset()
  const created = store.createProject('/code/app', { group: 'OPS' })
  renameSync(created.dir, join(store.projectsDir(), 'renamed-by-hand'))
  store.invalidateProjects()
  const found = store.scanProjects().projects.find((p) => p.dir.endsWith('renamed-by-hand'))
  assert.equal(found?.path, '/code/app')
  assert.equal(found?.group, 'OPS')
})

test('updateProject edits in place and keeps the documentation', () => {
  reset()
  store.createProject('/code/app')
  store.setProjectValue('/code/app', 'pinned', true)
  store.setProjectEnvValue('/code/app', 'php', '8.5')
  const project_ = store.scanProjects().projects[0]
  assert.equal(project_.pinned, true)
  assert.equal(project_.env?.php, '8.5')
  const raw = readFileSync(join(project_.dir, 'config.toml'), 'utf8')
  assert.ok(raw.includes('# | Containerized Environment'), 'comments survive an app write')
})

test('removeProject deletes the directory and only that one', () => {
  reset()
  store.createProject('/code/a')
  store.createProject('/code/b')
  store.removeProject('/code/a')
  assert.deepEqual(store.scanProjects().projects.map((p) => p.path), ['/code/b'])
})

test('directoryNameFor never returns a name already taken', () => {
  const taken = new Set(['os', 'projects-os', 'projects-os-2'])
  assert.equal(store.directoryNameFor('/code/projects/os', taken), 'projects-os-3')
})
