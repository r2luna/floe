import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installHook } from './config/hook.test-helper.ts'

// The registry writes through configDir(), which honours XDG_CONFIG_HOME — a
// scratch dir keeps the whole run away from the real ~/.config/floe.
const scratch = mkdtempSync(join(tmpdir(), 'floe-harness-'))
process.env.XDG_CONFIG_HOME = scratch

installHook()

const { addMcpServer } = await import('./config/mcpServers.ts')
const {
  claudeMcpConfig,
  clearHarnessConfigs,
  codexMcpConfig,
  geminiMcpConfig,
  harnessMcp,
  mcpUrlFor,
  opencodeMcpConfig,
  queryServers,
  serversFor,
  setMcpPort
} = await import('./mcpHarness.ts')

after(() => {
  clearHarnessConfigs()
  rmSync(scratch, { recursive: true, force: true })
})

setMcpPort(41673)
addMcpServer('global', {
  name: 'paid',
  transport: 'http',
  url: 'https://mcp.example/mcp',
  headers: { Authorization: 'Bearer s3cret' }
})
addMcpServer('global', { name: 'local', transport: 'stdio', command: 'npx', args: ['-y', 'thing'], env: { API_KEY: 'k' } })
addMcpServer('global', { name: 'off', transport: 'http', url: 'https://off.example', enabled: false })

test('a session gets Floe plus the enabled registry entries, with their credentials', () => {
  const map = serversFor('sess-1')
  assert.deepEqual(Object.keys(map).sort(), ['floe', 'local', 'paid'], 'a disabled entry is not handed to anyone')
  assert.equal(map.floe.url, 'http://127.0.0.1:41673/mcp/sess-1', 'the url carries this caller as its token')
  assert.deepEqual(map.paid.headers, { Authorization: 'Bearer s3cret' })
  assert.deepEqual(map.local.env, { API_KEY: 'k' })
})

test('claude gets its own mcpServers object', () => {
  const { mcpServers } = claudeMcpConfig(serversFor('sess-1'))
  assert.deepEqual(mcpServers.floe, { type: 'http', url: 'http://127.0.0.1:41673/mcp/sess-1' })
  assert.deepEqual(mcpServers.paid, {
    type: 'http',
    url: 'https://mcp.example/mcp',
    headers: { Authorization: 'Bearer s3cret' }
  })
  assert.deepEqual(mcpServers.local, { command: 'npx', args: ['-y', 'thing'], env: { API_KEY: 'k' } })
})

test('codex gets thread config, and every server auto-approved', () => {
  const { mcp_servers } = codexMcpConfig(serversFor('sess-1'))
  // Without this codex answers "requires approval, but approval policy is
  // never" on every call — Floe starts its threads with approvals off.
  assert.equal((mcp_servers.floe as { default_tools_approval_mode: string }).default_tools_approval_mode, 'approve')
  assert.deepEqual(mcp_servers.paid, {
    url: 'https://mcp.example/mcp',
    http_headers: { Authorization: 'Bearer s3cret' },
    default_tools_approval_mode: 'approve'
  })
  assert.deepEqual(mcp_servers.local, {
    command: 'npx',
    args: ['-y', 'thing'],
    env: { API_KEY: 'k' },
    default_tools_approval_mode: 'approve'
  })
})

test('opencode and gemini each get their own dialect', () => {
  const { mcp } = opencodeMcpConfig(serversFor('sess-1'))
  assert.deepEqual(mcp.floe, { type: 'remote', url: 'http://127.0.0.1:41673/mcp/sess-1', enabled: true })
  assert.deepEqual(mcp.local, {
    type: 'local',
    command: ['npx', '-y', 'thing'],
    enabled: true,
    environment: { API_KEY: 'k' }
  })

  const gemini = geminiMcpConfig(serversFor('sess-1')) as { mcpServers: Record<string, unknown> }
  assert.deepEqual(gemini.mcpServers.floe, { httpUrl: 'http://127.0.0.1:41673/mcp/sess-1' })
  assert.deepEqual(gemini.mcpServers.local, { command: 'npx', args: ['-y', 'thing'], env: { API_KEY: 'k' } })
})

test('a query is handed every server switched OFF, and no token', () => {
  const map = queryServers()
  // 'off' is disabled in Floe's own registry and still named here: a query
  // inherits the HARNESS's config, where that entry may well be on.
  assert.deepEqual(Object.keys(map).sort(), ['floe', 'local', 'off', 'paid'])
  assert.ok(
    Object.values(map).every((s) => s.enabled === false),
    'naming them is the only way to disable an inherited one'
  )
  assert.doesNotMatch(map.floe.url ?? '', /41673/, 'a disabled entry must not carry a live url either')

  // codex refuses an override for a server it has never heard of, so the
  // transport is restated alongside the off switch.
  const { mcp_servers } = codexMcpConfig(map)
  assert.deepEqual(mcp_servers.floe, { url: 'http://127.0.0.1:0/mcp/disabled', enabled: false })
  assert.equal((mcp_servers.local as { enabled: boolean }).enabled, false)

  // gemini has no per-server switch: an allow-list of nothing is the way.
  assert.deepEqual(geminiMcpConfig(map), { mcpServers: {}, mcp: { allowed: [] } })
})

test('harnessMcp writes gemini a 0600 file and gives opencode its env blob', () => {
  const opencode = harnessMcp('opencode', 'sess-1')
  const parsed = JSON.parse(opencode.OPENCODE_CONFIG_CONTENT) as { mcp: Record<string, unknown> }
  assert.ok(parsed.mcp.floe, 'opencode reads its servers out of the environment')

  const gemini = harnessMcp('gemini', 'sess-1')
  const file = gemini.GEMINI_CLI_SYSTEM_SETTINGS_PATH
  assert.ok(file, 'gemini reads settings files only, so one is generated for it')
  assert.match(readFileSync(file, 'utf8'), /mcp\/sess-1/)

  assert.deepEqual(harnessMcp('lmstudio', 'sess-1'), {}, 'a harness with no tools gets nothing')
})

test('a query key reaches the off switch through harnessMcp too', () => {
  const opencode = harnessMcp('opencode', 'sess-1~codex')
  const parsed = JSON.parse(opencode.OPENCODE_CONFIG_CONTENT) as { mcp: Record<string, { enabled: boolean }> }
  assert.equal(parsed.mcp.floe.enabled, false)
})

test('the url is the one place the caller becomes a token', () => {
  assert.equal(mcpUrlFor('a b'), 'http://127.0.0.1:41673/mcp/a%20b')
})
