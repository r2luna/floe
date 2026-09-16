import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { register } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// support.ts reaches ./compose for the domain, and main-process modules import
// each other without extensions. Same rewrite hook the other main tests use.
register(
  'data:text/javascript,' +
    encodeURIComponent(`
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
export async function resolve(specifier, context, next) {
  if (specifier === 'node:child_process' && /\\/(support|caddy)\\.ts$/.test(String(context.parentURL)))
    return { url: 'stub:child_process', shortCircuit: true, format: 'module' }
  if (specifier.startsWith('./') && !/\\.[a-z]+$/i.test(specifier) && context.parentURL) {
    const tsPath = fileURLToPath(new URL(specifier, context.parentURL)) + '.ts'
    if (existsSync(tsPath)) return next(specifier + '.ts', context)
  }
  return next(specifier, context)
}
export async function load(url, context, next) {
  if (url === 'stub:child_process')
    return {
      format: 'module',
      shortCircuit: true,
      source:
        "export const spawnSync = () => ({ stdout: '' })\\n" +
        "export const execFile = (cmd, args, opts, cb) => {\\n" +
        "  if (!String(cmd).endsWith('docker')) return cb(null, '', '')\\n" +
        "  globalThis.__dockerCalls.push(args)\\n" +
        "  const plan = globalThis.__dockerPlan\\n" +
        "  plan ? cb(Object.assign(new Error('boom'), {}), '', plan) : cb(null, 'compose-said-this', '')\\n" +
        "}"
    }
  return next(url, context)
}
`),
  import.meta.url
)

declare global {
  var __dockerCalls: string[][]
  var __dockerPlan: string | null
}
globalThis.__dockerCalls = []
globalThis.__dockerPlan = null

// Both support.ts and the compose.ts it reads resolve their paths off homedir()
// at module load, so HOME has to be throwaway before the import — otherwise
// ensureSupportFiles would write into the developer's real ~/.floe.
const home = mkdtempSync(join(tmpdir(), 'floe-support-home-'))
process.env.HOME = home

const {
  DBGATE_PORT,
  SUPPORT_PROJECT,
  ensureSupportFiles,
  supportComposePath,
  supportComposeYaml,
  supportEnvExample,
  supportEnvPath,
  supportStack
} = await import('./support.ts')

test('the stack is one compose project holding all four shared services', () => {
  const yaml = supportComposeYaml()
  assert.match(yaml, new RegExp(`^name: ${SUPPORT_PROJECT}$`, 'm'))
  for (const service of ['mysql:', 'postgres:', 'dbgate:', 'redis:'])
    assert.match(yaml, new RegExp(`^  ${service}$`, 'm'))
})

// The per-worktree compose files join `floe` with `external: true`; if this
// stack named its network anything else, every worktree app would fail to come
// up with "network floe declared as external, but could not be found".
test('it owns the `floe` network the per-worktree compose files join', () => {
  assert.match(supportComposeYaml(), /^networks:\n {2}floe:\n {4}name: floe$/m)
})

// Every published port is the host Caddy's business alone. A bare "3306:3306"
// would put the shared database on the machine's public interface.
test('nothing is published beyond loopback', () => {
  const published = supportComposeYaml().match(/^ +- "(.+:)?\d+:\d+"$/gm) ?? []
  assert.ok(published.length >= 4, `expected published ports, found ${published.length}`)
  for (const line of published) assert.match(line, /"127\.0\.0\.1:/, `${line.trim()} is not loopback-bound`)
})

test('DBGate is published where the Caddy route expects it', () => {
  assert.match(supportComposeYaml(), new RegExp(`"127\\.0\\.0\\.1:${DBGATE_PORT}:3000"`))
})

// The passwords live in support.env and are interpolated by `docker compose
// --env-file`. Writing them into the compose file would copy the machine's DB
// credentials into a file that gets rewritten on every `up`.
test('credentials stay as env references, never inlined', () => {
  const yaml = supportComposeYaml()
  assert.match(yaml, /MYSQL_ROOT_PASSWORD: \$\{MYSQL_ROOT_PASSWORD\}/)
  assert.match(yaml, /POSTGRES_PASSWORD: \$\{POSTGRES_PASSWORD\}/)
})

test('first run seeds the env file, private, and reports that it did', () => {
  const first = ensureSupportFiles()
  assert.equal(first.seeded, true)
  assert.ok(existsSync(supportComposePath()))
  assert.equal(readFileSync(supportEnvPath(), 'utf8'), supportEnvExample())
  assert.equal(statSync(supportEnvPath()).mode & 0o777, 0o600)
})

// `up` rewrites the compose file every time (it may have changed with a Floe
// release) but must never touch the env file — that is the machine's own config.
test('a second run rewrites the compose file and leaves the env alone', () => {
  writeFileSync(supportEnvPath(), 'DOMAIN=mine.example\n')
  writeFileSync(supportComposePath(), 'stale\n')
  const second = ensureSupportFiles()
  assert.equal(second.seeded, false)
  assert.equal(readFileSync(supportComposePath(), 'utf8'), supportComposeYaml())
  assert.equal(readFileSync(supportEnvPath(), 'utf8'), 'DOMAIN=mine.example\n')
})

// ── the one entry point ⌘K and the MCP tool share ────────────────────────────
// The palette command, the `support_stack` tool and this function are the same
// dispatch; if they diverged, an agent and the user would be driving different
// code against the machine's shared databases.

const lastDockerArgs = (): string[] => globalThis.__dockerCalls.at(-1) ?? []

test('supportStack up brings the stack up and reports where it listens', async () => {
  // The env file already exists from the seeding test above, so `up` proceeds.
  const out = await supportStack('up')
  assert.deepEqual(lastDockerArgs().slice(-2), ['up', '-d'])
  assert.match(out, /Support stack up/)
  assert.match(out, /mysql: +127\.0\.0\.1:3306/)
})

test('supportStack down takes it down', async () => {
  assert.match(await supportStack('down'), /Support stack down/)
  assert.deepEqual(lastDockerArgs().slice(-1), ['down'])
})

test('supportStack logs tails the compose logs', async () => {
  await supportStack('logs')
  assert.deepEqual(lastDockerArgs().slice(-2), ['logs', '--tail=100'])
})

// Anything unrecognised — including the palette's default and a bad agent
// argument — reads state rather than changing it.
test('supportStack defaults to status, never to an action', async () => {
  for (const action of [undefined, 'status', 'restart', 42]) {
    await supportStack(action)
    assert.deepEqual(lastDockerArgs().slice(-1), ['ps'], `${String(action)} did not read status`)
  }
})

// This answer goes straight into the palette line and the tool result, so a
// failure has to come back as text — a rejection would surface as an unhandled
// IPC error with nothing shown to the user.
test('supportStack returns docker failures as text, never throws', async () => {
  globalThis.__dockerPlan = 'Cannot connect to the Docker daemon'
  try {
    assert.match(await supportStack('status'), /Cannot connect to the Docker daemon/)
  } finally {
    globalThis.__dockerPlan = null
  }
})

// docker missing entirely is the common first-run case on a fresh machine, and
// execFile reports it as a bare ENOENT that says nothing about what to install.
test('a missing docker binary is named as such', async () => {
  globalThis.__dockerPlan = 'spawn docker ENOENT'
  try {
    assert.match(await supportStack('status'), /docker not found on this machine/)
  } finally {
    globalThis.__dockerPlan = null
  }
})

// ── the DBGate URL must not be a promise nobody kept ─────────────────────────
// DBGate publishes a loopback port only; `db.dev.<domain>` resolves because we
// write the Caddy route for it. Announcing the hostname without creating the
// route pointed the user at something that never answered.

test('off the server, up reports the loopback address it actually published', async () => {
  delete process.env.FLOE_IS_SERVER
  const out = await supportStack('up')
  assert.match(out, new RegExp(`db: +http://127\\.0\\.0\\.1:${DBGATE_PORT}`))
  assert.doesNotMatch(out, /https:\/\/db\.dev\./)
})

test('on the server, up writes the db route and then names it', async () => {
  process.env.FLOE_IS_SERVER = '1'
  try {
    assert.match(await supportStack('up'), /db: +https:\/\/db\.dev\./)
  } finally {
    delete process.env.FLOE_IS_SERVER
  }
})

// The palette exposes logs as its own command, so it is reachable on a machine
// that has never run `up` — where docker answers "couldn't find env file: …".
test('logs on a machine that never ran up explains itself', async () => {
  // The tests above already generated the compose file; this is the fresh-machine
  // state, where nothing under ~/.floe/support exists yet.
  rmSync(supportComposePath(), { force: true })
  const seen = globalThis.__dockerCalls.length
  assert.match(await supportStack('logs'), /never brought up/)
  assert.equal(globalThis.__dockerCalls.length, seen, 'shelled out to docker anyway')
})
