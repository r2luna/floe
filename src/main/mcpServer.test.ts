import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installHook } from './config/hook.test-helper.ts'

// Hermetic boot of the real server: the loader hook stubs `electron` and
// rewrites extensionless imports so the whole main-process graph loads under
// plain `node --test`, then the MCP client SDK connects over streamable HTTP —
// the same transport a spawned `claude` uses.

// The boot path auto-registers with the `claude` CLI when it lands on the
// preferred port — a test must never shell out `claude mcp add`.
process.env.FLOE_MCP_NO_REGISTER = '1'

// The skills tools write through configDir(), which honours XDG_CONFIG_HOME —
// point it at a scratch dir so the test exercises the real CRUD without ever
// touching ~/.config/floe.
const scratchConfig = mkdtempSync(join(tmpdir(), 'floe-mcp-test-'))
process.env.XDG_CONFIG_HOME = scratchConfig

installHook()

const { startMcpServer, port, mcpConfigFor, shutdown } = await import('./mcpServer.ts')
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js')

before(async () => {
  startMcpServer(() => undefined) // no window — the tools exercised here don't need one
  // Wait for the port: the preferred one, or the ephemeral fallback when a real
  // Floe instance is running on this machine.
  for (let i = 0; i < 50 && port() === 0; i++) await new Promise((r) => setTimeout(r, 10))
  assert.ok(port() > 0, 'server should bind a port')
})

after(() => {
  shutdown()
  rmSync(scratchConfig, { recursive: true, force: true })
})

function connect(): Promise<InstanceType<typeof Client>> {
  const url = new URL(`http://127.0.0.1:${port()}/mcp/test-key`)
  const transport = new StreamableHTTPClientTransport(url)
  const client = new Client({ name: 'test', version: '1.0.0' })
  return client.connect(transport).then(() => client)
}

test('lists the floe tools over the token-routed HTTP transport', async () => {
  const client = await connect()
  try {
    const { tools } = await client.listTools()
    const names = tools.map((t) => t.name).sort()
    // The hooks (main/hooks.ts) steer sessions to these exact names — a rename
    // here must update them too.
    for (const expected of [
      'list_projects',
      'list_worktrees',
      'create_worktree',
      'remove_worktree',
      'merge_worktree',
      'worktree_status',
      'list_branches',
      'changed_files',
      'file_diff',
      'list_sessions',
      'create_session',
      'send_message',
      'ask_codex',
      'read_session_output',
      'open_query',
      'ask_all',
      'list_queries',
      'peek_query',
      'merge_query',
      'discard_query',
      'stop_session',
      'select_session',
      'create_followup',
      'list_followups',
      'cancel_followup',
      'list_plans',
      'read_plan',
      'open_plan',
      'list_drawings',
      'read_drawing',
      'create_drawing',
      'draw_elements',
      'erase_elements',
      'move_elements',
      'promote_drawing',
      'open_drawing',
      'present_decision',
      'start_merge',
      'colony_board',
      'colony_add_task',
      'colony_start_task',
      'colony_remove_task',
      'list_skills',
      'read_skill',
      'create_skill',
      'update_skill',
      'rename_skill',
      'delete_skill',
      'list_mcp_servers',
      'add_mcp_server',
      'update_mcp_server',
      'remove_mcp_server',
      'list_project_commands',
      'add_project_command',
      'list_commands',
      'run_command'
    ]) {
      assert.ok(names.includes(expected), `tools/list should include ${expected} (got ${names.join(', ')})`)
    }
  } finally {
    await client.close()
  }
})

test('calls list_projects and returns a JSON text result', async () => {
  const client = await connect()
  try {
    const result = await client.callTool({ name: 'list_projects', arguments: {} })
    const content = result.content as Array<{ type: string; text: string }>
    assert.equal(content[0].type, 'text')
    // Whatever the local project list is, the tool must return parseable JSON
    // (an array) rather than throwing.
    const parsed = JSON.parse(content[0].text)
    assert.ok(Array.isArray(parsed), 'list_projects should return a JSON array')
  } finally {
    await client.close()
  }
})

test('run_command without a window answers with an error, not a hang', async () => {
  const client = await connect()
  try {
    const result = await client.callTool({ name: 'run_command', arguments: { command_id: 'panel.right' } })
    const content = result.content as Array<{ type: string; text: string }>
    const parsed = JSON.parse(content[0].text) as { error?: string }
    assert.ok(parsed.error, 'with no window the tool must return an error explaining that')
  } finally {
    await client.close()
  }
})

test('rejects browser-shaped requests (Origin header) with 403', async () => {
  const res = await fetch(`http://127.0.0.1:${port()}/mcp/test-key`, {
    method: 'POST',
    headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
    body: '{}'
  })
  assert.equal(res.status, 403)
})

test('mcpConfigFor writes a config file pointing at the token url', () => {
  const path = mcpConfigFor('abc-123')
  assert.ok(existsSync(path), 'config file should be written')
  assert.ok(/floe-mcp-abc-123\.json$/.test(path), 'file name is what hooks.ts DETECT_FLOE greps for')
  const cfg = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(cfg.mcpServers.floe.type, 'http')
  assert.match(cfg.mcpServers.floe.url, /\/mcp\/abc-123$/)
})

test('skills lifecycle over MCP: create, update, read, rename, delete', async () => {
  const client = await connect()
  const call = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const result = await client.callTool({ name, arguments: args })
    const content = result.content as Array<{ type: string; text: string }>
    return JSON.parse(content[0].text) as Record<string, unknown>
  }
  try {
    // The whole run lives in the scratch XDG_CONFIG_HOME set above — the real
    // ~/.config/floe is never touched.
    const made = await call('create_skill', { name: 'mcp-test-skill', scope: 'global' })
    assert.equal(made.name, 'mcp-test-skill')

    const body = '---\nname: mcp-test-skill\ndescription: test\n---\n\nHello from the test.\n'
    const updated = await call('update_skill', { name: 'mcp-test-skill', content: body })
    assert.equal(updated.ok, true)

    const read = await call('read_skill', { name: 'mcp-test-skill' })
    assert.equal(read.content, body)

    const renamed = await call('rename_skill', { name: 'mcp-test-skill', to: 'mcp-test-skill-2' })
    assert.equal(renamed.name, 'mcp-test-skill-2')

    const listed = await call('list_skills', {})
    const names = (listed as unknown as Array<{ name: string }>).map((s) => s.name)
    assert.ok(names.includes('mcp-test-skill-2'), `list_skills should show the renamed skill (got ${names.join(', ')})`)
    assert.ok(!names.includes('mcp-test-skill'), 'the old name must be gone after rename')

    const gone = await call('delete_skill', { name: 'mcp-test-skill-2' })
    assert.equal(gone.ok, true)
    const missing = await call('read_skill', { name: 'mcp-test-skill-2' })
    assert.ok(missing.error, 'reading a deleted skill must answer an error, not throw')
  } finally {
    await client.close()
  }
})

test('mcpConfigFor merges the enabled registry entries into the per-session config', async () => {
  const { addMcpServer, removeMcpServer } = await import('./config/mcpServers.ts')
  addMcpServer('global', { name: 'merged', transport: 'http', url: 'https://example.com/mcp' })
  addMcpServer('global', { name: 'dark', transport: 'http', url: 'https://example.com/off', enabled: false })
  try {
    const cfg = JSON.parse(readFileSync(mcpConfigFor('merge-check'), 'utf8'))
    assert.equal(cfg.mcpServers.merged.url, 'https://example.com/mcp')
    assert.equal(cfg.mcpServers.dark, undefined, 'a disabled entry must not reach a session')
    assert.ok(cfg.mcpServers.floe, "floe's own server always rides along")
  } finally {
    removeMcpServer('merged')
    removeMcpServer('dark')
  }
})

test('send_message can name the harness, and reads a handle when it does not', async () => {
  const client = await connect()
  try {
    const { tools } = await client.listTools()
    const send = tools.find((t) => t.name === 'send_message')
    const props = (send?.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}
    // Everything the composer's picker can say, an agent can say too — that is
    // the agent-first rule, and the schema is where it is either true or not.
    for (const key of ['harness', 'model', 'effort', 'mode'])
      assert.ok(key in props, `send_message should take ${key} (got ${Object.keys(props).join(', ')})`)
    // And the literal parity: `@codex …` in the prompt does what it does in the box.
    assert.match(String((props.prompt as { description?: string }).description), /@codex/)
  } finally {
    await client.close()
  }
})
