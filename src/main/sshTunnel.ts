// SSH transport for attached mode: instead of a public URL + token, forward the
// remote Rookery port to a local loopback port over SSH and attach to that.
// Auth is your SSH key (the `ssh <host>` you already use); the server trusts the
// loopback connection, so no token and no public exposure. One tunnel per
// attached backend — the window can hold several at once (docs/attached.md).
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer, createConnection } from 'node:net'

const pexec = promisify(execFile)

interface Tunnel {
  host: string
  remotePort: number
  localPort: number
  token: string | null
  proc: ChildProcess
}

const active = new Map<string, Tunnel>() // key = host:remotePort

const key = (host: string, remotePort: number): string => `${host}:${remotePort}`

export function getTunnel(host: string, remotePort: number): Tunnel | null {
  const t = active.get(key(host, remotePort))
  return t && t.proc.exitCode === null ? t : null
}

// Read the server's per-install token over SSH. Needed because a tunneled
// connection arrives with a Host header carrying the LOCAL forward port, so the
// server's loopback trust (which keys off Host === 127.0.0.1:<its port>) doesn't
// fire — the token is what authenticates instead. Fetching it over SSH keeps it
// off the public net: it rides the same key-auth'd channel as the tunnel. Null
// if there's no token file (a loopback-only server that skips auth entirely).
async function fetchToken(host: string): Promise<string | null> {
  try {
    // ~ expands in the remote login shell; ROOKERY_DATA_DIR defaults to ~/.rookery.
    const { stdout } = await pexec('ssh', ['-o', 'BatchMode=yes', host, 'cat', '~/.rookery/rookery-token'], {
      timeout: 8000
    })
    return stdout.trim() || null
  } catch {
    return null
  }
}

// A valid SSH destination: optional `user@`, then a hostname/alias. Crucially it
// must NOT start with `-`, or ssh would read it as a flag — `-oProxyCommand=…`
// smuggles arbitrary command execution, and ssh honors no `--` end-of-options
// marker for the destination, so an allowlist regex is the only defense. Applied
// at every point a host reaches `spawn`/`execFile` (parse, attach, ensureTunnel).
const SSH_HOST_RE = /^(?:[A-Za-z0-9_][A-Za-z0-9_.-]*@)?[A-Za-z0-9][A-Za-z0-9.-]*$/
export function isValidSshHost(host: string): boolean {
  return SSH_HOST_RE.test(host)
}

// An `ssh://host[:remotePort]` attach target → its parts. `remotePort` is the
// REMOTE Rookery port to forward to (the SSH port itself comes from ~/.ssh/config);
// defaults to the server's own default. Null for non-ssh or malformed targets.
export function parseSshTarget(target: string | null): { host: string; remotePort: number } | null {
  if (!target || !/^ssh:\/\//i.test(target)) return null
  const [host, portStr] = target.replace(/^ssh:\/\//i, '').split(':')
  if (!host || !isValidSshHost(host)) return null
  const remotePort = portStr ? Number(portStr) : 41600
  if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) return null
  return { host, remotePort }
}

// ponytail: tiny TOCTOU window between closing this probe socket and the next
// bind — negligible for a single-user desktop tunnel/CDP port.
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port
      srv.close(() => resolve(port))
    })
  })
}

// Poll until the forwarded port accepts a connection (ssh -N gives no ready
// signal), or give up. Faster than a fixed sleep, bounded so a dead host fails.
function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    const tryOnce = (): void => {
      const sock = createConnection({ host: '127.0.0.1', port }, () => {
        sock.end()
        resolve()
      })
      sock.on('error', () => {
        sock.destroy()
        if (Date.now() - start > timeoutMs) reject(new Error('port never opened'))
        else setTimeout(tryOnce, 150)
      })
    }
    tryOnce()
  })
}

// Open (or reuse) an SSH tunnel `host` → local loopback and return the local
// port. Reuses the live tunnel if it already targets the same host+port.
export async function ensureTunnel(host: string, remotePort: number): Promise<number> {
  // Defense in depth: never hand an argv-smuggling host to ssh, even if a caller
  // skipped parseSshTarget.
  if (!isValidSshHost(host)) throw new Error(`Invalid SSH host: ${host}`)
  const live = getTunnel(host, remotePort)
  if (live) return live.localPort

  // Grab the token first (own SSH call) — if the host is unreachable this fails
  // fast with a clear error before we bother spawning the forward.
  const token = await fetchToken(host)
  const localPort = await freePort()
  // BatchMode: never block on a password/passphrase prompt — there's no TTY here,
  // so it would hang forever; rely on key auth (agent), same as a bare `ssh host`.
  // ExitOnForwardFailure: if the forward can't bind, ssh exits instead of running
  // a useless session, and waitForPort surfaces the stderr.
  const proc = spawn(
    'ssh',
    [
      '-N',
      '-o', 'BatchMode=yes',
      '-o', 'ExitOnForwardFailure=yes',
      '-o', 'ServerAliveInterval=15',
      '-L', `${localPort}:127.0.0.1:${remotePort}`,
      host
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  )
  let stderr = ''
  proc.stderr?.on('data', (d: Buffer) => {
    stderr += d.toString()
  })
  proc.on('exit', () => {
    if (active.get(key(host, remotePort))?.proc === proc) active.delete(key(host, remotePort))
  })

  try {
    await waitForPort(localPort, 8000)
  } catch {
    proc.kill()
    throw new Error(`SSH tunnel to ${host} failed: ${stderr.trim() || 'could not open forward — check `ssh ' + host + '`'}`)
  }
  active.set(key(host, remotePort), { host, remotePort, localPort, token, proc })
  return localPort
}

// Close one backend's tunnel, or every tunnel when called with no host.
// ponytail: per-app forwards are only torn down on the close-all path — they're
// keyed by host too, but nothing yet detaches one backend while another shares
// the same host.
export function closeTunnel(host?: string, remotePort?: number): void {
  if (host && remotePort != null) {
    const t = active.get(key(host, remotePort))
    if (t) {
      t.proc.kill()
      active.delete(key(host, remotePort))
    }
    return
  }
  for (const t of active.values()) t.proc.kill()
  active.clear()
  closeForwards()
}

// --- per-app forwards -----------------------------------------------------------------
// The browser pane loads worktree apps that listen on the SERVER's loopback
// (e.g. 127.0.0.1:42731 on link). Each one gets its own `ssh -N -L` forward,
// cached by host:remotePort and torn down with the tunnel on detach.
const forwards = new Map<string, { localPort: number; proc: ChildProcess }>()

export async function ensureForward(host: string, remotePort: number): Promise<number> {
  if (!isValidSshHost(host)) throw new Error(`Invalid SSH host: ${host}`)
  const key = `${host}:${remotePort}`
  const live = forwards.get(key)
  if (live && live.proc.exitCode === null) return live.localPort

  const localPort = await freePort()
  const proc = spawn(
    'ssh',
    [
      '-N',
      '-o', 'BatchMode=yes',
      '-o', 'ExitOnForwardFailure=yes',
      '-o', 'ServerAliveInterval=15',
      '-L', `${localPort}:127.0.0.1:${remotePort}`,
      host
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  )
  let stderr = ''
  proc.stderr?.on('data', (d: Buffer) => {
    stderr += d.toString()
  })
  proc.on('exit', () => {
    if (forwards.get(key)?.proc === proc) forwards.delete(key)
  })
  try {
    await waitForPort(localPort, 8000)
  } catch {
    proc.kill()
    throw new Error(`SSH forward ${key} failed: ${stderr.trim() || 'could not open forward'}`)
  }
  forwards.set(key, { localPort, proc })
  return localPort
}

export function closeForwards(): void {
  for (const { proc } of forwards.values()) proc.kill()
  forwards.clear()
}

// --- reverse CDP forward --------------------------------------------------------------
// The server's Claude drives THIS app's embedded browser over Playwright: the
// app exposes Chrome DevTools Protocol on a local loopback port, and this
// reverse forward publishes it on the SERVER's loopback (fixed port 9333, which
// the server-side playwright MCP points at). Best-effort and its own ssh
// process on purpose: if 9333 is taken on the server (a stale forward from
// another attach), only Claude-drives-the-browser degrades — never the attach.
let reverse: ChildProcess | null = null

export function ensureReverseCdp(host: string, localCdpPort: number): void {
  if (reverse && reverse.exitCode === null) return
  if (!isValidSshHost(host)) return
  reverse = spawn(
    'ssh',
    [
      '-N',
      '-o', 'BatchMode=yes',
      '-o', 'ExitOnForwardFailure=yes',
      '-o', 'ServerAliveInterval=15',
      '-R', `9333:127.0.0.1:${localCdpPort}`,
      host
    ],
    { stdio: 'ignore' }
  )
  reverse.on('exit', () => {
    reverse = null
  })
}

export function closeReverseCdp(): void {
  reverse?.kill()
  reverse = null
}
