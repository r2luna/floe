import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installHook } from './hook.test-helper.ts'
import { settle, waitFor } from '../watch.test-helper.ts'

// configDir() is XDG-aware, so a temp XDG_CONFIG_HOME gives the real module
// graph a real directory to watch. The hook stubs `electron`, which this graph
// reaches through dataDir/editors/keybindings.
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'floe-cfg-'))
installHook()

const config = await import('./index.ts')
const { configDir } = await import('../dataDir.ts')

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// Collect what the watcher reports, with the watcher already settled — macOS
// delivers FSEvents with enough latency that a write issued immediately after
// `watch()` can be missed.
//
// `want` is how a test that expects a report waits for it; the tests that expect
// silence pass nothing and rely on `settle` alone, which returns once the
// callbacks stop arriving instead of after a fixed guess.
async function watching(
  body: (dir: string) => void,
  want?: (seen: string[]) => boolean
): Promise<string[]> {
  const seen: string[] = []
  const stop = config.watchConfig((file) => seen.push(file))
  try {
    await wait(200)
    body(configDir())
    if (want) await waitFor(() => want(seen), 5000, 'the config change to be reported')
    await settle(() => seen.length)
  } finally {
    stop()
  }
  return seen
}

test('a config file written anywhere under the dir is reported, nested ones included', async () => {
  const seen = await watching((dir) => {
    mkdirSync(join(dir, 'projects', 'hln-web'), { recursive: true })
    writeFileSync(join(dir, 'projects', 'hln-web', 'config.toml'), 'path = "/code/hln-web"\n')
  }, (seen) => seen.some((f) => f.endsWith(join('hln-web', 'config.toml'))))
  // Recursive, because a project's config.toml is two levels down and an agent
  // writing one has to reach the sidebar without a restart.
  assert.ok(
    seen.some((f) => f.endsWith(join('hln-web', 'config.toml'))),
    `expected a nested config.toml, got ${JSON.stringify(seen)}`
  )
})

// Our own atomic writes land as `<file>.tmp` first; reacting to those reloads a
// file that is about to be replaced anyway.
test('the temp files of an atomic write are not a change', async () => {
  const seen = await watching((dir) => {
    writeFileSync(join(dir, 'floe.toml.tmp'), 'half written')
    writeFileSync(join(dir, 'floe.toml.migrated'), 'old copy')
  })
  assert.deepEqual(seen, [])
})

// Plugins live under the config dir but are code and private state, not config:
// a plugin writing its own files must not repaint the app.
test('a plugin writing its own files does not count as a config change', async () => {
  const seen = await watching((dir) => {
    mkdirSync(join(dir, 'plugins', 'acme'), { recursive: true })
    writeFileSync(join(dir, 'plugins', 'acme', 'state.json'), '{}')
  })
  assert.deepEqual(seen, [])
})

/** A real repository, registered as a project before the watcher starts. */
function trackedRepo(withFloe: boolean): string {
  const repo = mkdtempSync(join(tmpdir(), 'floe-repo-'))
  if (withFloe) mkdirSync(join(repo, '.floe', 'plans'), { recursive: true })
  const dir = join(configDir(), 'projects', repo.split('/').pop()!)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.toml'), `path = "${repo}"\n`)
  config.invalidateAll()
  return repo
}

// The project's commands, MCP servers and skills live in the repo now, so an
// edit there has to repaint the app just like one in ~/.config did.
test("a config file in a project's .floe is reported, a plan beside it is not", async () => {
  const repo = trackedRepo(true)
  const commands = join(repo, '.floe', 'commands.toml')
  const seen = await watching(() => {
    writeFileSync(join(repo, '.floe', 'plans', 'notes.md'), '# not config')
    writeFileSync(commands, '[[command]]\nname = "Dev"\ncommand = "x"\n')
  }, (seen) => seen.includes(commands))
  assert.ok(!seen.some((f) => f.includes('plans')), JSON.stringify(seen))
})

test('a .floe created after the watcher started is picked up', async () => {
  const repo = trackedRepo(false)
  const mcp = join(repo, '.floe', 'mcp.toml')
  const seen: string[] = []
  const stop = config.watchConfig((file) => seen.push(file))
  try {
    await wait(200)
    mkdirSync(join(repo, '.floe'))
    await waitFor(() => seen.length > 0, 5000, 'the new .floe to be reported')
    await wait(200)
    writeFileSync(mcp, '')
    await waitFor(() => seen.includes(mcp), 5000, 'a write inside the new .floe to be reported')
  } finally {
    stop()
  }
})

test('the dispose function stops the callbacks', async () => {
  const seen: string[] = []
  const stop = config.watchConfig((file) => seen.push(file))
  await wait(200)
  stop()
  writeFileSync(join(configDir(), 'floe.toml'), '[projects]\ngroups = []\n')
  await settle(() => seen.length)
  assert.deepEqual(seen, [])
})

test('configPaths names the files Settings has to be able to open', () => {
  const paths = config.configPaths()
  assert.equal(paths.dir, configDir())
  assert.equal(paths.floe, join(configDir(), 'floe.toml'))
  assert.equal(paths.projects, join(configDir(), 'projects'))
  assert.ok(paths.systemPrompt.endsWith('.md'))
  assert.equal(config.configDirExists(), true)
})
