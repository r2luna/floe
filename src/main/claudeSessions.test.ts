import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// claudeSessions.ts uses extensionless relative imports (./plans, ./sessionStore,
// …) — resolved by electron-vite at build time, not by raw Node ESM. Register the
// same in-memory hook the other main-process tests use to rewrite `./x` → `./x.ts`
// before importing the module. (No electron in this graph, so no stub needed.)
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
    const src = "export const app = { getPath: () => '/tmp' }; export class BrowserWindow {}; export const ipcMain = { handle(){}, on(){} }; export default {};"
    return { format: 'module', shortCircuit: true, source: src }
  }
  return next(url, context)
}
`
const hookUrl = 'data:text/javascript,' + encodeURIComponent(hookSource)
register(hookUrl, import.meta.url)

const { generateWorktreeDesc } = await import('./claudeSessions.ts')

// The regen guard: when a `.gw-desc` marker is newer than the spec it summarises,
// generateWorktreeDesc must short-circuit to null *before* shelling out to claude.
// This is what stops every sidebar refresh from spawning a Haiku process (and any
// regen loop). We prove it without the claude binary: a stale-spec/fresh-marker
// worktree returns null, and it returns fast (no 20s CLI timeout).
test('generateWorktreeDesc: fresh marker skips regeneration (no claude call)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rookery-desc-'))
  try {
    const specDir = join(root, 'specs', 'feat-x')
    mkdirSync(specDir, { recursive: true })
    const spec = join(specDir, 'spec.md')
    writeFileSync(spec, '# Feature\nDoes a thing.\n')
    const marker = join(root, '.gw-desc')
    writeFileSync(marker, 'Existing description.\n')
    // Marker 10s newer than the spec → the gate sees it as fresh.
    const old = Date.now() / 1000 - 100
    utimesSync(spec, old, old)
    utimesSync(marker, old + 10, old + 10)

    const started = Date.now()
    const result = await generateWorktreeDesc(root, 'feat-x')
    assert.equal(result, null)
    // Well under the 20s CLI timeout — proves it never spawned claude.
    assert.ok(Date.now() - started < 2000)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// No spec folder at all → null (nothing to summarise), also without a claude call.
test('generateWorktreeDesc: no spec returns null', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rookery-desc-'))
  try {
    const result = await generateWorktreeDesc(root, 'feat-x')
    assert.equal(result, null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
