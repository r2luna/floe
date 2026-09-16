import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ProjectEnvConfig } from '../shared/types'

// Containerized per-worktree environments. Each worktree gets its own Compose
// project (`floe-<slug>`) running one serversideup/php app container, joined to
// the shared `floe` network the support stack owns (see ./support.ts). The app
// publishes a loopback host port; the host Caddy (see ./caddy.ts) reverse-proxies
// `<slug>.dev.<domain>` to it and manages TLS. Routes are written/removed by
// Floe as the container comes up / is torn down. (The Floe UI lives at
// `ide.<domain>`; worktree apps sit under `dev`.)
//
// The app talks to the shared DBs/Redis by service name (`mysql`/`postgres`/`redis`)
// over the `floe` network; the control plane (provisioning) creates/drops the
// per-worktree database by `docker exec`-ing the DB container, so the app never
// needs root DB credentials.

// The support stack's env, seeded into ~/.floe by ./support.ts on the first
// "Support stack: bring up". Provisioning reads it for the domain and the DB root
// password (control plane).
const SUPPORT_ENV = join(homedir(), '.floe', 'support.env')

export interface SupportConfig {
  domain: string
  mysqlRootPassword: string
  postgresPassword: string
  // The IP the host Caddy binds (the server's Tailscale address). Per-worktree
  // route files must bind the same IP as the main site, or Caddy fights itself
  // over :443. Overridable via EDGE_BIND in support.env.
  edgeBind: string
}

function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split('\n')) {
    const m = raw.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
  }
  return out
}

export function readSupportConfig(): SupportConfig {
  const env = existsSync(SUPPORT_ENV) ? parseEnv(readFileSync(SUPPORT_ENV, 'utf8')) : {}
  return {
    domain: env.DOMAIN || 'pinguim.io',
    mysqlRootPassword: env.MYSQL_ROOT_PASSWORD || 'floe',
    postgresPassword: env.POSTGRES_PASSWORD || 'floe',
    edgeBind: env.EDGE_BIND || '100.105.189.56'
  }
}

// A stable host port for a worktree's app container, derived from its slug. The
// host Caddy (off the docker network) reverse-proxies `<slug>.dev.<domain>` to
// `127.0.0.1:<port>`, so the port must be deterministic (teardown/reopen find it
// without state) and loopback-only (Caddy is the only thing that should reach it).
// ponytail: naive hash into a 1000-port window — two slugs can collide and the
// second `up` fails on the bound port; fine for a handful of worktrees, swap for
// a recorded free-port allocator if that ever bites.
export function worktreePort(slug: string): number {
  let h = 0
  for (let i = 0; i < slug.length; i++) h = (h * 31 + slug.charCodeAt(i)) >>> 0
  return 42000 + (h % 1000)
}

// The vite dev server's host port — the app port shifted by 1000 into a parallel
// 43000-window, so it's deterministic and can't collide with any app port. The
// host Caddy fronts it at `<slug>-vite.dev.<domain>` for HMR over wss.
export const worktreeVitePort = (slug: string): number => worktreePort(slug) + 1000

// Compose project name / container names are derived from the slug and stable, so
// teardown and `docker exec` can find them without a lookup.
export const composeProject = (slug: string): string => `floe-${slug}`
// The shared support stack runs as compose project `floe-support` (see
// SUPPORT_PROJECT in ./support.ts), so its DB containers are these.
// ponytail: assumes the default replica index `-1`; fine for a single-instance stack.
export const MYSQL_CONTAINER = 'floe-support-mysql-1'
export const POSTGRES_CONTAINER = 'floe-support-postgres-1'

export const worktreeComposePath = (worktreePath: string): string =>
  join(worktreePath, '.floe', 'docker-compose.yml')

export const worktreeDockerfilePath = (worktreePath: string): string =>
  join(worktreePath, '.floe', 'App.Dockerfile')

export const worktreeViteConfigPath = (worktreePath: string): string =>
  join(worktreePath, '.floe', 'vite.config.mjs')

// Vite config files, in the order Vite itself resolves them.
const VITE_CONFIG_NAMES = [
  'vite.config.js',
  'vite.config.mjs',
  'vite.config.ts',
  'vite.config.mts',
  'vite.config.cjs'
]

export function findProjectViteConfig(worktreePath: string): string | null {
  return VITE_CONFIG_NAMES.find((n) => existsSync(join(worktreePath, n))) ?? null
}

export const appHost = (slug: string, cfg: SupportConfig): string => `${slug}.dev.${cfg.domain}`
export const viteHost = (slug: string, cfg: SupportConfig): string => `${slug}-vite.dev.${cfg.domain}`

// TLS terminates at the host Caddy, which reaches the container over plain HTTP —
// so nginx's `$https` is empty, PHP never receives `HTTPS=on`, and Laravel builds
// every URL as `http://` on an `https://` page. The browser then blocks the app's
// own scripts (flux.js, livewire.js) as mixed content and the page renders but
// nothing responds.
//
// Fixing it in the image rather than in each project keeps `bootstrap/app.php`
// (`trustProxies`) out of it: nginx re-asserts the original scheme from the
// forwarded header, and Symfony derives `https` — and port 443, since it reads the
// portless `Host` header — with no application config at all.
//
// `fastcgi_param` at `server` level would be ignored (the `location ~ \.php$`
// redefines its own set), so the substitution goes into the shared
// `fastcgi_params` file that every location includes. The map defaults to `$https`
// so a genuinely TLS-terminated request still behaves.
// ponytail: patches serversideup's stock files in place; the `grep -q` guard fails
// the build loudly if upstream renames them, rather than silently serving http URLs.
const NGINX_FORWARDED_PROTO_LAYER = `RUN printf '%s\\n' \\
      'map $http_x_forwarded_proto $floe_https {' \\
      '    default $https;' \\
      '    https   on;' \\
      '}' > /etc/nginx/conf.d/00-floe-forwarded-proto.conf \\
 && grep -q 'HTTPS              $https if_not_empty' /etc/nginx/fastcgi_params \\
 && sed -i 's|HTTPS              $https if_not_empty|HTTPS              $floe_https if_not_empty|' /etc/nginx/fastcgi_params`

// The serversideup PHP image serves the app, but a Laravel worktree also needs a
// JS runtime for vite/asset builds — so we build a thin image on top with Node +
// bun baked in. Built once per PHP version (shared `floe/app:<php>` tag) since
// the layer is identical across worktrees. www-data is remapped to the host user's
// uid/gid so bind-mounted files (vendor/, node_modules/, storage/) stay writable.
export function worktreeDockerfile(): string {
  return `# Generated by Floe — do not edit by hand.
ARG PHP=8.4
FROM serversideup/php:\${PHP}-fpm-nginx
USER root
ARG USER_ID=1000
ARG GROUP_ID=1000
RUN apt-get update \\
 && apt-get install -y --no-install-recommends curl ca-certificates gnupg \\
 && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \\
 && apt-get install -y --no-install-recommends nodejs \\
 && corepack enable \\
 && npm install -g bun \\
 && apt-get clean && rm -rf /var/lib/apt/lists/*
${NGINX_FORWARDED_PROTO_LAYER}
# Remap www-data to the host user's uid/gid so bind-mounted worktree files
# (vendor/, node_modules/, storage/) are writable from the container. This is
# serversideup's supported mechanism — PUID/PGID env is deprecated.
RUN docker-php-serversideup-set-id www-data \${USER_ID}:\${GROUP_ID} \\
 && docker-php-serversideup-set-file-permissions --owner \${USER_ID}:\${GROUP_ID}
USER www-data
`
}

// The generated Compose file for one worktree. Absolute volume path so the file's
// own location doesn't matter; `external: true` network so it consumes the shared
// `floe` net the support stack created; a loopback-published port so the host
// Caddy can reach it (`127.0.0.1:<port>` → container's :8080).
export function worktreeComposeYaml(
  slug: string,
  worktreePath: string,
  env: ProjectEnvConfig,
  cfg: SupportConfig
): string {
  const port = worktreePort(slug)
  const vitePort = worktreeVitePort(slug)
  // Remap the container user to whoever runs the server, so bind-mounted files stay
  // writable. `process.getuid` is undefined on Windows — default to 1000 (the box).
  const uid = process.getuid?.() ?? 1000
  const gid = process.getgid?.() ?? 1000
  return `# Generated by Floe — do not edit by hand (rewritten on re-provision).
name: ${composeProject(slug)}

services:
  app:
    build:
      context: .
      dockerfile: App.Dockerfile
      args:
        PHP: "${env.php}"
        USER_ID: "${uid}"
        GROUP_ID: "${gid}"
    image: floe/app:${env.php}
    restart: unless-stopped
    volumes:
      - ${worktreePath}:/var/www/html
    environment:
      SSL_MODE: "off"           # TLS is terminated by Caddy, not the app
      AUTORUN_ENABLED: "false"  # migrations are run by the control plane, not on boot
      PHP_OPCACHE_ENABLE: "0"   # dev: pick up code changes without a cache flush
      # The project's vite.config reads these: bind all interfaces in the container,
      # and point HMR/assets at the Caddy-fronted vite host (over 443/wss).
      VITE_HOST: "0.0.0.0"
      VITE_HMR_HOST: "${viteHost(slug, cfg)}"
    ports:
      - "127.0.0.1:${port}:8080"     # host Caddy reverse-proxies here
      - "127.0.0.1:${vitePort}:5173" # vite dev server → Caddy at ${viteHost(slug, cfg)}
    networks:
      - floe

networks:
  floe:
    external: true
    name: floe
`
}

// A Vite config that wraps the project's own and forces the container-correct
// dev-server settings on top of it.
//
// Passing VITE_HOST/VITE_HMR_HOST through the environment only works if the
// project's config bothers to read them — and the common Laravel shape does the
// opposite, binding `new URL(APP_URL).host`, an address that resolves to the host
// machine and can't be bound from inside the container (EADDRNOTAVAIL). Wrapping
// makes it work for every project regardless of what its config says, and without
// editing a tracked file.
//
// The project's config is imported relatively, so Vite's own config bundler
// inlines it — a `.ts` config works from this `.mjs` wrapper for the same reason.
export function worktreeViteConfig(slug: string, appUrl: string, cfg: SupportConfig, projectConfig: string | null): string {
  const vHost = viteHost(slug, cfg)
  const base = projectConfig
    ? `import base from '../${projectConfig}'`
    : `const base = {} // project has no vite config of its own`
  return `// Generated by Floe — do not edit by hand (rewritten on re-provision).
${base}

// TLS is terminated by the host Caddy in front of this container, so the browser
// reaches the dev server at https://${vHost} while Vite itself only ever speaks
// plain HTTP on 5173.
const server = {
  host: '0.0.0.0',
  // Compose publishes exactly 5173; a project-chosen port would not be routed.
  port: 5173,
  strictPort: true,
  // Written verbatim into public/hot, so it has to be the browser-reachable proxy
  // rather than the bind address.
  origin: 'https://${vHost}',
  allowedHosts: ['${vHost}'],
  // Setting \`origin\` collapses laravel-vite-plugin's default CORS allow-list down
  // to that origin alone, which would shut out the app — it is served from a
  // different hostname than the dev server.
  cors: { origin: '${appUrl}' },
  hmr: { host: '${vHost}', protocol: 'wss', clientPort: 443 }
}

export default async (configEnv) => {
  const resolved = typeof base === 'function' ? await base(configEnv) : await base
  return { ...resolved, server: { ...resolved?.server, ...server } }
}
`
}

// Write the worktree's compose file (and the App.Dockerfile it builds from),
// returning the compose path.
export function writeWorktreeCompose(
  slug: string,
  worktreePath: string,
  env: ProjectEnvConfig
): string {
  const cfg = readSupportConfig()
  const path = worktreeComposePath(worktreePath)
  mkdirSync(join(worktreePath, '.floe'), { recursive: true })
  writeFileSync(worktreeDockerfilePath(worktreePath), worktreeDockerfile())
  writeFileSync(path, worktreeComposeYaml(slug, worktreePath, env, cfg))
  writeFileSync(
    worktreeViteConfigPath(worktreePath),
    worktreeViteConfig(slug, `https://${appHost(slug, cfg)}`, cfg, findProjectViteConfig(worktreePath))
  )
  return path
}
