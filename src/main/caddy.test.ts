import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { register } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// caddy.ts shells out (`caddy reload`, `pgrep`) and writes into ~/.config/caddy.
// HOME points at a tmpdir so the route files are real but throwaway, and
// node:child_process is stubbed so no reload is ever attempted. compose.ts is
// reached for the bind IP, so support.env has to exist before the import.
const home = mkdtempSync(join(tmpdir(), 'floe-caddy-home-'))
process.env.HOME = home
mkdirSync(join(home, '.floe'), { recursive: true })
writeFileSync(join(home, '.floe', 'support.env'), 'DOMAIN=test.example\nEDGE_BIND=100.64.0.1\n')

register(
  'data:text/javascript,' +
    encodeURIComponent(`
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
export async function resolve(specifier, context, next) {
  if (specifier === 'node:child_process' && String(context.parentURL).includes('caddy.ts'))
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
        "export const execFile = (cmd, args, opts, cb) => { globalThis.__caddyReloads.push({ cmd, args, env: opts?.env }); cb(null, '', '') }"
    }
  return next(url, context)
}
`),
  import.meta.url
)

declare global {
  var __caddyReloads: Array<{ cmd: string; args: string[]; env?: Record<string, string> }>
}
globalThis.__caddyReloads = []
process.env.FLOE_IS_SERVER = '1'

const { caddyBin, edgeIsOurs, removeWorktreeRoute, routeBlock, writeWorktreeRoute } = await import('./caddy.ts')

const routeFile = (host: string): string => join(home, '.config', 'caddy', 'sites', `${host}.caddy`)

// The host Caddy already owns :443 on the Tailscale IP for the main site. A route
// that omits the bind, or binds something else, makes Caddy fight itself for the
// port and the whole reload fails — taking every other site down with it.
test('a route binds the edge IP from support.env', () => {
  assert.match(routeBlock('x.dev.test.example', 42123, '100.64.0.1'), /^\tbind 100\.64\.0\.1$/m)
})

test('a route reverse-proxies to the loopback port the container publishes', () => {
  assert.match(routeBlock('x.dev.test.example', 42123, '100.64.0.1'), /reverse_proxy 127\.0\.0\.1:42123/)
})

test('writing a route creates the sites file and reloads Caddy', async () => {
  await writeWorktreeRoute('feature-x.dev.test.example', 42123)
  const written = readFileSync(routeFile('feature-x.dev.test.example'), 'utf8')
  assert.match(written, /^feature-x\.dev\.test\.example \{$/m)
  assert.match(written, /^\tbind 100\.64\.0\.1$/m)
  assert.deepEqual(globalThis.__caddyReloads.at(-1)?.args.slice(0, 1), ['reload'])
})

// Re-provisioning and reopening a worktree both write the route again; the
// second write must land on the same file rather than accumulate stale blocks.
test('writing the same route twice is idempotent', async () => {
  const before = readFileSync(routeFile('feature-x.dev.test.example'), 'utf8')
  await writeWorktreeRoute('feature-x.dev.test.example', 42123)
  assert.equal(readFileSync(routeFile('feature-x.dev.test.example'), 'utf8'), before)
})

test('removing a route deletes the file and reloads', async () => {
  await removeWorktreeRoute('feature-x.dev.test.example')
  assert.equal(existsSync(routeFile('feature-x.dev.test.example')), false)
  assert.deepEqual(globalThis.__caddyReloads.at(-1)?.args.slice(0, 1), ['reload'])
})

// Teardown runs for host-native worktrees too, and for containers torn down
// after a route was already removed by hand. Neither may fail the teardown.
test('removing a route that was never written does nothing, and does not reload', async () => {
  const reloads = globalThis.__caddyReloads.length
  await removeWorktreeRoute('never-existed.dev.test.example')
  assert.equal(globalThis.__caddyReloads.length, reloads)
})

// Caddy is a user-local install on the server (~/.local/bin/caddy), which is not
// on the PATH a systemd unit inherits. Resolving the bare name there would
// ENOENT on every reload and routes would never publish.
test('the caddy binary falls back to the bare name when nothing is running', () => {
  assert.equal(caddyBin(), 'caddy')
})

// ── the desktop must never touch Caddy ───────────────────────────────────────
// Container mode is opt-in on the desktop too (Project.env.mode: 'container'),
// and a desktop has no host Caddy. Before this gate, provisioning such a
// worktree died at "Start app container" — the reload rejected — and the user
// never reached composer install or migrations.

test('off the server, writing a route does nothing and reports it did nothing', async () => {
  delete process.env.FLOE_IS_SERVER
  try {
    const reloads = globalThis.__caddyReloads.length
    assert.equal(edgeIsOurs(), false)
    assert.equal(await writeWorktreeRoute('desktop.dev.test.example', 42999), false)
    assert.equal(existsSync(routeFile('desktop.dev.test.example')), false)
    assert.equal(globalThis.__caddyReloads.length, reloads, 'reloaded Caddy on a desktop')
  } finally {
    process.env.FLOE_IS_SERVER = '1'
  }
})

// Teardown runs on the desktop too, and must not reload a Caddy that isn't there.
test('off the server, removing a route does nothing', async () => {
  await writeWorktreeRoute('teardown.dev.test.example', 42998)
  delete process.env.FLOE_IS_SERVER
  try {
    const reloads = globalThis.__caddyReloads.length
    assert.equal(await removeWorktreeRoute('teardown.dev.test.example'), false)
    assert.equal(globalThis.__caddyReloads.length, reloads)
  } finally {
    process.env.FLOE_IS_SERVER = '1'
  }
})

test('on the server, a written route reports true and a missing one false', async () => {
  assert.equal(await writeWorktreeRoute('reported.dev.test.example', 42997), true)
  assert.equal(await removeWorktreeRoute('reported.dev.test.example'), true)
  assert.equal(await removeWorktreeRoute('reported.dev.test.example'), false)
})

// ── the Cloudflare token ─────────────────────────────────────────────────────
// `caddy reload` runs in a fresh process and resolves {env.CF_API_TOKEN} against
// ITS environment. The token is normally recovered from the running Caddy's
// /proc entry — which misses on a non-Linux box, or when pgrep finds nothing.

test('a missed /proc lookup keeps the token this process was given', async () => {
  process.env.CF_API_TOKEN = 'from-the-environment'
  try {
    await writeWorktreeRoute('token.dev.test.example', 42996)
    assert.equal(globalThis.__caddyReloads.at(-1)?.env?.CF_API_TOKEN, 'from-the-environment')
  } finally {
    delete process.env.CF_API_TOKEN
  }
})

// An empty value is not neutral: the cloudflare module rejects it outright, so
// writing "" over a good token turns a missed lookup into a failed reload — and
// every route on the box stops being served.
test('the token is never blanked out', async () => {
  delete process.env.CF_API_TOKEN
  await writeWorktreeRoute('token.dev.test.example', 42996)
  assert.equal(globalThis.__caddyReloads.at(-1)?.env?.CF_API_TOKEN, '')
})
