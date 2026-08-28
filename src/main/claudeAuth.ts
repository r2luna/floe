import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import * as pty from 'node-pty'
import type { BrowserWindow } from 'electron'
import type { AuthStatus, ClaudeAuthEvent } from '../shared/types'

// Signing in to the Claude account the CLI runs as — the `/login` you would
// otherwise have to do inside a Claude Code TUI.
//
// `claude auth login` does the whole flow, with two things to know:
//
//  - it refuses to run unless stdin is a TTY, so it goes in a PTY, not a plain
//    child process (same reason as mcpAuth.ts);
//  - unlike an MCP server login there is NO loopback callback. The redirect is
//    `platform.claude.com/oauth/code/callback`, which shows a code for you to
//    copy, and the CLI waits on "Paste code here if prompted >". So the flow is
//    always: open URL → consent → paste code back. Nothing completes by itself.
//
// The CLI opens the browser on its own; the URL it prints is emitted anyway,
// because "the browser didn't open" is a real case and it is the only way to
// finish from a machine that has no browser.

const TIMEOUT_MS = 5 * 60 * 1000

interface Login {
  proc: pty.IPty
  buffer: string
  timer: ReturnType<typeof setTimeout>
  done: boolean
}

// One at a time: the account is global, so a second login would be racing the
// first for the same credential file.
let login: Login | null = null

/** Who the CLI is logged in as. `claude auth status --json` answers directly. */
export function authStatus(): Promise<AuthStatus> {
  return new Promise((resolve) => {
    execFile(
      'claude',
      ['auth', 'status', '--json'],
      { timeout: 15_000, cwd: homedir() },
      (err, stdout) => {
        // A non-zero exit still prints the JSON when it just means "logged out",
        // so parse first and only report an error when there is nothing to read.
        try {
          resolve(JSON.parse(stdout) as AuthStatus)
        } catch {
          resolve({
            loggedIn: false,
            error: err
              ? err.message.includes('ENOENT')
                ? 'claude CLI not found'
                : err.message
              : 'could not read auth status'
          })
        }
      }
    )
  })
}

// The URL is printed twice: as an OSC 8 hyperlink target (ESC ] 8 ; ; URL BEL)
// and as visible text. The hyperlink form is the one to read — its BEL
// terminator proves the URL arrived whole, so a chunk boundary mid-URL can't
// hand us a truncated link.
export function findLoginUrl(buffer: string): string | null {
  const raw =
    // eslint-disable-next-line no-control-regex
    /\x1b]8;;(https:\/\/[^\x07\x1b]+)\x07/.exec(buffer)?.[1] ??
    // eslint-disable-next-line no-control-regex
    /(https:\/\/[^\s\x07\x1b]+)[\r\n]/.exec(buffer)?.[1]
  if (!raw) return null
  // Scraped from a subprocess and handed to a browser: parse it, and only accept
  // a real https URL.
  try {
    return new URL(raw).protocol === 'https:' ? raw : null
  } catch {
    return null
  }
}

/** The last non-empty line, ANSI stripped — the CLI's own failure message. */
function lastLine(buffer: string): string {
  const lines = buffer
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b]8;;[^\x07]*\x07/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  return lines[lines.length - 1] ?? ''
}

function kill(proc: pty.IPty): void {
  try {
    proc.kill()
  } catch {
    /* already gone */
  }
}

function emit(win: BrowserWindow, event: ClaudeAuthEvent): void {
  if (!win.isDestroyed()) win.webContents.send('claude:auth:event', event)
}

export function startLogin(win: BrowserWindow, mode: 'claudeai' | 'console' = 'claudeai'): void {
  if (login && !login.done) return

  let proc: pty.IPty
  try {
    proc = pty.spawn('claude', ['auth', 'login', `--${mode}`], {
      name: 'xterm-256color',
      // Wide enough that the CLI never hard-wraps the (very long) OAuth URL.
      cols: 1000,
      rows: 40,
      // The account is not a property of any worktree, so this runs from home.
      cwd: homedir(),
      env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>
    })
  } catch (e) {
    emit(win, { kind: 'error', message: e instanceof Error ? e.message : String(e) })
    return
  }

  const conn: Login = {
    proc,
    buffer: '',
    done: false,
    timer: setTimeout(() => finish({ kind: 'timeout' }), TIMEOUT_MS)
  }
  login = conn

  function finish(event: ClaudeAuthEvent): void {
    if (conn.done) return
    conn.done = true
    clearTimeout(conn.timer)
    kill(proc)
    if (login === conn) login = null
    emit(win, event)
  }

  let sentUrl = false
  proc.onData((data) => {
    conn.buffer += data
    if (sentUrl) return
    const url = findLoginUrl(conn.buffer)
    if (!url) return
    sentUrl = true
    emit(win, { kind: 'url', url })
  })

  proc.onExit(({ exitCode }) => {
    if (conn.done) return
    if (exitCode === 0) finish({ kind: 'signed-in' })
    else finish({ kind: 'error', message: lastLine(conn.buffer) || `claude auth login exited ${exitCode}` })
  })
}

/**
 * Hand the code from the consent page to the waiting CLI.
 *
 * This crosses a trust boundary (renderer string → a live process's stdin), so
 * only the first line is taken and it is written back with exactly one newline:
 * a pasted CR/LF would otherwise type extra lines into whatever prompt follows.
 */
export function pasteCode(code: string): void {
  if (!login || login.done) return
  const line = code.split(/[\r\n]/)[0].trim()
  if (!line || line.length > 512) return
  login.proc.write(line + '\r')
}

export function cancelLogin(): void {
  if (!login || login.done) return
  login.done = true
  clearTimeout(login.timer)
  kill(login.proc)
  login = null
}

/** Sign out. Not a PTY flow — it only deletes the stored credential. */
export function logout(): Promise<void> {
  cancelLogin()
  return new Promise((resolve) => {
    execFile('claude', ['auth', 'logout'], { timeout: 15_000, cwd: homedir() }, () => resolve())
  })
}
