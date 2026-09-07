import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SupportConfig } from './compose.ts'

// support.env's path is resolved off homedir() at module load, so HOME has to
// point somewhere throwaway before the import — otherwise readSupportConfig
// reads the developer's real ~/.floe.
const home = mkdtempSync(join(tmpdir(), 'floe-home-'))
process.env.HOME = home

const { readSupportConfig, worktreeDockerfile, worktreePort, worktreeViteConfig } = await import('./compose.ts')

const cfg: SupportConfig = {
  domain: 'pinguim.io',
  mysqlRootPassword: 'x',
  postgresPassword: 'x',
  edgeBind: '127.0.0.1'
}

test('worktreePort is deterministic for a slug', () => {
  assert.equal(worktreePort('feature-x'), worktreePort('feature-x'))
})

test('worktreePort stays in the loopback window [42000, 42999]', () => {
  for (const s of ['a', 'feature/login', 'very-long-branch-name-here', '', 'x'.repeat(200)]) {
    const p = worktreePort(s.replace(/\//g, '-'))
    assert.ok(p >= 42000 && p <= 42999, `${s} -> ${p} out of range`)
  }
})

test('worktreePort separates distinct slugs (no trivial constant)', () => {
  assert.notEqual(worktreePort('alpha'), worktreePort('beta'))
})

// The whole point of the nginx layer is that PHP receives HTTPS=on for a request
// Caddy forwarded as https. Assert the two halves that make that work: the map
// exists, and the fastcgi_params substitution is guarded by a grep that fails the
// build if serversideup ever changes the stock line.
test('Dockerfile maps X-Forwarded-Proto onto the HTTPS fastcgi param', () => {
  const df = worktreeDockerfile()
  assert.match(df, /map \$http_x_forwarded_proto \$floe_https/)
  assert.match(df, /'    https   on;'/)
  assert.match(df, /grep -q 'HTTPS {14}\$https if_not_empty' \/etc\/nginx\/fastcgi_params/)
  assert.match(df, /sed -i .*HTTPS {14}\$floe_https if_not_empty.* \/etc\/nginx\/fastcgi_params/)
})

test('Dockerfile keeps $https as the map default so real TLS still works', () => {
  assert.match(worktreeDockerfile(), /'    default \$https;'/)
})

// The layer must run before the image drops back to www-data.
test('Dockerfile applies the nginx layer while still root', () => {
  const df = worktreeDockerfile()
  assert.ok(df.indexOf('00-floe-forwarded-proto.conf') < df.indexOf('USER www-data'))
})

test('vite wrapper binds the container and points HMR at the Caddy vite host', () => {
  const out = worktreeViteConfig('feat-x', 'https://feat-x.dev.pinguim.io', cfg, 'vite.config.js')
  assert.match(out, /import base from '\.\.\/vite\.config\.js'/)
  assert.match(out, /host: '0\.0\.0\.0'/)
  assert.match(out, /origin: 'https:\/\/feat-x-vite\.dev\.pinguim\.io'/)
  assert.match(out, /allowedHosts: \['feat-x-vite\.dev\.pinguim\.io'\]/)
  // CORS must name the APP origin, not the dev-server one — see the comment in
  // worktreeViteConfig for why setting `origin` makes this mandatory.
  assert.match(out, /cors: \{ origin: 'https:\/\/feat-x\.dev\.pinguim\.io' \}/)
  assert.match(out, /hmr: \{ host: 'feat-x-vite\.dev\.pinguim\.io', protocol: 'wss', clientPort: 443 \}/)
})

test('vite wrapper still produces a config when the project has none', () => {
  const out = worktreeViteConfig('feat-x', 'https://feat-x.dev.pinguim.io', cfg, null)
  assert.doesNotMatch(out, /^import base/m)
  assert.match(out, /const base = \{\}/)
})

test('vite wrapper overrides the project server block rather than being overridden', () => {
  const out = worktreeViteConfig('feat-x', 'https://feat-x.dev.pinguim.io', cfg, 'vite.config.ts')
  // Spread order decides the fix: Floe's `server` must come last.
  assert.match(out, /server: \{ \.\.\.resolved\?\.server, \.\.\.server \}/)
})

// Runs before the file below is written: no support.env is the normal state on a
// dev machine that has never run `floe server support up`.
test('readSupportConfig falls back to the shipped defaults when support.env is absent', () => {
  assert.deepEqual(readSupportConfig(), {
    domain: 'pinguim.io',
    mysqlRootPassword: 'floe',
    postgresPassword: 'floe',
    edgeBind: '100.72.153.33'
  })
})

test('readSupportConfig reads support.env, unquoting and ignoring non-assignments', () => {
  mkdirSync(join(home, '.floe'), { recursive: true })
  writeFileSync(
    join(home, '.floe', 'support.env'),
    [
      '# written by `floe server support up`',
      'DOMAIN="example.test"',
      'MYSQL_ROOT_PASSWORD=s3cret  ',
      "POSTGRES_PASSWORD='pg-pass'",
      'EDGE_BIND=100.64.0.1',
      'not an assignment at all',
      ''
    ].join('\n')
  )
  assert.deepEqual(readSupportConfig(), {
    domain: 'example.test',
    mysqlRootPassword: 's3cret',
    postgresPassword: 'pg-pass',
    edgeBind: '100.64.0.1'
  })
})

test('a support.env missing a key keeps that one default rather than blanking it', () => {
  mkdirSync(join(home, '.floe'), { recursive: true })
  writeFileSync(join(home, '.floe', 'support.env'), 'DOMAIN=only.test\n')
  const cfg = readSupportConfig()
  assert.equal(cfg.domain, 'only.test')
  assert.equal(cfg.mysqlRootPassword, 'floe')
  assert.equal(cfg.edgeBind, '100.72.153.33')
})
