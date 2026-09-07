import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import type { BrowserWindow } from 'electron'
import type { McpAuthEvent } from '../shared/types.ts'

// `claude mcp login` runs in a PTY, so the module under test imports node-pty —
// a native addon, and a real login would need the network and a browser. The
// loader serves a scriptable fake instead: every spawn is recorded on
// globalThis, and the test drives its output and exit code by hand.
const ptyStub = `
const state = (globalThis.__ptyStub ??= { spawns: [], fail: false })
export function spawn(file, args, opts) {
  if (state.fail) throw new Error('File not found: ' + file)
  const dataCbs = []
  const exitCbs = []
  const proc = {
    file, args, opts, written: [], killed: false,
    onData: (cb) => dataCbs.push(cb),
    onExit: (cb) => exitCbs.push(cb),
    write: (s) => proc.written.push(s),
    kill: () => { proc.killed = true },
    say: (chunk) => { for (const cb of dataCbs) cb(chunk) },
    quit: (code) => { for (const cb of exitCbs) cb({ exitCode: code, signal: 0 }) }
  }
  state.spawns.push(proc)
  return proc
}
export default { spawn }
`

register(
  'data:text/javascript,' +
    encodeURIComponent(`
export async function resolve(specifier, context, next) {
  if (specifier === 'node-pty') return { url: 'stub:node-pty', shortCircuit: true, format: 'module' }
  return next(specifier, context)
}
export async function load(url, context, next) {
  if (url === 'stub:node-pty') {
    return { format: 'module', shortCircuit: true, source: ${JSON.stringify(ptyStub)} }
  }
  return next(url, context)
}
`),
  import.meta.url
)

const { cancelMcpAuth, findAuthUrl, killAllMcpAuths, pasteMcpAuth, startMcpAuth } = await import('./mcpAuth.ts')

interface FakePty {
  args: string[]
  opts: { cwd: string; cols: number; env: Record<string, string> }
  written: string[]
  killed: boolean
  say(chunk: string): void
  quit(code: number): void
}
const stub = globalThis as unknown as { __ptyStub: { spawns: FakePty[]; fail: boolean } }
const lastSpawn = (): FakePty => stub.__ptyStub.spawns[stub.__ptyStub.spawns.length - 1]

const events: Array<{ serverName: string; worktreePath: string; event: McpAuthEvent }> = []
const win = {
  isDestroyed: () => false,
  webContents: { send: (_channel: string, payload: unknown) => events.push(payload as never) }
} as unknown as BrowserWindow

// A real `claude mcp login <name> --no-browser` PTY chunk: the URL arrives as an
// OSC 8 hyperlink target and again as visible text.
const URL = 'https://slack.com/oauth/v2_user/authorize?response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A3118%2Fcallback'
const OUT = `Visit this URL to authorize:\r\n  \x1b]8;;${URL}\x07${URL}\x1b]8;;\x07\r\n`

after(() => killAllMcpAuths()) // no stray timers or "processes" holding the runner open

test('reads the authorization URL out of the login PTY output', () => {
  assert.equal(findAuthUrl(OUT), URL)
})

test('waits for the whole URL instead of returning a truncated one', () => {
  assert.equal(findAuthUrl(OUT.slice(0, 80)), null)
})

test('ignores output with no URL yet', () => {
  assert.equal(findAuthUrl('Starting authentication for "plugin:slack:slack"…\r\n'), null)
})

test('rejects a non-https scheme', () => {
  assert.equal(findAuthUrl('\x1b]8;;file:///etc/passwd\x07'), null)
})

test('startMcpAuth runs the login in a PTY wide enough not to wrap the URL', () => {
  events.length = 0
  startMcpAuth(win, '/wt/a', 'slack')
  const proc = lastSpawn()
  // --no-browser: Floe opens the URL in its own embedded browser instead.
  assert.deepEqual(proc.args, ['mcp', 'login', 'slack', '--no-browser'])
  assert.equal(proc.opts.cwd, '/wt/a')
  assert.ok(proc.opts.cols >= 1000, 'a hard-wrapped OAuth URL cannot be scraped back')
  assert.equal(proc.opts.env.TERM, 'xterm-256color')

  // Already in progress for this server: a second click must not spawn again.
  const spawned = stub.__ptyStub.spawns.length
  startMcpAuth(win, '/wt/a', 'slack')
  assert.equal(stub.__ptyStub.spawns.length, spawned)
})

test('the URL is emitted once, and only after it has arrived whole', () => {
  proc().say(OUT.slice(0, 80)) // chunk boundary mid-URL
  assert.deepEqual(events, [])
  proc().say(OUT.slice(80))
  assert.deepEqual(events, [{ serverName: 'slack', worktreePath: '/wt/a', event: { kind: 'url', url: URL } }])
  proc().say(OUT) // the CLI prints it again; the renderer must not be sent twice
  assert.equal(events.length, 1)
})

test('a pasted redirect is written back to the waiting CLI, once', () => {
  const redirect = 'http://localhost:3118/callback?code=abc123&state=xyz'
  pasteMcpAuth('/wt/a', 'slack', redirect)
  assert.deepEqual(proc().written, [redirect + '\r'])
  // The CLI prompts once, so a second paste would type into whatever comes next.
  pasteMcpAuth('/wt/a', 'slack', 'http://localhost:3118/callback?code=second')
  assert.equal(proc().written.length, 1)
})

test('exit 0 is the answer: connected, process killed, session forgotten', () => {
  proc().quit(0)
  assert.deepEqual(events[events.length - 1].event, { kind: 'connected' })
  assert.equal(proc().killed, true)
  // Forgotten: a late paste has nothing to write to.
  pasteMcpAuth('/wt/a', 'slack', 'http://localhost:3118/callback?code=late')
  assert.equal(proc().written.length, 1)
})

// The renderer hands over a string the embedded browser was redirected to. It
// reaches a live process's stdin, so anything but a loopback callback carrying an
// OAuth `code` is dropped.
test('pasteMcpAuth drops anything that is not a loopback OAuth callback', () => {
  events.length = 0
  startMcpAuth(win, '/wt/b', 'notion')
  const p = proc()
  for (const bad of [
    'not a url at all',
    'file:///etc/passwd?code=1',
    'javascript:alert(1)?code=1',
    'https://evil.example/callback?code=1', // right shape, wrong host
    'http://localhost:3118/callback', // loopback, but no code
    'http://localhost.evil.example/callback?code=1'
  ]) {
    pasteMcpAuth('/wt/b', 'notion', bad)
  }
  // Not deepEqual: it narrows `written` to never[] for the rest of this block.
  assert.equal(p.written.length, 0, 'nothing may reach the CLI stdin')

  // 127.0.0.1 is the same callback as localhost, and the URL is written back
  // parsed — never the raw input, which could type extra lines into the CLI.
  pasteMcpAuth('/wt/b', 'notion', 'http://127.0.0.1:3118/cb?code=abc\r\nwhoami')
  assert.equal(p.written.length, 1)
  const line = p.written[0]
  assert.equal(line.endsWith('\r'), true)
  assert.equal(/[\r\n]/.test(line.slice(0, -1)), false, 'no smuggled newline')

  // An auth nobody is waiting for is a no-op, not a throw.
  pasteMcpAuth('/wt/b', 'nothing-here', 'http://localhost:3118/cb?code=abc')
})

test('a non-zero exit reports the CLI’s own last line, ANSI stripped', () => {
  events.length = 0
  startMcpAuth(win, '/wt/c', 'github')
  proc().say('\x1b]8;;https://x.test/a\x07link\x1b]8;;\x07\r\n\x1b[31mAuthentication failed: invalid_grant\x1b[0m\r\n\r\n')
  proc().quit(1)
  assert.deepEqual(events[events.length - 1].event, {
    kind: 'error',
    message: 'Authentication failed: invalid_grant'
  })
})

test('an exit with nothing to quote still names the exit code', () => {
  events.length = 0
  startMcpAuth(win, '/wt/d', 'linear')
  proc().quit(7)
  assert.deepEqual(events[events.length - 1].event, {
    kind: 'error',
    message: 'claude mcp login exited 7'
  })
})

test('cancelMcpAuth kills the login and says nothing to the renderer', () => {
  events.length = 0
  startMcpAuth(win, '/wt/e', 'jira')
  const p = proc()
  cancelMcpAuth('/wt/e', 'jira')
  assert.equal(p.killed, true)
  assert.deepEqual(events, [])
  cancelMcpAuth('/wt/e', 'jira') // idempotent
  // Cancelled means gone: a fresh attempt for the same server can start.
  const spawned = stub.__ptyStub.spawns.length
  startMcpAuth(win, '/wt/e', 'jira')
  assert.equal(stub.__ptyStub.spawns.length, spawned + 1)
  cancelMcpAuth('/wt/e', 'jira')
})

test('a login that cannot even be spawned is reported, not swallowed', () => {
  events.length = 0
  stub.__ptyStub.fail = true
  try {
    startMcpAuth(win, '/wt/f', 'slack')
  } finally {
    stub.__ptyStub.fail = false
  }
  assert.equal(events.length, 1)
  assert.equal(events[0].event.kind, 'error')
  // Nothing was registered, so a retry is allowed straight away.
  startMcpAuth(win, '/wt/f', 'slack')
  assert.equal(proc().args[3], '--no-browser')
  cancelMcpAuth('/wt/f', 'slack')
})

function proc(): FakePty {
  return lastSpawn()
}
