import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import type { BrowserWindow } from 'electron'
import type { ClaudeAuthEvent } from '../shared/types'

// `claude auth login` only runs in a PTY, so node-pty is swapped for a fake the
// test drives by hand: no real terminal, no real CLI, no 5-minute timer left
// behind. Same register-then-dynamic-import shape as appSettings.test.ts.
const hookSource = `
export async function resolve(specifier, context, next) {
  if (specifier === 'node-pty') return { url: 'stub:node-pty', shortCircuit: true, format: 'module' }
  return next(specifier, context)
}
export async function load(url, context, next) {
  if (url === 'stub:node-pty')
    return {
      format: 'module',
      shortCircuit: true,
      source: 'export const spawn = (...a) => globalThis.__floePtySpawn(...a)'
    }
  return next(url, context)
}
`
register('data:text/javascript,' + encodeURIComponent(hookSource), import.meta.url)

class FakePty {
  written: string[] = []
  kills = 0
  onDataCb: (data: string) => void = () => {}
  onExitCb: (e: { exitCode: number }) => void = () => {}
  onData(cb: (data: string) => void): void {
    this.onDataCb = cb
  }
  onExit(cb: (e: { exitCode: number }) => void): void {
    this.onExitCb = cb
  }
  write(s: string): void {
    this.written.push(s)
  }
  kill(): void {
    this.kills++
  }
}

let ptyProc: FakePty
let ptyArgs: string[] = []
let ptyCwd: string | undefined
let ptyThrows: Error | null = null

;(globalThis as { __floePtySpawn?: unknown }).__floePtySpawn = (
  _file: string,
  args: string[],
  opts: { cwd?: string }
): FakePty => {
  ptyArgs = args
  ptyCwd = opts.cwd
  if (ptyThrows) throw ptyThrows
  ptyProc = new FakePty()
  return ptyProc
}

const { cancelLogin, findLoginUrl, pasteCode, startLogin } = await import('./claudeAuth.ts')

let events: ClaudeAuthEvent[] = []
let destroyed = false
const win = {
  isDestroyed: () => destroyed,
  webContents: { send: (_c: string, e: ClaudeAuthEvent) => events.push(e) }
} as unknown as BrowserWindow

test.beforeEach(() => {
  events = []
  destroyed = false
  ptyThrows = null
  cancelLogin()
})
test.afterEach(() => cancelLogin())

// A real `claude auth login` PTY chunk (claude 2.1.222): the CLI opens the
// browser itself, then prints the URL as an OSC 8 hyperlink target and again as
// visible text, and finally parks on the code prompt.
const URL =
  'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Aprofile&state=fkJyk7'
const OUT = `Opening browser to sign in…\r\nIf the browser didn't open, visit: \x1b]8;;${URL}\x07${URL}\x1b]8;;\x07\r\nPaste code here if prompted > `

test('reads the sign-in URL out of the login PTY output', () => {
  assert.equal(findLoginUrl(OUT), URL)
})

test('waits for the whole URL instead of returning a truncated one', () => {
  assert.equal(findLoginUrl(OUT.slice(0, 120)), null)
})

test('ignores output before the URL arrives', () => {
  assert.equal(findLoginUrl('Opening browser to sign in…\r\n'), null)
})

test('rejects a non-https scheme', () => {
  assert.equal(findLoginUrl('\x1b]8;;file:///etc/passwd\x07'), null)
})

test('startLogin: the URL is emitted once, from home, in the chosen mode', () => {
  startLogin(win, 'console')
  assert.deepEqual(ptyArgs, ['auth', 'login', '--console'])
  // The account is not a property of any worktree.
  assert.equal(ptyCwd, process.env.HOME)

  // Chunked, as a PTY delivers it: nothing until the URL is whole.
  ptyProc.onDataCb(OUT.slice(0, 120))
  assert.deepEqual(events, [])
  ptyProc.onDataCb(OUT.slice(120))
  assert.deepEqual(events, [{ kind: 'url', url: URL }])

  // More output must not re-announce the same URL.
  ptyProc.onDataCb(OUT)
  assert.equal(events.length, 1)
})

test('startLogin: exit 0 is a completed sign-in, and the PTY is reaped', () => {
  startLogin(win)
  assert.deepEqual(ptyArgs, ['auth', 'login', '--claudeai'])
  ptyProc.onExitCb({ exitCode: 0 })
  assert.deepEqual(events, [{ kind: 'signed-in' }])
  assert.equal(ptyProc.kills, 1)

  // Settled: a second exit event changes nothing.
  ptyProc.onExitCb({ exitCode: 1 })
  assert.equal(events.length, 1)
})

test("startLogin: a failed exit reports the CLI's own last line, ANSI stripped", () => {
  startLogin(win)
  ptyProc.onDataCb('\x1b[2mchecking…\x1b[0m\r\n\x1b]8;;https://x\x07\x1b[31mOAuth error: access_denied\x1b[0m\r\n\r\n')
  ptyProc.onExitCb({ exitCode: 1 })
  assert.deepEqual(events, [
    { kind: 'url', url: 'https://x' },
    { kind: 'error', message: 'OAuth error: access_denied' }
  ])
})

test('startLogin: with nothing printed, the exit code is the message', () => {
  startLogin(win)
  ptyProc.onExitCb({ exitCode: 7 })
  assert.deepEqual(events, [{ kind: 'error', message: 'claude auth login exited 7' }])
})

test('startLogin: a PTY that will not spawn is an error event, not a throw', () => {
  ptyThrows = new Error('posix_spawnp failed')
  startLogin(win)
  assert.deepEqual(events, [{ kind: 'error', message: 'posix_spawnp failed' }])
})

test('startLogin: one login at a time — the account is global', () => {
  startLogin(win)
  const first = ptyProc
  startLogin(win)
  assert.equal(ptyProc, first, 'the second call must not spawn a second CLI')

  // Once the first is finished, a new login can start.
  ptyProc.onExitCb({ exitCode: 0 })
  startLogin(win)
  assert.notEqual(ptyProc, first)
})

test('startLogin: a closed window is never sent to', () => {
  startLogin(win)
  destroyed = true
  ptyProc.onDataCb(OUT)
  ptyProc.onExitCb({ exitCode: 0 })
  assert.deepEqual(events, [])
})

test('pasteCode: only the first line, with exactly one carriage return', () => {
  startLogin(win)
  pasteCode('  code#state\nrm -rf /\n')
  assert.deepEqual(ptyProc.written, ['code#state\r'])

  // Empty and absurdly long pastes are dropped rather than typed at the prompt.
  pasteCode('   ')
  pasteCode('x'.repeat(513))
  assert.equal(ptyProc.written.length, 1)
})

test('pasteCode: nothing to type into once the login is over', () => {
  startLogin(win)
  const proc = ptyProc
  cancelLogin()
  assert.equal(proc.kills, 1)
  pasteCode('code')
  assert.deepEqual(proc.written, [])

  // And with no login at all it is a no-op too.
  pasteCode('code')
})
