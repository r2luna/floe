import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// database.ts imports ./provision, ./projects, ./commandRunner — whose graphs use
// extensionless relative imports and touch `electron`. Register the same in-memory
// hook the other main tests use: rewrite `./x` → `./x.ts` and stub `electron`.
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

const { assertReadOnly, detectDbConfig } = await import('./database.ts')

test('assertReadOnly allows read-only statements', () => {
  for (const sql of [
    'SELECT * FROM users',
    '  select 1',
    'WITH x AS (SELECT 1) SELECT * FROM x',
    'SHOW TABLES',
    'EXPLAIN SELECT 1',
    'DESCRIBE users',
    'PRAGMA table_info(users)',
    'SELECT * FROM users;' // single trailing semicolon is fine
  ]) {
    assert.doesNotThrow(() => assertReadOnly(sql), sql)
  }
})

test('assertReadOnly rejects writes, DDL, and stacked statements', () => {
  for (const sql of [
    'INSERT INTO users (name) VALUES ("x")',
    'UPDATE users SET name = "x"',
    'DELETE FROM users',
    'DROP TABLE users',
    'TRUNCATE users',
    'SELECT 1; DROP TABLE users', // stacked — the classic injection
    'select * from t; delete from t'
  ]) {
    assert.throws(() => assertReadOnly(sql), sql)
  }
})

test('detectDbConfig reads the connection from .env (no password leaks out)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rk-db-'))
  try {
    writeFileSync(
      join(dir, '.env'),
      'DB_CONNECTION=mysql\nDB_HOST=127.0.0.1\nDB_PORT=3307\nDB_DATABASE=app\nDB_USERNAME=root\nDB_PASSWORD=secret\n'
    )
    const cfg = detectDbConfig(dir)
    assert.deepEqual(cfg, { driver: 'mysql', host: '127.0.0.1', port: 3307, database: 'app', username: 'root' })
    assert.equal(JSON.stringify(cfg).includes('secret'), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('detectDbConfig maps pgsql and defaults, and returns null when unset', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rk-db-'))
  try {
    writeFileSync(join(dir, '.env'), 'DB_CONNECTION=pgsql\nDB_DATABASE=app\n')
    assert.deepEqual(detectDbConfig(dir), {
      driver: 'postgres',
      host: '127.0.0.1',
      port: 5432,
      database: 'app',
      username: 'postgres'
    })

    writeFileSync(join(dir, '.env'), 'APP_NAME=x\n') // no DB_CONNECTION, no sqlite file
    assert.equal(detectDbConfig(dir), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
