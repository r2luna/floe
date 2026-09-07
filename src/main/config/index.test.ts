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
