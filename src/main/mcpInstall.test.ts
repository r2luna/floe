import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// homedir() reads $HOME, so a scratch one keeps every write in this file away
// from the developer's own ~/.config/opencode and ~/.gemini.
const home = mkdtempSync(join(tmpdir(), 'floe-install-'))
process.env.HOME = home
// Never shell `claude mcp add` / `codex mcp add` out of a test run.
process.env.FLOE_MCP_NO_REGISTER = '1'

const {
  installEverywhere,
  installGemini,
  installMessage,
  installOpencode,
  opencodeConfigPath,
  geminiSettingsPath
} = await import('./mcpInstall.ts')

after(() => {
  delete process.env.FLOE_MCP_NO_REGISTER
})

const URL_ = 'http://127.0.0.1:41673/mcp/global'
const read = (path: string): Record<string, unknown> => JSON.parse(readFileSync(path, 'utf8'))

test('opencode gets a config file when it has none', () => {
  const result = installOpencode(URL_)
  assert.equal(result.ok, true)
  const doc = read(opencodeConfigPath()) as { mcp: Record<string, unknown> }
  assert.deepEqual(doc.mcp.floe, { type: 'remote', url: URL_, enabled: true })
})

test("the user's own settings survive the merge", () => {
  const path = geminiSettingsPath()
  mkdirSync(join(home, '.gemini'), { recursive: true })
  writeFileSync(path, JSON.stringify({ theme: 'dark', mcpServers: { other: { httpUrl: 'https://x' } } }))

  assert.equal(installGemini(URL_).ok, true)
  const doc = read(path) as { theme: string; mcpServers: Record<string, unknown> }
  assert.equal(doc.theme, 'dark', 'an unrelated key is not dropped')
  assert.deepEqual(doc.mcpServers.other, { httpUrl: 'https://x' }, 'nor is another server')
  assert.deepEqual(doc.mcpServers.floe, { httpUrl: URL_ })
})

test('a config that does not parse is reported, never overwritten', () => {
  const path = geminiSettingsPath()
  writeFileSync(path, '{ this is not json')
  assert.equal(installGemini(URL_).ok, false)
  assert.equal(readFileSync(path, 'utf8'), '{ this is not json', 'the file the user hand-wrote is left alone')
})

test('a section that is there but is not a table is refused, not replaced', () => {
  const path = geminiSettingsPath()
  writeFileSync(path, JSON.stringify({ mcpServers: 'nope' }))
  assert.equal(installGemini(URL_).ok, false)
  assert.deepEqual(read(path), { mcpServers: 'nope' })
})

test('installEverywhere skips the CLIs under the test guard', async () => {
  writeFileSync(geminiSettingsPath(), '{}')
  const results = await installEverywhere(URL_)
  assert.deepEqual(
    results.map((r) => r.harness),
    ['opencode', 'gemini']
  )
})

test('the message names who got it and who did not', () => {
  const results = [
    { harness: 'claude', ok: true, detail: URL_ },
    { harness: 'codex', ok: false, detail: 'command not found' }
  ]
  const message = installMessage(results, URL_, true)
  assert.match(message, /for claude/)
  assert.match(message, /Not registered: codex \(command not found\)/)
  assert.doesNotMatch(message, /fallback port/)

  // A fallback port means the registration dies with this app run — say so
  // rather than letting the user find out at the next launch.
  assert.match(installMessage(results, URL_, false), /fallback port this run/)
  assert.match(installMessage([], URL_, true), /for no harness/)
})
