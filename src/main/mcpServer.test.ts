import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

// The main-process modules use extensionless relative imports and `electron`
// named imports — both resolved by electron-vite at build time, neither by raw
// Node ESM. Register an in-memory customization hook BEFORE importing mcpServer
// so the test can load it hermetically (no Electron runtime, no real electron):
//   - rewrite extensionless `./x` / `../x` to `./x.ts`
//   - replace `electron` with a tiny stub exposing the names the graph imports
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
    const src = [
      "export const app = { getPath: () => '/tmp' };",
      'export class BrowserWindow {}',
      'export const Menu = { setApplicationMenu(){}, buildFromTemplate: () => ({}) };',
      'export class Notification {}',
      'export const dialog = {};',
      'export const ipcMain = { handle(){}, on(){} };',
      'export const nativeTheme = { on(){}, get shouldUseDarkColors(){ return false } };',
      'export const safeStorage = { isEncryptionAvailable: () => false };',
      'export const shell = {};',
      'export default {};'
    ].join('\\n')
    return { format: 'module', shortCircuit: true, source: src }
  }
  return next(url, context)
}
`
// Materialize the hook as a data: URL so the whole test stays in one file.
const hookUrl = 'data:text/javascript,' + encodeURIComponent(hookSource)
register(hookUrl, import.meta.url)

// Now that the resolver is in place, pull in mcpServer and the MCP client SDK.
const { startMcpServer, port, mcpConfigFor, shutdown } = await import('./mcpServer.ts')
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js')

// Silence the unused-import lint for the symbols the data-url hook mirrors.
void existsSync
void fileURLToPath
void pathToFileURL

before(async () => {
  startMcpServer(() => undefined) // no window — list_projects doesn't need one
  // Wait for the ephemeral port to be assigned by the OS.
  for (let i = 0; i < 50 && port() === 0; i++) await new Promise((r) => setTimeout(r, 10))
  assert.ok(port() > 0, 'server should bind an ephemeral port')
})

after(() => shutdown())

function connect(): Promise<InstanceType<typeof Client>> {
  const url = new URL(`http://127.0.0.1:${port()}/mcp/test-key`)
  const transport = new StreamableHTTPClientTransport(url)
  const client = new Client({ name: 'test', version: '1.0.0' })
  return client.connect(transport).then(() => client)
}

test('lists the rookery tools over the token-routed HTTP transport', async () => {
  const client = await connect()
  try {
    const { tools } = await client.listTools()
    const names = tools.map((t) => t.name).sort()
    for (const expected of [
      'list_projects',
      'list_worktrees',
      'create_worktree',
      'list_sessions',
      'create_session',
      'send_message',
      'read_session_output',
      'switch_view',
      'select_session',
      'list_plans',
      'open_plan'
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

test('mcpConfigFor writes a config file pointing at the token url', () => {
  const path = mcpConfigFor('abc-123')
  assert.ok(existsSync(path), 'config file should be written')
  const cfg = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(cfg.mcpServers.rookery.type, 'http')
  assert.match(cfg.mcpServers.rookery.url, /\/mcp\/abc-123$/)
})
