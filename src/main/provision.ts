import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { BrowserWindow } from 'electron'
import type { ProjectEnvConfig, ProvisionEvent, ProvisionStep } from '../shared/types'
import { randomUUID } from 'node:crypto'
import { detectPackageManager } from './devServer'
import { floeConfig } from './config/floe'
import {
  composePremise,
  hasPremise,
  interviewQuestions,
  PREMISE_REL,
  writePremise,
  type PremiseAnswer
} from './premise'
import { removeWorktreeRoute, writeWorktreeRoute } from './caddy'
import { bwrapPresent, sandboxDisabled, sandboxedSpawn } from './sandbox'
import { beginProvision, trackChild } from './provisionRuns'
import { isLaravel, listCommands } from './commands'
import { startCommand, userShell } from './commandRunner'
import { getProjectEnv } from './projects'
import {
  appHost,
  type SupportConfig,
  MYSQL_CONTAINER,
  POSTGRES_CONTAINER,
  readSupportConfig,
  viteHost,
  worktreeComposePath,
  worktreePort,
  worktreeVitePort,
  writeWorktreeCompose
} from './compose'

// Provisioning makes a freshly created worktree ready to work: it runs the
// per-stack setup steps (copy .env, install deps, link Herd, start commands) and
// streams each step's progress to the checklist UI. Steps are idempotent so a
// retry (or a re-run after a skip) is always safe.

type Stack = 'laravel' | 'node'

// Detect the project's stack the same way the rest of the app does — Laravel
// owns the `artisan` + `composer.json` pair (isLaravel); anything else with a
// package.json is treated as a generic node project (Floe included).
export function detectStack(worktreePath: string): Stack | null {
  if (isLaravel(worktreePath)) return 'laravel'
  if (existsSync(join(worktreePath, 'package.json'))) return 'node'
  return null
}

// `git worktree add` can return before the working-tree files are fully visible
// on disk to a separate process, so detecting the stack the instant it resolves
// can momentarily see an empty directory and report `null` — which makes the
// whole recipe (copy .env, composer, Herd, install) silently skip and "do
// nothing". Since the worktree is a checkout of the same repo, it gets the same
// stack as the main checkout once git finishes; poll until it materialises.
function waitForStack(worktreePath: string, timeoutMs = 15000): Promise<Stack | null> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs
    const tick = (): void => {
      const stack = detectStack(worktreePath)
      if (stack || Date.now() >= deadline) resolve(stack)
      else setTimeout(tick, 100)
    }
    tick()
  })
}

interface Ctx {
  win: BrowserWindow
  root: string // the main checkout (source of .env, etc.)
  worktreePath: string
  branch: string
  projectName: string
  linkName: string // Herd link name → `<linkName>.test`
  domain: string
  env?: ProjectEnvConfig // set → containerized recipe; unset → host-native
}

type Log = (text: string) => void

interface StepDef {
  id: string
  label: string
  // Resolves to 'done' or 'skipped'; throws (message → step detail) on failure.
  run: (ctx: Ctx, log: Log) => Promise<'done' | 'skipped'>
}

// A worktree branch becomes a filesystem/host-safe slug the way git.ts does it.
const slug = (branch: string): string => branch.replace(/\//g, '-')

// Rewrite (or append) `KEY=value` lines in a .env body, leaving everything else
// untouched.
function setEnvVars(text: string, vars: Record<string, string>): string {
  let out = text
  for (const [key, value] of Object.entries(vars)) {
    const re = new RegExp(`^${key}=.*$`, 'm')
    const line = `${key}=${value}`
    if (re.test(out)) out = out.replace(re, line)
    else out = (out.endsWith('\n') || out === '' ? out : out + '\n') + line + '\n'
  }
  return out
}

// Read a worktree's .env into a flat map (quotes stripped). Used to find the DB
// connection details for creating the per-worktree database before migrating.
export function readEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {}
  if (!existsSync(path)) return out
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const m = raw.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
  }
  return out
}

// The worktree's own APP_URL (Laravel .env, or any project that sets one) — lets
// the browser panel auto-open the app under test instead of landing blank.
export function getAppUrl(worktreePath: string): string | null {
  return readEnvFile(join(worktreePath, '.env')).APP_URL || null
}

// Single-quote a token for safe interpolation into a shell command line.
const shQuote = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`

// Run a shell command, streaming stdout+stderr to `log`. Commands run through the
// user's login shell (`$SHELL -lc …`) so they resolve against the real PATH —
// Herd, asdf, ~/.bun, /opt/homebrew — the same way the terminal and command
// runner do. A packaged GUI launch otherwise has a minimal PATH and `composer`,
// `herd`, `bun` come back "not found". Rejects on a non-zero exit or spawn error;
// a missing command (login-shell exit 127, or ENOENT on Windows) becomes a clear
// "<cmd> not found" so callers like the Herd step can treat it as a skip.
function runShell(
  cmd: string,
  args: string[],
  cwd: string,
  log: Log,
  extraEnv?: Record<string, string>,
  // Isolate this command from the user's secrets (see ./sandbox). Set on the
  // dependency-install steps, whose scripts are untrusted transitive code.
  sandbox?: boolean
): Promise<void> {
  return new Promise((resolve, reject) => {
    const win32 = process.platform === 'win32'
    const line = [cmd, ...args].map(shQuote).join(' ')
    let spawnCmd: string
    let spawnArgs: string[]
    let env: NodeJS.ProcessEnv = { ...process.env, FORCE_COLOR: '0', ...extraEnv }
    if (sandbox && !win32 && !sandboxDisabled()) {
      if (bwrapPresent()) {
        // Run the install inside bwrap. Use `/bin/sh -c` (not the login shell):
        // PATH was already discovered at app boot and is carried in the allowlist,
        // and a login shell would try to read the now-empty $HOME config.
        const sb = sandboxedSpawn(cwd)
        spawnCmd = sb.cmd
        spawnArgs = [...sb.args, '/bin/sh', '-c', line]
        env = { ...sb.env, ...extraEnv }
      } else if (process.platform === 'linux') {
        // Fail closed: sandbox requested, not disabled, but bwrap is missing —
        // never silently fall back to running the install with full access.
        reject(new Error('bwrap not found — refusing to run install without the sandbox (install it, or set FLOE_SANDBOX=0 to opt out)'))
        return
      } else {
        // Fase 1.5: macOS has no bwrap yet. Run unsandboxed, but say so loudly.
        log('⚠ dependency sandbox unsupported on this platform — running install unsandboxed\n')
        spawnCmd = userShell()
        spawnArgs = ['-lc', line]
      }
    } else {
      spawnCmd = win32 ? cmd : userShell()
      spawnArgs = win32 ? args : ['-lc', line]
    }
    let child: ReturnType<typeof spawn>
    try {
      // Its own process group off Windows, so removing the worktree can stop the
      // install the shell started and not just the shell (see provisionRuns).
      child = spawn(spawnCmd, spawnArgs, { cwd, env, detached: !win32 })
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)))
      return
    }
    trackChild(cwd, child)
    log(`$ ${cmd} ${args.join(' ')}\n`)
    child.stdout?.on('data', (d: Buffer) => log(d.toString()))
    child.stderr?.on('data', (d: Buffer) => log(d.toString()))
    child.on('error', (e: NodeJS.ErrnoException) =>
      reject(e.code === 'ENOENT' ? new Error(`${cmd} not found`) : e)
    )
    child.on('exit', (code) => {
      if (code === 0) resolve()
      // 127 from the login shell means the command itself wasn't found.
      else if (code === 127) reject(new Error(`${cmd} not found`))
      else reject(new Error(`${cmd} exited with code ${code ?? 'unknown'}`))
    })
  })
}

// The main checkout's gitignored local config, which never comes across with a
// worktree: `.env` (config) and `auth.json` (composer credentials). Without the
// latter, `composer install` dies on an HTTP 401 for any private repo — Laravel
// projects on flux-pro/nova hit it every time, and inside the container there is
// no user-level COMPOSER_HOME to fall back on.
// ponytail: a fixed list; add a name here when another tool needs one.
const LOCAL_CONFIG_FILES = ['.env', 'auth.json']

// Copy that local config into the worktree. Per file: skipped when absent from
// the main checkout or already present in the worktree.
const copyEnvStep: StepDef = {
  id: 'copy-env',
  label: 'Copy local config',
  run: async (ctx, log) => {
    const copied: string[] = []
    for (const name of LOCAL_CONFIG_FILES) {
      const src = join(ctx.root, name)
      const dst = join(ctx.worktreePath, name)
      if (!existsSync(src) || existsSync(dst)) continue
      copyFileSync(src, dst)
      copied.push(name)
    }
    if (!copied.length) {
      log(`Nothing to copy (${LOCAL_CONFIG_FILES.join(', ')} absent or already present)`)
      return 'skipped'
    }
    log(`Copied ${copied.join(', ')} from ${ctx.root}`)
    return 'done'
  }
}

// Run the package manager's install (bun/pnpm/yarn/npm, by lockfile).
const nodeInstallStep: StepDef = {
  id: 'node-install',
  label: 'Install JS dependencies',
  run: async (ctx, log) => {
    if (!existsSync(join(ctx.worktreePath, 'package.json'))) {
      log('No package.json — skipping')
      return 'skipped'
    }
    const pm = detectPackageManager(ctx.worktreePath)
    // sandbox: untrusted pre/postinstall scripts from transitive deps.
    await runShell(pm, ['install'], ctx.worktreePath, log, undefined, true)
    return 'done'
  }
}

// Locate the installed `electron` package for a checkout — pnpm's nested layout
// (`node_modules/.pnpm/electron@<ver>/node_modules/electron`) or a flat
// `node_modules/electron` — returning its directory and version, or null when the
// project doesn't depend on Electron.
function findElectronInstall(base: string): { dir: string; version: string } | null {
  const pnpm = join(base, 'node_modules', '.pnpm')
  if (existsSync(pnpm)) {
    const entry = readdirSync(pnpm).find((d) => /^electron@\d/.test(d))
    if (entry) {
      const dir = join(pnpm, entry, 'node_modules', 'electron')
      // The directory name is `electron@<version>[_<peer-hash>]` — keep the version.
      if (existsSync(dir)) return { dir, version: entry.slice('electron@'.length).split('_')[0] }
    }
  }
  const flat = join(base, 'node_modules', 'electron')
  if (existsSync(join(flat, 'package.json'))) {
    try {
      const version = JSON.parse(readFileSync(join(flat, 'package.json'), 'utf8')).version as string
      return { dir: flat, version }
    } catch {
      /* unreadable package.json — treat as not found */
    }
  }
  return null
}

// Electron's real binary lives in `<pkg>/dist`, with `<pkg>/path.txt` naming the
// executable inside it. Both are produced by a postinstall download. "OK" means
// path.txt is non-empty and the file it points at actually exists.
function electronBinaryOk(dir: string): boolean {
  const ptxt = join(dir, 'path.txt')
  if (!existsSync(ptxt)) return false
  const rel = readFileSync(ptxt, 'utf8').trim()
  return rel.length > 0 && existsSync(join(dir, 'dist', rel))
}

// In a worktree, Electron's binary download is commonly blocked or partial (the
// supply-chain install policy), leaving `dist` empty and `path.txt` blank — and
// `electron-vite dev` then dies with "Error: Electron uninstall". Repair it by
// borrowing the main checkout's already-downloaded, same-version binary: copy its
// path.txt and point the worktree's `dist` at it via a symlink. Idempotent, and a
// no-op for projects without Electron or where the binary is already healthy.
const electronRepairStep: StepDef = {
  id: 'electron-repair',
  label: 'Repair Electron binary',
  run: async (ctx, log) => {
    const wt = findElectronInstall(ctx.worktreePath)
    if (!wt) {
      log('No Electron dependency — nothing to repair')
      return 'skipped'
    }
    if (electronBinaryOk(wt.dir)) {
      log('Electron binary already present')
      return 'skipped'
    }
    const main = findElectronInstall(ctx.root)
    if (!main || main.version !== wt.version || !electronBinaryOk(main.dir)) {
      log(
        main
          ? `Main checkout Electron (${main.version}) can't satisfy worktree (${wt.version}) — run the package manager install`
          : 'No Electron in the main checkout to borrow from — skipping'
      )
      return 'skipped'
    }
    copyFileSync(join(main.dir, 'path.txt'), join(wt.dir, 'path.txt'))
    const wtDist = join(wt.dir, 'dist')
    if (existsSync(wtDist)) rmSync(wtDist, { recursive: true, force: true })
    symlinkSync(join(main.dir, 'dist'), wtDist)
    log(`Linked Electron ${wt.version} from the main checkout`)
    return 'done'
  }
}

// Ensure the project's configured commands exist (listCommands seeds a Laravel
// project's defaults on first read), then start the ones flagged autoStart.
const commandsStep: StepDef = {
  id: 'commands',
  label: 'Configured commands',
  run: async (ctx, log) => {
    const commands = listCommands(ctx.root, ctx.worktreePath)
    log(`${commands.length} command(s) configured`)
    return 'done'
  }
}

const startStep: StepDef = {
  id: 'start',
  label: 'Start commands',
  run: async (ctx, log) => {
    const auto = listCommands(ctx.root, ctx.worktreePath).filter((c) => c.autoStart)
    if (auto.length === 0) {
      log('No commands flagged autoStart')
      return 'skipped'
    }
    for (const c of auto) {
      log(`Starting "${c.name}": ${c.command}`)
      startCommand(
        ctx.win,
        `${ctx.worktreePath}#${c.id}`,
        ctx.worktreePath,
        ctx.branch,
        c.command,
        80,
        24,
        c.watch,
        c.autoRestart
      )
    }
    return 'done'
  }
}

// Laravel keeps its writable runtime dirs gitignored, so a fresh worktree has
// no storage/framework/* or bootstrap/cache — without them the framework throws
// "Please provide a valid cache path" and the served site 500s. Create them up
// front; mkdir recursive is idempotent. Shared by host + container recipes.
const storageDirsStep: StepDef = {
  id: 'storage-dirs',
  label: 'Prepare storage directories',
  run: async (ctx, log) => {
    const dirs = [
      'storage/framework/cache/data',
      'storage/framework/sessions',
      'storage/framework/views',
      'storage/logs',
      'bootstrap/cache'
    ]
    for (const d of dirs) mkdirSync(join(ctx.worktreePath, d), { recursive: true })
    log(`Ensured: ${dirs.join(', ')}`)
    return 'done'
  }
}

// The PHP minors the App.Dockerfile can build (serversideup publishes these).
const SUPPORTED_PHP = [2, 3, 4, 5]
const DEFAULT_PHP_MINOR = 4

// Read a composer `require.php` constraint into one PHP minor we can build.
//
// Naively taking the first `8.x` in the string picks the wrong end of a range:
// `>=8.1 <8.4` would yield 8.4, the one version the project explicitly excludes,
// and the image would fail its own composer install. So an exclusive upper bound
// is read FIRST and applied as a ceiling — never as a candidate. (`<=8.4` is
// inclusive and is not a ceiling.)
//
// This is a heuristic, not a semver solver: it picks the first buildable minor the
// constraint mentions and clamps it. Pin an explicit Project.env to override.
export function phpFromConstraint(req: string): ProjectEnvConfig['php'] {
  const exclusive = req.match(/<\s*8\.(\d+)/)
  const ceiling = exclusive ? Number(exclusive[1]) - 1 : Infinity
  const mentioned = [...req.matchAll(/8\.(\d+)/g)].map((m) => Number(m[1]))
  const picked = mentioned.find((n) => SUPPORTED_PHP.includes(n)) ?? DEFAULT_PHP_MINOR
  // A constraint below everything we build (`<8.2`) still has to produce a
  // buildable image; it will fail at composer install, where the reason is legible.
  const clamped = Math.min(Math.max(Math.min(picked, ceiling), SUPPORTED_PHP[0]), SUPPORTED_PHP.at(-1) as number)
  return `8.${clamped}` as ProjectEnvConfig['php']
}

// The headless server has no host PHP/Herd, so every Laravel worktree MUST run in
// Docker even when the project never opted into `env.mode: 'container'`. Synthesize a
// sensible container config: PHP pinned from composer.json's `require.php` (else the
// latest supported), package manager from the lockfile, MySQL by default.
// ponytail: MySQL/latest-PHP defaults; pin an explicit Project.env to override.
export function defaultContainerEnv(worktreePath: string): ProjectEnvConfig {
  let php: ProjectEnvConfig['php'] = '8.4'
  const composer = join(worktreePath, 'composer.json')
  if (existsSync(composer)) {
    try {
      const req = (JSON.parse(readFileSync(composer, 'utf8')).require ?? {}).php
      if (typeof req === 'string') php = phpFromConstraint(req)
    } catch {
      // malformed composer.json — keep the default
    }
  }
  return { mode: 'container', runtime: 'laravel', php, packageManager: detectPackageManager(worktreePath), db: 'mysql' }
}

// ── container recipe (opt-in via Project.env) ─────────────────────────────────
// `docker compose exec` args for the worktree's app container. `extraEnv` is
// forwarded via `-e` so a single call can carry one-off secrets (composer auth)
// without baking them into the generated compose file.
const composeExec = (worktreePath: string, cmd: string[], extraEnv?: Record<string, string>): string[] => [
  'compose',
  '-f',
  worktreeComposePath(worktreePath),
  'exec',
  '-T',
  ...Object.entries(extraEnv ?? {}).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
  'app',
  ...cmd
]

// Composer's own auth (fluxui, private Satis mirrors, etc.) normally lives in
// `COMPOSER_HOME/auth.json` on the machine running `composer install` — not per
// project — so a fresh worktree, and its container, never has it. Forward the
// host's global auth.json into the container as COMPOSER_AUTH so private
// packages resolve the same way they do outside Docker.
function globalComposerAuth(): string | null {
  const home = process.env.COMPOSER_HOME ?? join(homedir(), process.platform === 'linux' ? '.config/composer' : '.composer')
  const path = join(home, 'auth.json')
  if (!existsSync(path)) return null
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

// Point the app at the shared DBs by service name (mysql/postgres) and at its
// Caddy-routed URL. The app connects as the DB root user over the private
// `floe` network — the control plane creates the DB separately.
const containerEnvVarsStep: StepDef = {
  id: 'env-vars',
  label: 'Set container env vars',
  run: async (ctx, log) => {
    const dst = join(ctx.worktreePath, '.env')
    if (!existsSync(dst)) {
      log('No .env to update — skipping')
      return 'skipped'
    }
    const cfg = readSupportConfig()
    const env = ctx.env as ProjectEnvConfig
    const s = slug(ctx.branch)
    const db = ctx.linkName.replace(/[^A-Za-z0-9_]/g, '_')
    const isPg = env.db === 'postgres'
    const updated = setEnvVars(readFileSync(dst, 'utf8'), {
      APP_NAME: ctx.linkName,
      APP_URL: `https://${appHost(s, cfg)}`,
      DB_CONNECTION: isPg ? 'pgsql' : 'mysql',
      DB_HOST: isPg ? 'postgres' : 'mysql',
      DB_PORT: isPg ? '5432' : '3306',
      DB_DATABASE: db,
      DB_USERNAME: isPg ? 'postgres' : 'root',
      DB_PASSWORD: isPg ? cfg.postgresPassword : cfg.mysqlRootPassword,
      // Shared Redis: one instance for all worktrees, isolated by a per-worktree
      // key prefix (Redis' 16-DB ceiling doesn't scale; a prefix does). Sessions,
      // cache and queues all inherit it.
      REDIS_HOST: 'redis',
      REDIS_PORT: '6379',
      REDIS_PREFIX: `${s}_`,
      CACHE_PREFIX: `${s}_`
    })
    writeFileSync(dst, updated)
    log(`APP_URL=https://${appHost(s, cfg)}\nDB_HOST=${isPg ? 'postgres' : 'mysql'} DB_DATABASE=${db}\nREDIS_HOST=redis REDIS_PREFIX=${s}_`)
    return 'done'
  }
}

const served = (what: string, host: string, port: number, routed: boolean): string =>
  routed ? `${what} served at https://${host} (127.0.0.1:${port})` : `${what} served at http://127.0.0.1:${port}`

// Write the worktree's compose file, bring the app container up, and — on the
// server — add its host Caddy route (`<slug>.dev.<domain>` → the loopback port).
const composeUpStep: StepDef = {
  id: 'compose-up',
  label: 'Start app container',
  run: async (ctx, log) => {
    const cfg = readSupportConfig()
    const s = slug(ctx.branch)
    const path = writeWorktreeCompose(s, ctx.worktreePath, ctx.env as ProjectEnvConfig)
    log(`Wrote ${path}`)
    // --build so the Node+bun layer on top of serversideup is (re)built as needed.
    await runShell('docker', ['compose', '-f', path, 'up', '-d', '--build'], ctx.worktreePath, log)
    // Routed on the server, loopback-only on a desktop (see ./caddy.ts) — the app
    // container is published either way, so container mode still works with no
    // Caddy anywhere on the machine.
    const host = appHost(s, cfg)
    const routed = await writeWorktreeRoute(host, worktreePort(s))
    log(served('App', host, worktreePort(s), routed))
    // Second route for the containerized vite dev server (HMR over wss).
    const vHost = viteHost(s, cfg)
    log(served('Vite', vHost, worktreeVitePort(s), await writeWorktreeRoute(vHost, worktreeVitePort(s))))
    return 'done'
  }
}

const composerInstallContainerStep: StepDef = {
  id: 'composer',
  label: 'composer install (in container)',
  run: async (ctx, log) => {
    const auth = globalComposerAuth()
    if (!auth) log('No global COMPOSER_HOME/auth.json found — private packages may fail to authenticate')
    await runShell(
      'docker',
      composeExec(ctx.worktreePath, ['composer', 'install'], auth ? { COMPOSER_AUTH: auth } : undefined),
      ctx.worktreePath,
      log
    )
    return 'done'
  }
}

// JS deps install INSIDE the container — the image has node+bun baked in, and the
// server host has neither. (The host-side nodeInstallStep is for desktop/Herd mode.)
const nodeInstallContainerStep: StepDef = {
  id: 'node-install',
  label: 'Install JS dependencies (in container)',
  run: async (ctx, log) => {
    if (!existsSync(join(ctx.worktreePath, 'package.json'))) {
      log('No package.json — skipping')
      return 'skipped'
    }
    const pm = detectPackageManager(ctx.worktreePath)
    await runShell('docker', composeExec(ctx.worktreePath, [pm, 'install']), ctx.worktreePath, log)
    return 'done'
  }
}

// Create the per-worktree database on the SHARED DB container (control plane),
// not from inside the app container — the app never needs root DB tools.
const createDbStep: StepDef = {
  id: 'create-db',
  label: 'Create database',
  run: async (ctx, log) => {
    const cfg = readSupportConfig()
    const db = ctx.linkName.replace(/[^A-Za-z0-9_]/g, '_')
    if ((ctx.env as ProjectEnvConfig).db === 'postgres') {
      // Postgres has no CREATE DATABASE IF NOT EXISTS — guard with a SELECT.
      const script = `psql -U postgres -tc "SELECT 1 FROM pg_database WHERE datname='${db}'" | grep -q 1 || psql -U postgres -c 'CREATE DATABASE "${db}"'`
      await runShell(
        'docker',
        ['exec', '-e', `PGPASSWORD=${cfg.postgresPassword}`, POSTGRES_CONTAINER, 'sh', '-c', script],
        ctx.worktreePath,
        log
      )
    } else {
      const sql = `CREATE DATABASE IF NOT EXISTS \`${db}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
      await runShell(
        'docker',
        ['exec', MYSQL_CONTAINER, 'mysql', '-uroot', `-p${cfg.mysqlRootPassword}`, '-e', sql],
        ctx.worktreePath,
        log
      )
    }
    log(`Ensured database ${db}`)
    return 'done'
  }
}

const migrateContainerStep: StepDef = {
  id: 'migrate',
  label: 'Migrate (in container)',
  run: async (ctx, log) => {
    await runShell(
      'docker',
      composeExec(ctx.worktreePath, ['php', 'artisan', 'migrate', '--force']),
      ctx.worktreePath,
      log
    )
    return 'done'
  }
}

const seedContainerStep: StepDef = {
  id: 'seed',
  label: 'Seed (in container)',
  run: async (ctx, log) => {
    await runShell(
      'docker',
      composeExec(ctx.worktreePath, ['php', 'artisan', 'db:seed', '--force']),
      ctx.worktreePath,
      log
    )
    return 'done'
  }
}

// serversideup app container serves PHP; JS/Vite deps still install on the host
// (node lives there, and `vite` dev runs host-side). ponytail: queue/scheduler
// workers in-container are phase 2.1 — add when a project needs them.
const laravelContainerRecipe: StepDef[] = [
  copyEnvStep,
  containerEnvVarsStep,
  storageDirsStep,
  composeUpStep,
  composerInstallContainerStep,
  createDbStep,
  migrateContainerStep,
  seedContainerStep,
  nodeInstallContainerStep
]

const laravelRecipe: StepDef[] = [
  copyEnvStep,
  {
    id: 'env-vars',
    label: 'Set per-worktree variables',
    run: async (ctx, log) => {
      const dst = join(ctx.worktreePath, '.env')
      if (!existsSync(dst)) {
        log('No .env to update — skipping')
        return 'skipped'
      }
      const db = ctx.linkName.replace(/[^A-Za-z0-9_]/g, '_')
      const updated = setEnvVars(readFileSync(dst, 'utf8'), {
        APP_NAME: ctx.linkName,
        APP_URL: `http://${ctx.domain}`,
        DB_DATABASE: db
      })
      writeFileSync(dst, updated)
      log(`APP_URL=http://${ctx.domain}\nDB_DATABASE=${db}`)
      return 'done'
    }
  },
  storageDirsStep,
  {
    id: 'composer',
    label: 'composer install',
    run: async (ctx, log) => {
      // sandbox: composer plugins execute arbitrary PHP during install.
      await runShell('composer', ['install'], ctx.worktreePath, log, undefined, true)
      return 'done'
    }
  },
  {
    id: 'herd',
    label: 'Link Herd site',
    run: async (ctx, log) => {
      try {
        await runShell('herd', ['link', ctx.linkName], ctx.worktreePath, log)
        log(`Linked as ${ctx.domain}`)
        return 'done'
      } catch (e) {
        // Herd isn't installed everywhere — treat a missing binary as a skip,
        // not a hard failure.
        if (e instanceof Error && /not found/.test(e.message)) {
          log('herd not found — skipping')
          return 'skipped'
        }
        throw e
      }
    }
  },
  nodeInstallStep,
  {
    // Each worktree gets its own DB_DATABASE (set in env-vars), so the database is
    // brand new. `migrate` can't create the database — so for MySQL/MariaDB create
    // it first, then run the migrations. Runs through the login shell so `php`/
    // `mysql` resolve (Herd). `--force` keeps it from blocking on the production
    // confirmation prompt in a non-interactive run.
    id: 'migrate',
    label: 'Migrate (migrate --force)',
    run: async (ctx, log) => {
      const env = readEnvFile(join(ctx.worktreePath, '.env'))
      const conn = (env.DB_CONNECTION || 'mysql').toLowerCase()
      const db = env.DB_DATABASE
      if ((conn === 'mysql' || conn === 'mariadb') && db) {
        const host = env.DB_HOST || '127.0.0.1'
        const port = env.DB_PORT || '3306'
        const user = env.DB_USERNAME || 'root'
        const sql = `CREATE DATABASE IF NOT EXISTS \`${db.replace(/`/g, '')}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
        log(`Ensuring database \`${db}\` exists`)
        // MYSQL_PWD passes the password without exposing it on the command line.
        await runShell(
          'mysql',
          ['--protocol=TCP', `--host=${host}`, `--port=${port}`, `--user=${user}`, '-e', sql],
          ctx.worktreePath,
          log,
          env.DB_PASSWORD ? { MYSQL_PWD: env.DB_PASSWORD } : undefined
        )
      }
      await runShell('php', ['artisan', 'migrate', '--force'], ctx.worktreePath, log)
      return 'done'
    }
  },
  {
    // Separate step so a seeder failure doesn't roll back a successful migrate (and
    // can be retried on its own). `--force` so it never blocks on the production
    // confirmation prompt in a non-interactive run.
    id: 'seed',
    label: 'Seed (db:seed)',
    run: async (ctx, log) => {
      await runShell('php', ['artisan', 'db:seed', '--force'], ctx.worktreePath, log)
      return 'done'
    }
  },
  commandsStep,
  startStep
]

const nodeRecipe: StepDef[] = [copyEnvStep, nodeInstallStep, electronRepairStep, commandsStep, startStep]

// Container teardown: `docker compose down` the app, then drop its database on
// the shared DB container. The generated .env carries the engine + db name.
// The app + vite hosts a worktree published, recovered from its generated compose
// file (`name: floe-<slug>`). Returns nothing when the file is unreadable or does
// not carry the project name — there is then no way to name the routes, and
// guessing one would risk deleting another worktree's.
export function teardownRouteHosts(composePath: string, cfg: SupportConfig): string[] {
  let slug: string | undefined
  try {
    slug = readFileSync(composePath, 'utf8').match(/^name: floe-(.+)$/m)?.[1].trim()
  } catch {
    return []
  }
  return slug ? [appHost(slug, cfg), viteHost(slug, cfg)] : []
}

async function dropContainerWorktree(
  worktreePath: string,
  composePath: string,
  log: Log
): Promise<'dropped' | 'skipped'> {
  log('Stopping app container')
  try {
    await runShell('docker', ['compose', '-f', composePath, 'down'], worktreePath, log)
  } catch (e) {
    log(e instanceof Error ? e.message : String(e))
  }
  // Drop the host Caddy routes. Both hosts are derived from the slug the SAME way
  // the write side derives them — read back from the compose file's own project
  // name, which is the write side's record of it. Deriving them from the .env's
  // APP_URL instead would leak both route files whenever that file was edited or
  // already deleted, leaving Caddy holding a dead upstream.
  const cfg = readSupportConfig()
  for (const h of teardownRouteHosts(composePath, cfg)) {
    try {
      if (await removeWorktreeRoute(h)) log(`Removed route ${h}`)
    } catch (e) {
      log(e instanceof Error ? e.message : String(e))
    }
  }
  const env = readEnvFile(join(worktreePath, '.env'))
  const db = env.DB_DATABASE
  const conn = (env.DB_CONNECTION || 'mysql').toLowerCase()
  if (!db) {
    log('No DB_DATABASE in .env — nothing to drop')
    return 'skipped'
  }
  log(`Dropping database ${db}`)
  if (conn === 'pgsql' || conn === 'postgres' || conn === 'postgresql') {
    await runShell(
      'docker',
      ['exec', '-e', `PGPASSWORD=${cfg.postgresPassword}`, POSTGRES_CONTAINER, 'psql', '-U', 'postgres', '-c', `DROP DATABASE IF EXISTS "${db.replace(/"/g, '')}" WITH (FORCE)`],
      worktreePath,
      log
    )
  } else {
    await runShell(
      'docker',
      ['exec', MYSQL_CONTAINER, 'mysql', '-uroot', `-p${cfg.mysqlRootPassword}`, '-e', `DROP DATABASE IF EXISTS \`${db.replace(/`/g, '')}\``],
      worktreePath,
      log
    )
  }
  return 'dropped'
}

// Drop the per-worktree database that provisioning created. Reads the worktree's
// .env for the connection, then `DROP DATABASE`. Handles MySQL/MariaDB and
// Postgres; a SQLite file lives inside the worktree and goes away with it.
// Guard: never drop the main checkout's database (a copied-but-never-repointed
// .env would otherwise nuke the real dev DB). Returns 'dropped' or 'skipped';
// throws (message → step detail) when the drop command fails.
// Unlink the worktree's Herd site, undoing the `herd link` the Laravel recipe
// made. Runs BEFORE the worktree directory goes: `herd unlink` reads the site
// from the directory it is called in, and a link left behind keeps serving a
// path that no longer exists.
//
// Every absence is a skip, not a failure: no Herd installed, a stack that never
// linked anything, a site already unlinked by hand. Removing a worktree must not
// stop on a site that is already gone.
export async function unlinkWorktreeSite(worktreePath: string, log: Log): Promise<'unlinked' | 'skipped'> {
  if (!existsSync(join(worktreePath, 'artisan'))) {
    log('Not a Laravel worktree — no Herd site to unlink')
    return 'skipped'
  }
  try {
    await runShell('herd', ['unlink'], worktreePath, log)
    return 'unlinked'
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    if (/not found/i.test(message)) {
      log('herd not found — skipping')
      return 'skipped'
    }
    // Herd exits non-zero when the directory was never linked. That is the
    // desired end state either way, so it is reported, not raised.
    log(`herd unlink: ${message}`)
    return 'skipped'
  }
}

export async function dropWorktreeDatabase(
  worktreePath: string,
  mainRoot: string,
  log: Log
): Promise<'dropped' | 'skipped'> {
  // Container mode (a generated compose file is present): tear down the app
  // container, then drop the per-worktree DB via the SHARED DB container.
  const composePath = worktreeComposePath(worktreePath)
  if (existsSync(composePath)) return dropContainerWorktree(worktreePath, composePath, log)

  const env = readEnvFile(join(worktreePath, '.env'))
  const conn = (env.DB_CONNECTION || 'mysql').toLowerCase()
  const db = env.DB_DATABASE
  const isMysql = conn === 'mysql' || conn === 'mariadb'
  const isPg = conn === 'pgsql' || conn === 'postgres' || conn === 'postgresql'
  if (!db || (!isMysql && !isPg)) {
    log(`No MySQL/Postgres database to drop (connection=${conn || 'none'})`)
    return 'skipped'
  }
  const mainDb = readEnvFile(join(mainRoot, '.env')).DB_DATABASE
  if (mainDb && db === mainDb) {
    log(`Refusing to drop \`${db}\` — it's the main checkout's database`)
    return 'skipped'
  }
  const host = env.DB_HOST || '127.0.0.1'
  const user = env.DB_USERNAME || (isPg ? 'postgres' : 'root')
  log(`Dropping database \`${db}\``)
  if (isMysql) {
    const port = env.DB_PORT || '3306'
    // MYSQL_PWD passes the password without exposing it on the command line.
    await runShell(
      'mysql',
      ['--protocol=TCP', `--host=${host}`, `--port=${port}`, `--user=${user}`, '-e', `DROP DATABASE IF EXISTS \`${db.replace(/`/g, '')}\``],
      worktreePath,
      log,
      env.DB_PASSWORD ? { MYSQL_PWD: env.DB_PASSWORD } : undefined
    )
  } else {
    const port = env.DB_PORT || '5432'
    // Connect to the maintenance `postgres` DB (you can't drop the DB you're
    // attached to). WITH (FORCE) terminates active connections — e.g. a still-
    // running dev server — so the drop doesn't fail.
    // ponytail: FORCE needs Postgres 13+; pre-13 would need pg_terminate_backend first.
    const sql = `DROP DATABASE IF EXISTS "${db.replace(/"/g, '')}" WITH (FORCE)`
    // PGPASSWORD passes the password without exposing it; --no-password fails
    // fast instead of prompting when auth is needed but unset.
    await runShell(
      'psql',
      [`--host=${host}`, `--port=${port}`, `--username=${user}`, '--dbname=postgres', '--no-password', '-c', sql],
      worktreePath,
      log,
      env.DB_PASSWORD ? { PGPASSWORD: env.DB_PASSWORD } : undefined
    )
  }
  return 'dropped'
}

// Bring a container-mode worktree's app back up when it's opened (the container
// only gets created during provisioning on create; reopening after a reboot or a
// `compose down` would otherwise leave nothing serving). Idempotent: `up -d` and
// the route write are both no-ops when already running. Skips silently for
// host-native projects. This also doubles as route reconcile — a reopened
// worktree re-writes its Caddy route, healing any drift.
export async function ensureContainerUp(
  root: string,
  worktreePath: string,
  branch: string
): Promise<void> {
  // On the server every worktree is container-mode; elsewhere gate on Project.env.
  if (getProjectEnv(root)?.mode !== 'container' && process.env.FLOE_IS_SERVER !== '1') return
  const composePath = worktreeComposePath(worktreePath)
  if (!existsSync(composePath)) return // never provisioned as a container — nothing to ensure
  const s = slug(branch)
  const log: Log = (t) => console.log(`[ensureContainerUp ${s}]`, t.trimEnd())
  await runShell('docker', ['compose', '-f', composePath, 'up', '-d'], worktreePath, log)
  // Route reconcile, server-only — both writes are no-ops on a desktop.
  const cfg = readSupportConfig()
  await writeWorktreeRoute(appHost(s, cfg), worktreePort(s))
  await writeWorktreeRoute(viteHost(s, cfg), worktreeVitePort(s))
}

// Distributive Omit so each ProvisionEvent variant keeps its own fields.
type WithoutWorktree<T> = T extends unknown ? Omit<T, 'worktreePath'> : never

// Provision a worktree: detect the stack, emit the step plan, then run the
// recipe in order, streaming progress. Stops at the first failed step. `from`
// resumes at a step (earlier ones are reported done without re-running) and
// `skip` marks steps skipped — together they back the checklist's retry/skip.
// --- the premise interview --------------------------------------------------
//
// The one part of setup that asks instead of runs. It rides the same checklist
// because that is where the user already is while a worktree comes up, but it
// runs BESIDE the recipe rather than inside it: composer install must not wait
// on a question, and a question must not wait on composer install.
//
// See premise.ts for what it writes and why the file exists at all.

/** The step id the interview reports under. */
export const PREMISE_STEP_ID = 'premise'

/** Questions on screen, waiting for the panel to answer them. */
const pendingAsks = new Map<string, { worktreePath: string; resolve: (answer: string | null) => void }>()

/**
 * The checklist answered. `null` skips the rest of the interview — one refusal
 * ends it, rather than asking the remaining questions of someone who has just
 * said they don't want to be asked.
 */
export function answerProvisionAsk(requestId: string, answer: string | null): void {
  const pending = pendingAsks.get(requestId)
  if (!pending) return
  pendingAsks.delete(requestId)
  pending.resolve(answer)
}

/** Drop a worktree's open questions — a re-run replaces the interview. */
function cancelAsks(worktreePath: string): void {
  for (const [id, pending] of Array.from(pendingAsks)) {
    if (pending.worktreePath !== worktreePath) continue
    pendingAsks.delete(id)
    pending.resolve(null)
  }
}

type Emit = (e: WithoutWorktree<ProvisionEvent>) => void

/**
 * Whether this run interviews the worktree.
 *
 * Only with an answer from the new-worktree form: the checklist no longer asks
 * the question itself, so a run without one (a re-run, a form left blank) has
 * nothing to write. Not on a retry (the `from` path re-runs a recipe that
 * failed halfway), unless the premise step is itself what they retried. Never
 * when the file is already there: a premise is written once and edited by hand
 * after that.
 */
function wantsInterview(worktreePath: string, opts: ProvisionOpts): boolean {
  if (!floeConfig().premise.enabled) return false
  if (!opts.premiseAnswer?.trim()) return false
  if (hasPremise(worktreePath)) return false
  if ((opts.skip ?? []).includes(PREMISE_STEP_ID)) return false
  return !opts.from || opts.from === PREMISE_STEP_ID
}

/** What `provision:run` may be asked for besides the recipe itself. */
export interface ProvisionOpts {
  from?: string
  skip?: string[]
  /** The interview's one answer, given up front (the new-worktree form asks
   *  it) — the premise is composed and written without a question on screen. */
  premiseAnswer?: string
}

async function runInterview(
  worktreePath: string,
  branch: string,
  emit: Emit,
  given?: string
): Promise<void> {
  const step = (status: ProvisionStep['status'], detail?: string): void =>
    emit({ kind: 'step', id: PREMISE_STEP_ID, status, detail })
  const clear = (): void => emit({ kind: 'ask', ask: null })

  const questions = interviewQuestions()
  if (!questions.length) return step('skipped')
  step('running')

  const answers: PremiseAnswer[] = []
  // Answered already: the same one question, only nobody has to be asked it.
  if (given?.trim()) answers.push({ question: questions[0].question, answer: given })
  for (const [i, q] of given?.trim() ? [] : questions.entries()) {
    const requestId = randomUUID()
    emit({
      kind: 'ask',
      ask: {
        stepId: PREMISE_STEP_ID,
        requestId,
        question: q.question,
        options: q.options,
        index: i + 1,
        total: questions.length
      }
    })
    const answer = await new Promise<string | null>((resolve) =>
      pendingAsks.set(requestId, { worktreePath, resolve })
    )
    // Skipped: stop asking, and leave the worktree without a premise rather
    // than writing one from half an interview.
    if (answer === null) {
      clear()
      return step('skipped')
    }
    if (answer.trim()) answers.push({ question: q.question, answer })
  }
  clear()
  if (!answers.length) return step('skipped')

  step('running', 'writing the premise')
  const body = await composePremise(worktreePath, branch, answers)
  if (!body) return step('failed', 'the model returned nothing to write')
  try {
    writePremise(worktreePath, body)
  } catch (e) {
    return step('failed', e instanceof Error ? e.message : String(e))
  }
  step('done', PREMISE_REL)
}

export async function provisionWorktree(
  win: BrowserWindow,
  root: string,
  worktreePath: string,
  branch: string,
  // Over the web bridge an omitted trailing arg arrives as `null` (JSON has no
  // `undefined`), which a `= {}` default doesn't catch — so accept null and
  // normalize, or `opts.skip` throws and takes the whole server down.
  opts: ProvisionOpts | null = {}
): Promise<void> {
  opts = opts ?? {}
  const emit = (e: WithoutWorktree<ProvisionEvent>): void => {
    if (!win.isDestroyed()) win.webContents.send('provision:event', { worktreePath, ...e })
  }
  // Registered for the whole run, so removing the tree can stop it and wait.
  const run = beginProvision(worktreePath)
  try {
    await runProvision(win, root, worktreePath, branch, opts, emit, run.signal)
  } finally {
    run.end()
  }
}

async function runProvision(
  win: BrowserWindow,
  root: string,
  worktreePath: string,
  branch: string,
  opts: ProvisionOpts,
  emit: Emit,
  signal: AbortSignal
): Promise<void> {

  // A re-run replaces whatever the last one was still asking.
  cancelAsks(worktreePath)
  // The interview is its own track, started before the recipe and never awaited
  // by it. `done` reports the RECIPE — a worktree whose environment is ready is
  // ready whether or not its premise has been written, and the checklist keeps
  // showing the question after the installs finish.
  // Started only once its row is on the checklist (below): a step event that
  // lands before the plan is overwritten by the plan's own `pending`.
  const interviewing = wantsInterview(worktreePath, opts)
  const premiseRow: ProvisionStep[] = interviewing
    ? [{ id: PREMISE_STEP_ID, label: 'What this worktree is for', status: 'pending' }]
    : []
  const startInterview = (): void => {
    if (interviewing) void runInterview(worktreePath, branch, emit, opts.premiseAnswer)
  }

  // Only wait when the main checkout itself is a known stack — otherwise a
  // genuinely stack-less project would hang for the full timeout on every
  // create. When `root` has a stack, the worktree will too once git settles.
  const stack = detectStack(root) ? await waitForStack(worktreePath) : detectStack(worktreePath)
  if (!stack) {
    // No recipe to run, but a worktree with no stack still has a purpose worth
    // writing down — the interview above is already running.
    emit({ kind: 'plan', branch, steps: premiseRow })
    startInterview()
    emit({ kind: 'done', ok: true })
    return
  }

  const projectName = basename(root)
  const linkName = `${projectName}-${slug(branch)}`
  // On the headless server there's no host PHP/Herd, so a Laravel worktree ALWAYS runs
  // in Docker — synthesize a container env when the project didn't pin one.
  const env =
    getProjectEnv(root) ??
    (process.env.FLOE_IS_SERVER === '1' && stack === 'laravel' ? defaultContainerEnv(worktreePath) : undefined)
  const ctx: Ctx = { win, root, worktreePath, branch, projectName, linkName, domain: `${linkName}.test`, env }

  // Container mode (Project.env, or forced on the server above) overrides the
  // host-native recipe; the env block always describes a Laravel runtime.
  const recipe =
    env?.mode === 'container' ? laravelContainerRecipe : stack === 'laravel' ? laravelRecipe : nodeRecipe
  const skip = new Set(opts.skip ?? [])

  const steps: ProvisionStep[] = [
    ...premiseRow,
    ...recipe.map((s) => ({
      id: s.id,
      label: s.label,
      status: (skip.has(s.id) ? 'skipped' : 'pending') as ProvisionStep['status']
    }))
  ]
  emit({ kind: 'plan', branch, steps })
  startInterview()

  let started = !opts.from
  let ok = true
  for (const def of recipe) {
    // The tree is being removed: the steps left would only write into a folder
    // that is about to be deleted.
    if (signal.aborted) {
      ok = false
      break
    }
    // Steps before `from` already ran in a previous pass — report them done.
    if (!started && def.id !== opts.from) {
      if (!skip.has(def.id)) emit({ kind: 'step', id: def.id, status: 'done', detail: 'already done' })
      continue
    }
    started = true
    if (skip.has(def.id)) {
      emit({ kind: 'step', id: def.id, status: 'skipped' })
      continue
    }
    emit({ kind: 'step', id: def.id, status: 'running' })
    try {
      const result = await def.run(ctx, (text) => emit({ kind: 'log', id: def.id, text }))
      emit({ kind: 'step', id: def.id, status: result })
    } catch (e) {
      emit({ kind: 'step', id: def.id, status: 'failed', detail: e instanceof Error ? e.message : String(e) })
      ok = false
      break
    }
  }
  emit({ kind: 'done', ok })
}
