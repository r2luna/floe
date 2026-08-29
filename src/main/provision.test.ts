import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// provision.ts imports ./devServer, ./commands, ./commandRunner, ./projects —
// whose graphs use extensionless relative imports and touch `electron`. Same in-memory hook the other main tests use: rewrite `./x` →
// `./x.ts` and stub `electron`.
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
    return { format: 'module', shortCircuit: true, source: "export const app = { getPath: () => '/tmp' }; export const dialog = {}; export default {};" }
  }
  return next(url, context)
}
`
register('data:text/javascript,' + encodeURIComponent(hookSource), import.meta.url)

const { getAppUrl } = await import('./provision.ts')

test('getAppUrl reads APP_URL from the worktree .env', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rk-appurl-'))
  try {
    writeFileSync(join(dir, '.env'), 'APP_NAME=Test\nAPP_URL=https://foo.dev.pinguim.io\nDB_CONNECTION=mysql\n')
    assert.equal(getAppUrl(dir), 'https://foo.dev.pinguim.io')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('getAppUrl returns null when APP_URL is unset or .env is missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rk-appurl-'))
  try {
    writeFileSync(join(dir, '.env'), 'APP_NAME=Test\n')
    assert.equal(getAppUrl(dir), null)
    assert.equal(getAppUrl(join(dir, 'nope')), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
