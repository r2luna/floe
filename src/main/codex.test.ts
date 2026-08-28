import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'

// codex.ts now pulls in mcpServer (which imports `electron`) and value imports
// from ../shared/types — neither resolvable by raw Node ESM. Register the same
// hermetic hook mcpServer.test.ts uses (rewrite extensionless `./x` → `./x.ts`,
// stub `electron`) before importing codex, so this pure-function test can load it.
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
register('data:text/javascript,' + encodeURIComponent(hookSource), import.meta.url)

const { nextExchange, MAX_EXCHANGES } = await import('./codex.ts')

// The exchange window: MAX_EXCHANGES real turns, then one capped call that resets
// the window so the next round starts fresh after the user's guidance.
test('nextExchange caps after MAX_EXCHANGES and then resets', () => {
  const state = { step: 0 }
  for (let i = 1; i <= MAX_EXCHANGES; i++) {
    assert.deepEqual(nextExchange(state), { capped: false })
    assert.equal(state.step, i)
  }
  // Window full: next call is capped and does not consume a step.
  assert.deepEqual(nextExchange(state), { capped: true })
  assert.equal(state.step, 0)
  // Fresh round after the cap.
  assert.deepEqual(nextExchange(state), { capped: false })
  assert.equal(state.step, 1)
})
