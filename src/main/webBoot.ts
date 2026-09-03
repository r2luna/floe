// Deciding whether this process should serve the UI to a browser, and with what.
//
// Split from webServer.ts so that file stays a pure request handler: this is
// the part that reads the environment, and it is the only part that knows the
// daemon's layout on disk.

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { startWebServer, type WebBoot } from './webServer.ts'

export const DEFAULT_WEB_PORT = 41681

/**
 * The gate's token, so the served page clears `hello` without asking for one.
 *
 * Read straight from the server-mode plugin's config rather than through the
 * plugin: the plugin lives in another repo, and a page cannot be served before
 * its token exists anyway. Null when server mode was never enabled — there is
 * nothing to connect a browser to, so nothing is served.
 */
export function gateToken(configDir?: string): string | null {
  const dir = configDir ?? join(homedir(), '.config', 'floe', 'plugins', 'server')
  try {
    const config = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as {
      serveToken?: string
      enabled?: boolean
    }
    return config.enabled && config.serveToken ? config.serveToken : null
  } catch {
    return null
  }
}

/**
 * Where the web build sits: `out/web`, beside the `out/server` this bundle runs
 * from. `FLOE_WEB_ROOT` overrides it for a dev run against a vite build here.
 */
export function webRoot(): string {
  return process.env.FLOE_WEB_ROOT ?? resolve(__dirname, '..', 'web')
}

/**
 * Serve the UI, when this process is the daemon and there is something to serve.
 *
 * Silent no-op on the desktop: a BrowserWindow already has the renderer, and
 * binding a port there would put an unauthenticated copy of the app on the
 * machine for no one.
 *
 * Never throws. A missing build or a taken port must not take the daemon down —
 * the WS gate is what the desktop clients attach to, and it does not need this.
 */
export async function serveWebUi(): Promise<void> {
  if (!process.env.FLOE_IS_DAEMON) return

  const token = gateToken()
  if (!token) return

  const root = webRoot()
  if (!existsSync(join(root, 'index.html'))) {
    console.error(`[web] no build at ${root} — skipping (build:web + deploy)`)
    return
  }

  const boot: WebBoot = {
    token,
    homeDir: homedir(),
    platform: process.platform,
    version: process.env.FLOE_SERVER_VERSION ?? '0.0.0',
    // Empty means same-origin `/ws`, which is what the host's Caddy serves.
    // Set FLOE_WEB_WS_URL to reach the gate directly, without a proxy in front.
    wsUrl: process.env.FLOE_WEB_WS_URL ?? ''
  }

  const port = Number(process.env.FLOE_WEB_PORT ?? DEFAULT_WEB_PORT)
  // Loopback unless told otherwise: the TLS and the tailnet address belong to
  // the Caddy in front, and this must not be a second way in behind its back.
  const host = process.env.FLOE_WEB_HOST ?? '127.0.0.1'

  try {
    await startWebServer({ root, port, host, boot })
    console.error(`[web] serving ${root} on http://${host}:${port}`)
  } catch (err) {
    console.error('[web] not serving:', err instanceof Error ? err.message : String(err))
  }
}
