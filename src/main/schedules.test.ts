import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// schedules.ts pulls in projects.ts (a runtime `electron` import) via extensionless
// relative imports — neither raw Node ESM resolves. Same in-memory hook as
// git.test.ts: rewrite `./x` -> `./x.ts`, stub `electron`.
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
      'export const dialog = {};',
      'export const ipcMain = { handle(){}, on(){} };',
      'export default {};'
    ].join('\\n')
    return { format: 'module', shortCircuit: true, source: src }
  }
  return next(url, context)
}
`
register('data:text/javascript,' + encodeURIComponent(hookSource), import.meta.url)
void existsSync
void fileURLToPath
void pathToFileURL

const { assertValidCron, matchesCron, createSchedule, readSchedules, updateSchedule, deleteSchedule } = await import(
  './schedules.ts'
)

test('matchesCron: "* * * * *" always matches', () => {
  assert.equal(matchesCron('* * * * *', new Date(2026, 0, 1, 13, 37)), true)
})

test('matchesCron: exact hour/minute only matches that minute', () => {
  assert.equal(matchesCron('0 3 * * *', new Date(2026, 0, 1, 3, 0)), true)
  assert.equal(matchesCron('0 3 * * *', new Date(2026, 0, 1, 3, 1)), false)
  assert.equal(matchesCron('0 3 * * *', new Date(2026, 0, 1, 4, 0)), false)
})

test('matchesCron: step values match every Nth unit', () => {
  for (const minute of [0, 15, 30, 45]) {
    assert.equal(matchesCron('*/15 * * * *', new Date(2026, 0, 1, 0, minute)), true, `minute ${minute} should match`)
  }
  for (const minute of [1, 14, 16, 44, 59]) {
    assert.equal(matchesCron('*/15 * * * *', new Date(2026, 0, 1, 0, minute)), false, `minute ${minute} should not match`)
  }
})

test('matchesCron: ranges and lists', () => {
  assert.equal(matchesCron('0 9-17 * * 1-5', new Date(2026, 0, 5, 12, 0)), true) // Monday
  assert.equal(matchesCron('0 9-17 * * 1-5', new Date(2026, 0, 4, 12, 0)), false) // Sunday
  assert.equal(matchesCron('0 9,13 * * *', new Date(2026, 0, 1, 13, 0)), true)
  assert.equal(matchesCron('0 9,13 * * *', new Date(2026, 0, 1, 11, 0)), false)
})

test('assertValidCron: rejects malformed expressions', () => {
  assert.throws(() => assertValidCron('* * * *')) // only 4 fields
  assert.throws(() => assertValidCron('60 * * * *')) // minute out of range
  assert.throws(() => assertValidCron('* * * * 8')) // dow out of range
  assert.throws(() => assertValidCron('*/0 * * * *')) // zero step
  assert.throws(() => assertValidCron('a-b * * * *')) // non-numeric range
  assert.doesNotThrow(() => assertValidCron('*/15 9-17 1,15 * 1-5'))
})

test('createSchedule/readSchedules/updateSchedule/deleteSchedule round-trip on disk', () => {
  const root = mkdtempSync(join(tmpdir(), 'floe-schedules-'))
  try {
    assert.deepEqual(readSchedules(root), [])

    const created = createSchedule(root, { name: 'Nightly', cron: '0 3 * * *', prompt: '/deploy patch' })
    assert.equal(created.enabled, true)
    assert.equal(readSchedules(root).length, 1)

    assert.throws(() => createSchedule(root, { name: 'Bad', cron: 'nope', prompt: 'x' }))

    const updated = updateSchedule(root, created.id, { prompt: '/deploy minor' })
    assert.equal(updated.prompt, '/deploy minor')
    assert.equal(updated.name, 'Nightly') // untouched fields survive the patch
    assert.equal(updated.cron, '0 3 * * *')

    deleteSchedule(root, created.id)
    assert.deepEqual(readSchedules(root), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
