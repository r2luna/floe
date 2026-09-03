// The daemon's HTTP face: the Floe UI in a browser.
//
// The headless bundle already answers everything the renderer asks — the
// server-mode plugin's WS gate turns `invoke(channel, ...args)` into the same
// call the preload makes over Electron IPC. What a browser cannot do is GET the
// UI, so this serves it: the web build in `out/web`, plus the one route the
// renderer needs that IPC cannot carry (`floe-media://` becomes `/media/…`).
//
// Loopback by default. The only thing reaching it is the host's Caddy, which
// terminates TLS for floe.pinguim.io on the tailnet address — see docs/web.md.
//
// Electron-free on purpose, like media.ts: index.ts wires it up, every decision
// is here, and the tests run under plain node.

import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { extname, join, normalize, resolve } from 'node:path'
import { Readable } from 'node:stream'
// Explicit .ts extension: this module is pulled in by a plain `node --test`
// run as well as by esbuild, and Node's ESM resolver does not guess extensions.
import { SCHEME, mediaResponse } from './media.ts'

/** What the served page needs before it can build `window.floe`. */
export interface WebBoot {
  /** The gate token, so the page's socket clears `hello` without a login. */
  token: string
  /** The daemon's home — the cwd of the synthetic "Home" workspace. */
  homeDir: string
  /** Platform of the machine the work runs on, for display only. */
  platform: string
  /** The daemon's version, for the client/server skew warning. */
  version: string
  /**
   * Where the page opens its socket. Empty means "same origin, /ws" — which is
   * what Caddy serves. Set it when the gate is reached directly (dev, no proxy).
   */
  wsUrl: string
}

export interface WebServerOptions {
  /** Directory holding the web build (index.html + assets). */
  root: string
  port: number
  /** Interface to bind. Loopback unless something in front is doing the TLS. */
  host?: string
  boot: WebBoot
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8'
}

/**
 * The boot payload as a script tag, injected into `<head>`.
 *
 * Serialized through JSON.stringify twice — once to make the object, once to
 * make that a JS *string literal* the page parses. A raw object literal here
 * would let a `</script>` inside any field close the tag; a string literal
 * only has to survive `<`, which the escape below handles.
 */
export function bootScript(boot: WebBoot): string {
  const json = JSON.stringify(JSON.stringify(boot)).replace(/</g, '\\u003c')
  return `<script>window.__FLOE_BOOT__ = JSON.parse(${json})</script>`
}

/** The shipped index.html with the boot payload in it. */
export function injectBoot(html: string, boot: WebBoot): string {
  return html.replace('</head>', `${bootScript(boot)}\n  </head>`)
}

/**
 * The path a `/media/…` request names, or null when it escapes the route.
 *
 * The request path after `/media` is byte-for-byte what `mediaUrl()` built, so
 * it is handed back to the same parser rather than decoded here — one encoding
 * rule, in one place.
 */
export function mediaUrlFromRequest(pathname: string): string | null {
  if (!pathname.startsWith('/media/')) return null
  return `${SCHEME}://file${pathname.slice('/media'.length)}`
}

/**
 * Resolve a request path inside `root`, or null when it points outside it.
 *
 * `normalize` collapses the `..` segments before the prefix check, so
 * `/../../etc/passwd` is rejected rather than served.
 */
export function resolveAsset(root: string, pathname: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null
  }
  if (decoded.includes('\0')) return null
  const base = resolve(root)
  const full = normalize(join(base, decoded))
  if (full !== base && !full.startsWith(base + '/')) return null
  return full
}

/** Pipe a fetch-style Response (what media.ts answers with) onto a node socket. */
async function sendResponse(res: ServerResponse, r: Response): Promise<void> {
  res.writeHead(r.status, Object.fromEntries(r.headers))
  if (!r.body) {
    res.end(await r.text())
    return
  }
  Readable.fromWeb(r.body as Parameters<typeof Readable.fromWeb>[0]).pipe(res)
}

function sendFile(res: ServerResponse, path: string): void {
  const type = MIME[extname(path).toLowerCase()] ?? 'application/octet-stream'
  const size = statSync(path).size
  // Hashed asset names make the bundle immutable; index.html must not be, or a
  // deploy would keep serving the old page from cache.
  const cache = path.endsWith('.html') ? 'no-store' : 'public, max-age=31536000, immutable'
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': String(size), 'Cache-Control': cache })
  createReadStream(path).pipe(res)
}

/**
 * Answer one request. Split out from the listener so the tests can drive it
 * without a socket.
 */
export async function handleRequest(
  opts: WebServerOptions,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' }).end('method not allowed')
    return
  }

  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname

  const media = mediaUrlFromRequest(pathname)
  if (media) {
    await sendResponse(res, mediaResponse(media, req.headers.range ?? null))
    return
  }

  const index = join(opts.root, 'index.html')
  const asset = resolveAsset(opts.root, pathname)
  // Anything that is not a file on disk is a route the SPA owns, so it gets the
  // page rather than a 404 — reloading on a deep link has to work.
  const isFile = asset !== null && asset !== index && existsSync(asset) && statSync(asset).isFile()

  if (isFile) {
    sendFile(res, asset)
    return
  }

  if (!existsSync(index)) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end(`no web build at ${opts.root} — run: pnpm build:web`)
    return
  }

  const html = injectBoot(readFileSync(index, 'utf8'), opts.boot)
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(html)),
    'Cache-Control': 'no-store'
  })
  res.end(html)
}

/** Bind the HTTP face. Resolves once listening; rejects if the port is taken. */
export function startWebServer(opts: WebServerOptions): Promise<Server> {
  return new Promise((res, rej) => {
    const server = createServer((req, response) => {
      void handleRequest(opts, req, response).catch(() => {
        if (!response.headersSent) response.writeHead(500)
        response.end('internal error')
      })
    })
    server.once('error', rej)
    server.listen(opts.port, opts.host ?? '127.0.0.1', () => {
      server.removeListener('error', rej)
      res(server)
    })
  })
}
