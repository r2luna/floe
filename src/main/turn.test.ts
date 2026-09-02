import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Same in-memory hook the other main-process tests use. HOME points at a temp
// dir so floe.toml is this test's, not the machine's.
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
    const src = "export const app = { getPath: () => process.env.FLOE_TEST_USERDATA || '/tmp' }; export class BrowserWindow {}; export const ipcMain = { handle(){}, on(){} }; export const dialog = {}; export const shell = {}; export const safeStorage = { isEncryptionAvailable: () => false }; export default {};"
    return { format: 'module', shortCircuit: true, source: src }
  }
  return next(url, context)
}
`
register('data:text/javascript,' + encodeURIComponent(hookSource), import.meta.url)

const home = mkdtempSync(join(tmpdir(), 'floe-turn-'))
process.env.HOME = home
process.env.XDG_CONFIG_HOME = join(home, '.config')
process.env.FLOE_TEST_USERDATA = home
mkdirSync(join(home, '.config', 'floe'), { recursive: true })
writeFileSync(
  join(home, '.config', 'floe', 'floe.toml'),
  [
    '[agent]',
    'model  = "opus"',
    'effort = "medium"',
    '',
    '[harness.codex]',
    'model  = "gpt-5.6-sol"',
    'effort = "xhigh"',
    ''
  ].join('\n')
)

const { routeOf, optionsForRoute } = await import('./turn.ts')

test('a handle is read the same way whichever door the prompt came in', () => {
  assert.deepEqual(routeOf('@codex revisa isso'), {
    harness: 'codex',
    model: undefined,
    effort: undefined,
    prompt: 'revisa isso'
  })
  // Mid-sentence it is a name, not an address — the composer's rule, unchanged.
  assert.equal(routeOf('pergunta pro @codex sobre isso'), null)
  // Every harness Floe can run, not the ones installed: an agent naming one
  // this machine lacks is told so by that harness, not answered by Claude.
  assert.equal(routeOf('@ollama resume')?.harness, 'ollama')
  assert.equal(routeOf('@nobody resume'), null)
})

test('a routed message takes the harness block, then falls back', () => {
  const codex = optionsForRoute({ harness: 'codex', prompt: 'x' })
  assert.equal(codex.provider, 'codex')
  assert.equal(codex.model, 'gpt-5.6-sol')
  assert.equal(codex.effort, 'xhigh')
  // codex has no "ask", so the agent default snaps to what it can do.
  assert.equal(codex.permissionMode, 'skip')

  // What the handle itself names beats the file.
  const named = optionsForRoute({ harness: 'codex', model: 'o3', effort: 'low', prompt: 'x' })
  assert.equal(named.model, 'o3')
  assert.equal(named.effort, 'low')

  // Nothing configured: no model is invented, and Claude alone borrows one.
  assert.equal(optionsForRoute({ harness: 'ollama', prompt: 'x' }).model, '')
  const claude = optionsForRoute({ harness: 'claude', prompt: 'x' })
  assert.equal(claude.provider, 'claude')
  assert.equal(claude.model, 'opus')
  assert.equal(claude.effort, 'medium')
})
