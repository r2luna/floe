import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installHook } from './hook.test-helper.ts'

// The store writes through configDir(), which honours XDG_CONFIG_HOME — a
// scratch dir keeps the whole run away from the real ~/.config/floe.
const scratch = mkdtempSync(join(tmpdir(), 'floe-mcp-store-'))
process.env.XDG_CONFIG_HOME = scratch

installHook()

const { addMcpServer, listMcpServers, removeMcpServer, updateMcpServer, globalMcpPath } = await import('./mcpServers.ts')

after(() => rmSync(scratch, { recursive: true, force: true }))

test('add writes a [[server]] entry the list reads back', () => {
  const made = addMcpServer('global', { name: 'context7', transport: 'http', url: 'https://mcp.context7.com/mcp' })
  assert.equal(made.name, 'context7')
  assert.equal(made.enabled, true)
  const listed = listMcpServers()
  assert.equal(listed.length, 1)
  assert.equal(listed[0].url, 'https://mcp.context7.com/mcp')
  // The file carries the template header, so a hand-editor learns the shape.
  assert.match(readFileSync(globalMcpPath(), 'utf8'), /Floe — MCP servers/)
})

test('a second entry with the same name is refused', () => {
  assert.throws(() => addMcpServer('global', { name: 'context7', transport: 'http', url: 'https://x' }), /already exists/)
})

test('an http server without a url is refused', () => {
  assert.throws(() => addMcpServer('global', { name: 'broken', transport: 'http' }), /needs a url/)
})

test('update patches only the passed fields; enabled=false keeps the entry', () => {
  const patched = updateMcpServer('context7', { enabled: false })
  assert.equal(patched.enabled, false)
  assert.equal(patched.url, 'https://mcp.context7.com/mcp')
  assert.equal(listMcpServers()[0].enabled, false)
})

test('a stdio server keeps its command and args', () => {
  addMcpServer('global', { name: 'local-tool', transport: 'stdio', command: 'npx', args: ['-y', '@some/mcp'] })
  const found = listMcpServers().find((s) => s.name === 'local-tool')
  assert.deepEqual(found?.args, ['-y', '@some/mcp'])
})

test('remove deletes the entry and only that entry', () => {
  removeMcpServer('context7')
  const names = listMcpServers().map((s) => s.name)
  assert.deepEqual(names, ['local-tool'])
})

test('an unknown name answers a clear error', () => {
  assert.throws(() => updateMcpServer('ghost', { enabled: true }), /no MCP server called/)
  assert.throws(() => removeMcpServer('ghost'), /no MCP server called/)
})
