// Rookery headless server.
//
// Runs the real src/main process under the Electron shim (see shims/electron.ts) and
// exposes it to browsers over WebSocket instead of Electron IPC:
//   - browser sends {t:'invoke', id, channel, args}  -> registry.handlers[channel]
//   - main calls win.webContents.send(channel, ...)  -> broadcast {t:'event', channel, args}
// Plus a tiny static file server for the built renderer (out/renderer).
//
// Access model (matches the plan's "gate duplo"): the box is meant to sit behind Tailscale
// (network layer). On top of that, a per-install token gates HTTP + WS so other tailnet
// members can't drive it. Defaults to loopback bind; loopback connections skip the token
// for local dev. Handlers can run git/shell, so an unauthenticated WS = remote code exec —
// hence this is not optional off-loopback.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFile, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { gzip } from 'node:zlib'
import { homedir } from 'node:os'
import { join, normalize, extname, isAbsolute, resolve } from 'node:path'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { WebSocketServer, WebSocket } from 'ws'
import { registry, DATA_DIR } from './shims/electron'

// Mark the process as the headless server before main boots (dynamic import below).
// There's no host PHP/Herd here, so provisioning forces every Laravel worktree into
// Docker regardless of per-project config. See provision.ts.
process.env.ROOKERY_SERVER = '1'

const PORT = Number(process.env.ROOKERY_PORT || 41600)
// Loopback by default. Binding to the tailnet/all interfaces is an explicit opt-in.
const HOST = process.env.ROOKERY_HOST || '127.0.0.1'
const TRUST_LOOPBACK = process.env.ROOKERY_TRUST_LOOPBACK !== '0'
const ALLOWED_ORIGINS = (process.env.ROOKERY_ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const RENDERER_DIR = process.env.ROOKERY_RENDERER_DIR || join(__dirname, '..', 'renderer')

// --- token ---------------------------------------------------------------------------
const TOKEN_FILE = join(DATA_DIR, 'rookery-token')
function loadOrCreateToken(): string {
  if (existsSync(TOKEN_FILE)) return readFileSync(TOKEN_FILE, 'utf8').trim()
  const t = randomBytes(32).toString('hex')
  writeFileSync(TOKEN_FILE, t, { mode: 0o600 })
  return t
}
const TOKEN = loadOrCreateToken()
function tokenOk(provided: string | undefined | null): boolean {
  if (!provided) return false
  const a = Buffer.from(provided)
  const b = Buffer.from(TOKEN)
  return a.length === b.length && timingSafeEqual(a, b)
}
function hostIsLoopback(req: IncomingMessage): boolean {
  const h = (req.headers.host || '').toLowerCase()
  return (
    h === `127.0.0.1:${PORT}` ||
    h === `localhost:${PORT}` ||
    h === `[::1]:${PORT}` ||
    h === '127.0.0.1' ||
    h === 'localhost' ||
    h === '[::1]'
  )
}
// Trust the connection only if BOTH the socket IP and the Host header are loopback — the
// Host check defeats DNS rebinding (a rebound page reaches 127.0.0.1 but its Host is the
// attacker's domain, not a loopback literal).
function isLoopback(req: IncomingMessage): boolean {
  const ip = req.socket.remoteAddress || ''
  const ipLoopback = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1'
  return TRUST_LOOPBACK && ipLoopback && hostIsLoopback(req)
}
function cookieToken(req: IncomingMessage): string | undefined {
  const m = /(?:^|;\s*)rk=([^;]+)/.exec(req.headers.cookie || '')
  return m ? decodeURIComponent(m[1]) : undefined
}
function queryToken(url: string | undefined): string | undefined {
  const q = (url || '').split('?')[1]
  if (!q) return undefined
  return new URLSearchParams(q).get('token') || undefined
}
function originAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (!origin) return true // non-browser client (curl, node, MCP)
  if (ALLOWED_ORIGINS.includes(origin)) return true
  // Same-origin: Origin host must match the Host we're served on (defeats other sites;
  // Host allowlisting for DNS-rebinding is the token's job here).
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

// --- static --------------------------------------------------------------------------
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.avif': 'image/avif', '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.map': 'application/json'
}
// Injected into index.html so the web bridge knows the SERVER's home dir / platform
// synchronously (no round-trip) before the app mounts.
const HOST_SCRIPT =
  '<script>window.__ROOKERY_HOST__=' +
  JSON.stringify({ platform: process.platform, homeDir: homedir(), appVersion: process.env.ROOKERY_VERSION || '0.0.0' }) +
  '</script>'

// Text assets that gzip well; woff2/png/etc are already compressed, so skip them.
const COMPRESSIBLE = /\.(js|mjs|css|json|svg|html|map)$/

function sendFile(
  res: ServerResponse,
  file: string,
  extra?: Record<string, string>,
  acceptEncoding = ''
): void {
  readFile(file, (err, body) => {
    if (err) return void res.writeHead(404).end('not found')
    let out: Buffer | string = body
    if (file.endsWith('index.html')) {
      out = body.toString('utf8').replace('<head>', '<head>' + HOST_SCRIPT)
    }
    // index.html must revalidate every load so a rebuild's new asset hashes are
    // picked up without a manual hard-reload; the content-hashed files under
    // /assets/ never change under a name, so cache them forever.
    const cache =
      !file.endsWith('index.html') && file.includes('/assets/')
        ? 'public, max-age=31536000, immutable'
        : 'no-cache'
    const headers: Record<string, string> = {
      'content-type': MIME[extname(file)] || 'application/octet-stream',
      'cache-control': cache,
      ...extra
    }
    // Gzip text assets on the fly: the renderer bundle is ~2.3MB raw (~600KB
    // gzipped), so cold first-load over the remote link is dominated by this
    // transfer. Async so a large compress never stalls the WS event loop (the
    // terminals). ponytail: recompresses per request — fine for a personal IDE
    // server (assets cache forever client-side); add an in-memory cache by path
    // if fan-out ever makes the CPU matter.
    if (COMPRESSIBLE.test(file) && /\bgzip\b/.test(acceptEncoding)) {
      const buf = typeof out === 'string' ? Buffer.from(out) : out
      return void gzip(buf, (gzErr, zipped) => {
        if (gzErr) {
          res.writeHead(200, headers)
          return void res.end(out)
        }
        res.writeHead(200, { ...headers, 'content-encoding': 'gzip', vary: 'Accept-Encoding' })
        res.end(zipped)
      })
    }
    res.writeHead(200, headers)
    res.end(out)
  })
}

const httpServer = createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' })
    return void res.end(JSON.stringify({ ok: true, handlers: registry.handlers.size, clients: wss.clients.size }))
  }
  // The Fleet dashboard (docs/fleet.md): read-only session state + focus, on the
  // SAME token as the app but always presented explicitly (it answers CORS-wide,
  // so cookie auth is deliberately not accepted). Checked before the app's auth
  // gate and before the ?token= redirect — Fleet is an API client, not a page, so
  // a 302 to a cookie'd URL or the 401 HTML would both be wrong. Mounted here and
  // not on the WS bridge, which is single-active-client (see the connection
  // handler): a Fleet client there would park the user's Rookery tab.
  if (fleet && req.url?.startsWith('/fleet/')) {
    return void fleet.handleFleet(req, res, { focus: fleet.fleetFocus })
  }
  // Auth gate for the app. Loopback is trusted; otherwise need a valid token via ?token=
  // (which we persist into an HttpOnly SameSite=Strict cookie) or an existing cookie.
  const authed = isLoopback(req) || tokenOk(cookieToken(req)) || tokenOk(queryToken(req.url))
  if (!authed) {
    res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' })
    return void res.end('<h3>Rookery</h3><p>Append <code>?token=YOUR_TOKEN</code> to the URL (see <code>~/.rookery/rookery-token</code> on the server).</p>')
  }
  // Serve an arbitrary file by absolute path for the desktop app's browser pane
  // ("open .html in browser"): the pane is a LOCAL WebContentsView that can't read
  // THIS box's disk, so it loads the file over this (SSH-forwarded, loopback-trusted)
  // HTTP instead. Already behind the auth gate above; the WS bridge exposes the same
  // filesystem (readFileContent + terminals), so this grants no new reach.
  if (req.url?.startsWith('/rk-file?')) {
    const p = new URLSearchParams(req.url.split('?')[1]).get('path')
    if (!p || !isAbsolute(p)) {
      res.writeHead(400, { 'content-type': 'text/plain' })
      return void res.end('rk-file needs an absolute ?path=')
    }
    return void readFile(resolve(p), (err, body) => {
      if (err) return void res.writeHead(404, { 'content-type': 'text/plain' }).end('not found')
      res.writeHead(200, {
        'content-type': MIME[extname(p)] || 'application/octet-stream',
        'content-disposition': 'inline',
        'cache-control': 'no-cache',
        'referrer-policy': 'no-referrer'
      })
      res.end(body)
    })
  }

  // The cron trigger (`rookery schedule:run`, fired by system cron) — checked before
  // the ?token= redirect below so a token-authed request runs instead of getting 302'd.
  if (req.url?.startsWith('/api/schedule/run')) {
    if (!runDueSchedules) {
      res.writeHead(503, { 'content-type': 'text/plain' })
      return void res.end('scheduler not ready')
    }
    void runDueSchedules().then((result) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(result))
    })
    return
  }

  // A valid ?token= sets the cookie and immediately 302s to a clean URL, so the token
  // never lingers in history / Referer / caches.
  const qt = queryToken(req.url)
  if (qt && tokenOk(qt)) {
    res.writeHead(302, {
      location: (req.url || '/').split('?')[0] || '/',
      'set-cookie': 'rk=' + encodeURIComponent(qt) + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000',
      'referrer-policy': 'no-referrer',
      'cache-control': 'no-store'
    })
    return void res.end()
  }

  const urlPath = decodeURIComponent((req.url || '/').split('?')[0])
  let rel = normalize(urlPath).replace(/^(\.\.[/\\])+/, '')
  if (rel === '/' || rel === '') rel = '/index.html'
  let file = join(RENDERER_DIR, rel)
  if (!file.startsWith(RENDERER_DIR) || !existsSync(file)) file = join(RENDERER_DIR, 'index.html')
  sendFile(res, file, { 'referrer-policy': 'no-referrer' }, req.headers['accept-encoding'] || '')
})

// --- websocket -----------------------------------------------------------------------
const wss = new WebSocketServer({
  server: httpServer,
  path: '/ws',
  verifyClient: (info, cb) => {
    if (!originAllowed(info.req)) return cb(false, 403, 'bad origin')
    const ok =
      isLoopback(info.req) || tokenOk(cookieToken(info.req)) || tokenOk(queryToken(info.req.url))
    return ok ? cb(true) : cb(false, 401, 'unauthorized')
  }
})

// The one client that events + invokes route to (see connection handler). Older
// tabs are gated out against this so a stale tab can't keep driving the app.
let activeWs: WebSocket | null = null

wss.on('connection', (ws: WebSocket) => {
  // Single active client. The main process backs the whole app with ONE logical
  // BrowserWindow, so `webContents.send` broadcasts and handlers assume a single
  // window / owner. Multiple live tabs would therefore double-run MCP commands,
  // share PTYs, and fight over the single-active-worktree file watchers. So the
  // newest tab takes over: it becomes `activeWs`; every other client is told it's
  // superseded (its browser parks + stops reconnecting) AND is gated out below, so
  // an old/stale/uncooperative tab can't keep driving handlers. Enforced, not just
  // advisory — leaving exactly one client that events + invokes route to.
  //
  // We deliberately do NOT close the old sockets: if only the close (not the
  // superseded frame) reached the client, it would reconnect and start a takeover
  // war. Gating them inert is enough; the superseded frame handles the UX.
  activeWs = ws
  for (const other of wss.clients) {
    if (other !== ws && other.readyState === other.OPEN) {
      other.send(JSON.stringify({ t: 'superseded' }))
    }
  }

  const onSend = (channel: string, args: unknown[]): void => {
    if (ws === activeWs && ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ t: 'event', channel, args }))
    }
  }
  registry.events.on('send', onSend)
  ws.on('close', () => registry.events.off('send', onSend))

  ws.on('message', async (raw) => {
    let msg: { t: string; id?: number; channel?: string; args?: unknown[] }
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      return
    }
    // Heartbeat: the client can't see protocol-level pings from the browser WS
    // API, so it asks here. Answered before the activeWs gate — a parked tab
    // still deserves to know whether the link itself is alive.
    if (msg.t === 'ping') return void ws.send(JSON.stringify({ t: 'pong' }))
    if (ws !== activeWs) return // superseded tab — ignore its invokes
    if (msg.t !== 'invoke' || !msg.channel) return
    const fn = registry.handlers.get(msg.channel)
    if (!fn) return void ws.send(JSON.stringify({ t: 'error', id: msg.id, error: `no handler: ${msg.channel}` }))
    try {
      const sender = registry.windows[0]?.webContents ?? { send: () => {}, isDestroyed: () => false }
      const result = await fn({ sender: sender as never }, ...(msg.args || []))
      ws.send(JSON.stringify({ t: 'reply', id: msg.id, result: result ?? null }))
    } catch (err) {
      ws.send(JSON.stringify({ t: 'error', id: msg.id, error: String((err as Error)?.message ?? err) }))
    }
  })
})

httpServer.listen(PORT, HOST, () => {
  // Never log the token itself (it'd land in the systemd journal). Point at the file.
  console.log(`[rookery-server] http+ws on ${HOST}:${PORT}  (renderer: ${RENDERER_DIR})`)
  console.log(`[rookery-server] token file: ${TOKEN_FILE}`)
  console.log(`[rookery-server] open: http://${HOST === '0.0.0.0' ? '<host>' : HOST}:${PORT}/?token=$(cat ${TOKEN_FILE})`)
})

let runDueSchedules: (() => Promise<{ ran: number }>) | undefined
// Imported after main boots, like the scheduler above: both reach into main's
// module graph, which must not load before ROOKERY_SERVER is set and the Electron
// shim is in place. Until then /fleet/* just falls through to the app routes.
let fleet:
  | { handleFleet: typeof import('../main/fleet').handleFleet; fleetFocus: typeof import('../main/mcpServer').fleetFocus }
  | undefined
void import('../main/index').then(async () => {
  setTimeout(() => console.log(`[rookery-server] main booted — ${registry.handlers.size} handlers`), 200)
  ;({ runDueSchedules } = await import('../main/schedules'))
  const [{ handleFleet }, { fleetFocus }] = await Promise.all([import('../main/fleet'), import('../main/mcpServer')])
  fleet = { handleFleet, fleetFocus }
})
