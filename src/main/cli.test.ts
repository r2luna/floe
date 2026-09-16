import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeGitRepo, type GitFixture } from './gitFixture.test-helper.ts'
import { installHook } from './config/hook.test-helper.ts'

// The install writes into a temp HOME and the project store into a temp XDG dir,
// so these are the real functions against a real filesystem — the only mock is
// the shared hook that stubs `electron` for the graph behind projects.ts.
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'floe-cli-cfg-'))
installHook()

const cli = await import('./cli.ts')
type CliPaths = import('./cli.ts').CliPaths

const dirs: string[] = []
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'floe-cli-'))
  dirs.push(dir)
  return dir
}

const fixtures: GitFixture[] = []
after(() => {
  for (const f of fixtures) f.cleanup()
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

/** A real repository — openProject asks git whether the path is one. */
function repo(): string {
  const fixture = makeGitRepo('floe-cli-repo-')
  fixtures.push(fixture)
  fixture.write('README.md', '# fixture\n')
  fixture.commit('init')
  return fixture.dir
}

function paths(overrides: Partial<CliPaths> = {}): CliPaths {
  const home = scratch()
  const data = scratch()
  const app = scratch()
  const script = join(app, 'floe.mjs')
  writeFileSync(script, '// shipped script\n')
  return {
    exePath: '/Applications/Floe.app/Contents/MacOS/Floe',
    scriptPath: script,
    version: '1.2.3',
    homeDir: home,
    dataDir: data,
    pathEnv: `/usr/bin:${join(home, '.local', 'bin')}`,
    ...overrides
  }
}

test('--open is read wherever it sits on the argv', () => {
  assert.equal(cli.openPathFromArgv(['/Floe', '--open', '/code/app']), '/code/app')
  assert.equal(cli.openPathFromArgv(['electron', '.', '--open', '/code/app']), '/code/app')
  assert.equal(cli.openPathFromArgv(['/Floe']), null)
  // A flag where the path should be is a typo, not a path.
  assert.equal(cli.openPathFromArgv(['/Floe', '--open', '--devtools']), null)
  assert.equal(cli.openPathFromArgv(['/Floe', '--open']), null)
})

test('--name is read off the argv beside --open', () => {
  assert.equal(cli.openNameFromArgv(['/Floe', '--open', '/code/app', '--name', 'my-app']), 'my-app')
  assert.equal(cli.openNameFromArgv(['/Floe', '--open', '/code/app']), null)
  assert.equal(cli.openNameFromArgv(['/Floe', '--name', '--devtools']), null)
})

test('the shim execs the app binary as node and hands it back to the script', () => {
  const shim = cli.cliShim('/Apps/Floe', '/data/cli/floe.mjs', '9.9.9')
  assert.match(shim, /^#!\/bin\/sh/)
  assert.match(shim, /ELECTRON_RUN_AS_NODE=1/)
  assert.match(shim, /FLOE_APP_EXE="\/Apps\/Floe"/)
  assert.match(shim, /FLOE_APP_VERSION="9\.9\.9"/)
  assert.match(shim, /exec "\/Apps\/Floe" "\/data\/cli\/floe\.mjs" "\$@"/)
})

test('installing writes an executable shim and its own copy of the script', () => {
  const p = paths()
  const result = cli.installCli(p)
  assert.equal(result.ok, true)
  assert.equal(result.path, cli.shimPath(p.homeDir))
  assert.equal(statSync(result.path!).mode & 0o777, 0o755)
  assert.equal(readFileSync(cli.installedScript(p.dataDir), 'utf8'), '// shipped script\n')
  // The shim points at the copy, not at the bundle it was installed from.
  assert.match(readFileSync(result.path!, 'utf8'), new RegExp(cli.installedScript(p.dataDir)))
  assert.match(result.message, /Try: floe \./)
})

test('a ~/.local/bin the shell cannot see is said out loud', () => {
  const result = cli.installCli(paths({ pathEnv: '/usr/bin:/bin' }))
  assert.equal(result.ok, true)
  assert.match(result.message, /Add .*\.local\/bin to your PATH/)
})

test('a home that cannot be written reports the path it failed on', () => {
  const home = scratch()
  chmodSync(home, 0o500)
  const result = cli.installCli(paths({ homeDir: home }))
  chmodSync(home, 0o700)
  assert.equal(result.ok, false)
  assert.match(result.message, /Could not write/)
})

test('boot refresh rewrites a stale shim and re-copies the script', () => {
  const p = paths()
  cli.installCli(p)
  // What an update looks like: a new binary, and a new script behind it.
  writeFileSync(p.scriptPath, '// build two\n')
  const next = { ...p, exePath: '/Applications/Floe.app/Contents/MacOS/Floe2', version: '1.3.0' }
  cli.refreshCli(next)
  assert.match(readFileSync(cli.shimPath(p.homeDir), 'utf8'), /Floe2/)
  assert.equal(readFileSync(cli.installedScript(p.dataDir), 'utf8'), '// build two\n')
})

test('boot refresh installs nothing on its own, and never touches another floe', () => {
  const p = paths()
  cli.refreshCli(p)
  assert.equal(existsSync(cli.shimPath(p.homeDir)), false)

  const q = paths()
  const someone = cli.shimPath(q.homeDir)
  cli.installCli(q) // makes the directories
  writeFileSync(someone, '#!/bin/sh\necho not ours\n')
  cli.refreshCli(q)
  assert.equal(readFileSync(someone, 'utf8'), '#!/bin/sh\necho not ours\n')
})

test('opening a repository registers it and says so', async () => {
  const dir = repo()
  const first = await cli.openProject(dir)
  assert.equal(first.created, true)
  assert.equal(first.project?.path, dir)
  assert.match(first.message!, /^Added /)

  // Re-opening is how you bring an existing project forward — not an error.
  const again = await cli.openProject(dir)
  assert.equal(again.created, false)
  assert.match(again.message!, /^Opened /)
})

test('a name names a new project and renames an existing one', async () => {
  const dir = repo()
  const first = await cli.openProject(dir, 'my-app')
  assert.equal(first.project?.name, 'my-app')
  assert.match(first.message!, /^Added my-app /)

  const again = await cli.openProject(dir, 'renamed')
  assert.equal(again.project?.name, 'renamed')
  assert.match(again.message!, /^Opened renamed /)

  // No name leaves the one it has.
  assert.equal((await cli.openProject(dir)).project?.name, 'renamed')
})

test('a directory that is not a repository is refused, with no project made', async () => {
  const result = await cli.openProject(scratch())
  assert.match(result.error!, /not a git repository/)
  assert.equal(result.project, undefined)
})
