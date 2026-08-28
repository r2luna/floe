import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { isAbsolute, join, resolve, sep } from 'node:path'
import type { WebContents } from 'electron'
import mysql from 'mysql2/promise'
import pg from 'pg'
import { watch, type FSWatcher } from 'node:fs'
import type { DbCell, DbConfig, DbResult, DbTablesResult } from '../shared/types'
import { userShell } from './commandRunner'
import { readEnvFile } from './provision'
import { isHomePath } from './projects'

// Read-only database viewer, scoped to a worktree. Detects the connection from
// the project's Laravel `.env` (DB_CONNECTION/DB_HOST/…), lists tables, and runs
// a single read-only statement. Mirrors http.ts: pure functions, worktree path
// threaded in, never throws for the caller (errors come back on the result).
//
// Two ways to reach the DB, tried in order: connect directly with an in-process
// driver (mysql2 / pg / better-sqlite3) for clean typed rows, and — when the
// host from .env isn't reachable (e.g. the DB only lives on a Docker network) —
// fall back to running the DB's CLI inside the container via `docker compose
// exec` and parsing its tab-separated output.

// Cap on rows returned to the renderer for a custom query. Opening a table asks
// for LIMIT 100; this only bounds ad-hoc SELECTs.
// ponytail: fetches the full result then slices — no server-side LIMIT injection.
// Add streaming/auto-LIMIT if someone SELECTs a million-row table and it hurts.
const MAX_ROWS = 1000

// Statement must start with one of these to run — the read-only guard. Blocks
// INSERT/UPDATE/DELETE/DDL so the viewer can never mutate a dev database.
const READONLY_START = /^(select|with|show|explain|describe|desc|pragma|table|values)\b/i

// --- config detection -------------------------------------------------------

// Full connection incl. the password, kept main-side and never sent to the
// renderer (DbConfig, the public shape, has no password field).
interface Conn {
  config: DbConfig
  password: string
}

function readConn(worktreePath: string): Conn | null {
  const env = readEnvFile(join(worktreePath, '.env'))
  const conn = (env.DB_CONNECTION || '').toLowerCase()
  const password = env.DB_PASSWORD || ''
  if (conn === 'mysql' || conn === 'mariadb') {
    return {
      config: {
        driver: 'mysql',
        host: env.DB_HOST || '127.0.0.1',
        port: Number(env.DB_PORT) || 3306,
        database: env.DB_DATABASE || '',
        username: env.DB_USERNAME || 'root'
      },
      password
    }
  }
  if (conn === 'pgsql' || conn === 'postgres' || conn === 'postgresql') {
    return {
      config: {
        driver: 'postgres',
        host: env.DB_HOST || '127.0.0.1',
        port: Number(env.DB_PORT) || 5432,
        database: env.DB_DATABASE || '',
        username: env.DB_USERNAME || 'postgres'
      },
      password
    }
  }
  if (conn === 'sqlite') {
    return { config: { driver: 'sqlite', database: env.DB_DATABASE || 'database/database.sqlite' }, password }
  }
  // No/unknown DB_CONNECTION — assume the Laravel 11 default SQLite file if it's there.
  if (!conn && existsSync(join(worktreePath, 'database/database.sqlite'))) {
    return { config: { driver: 'sqlite', database: 'database/database.sqlite' }, password }
  }
  return null
}

// The public connection info for the worktree (no password), or null when the
// worktree has no recognizable DB config.
export function detectDbConfig(worktreePath: string): DbConfig | null {
  return readConn(worktreePath)?.config ?? null
}

// --- read-only guard --------------------------------------------------------

// Throw unless `sql` is a single read-only statement. First keyword must be in
// the allow-list, and a second statement after `;` is rejected (no `SELECT 1;
// DROP TABLE x`).
// ponytail: keyword+single-statement check, not a real SQL parser. A postgres
// data-modifying CTE (`WITH x AS (DELETE …) SELECT …`) would slip past — the pg
// path also opens a read-only transaction as a backstop; upgrade to a parser if
// that's not enough.
export function assertReadOnly(sql: string): void {
  const stripped = sql.replace(/^\s*(?:--[^\n]*\n|\/\*[\s\S]*?\*\/|\s)+/, '').trim()
  const single = stripped.replace(/;\s*$/, '')
  if (single.includes(';')) throw new Error('only a single statement is allowed')
  if (!READONLY_START.test(single)) {
    throw new Error('read-only: only SELECT / WITH / SHOW / EXPLAIN / DESCRIBE / PRAGMA queries are allowed')
  }
}

// --- value + output normalization -------------------------------------------

// Coerce any driver value into something JSON-serializable for the grid.
function toCell(v: unknown): DbCell {
  if (v == null) return null
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') return v
  if (typeof v === 'bigint') return v.toString()
  if (v instanceof Date) return v.toISOString()
  if (Buffer.isBuffer(v)) return `0x${v.subarray(0, 32).toString('hex')}${v.length > 32 ? '…' : ''}`
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

// The SQL that lists user tables, per engine (a plain SELECT/SHOW, so it runs on
// both the direct and the docker path).
function tablesSql(driver: DbConfig['driver']): string {
  if (driver === 'mysql') return 'SHOW TABLES'
  if (driver === 'postgres') {
    return "SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema') ORDER BY tablename"
  }
  return "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
}

// --- direct (in-process driver) ---------------------------------------------

async function runDirect(config: DbConfig, password: string, sql: string): Promise<{ columns: string[]; rows: DbCell[][] }> {
  if (config.driver === 'mysql') {
    const conn = await mysql.createConnection({
      host: config.host,
      port: config.port,
      user: config.username,
      password,
      database: config.database || undefined,
      connectTimeout: 3000
    })
    try {
      const [rows, fields] = await conn.query({ sql, rowsAsArray: true })
      const columns = ((fields as { name: string }[]) ?? []).map((f) => f.name)
      return { columns, rows: (rows as unknown[][]).map((r) => r.map(toCell)) }
    } finally {
      await conn.end().catch(() => {})
    }
  }
  // postgres — open the session read-only as a backstop to the keyword guard.
  const client = new pg.Client({
    host: config.host,
    port: config.port,
    user: config.username,
    password,
    database: config.database || undefined,
    connectionTimeoutMillis: 3000,
    options: '-c default_transaction_read_only=on'
  })
  await client.connect()
  try {
    const res = await client.query({ text: sql, rowMode: 'array' })
    const columns = res.fields.map((f) => f.name)
    return { columns, rows: (res.rows as unknown[][]).map((r) => r.map(toCell)) }
  } finally {
    await client.end().catch(() => {})
  }
}

// Confirm the sqlite path stays inside the worktree, then resolve it (absolute
// paths in DB_DATABASE are honored).
function sqlitePath(worktreePath: string, database: string): string {
  const file = isAbsolute(database) ? database : resolve(worktreePath, database || 'database/database.sqlite')
  if (isAbsolute(database)) return file
  if (file !== worktreePath && !file.startsWith(worktreePath + sep)) {
    throw new Error('refusing to open a sqlite file outside the worktree')
  }
  return file
}

// better-sqlite3 is a native module built for Electron's ABI, so it's imported
// lazily — only when a SQLite DB is actually opened — to keep this module loadable
// under plain Node (the test runner) where that ABI wouldn't match.
async function runSqlite(
  worktreePath: string,
  config: DbConfig,
  sql: string
): Promise<{ columns: string[]; rows: DbCell[][] }> {
  const Database = (await import('better-sqlite3')).default
  const db = new Database(sqlitePath(worktreePath, config.database), { readonly: true, fileMustExist: true })
  try {
    const stmt = db.prepare(sql)
    stmt.raw(true)
    const rows = stmt.all() as unknown[][]
    const columns = stmt.columns().map((c) => c.name)
    return { columns, rows: rows.map((r) => r.map(toCell)) }
  } finally {
    db.close()
  }
}

// --- docker fallback --------------------------------------------------------

// Single-quote a token for the login-shell command line.
const shQuote = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`

// Run a command through the user's login shell (real PATH — docker lives in
// /usr/local/bin etc., which a packaged GUI launch doesn't have) from `cwd`,
// returning stdout. Rejects with stderr on a non-zero exit. 15s cap.
function capture(line: string, cwd: string, env: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(userShell(), ['-lc', line], { cwd, env: { ...process.env, ...env } })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('database command timed out (15s)'))
    }, 15_000)
    child.stdout?.on('data', (d: Buffer) => (out += d.toString()))
    child.stderr?.on('data', (d: Buffer) => (err += d.toString()))
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(out)
      else reject(new Error(err.trim() || `command exited with code ${code ?? 'unknown'}`))
    })
  })
}

// Parse a header + tab-separated rows into columns/rows. mysql --batch and
// `psql -A -F<tab>` both emit this.
// ponytail: naive split — a value containing a real tab or newline breaks a row,
// and NULL vs empty-string is only distinguished for mysql (which prints NULL).
// Good enough for a read-only viewer; the direct path (used whenever the host is
// reachable) has none of this ambiguity.
function parseTsv(out: string): { columns: string[]; rows: DbCell[][] } {
  const lines = out.replace(/\n$/, '').split('\n')
  if (lines.length === 0 || (lines.length === 1 && lines[0] === '')) return { columns: [], rows: [] }
  const columns = lines[0].split('\t')
  const rows = lines
    .slice(1)
    .filter((l) => l !== '')
    .map((l) => l.split('\t').map((v): DbCell => (v === 'NULL' ? null : v)))
  return { columns, rows }
}

// In Docker Compose a service's name IS the hostname other services use, so
// DB_HOST doubles as the `docker compose exec` service.
// ponytail: the password rides in the container env via `-e NAME=value`, which
// puts it in this host's process args (visible to `ps`). Reliable across Docker
// CLI versions (name-only `-e NAME` forwarding isn't) — fine for a dev DB on the
// user's own machine; revisit if that ever isn't the trust model.
async function runDocker(
  worktreePath: string,
  config: DbConfig,
  password: string,
  sql: string
): Promise<{ columns: string[]; rows: DbCell[][] }> {
  const service = config.host || (config.driver === 'mysql' ? 'mysql' : 'db')
  let args: string[]
  if (config.driver === 'mysql') {
    args = ['docker', 'compose', 'exec', '-T', '-e', `MYSQL_PWD=${password}`, service, 'mysql']
    if (config.username) args.push(`-u${config.username}`)
    if (config.database) args.push(config.database)
    args.push('--batch', '--default-character-set=utf8mb4', '-e', sql)
  } else {
    args = ['docker', 'compose', 'exec', '-T', '-e', `PGPASSWORD=${password}`, service, 'psql']
    if (config.username) args.push('-U', config.username)
    if (config.database) args.push('-d', config.database)
    args.push('-A', '-F', '\t', '-P', 'footer=off', '-c', sql)
  }
  return parseTsv(await capture(args.map(shQuote).join(' '), worktreePath, {}))
}

// Connection errors (host unreachable) — the trigger to try the docker fallback.
// A SQL error (bad table, syntax) is NOT one of these, so it surfaces as-is.
function isConnErr(e: unknown): boolean {
  const code = (e as { code?: string })?.code
  if (typeof code === 'string' && /^E(CONNREFUSED|TIMEDOUT|HOSTUNREACH|NETUNREACH|CONNRESET)$|NOTFOUND|EAI_AGAIN/.test(code)) {
    return true
  }
  return /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|getaddrinfo|connect ETIMEDOUT/i.test(String((e as Error)?.message ?? ''))
}

// Run one statement: direct driver first, docker exec if the host is unreachable.
// sqlite is always a local file (no fallback). Returns how it connected (`via`).
async function runSql(
  worktreePath: string,
  conn: Conn,
  sql: string
): Promise<{ columns: string[]; rows: DbCell[][]; via: 'direct' | 'docker' }> {
  const { config, password } = conn
  if (config.driver === 'sqlite') return { ...(await runSqlite(worktreePath, config, sql)), via: 'direct' }
  try {
    return { ...(await runDirect(config, password, sql)), via: 'direct' }
  } catch (e) {
    if (!isConnErr(e)) throw e
    return { ...(await runDocker(worktreePath, config, password, sql)), via: 'docker' }
  }
}

// --- IPC-facing entry points ------------------------------------------------

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

// The connection info + table list for the right-pane panel. Errors (unreachable
// host, auth) come back on `error` with an empty list so the UI can explain them.
export async function dbTables(worktreePath: string): Promise<DbTablesResult> {
  const conn = readConn(worktreePath)
  if (!conn) return { config: null, tables: [] }
  try {
    const { rows, via } = await runSql(worktreePath, conn, tablesSql(conn.config.driver))
    return { config: { ...conn.config, via }, tables: rows.map((r) => ({ name: String(r[0]) })) }
  } catch (e) {
    return { config: conn.config, tables: [], error: message(e) }
  }
}

// Run a read-only query. Never throws — a guard/connection/SQL failure comes
// back on `error`. Rows are capped at `limit` (default MAX_ROWS) with `truncated`.
export async function dbQuery(worktreePath: string, sql: string, limit?: number): Promise<DbResult> {
  const empty = (error?: string): DbResult => ({ columns: [], rows: [], rowCount: 0, duration: 0, error })
  const conn = readConn(worktreePath)
  if (!conn) return empty('no database configured for this worktree')
  try {
    assertReadOnly(sql)
  } catch (e) {
    return empty(message(e))
  }
  const started = Date.now()
  try {
    const { columns, rows } = await runSql(worktreePath, conn, sql)
    const cap = limit ?? MAX_ROWS
    const truncated = rows.length > cap
    return {
      columns,
      rows: truncated ? rows.slice(0, cap) : rows,
      rowCount: rows.length,
      duration: Date.now() - started,
      truncated: truncated || undefined
    }
  } catch (e) {
    return { columns: [], rows: [], rowCount: 0, duration: Date.now() - started, error: message(e) }
  }
}

// One live watcher on the active worktree, retargeted as the user switches, so an
// edited .env (connection changed) or a touched sqlite file refreshes the view.
// Same debounced single-watcher pattern as watchHttp.
let watcher: FSWatcher | null = null
let watchedPath: string | null = null
let debounce: ReturnType<typeof setTimeout> | null = null

export function watchDatabase(wc: WebContents, worktreePath: string): void {
  // Never watch the synthetic Home workspace (see watchHttp) — a recursive watch
  // on the whole home dir stalls the Linux server's event loop.
  if (isHomePath(worktreePath)) return
  if (watchedPath === worktreePath && watcher) return
  watcher?.close()
  watcher = null
  watchedPath = null
  try {
    watcher = watch(worktreePath, { recursive: true }, (_event, filename) => {
      const name = filename?.toString() ?? ''
      if (name !== '.env' && !/\.sqlite3?$|\.db$/.test(name)) return
      if (debounce) clearTimeout(debounce)
      debounce = setTimeout(() => {
        if (!wc.isDestroyed()) wc.send('db:changed', { worktreePath })
      }, 150)
    })
    watchedPath = worktreePath
  } catch {
    watcher = null
    watchedPath = null
  }
}
