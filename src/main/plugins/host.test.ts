import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installHook } from '../config/hook.test-helper.ts'

// Hermetic load of the real host: the loader hook stubs `electron`, and
// XDG_CONFIG_HOME points configDir() (and so pluginsDir()) at a scratch dir
// holding fixture plugins written by this test.

const scratchConfig = mkdtempSync(join(tmpdir(), 'floe-plugins-test-'))
process.env.XDG_CONFIG_HOME = scratchConfig

installHook()

const { handle } = await import('./handleMap.ts')
const { loadPlugins, loadedPlugins, panelBody, pluginCommands, pluginTools, runPluginCommand } = await import('./host.ts')

function writePlugin(name: string, manifest: Record<string, unknown>, source?: string): void {
  const dir = join(scratchConfig, 'floe', 'plugins', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest))
  if (source) writeFileSync(join(dir, 'main.cjs'), source)
}

before(async () => {
  // A core channel the fixture plugin dispatches into via ctx.invoke.
  handle('test:add', (_event, a: number, b: number) => a + b)

  writePlugin(
    'hello',
    { name: 'hello', version: '1.0.0', main: 'main.cjs' },
    `module.exports = {
      activate(ctx) {
        ctx.registerCommands([
          { id: 'ping', title: 'Ping', run: (arg) => { globalThis.__pingArg = arg ?? 'none' } },
          { id: 'boom', title: 'Boom', run: () => { throw new Error('kapow') } }
        ])
        ctx.registerTool({ name: 'hello_tool', description: 'says hi', run: () => 'hi' })
        ctx.registerIpc('echo', (text) => 'echo:' + text)
        ctx.registerPanel({
          id: 'main',
          title: 'Hello panel',
          body: () => [
            { kind: 'toggle', id: 'flip', label: 'Enabled', value: true },
            { kind: 'list', rows: [{ id: 'r1', title: 'Row' }], rowActions: [{ id: 'zap', label: 'zap' }] }
          ]
        })
        globalThis.__invoked = ctx.invoke('test:add', 2, 3)
      }
    }`
  )
  // Entry bundle missing entirely — must fail alone, not take the boot down.
  writePlugin('broken', { name: 'broken', version: '1.0.0', main: 'missing.cjs' })
  // Needs a newer Floe than we claim to be.
  writePlugin(
    'future',
    { name: 'future', version: '1.0.0', main: 'main.cjs', minFloeVersion: '99.0.0' },
    'module.exports = { activate() {} }'
  )
  // activate() that never settles — the shape of the `server` plugin when its
  // port is taken. It must be skipped, not hang boot; the short timeout keeps
  // the test fast.
  writePlugin(
    'hangs',
    { name: 'hangs', version: '1.0.0', main: 'main.cjs' },
    'module.exports = { activate() { return new Promise(() => {}) } }'
  )
  process.env.FLOE_PLUGIN_ACTIVATE_TIMEOUT_MS = '150'

  await loadPlugins('0.1.0', () => undefined)
})

after(() => rmSync(scratchConfig, { recursive: true, force: true }))

test('a working plugin loads and registers commands and tools', () => {
  const hello = loadedPlugins().find((p) => p.name === 'hello')
  assert.ok(hello && !hello.error)
  assert.deepEqual(
    pluginCommands().map((c) => c.id),
    ['plugin:hello:ping', 'plugin:hello:boom', 'plugin:hello:panel.main']
  )
  const panelCmd = pluginCommands().find((c) => c.panel)
  assert.deepEqual(panelCmd, {
    id: 'plugin:hello:panel.main',
    title: 'Hello panel',
    group: 'hello',
    panel: 'hello:main'
  })
  assert.equal(pluginCommands()[0]!.group, 'hello')
  assert.deepEqual(pluginTools().map((t) => t.name), ['hello_tool'])
})

test('ctx.invoke dispatches into a core handler registered via handle()', async () => {
  assert.equal(await (globalThis as Record<string, unknown>).__invoked, 5)
})

test('runPluginCommand runs with the arg, and reports a throw as an error', async () => {
  assert.deepEqual(await runPluginCommand('plugin:hello:ping', 'abc'), { ok: true })
  assert.equal((globalThis as Record<string, unknown>).__pingArg, 'abc')
  const boom = await runPluginCommand('plugin:hello:boom')
  assert.equal(boom.ok, false)
  assert.match((boom as { error: string }).error, /kapow/)
  const missing = await runPluginCommand('plugin:nope:x')
  assert.equal(missing.ok, false)
})

test('panelBody serves sections with command ids fully qualified', async () => {
  const body = await panelBody('hello:main')
  assert.equal(body?.title, 'Hello panel')
  const [toggle, list] = body!.sections
  assert.equal((toggle as { id: string }).id, 'plugin:hello:flip')
  assert.equal((list as { rowActions: Array<{ id: string }> }).rowActions[0]!.id, 'plugin:hello:zap')
  assert.equal(await panelBody('nope:x'), null)
})

test('a broken plugin is reported and skipped without stopping the others', () => {
  const broken = loadedPlugins().find((p) => p.name === 'broken')
  assert.ok(broken?.error)
})

test('minFloeVersion above the running version refuses to load', () => {
  const future = loadedPlugins().find((p) => p.name === 'future')
  assert.match(future?.error ?? '', /needs Floe >= 99\.0\.0/)
})

test('a plugin whose activate() never settles is skipped, not allowed to hang boot', () => {
  // The whole point: loadPlugins RESOLVED (this test runs), and the hung plugin
  // is reported failed alongside the ones that worked.
  const hangs = loadedPlugins().find((p) => p.name === 'hangs')
  assert.match(hangs?.error ?? '', /did not finish|port already in use/)
  // The good plugin still loaded — one bad neighbour takes nothing else down.
  assert.ok(loadedPlugins().find((p) => p.name === 'hello' && !p.error))
})
