#!/usr/bin/env node
// `rookery server <setup|up|down|restart|status>` — thin wrapper over a systemd user
// service. systemd already gives boot-on-login, restart-on-crash and cgroup caps; this
// adds the one-time bootstrap and prints the tailnet URL + token. On a host without
// systemd (macOS dev) `up` just runs the server in the foreground.
import { execFileSync, spawnSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, symlinkSync } from 'node:fs'
import { homedir, hostname, userInfo } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SERVER_JS = join(REPO, 'out/server/index.js')
const DATA_DIR = process.env.ROOKERY_DATA_DIR || join(homedir(), '.rookery')
const UNIT = join(homedir(), '.config/systemd/user/rookery.service')
const PORT = process.env.ROOKERY_PORT || '41600'
const HOST = process.env.ROOKERY_HOST || '127.0.0.1'

const C = { g: (s) => `\x1b[32m${s}\x1b[0m`, r: (s) => `\x1b[31m${s}\x1b[0m`, d: (s) => `\x1b[2m${s}\x1b[0m`, b: (s) => `\x1b[1m${s}\x1b[0m` }
const has = (cmd) => spawnSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }).status === 0
const hasSystemd = () => has('systemctl') && process.platform === 'linux'
const sc = (...args) => spawnSync('systemctl', ['--user', ...args], { stdio: 'inherit' })
const scq = (...args) => spawnSync('systemctl', ['--user', ...args], { encoding: 'utf8' }).stdout?.trim()

function token() {
  const f = join(DATA_DIR, 'rookery-token')
  return existsSync(f) ? readFileSync(f, 'utf8').trim() : '(gerado no 1º boot)'
}
function urls() {
  const t = token()
  const tn = tailnetName()
  const lines = [`  ${C.d('local:')}  http://127.0.0.1:${PORT}/?token=${t}`]
  if (tn) lines.push(`  ${C.d('tailnet:')} http://${tn}:${PORT}/?token=${t}`)
  else lines.push(`  ${C.d('lan:')}    http://${hostname()}:${PORT}/?token=${t}  ${C.d('(se HOST=0.0.0.0)')}`)
  return lines.join('\n')
}
function tailnetName() {
  try {
    const out = execFileSync('tailscale', ['status', '--json'], { encoding: 'utf8' })
    const j = JSON.parse(out)
    const dns = j.Self?.DNSName?.replace(/\.$/, '')
    return dns || null
  } catch {
    return null
  }
}

// --- distro / deps -------------------------------------------------------------------
function distro() {
  try {
    const os = readFileSync('/etc/os-release', 'utf8')
    const id = /^ID=(.*)$/m.exec(os)?.[1]?.replace(/"/g, '')
    return id || 'unknown'
  } catch {
    return process.platform === 'darwin' ? 'macos' : 'unknown'
  }
}
const PKG = {
  arch: { install: (p) => ['sudo', 'pacman', '-S', '--needed', '--noconfirm', ...p], names: { php: 'php', composer: 'composer', node: 'nodejs', npm: 'npm', git: 'git' } },
  debian: { install: (p) => ['sudo', 'apt-get', 'install', '-y', ...p], names: { php: 'php-cli', composer: 'composer', node: 'nodejs', npm: 'npm', git: 'git' } },
  ubuntu: { install: (p) => ['sudo', 'apt-get', 'install', '-y', ...p], names: { php: 'php-cli', composer: 'composer', node: 'nodejs', npm: 'npm', git: 'git' } },
  fedora: { install: (p) => ['sudo', 'dnf', 'install', '-y', ...p], names: { php: 'php-cli', composer: 'composer', node: 'nodejs', npm: 'npm', git: 'git' } }
}

function preflight() {
  const checks = ['node', 'git', 'php', 'composer', 'tailscale', 'claude', 'gh', 'valet']
  console.log(C.b('\nPreflight:'))
  const missing = []
  for (const c of checks) {
    const ok = has(c)
    console.log(`  ${ok ? C.g('✓') : C.r('✗')} ${c}`)
    if (!ok) missing.push(c)
  }
  return missing
}

function writeUnit() {
  mkdirSync(dirname(UNIT), { recursive: true })
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 })
  const path = ['/usr/local/bin', join(homedir(), '.local/bin'), join(homedir(), '.local/share/mise/shims'), '/usr/bin', '/bin'].join(':')
  const unit = `[Unit]
Description=Rookery headless server
After=network-online.target

[Service]
Type=simple
ExecStart=${process.execPath} ${SERVER_JS}
Environment=ROOKERY_PORT=${PORT}
Environment=ROOKERY_HOST=${HOST}
Environment=ROOKERY_DATA_DIR=${DATA_DIR}
Environment=ROOKERY_RENDERER_DIR=${join(REPO, 'out/renderer')}
Environment=PATH=${path}
WorkingDirectory=${REPO}
Restart=on-failure
RestartSec=2
# Resource caps (cgroup v2) — a runaway build degrades instead of OOM-killing the box.
MemoryMax=${process.env.ROOKERY_MEMORY_MAX || '24G'}
CPUQuota=${process.env.ROOKERY_CPU_QUOTA || '600%'}
TasksMax=4096

[Install]
WantedBy=default.target
`
  writeFileSync(UNIT, unit)
  console.log(C.g('✓') + ` unit escrito: ${UNIT}`)
}

// --- commands ------------------------------------------------------------------------
function cmdSetup() {
  console.log(C.b('rookery server setup') + C.d(`  (${distro()})`))
  if (!existsSync(SERVER_JS)) {
    console.log(C.r('✗') + ` build ausente: ${SERVER_JS}\n  rode: ${C.b('node scripts/build-server.mjs && pnpm exec electron-vite build')}`)
  }
  // Put a `rookery` on PATH so `rookery server update` works over SSH. ~/.local/bin is
  // already in the systemd unit's PATH; ln -sfn is idempotent (re-setup just re-points it).
  const binDir = join(homedir(), '.local/bin')
  mkdirSync(binDir, { recursive: true })
  spawnSync('ln', ['-sfn', join(REPO, 'bin/rookery-server.mjs'), join(binDir, 'rookery')])
  console.log(C.g('✓') + ` comando ${C.b('rookery')} em ${join(binDir, 'rookery')}` + C.d('  (garanta ~/.local/bin no PATH do shell)'))
  const missing = preflight()
  const d = distro()
  const pkg = PKG[d]
  const sysMissing = missing.filter((m) => ['node', 'git', 'php', 'npm'].includes(m) || (m === 'composer' && pkg))
  if (pkg && sysMissing.length) {
    const names = sysMissing.map((m) => pkg.names[m] || m)
    const cmd = pkg.install(names)
    console.log(C.b('\nInstalar deps de sistema:'), C.d(cmd.join(' ')))
    if (process.argv.includes('--yes')) {
      spawnSync(cmd[0], cmd.slice(1), { stdio: 'inherit' })
    } else {
      console.log(C.d('  (rode com --yes pra instalar, ou execute o comando acima manualmente)'))
    }
  }
  if (hasSystemd()) {
    writeUnit()
    sc('daemon-reload')
    sc('enable', 'rookery')
    // linger keeps the user manager (and thus the service) alive after logout/SSH-disconnect;
    // needs the real username (not $USER, which can be empty under systemd/ssh exec) and sudo.
    spawnSync('sudo', ['loginctl', 'enable-linger', userInfo().username], { stdio: 'inherit' })
    console.log(C.g('✓') + ' serviço habilitado (sobe no boot via linger)')
  } else {
    console.log(C.d('\n(sem systemd — em Linux o setup escreveria o unit; use `up` pra rodar em foreground)'))
  }
  console.log(C.b('\nPassos interativos (precisam da sua conta):'))
  if (missing.includes('tailscale') || !tailnetName()) console.log('  • ' + C.b('tailscale up') + C.d('  — entrar na tailnet'))
  if (missing.includes('claude')) console.log('  • ' + C.b('claude') + C.d('  — autenticar o Claude Code'))
  if (missing.includes('gh')) console.log('  • ' + C.b('gh auth login'))
  if (missing.includes('valet')) console.log('  • ' + C.b('composer global require cpriego/valet-linux && valet install'))
  console.log(C.b('\nDepois:') + ' rookery server up\n')
}

function cmdUp() {
  if (hasSystemd()) {
    if (!existsSync(UNIT)) {
      console.log(C.r('unit ausente — rode `rookery server setup` primeiro'))
      process.exit(1)
    }
    const r = sc('start', 'rookery')
    if (r.status === 0) {
      console.log(C.g('✓ rookery up'))
      console.log(urls())
    }
  } else {
    console.log(C.d('sem systemd — rodando em foreground (ctrl-c pra parar)'))
    console.log(urls())
    const env = { ...process.env, ROOKERY_PORT: PORT, ROOKERY_HOST: HOST, ROOKERY_DATA_DIR: DATA_DIR, ROOKERY_RENDERER_DIR: join(REPO, 'out/renderer') }
    spawn(process.execPath, [SERVER_JS], { stdio: 'inherit', env })
  }
}

function cmdStatus() {
  if (hasSystemd()) {
    const active = scq('is-active', 'rookery')
    console.log(`${active === 'active' ? C.g('● active') : C.r('○ ' + active)}`)
    // resource usage from the cgroup
    const mem = scq('show', 'rookery', '-p', 'MemoryCurrent')?.split('=')[1]
    if (mem && mem !== '[not set]') console.log(C.d(`  mem: ${(Number(mem) / 1048576).toFixed(0)} MB`))
  } else {
    console.log(C.d('sem systemd (dev)'))
  }
  // health check
  const health = spawnSync('curl', ['-sS', '-m', '3', `http://127.0.0.1:${PORT}/healthz`], { encoding: 'utf8' }).stdout
  console.log(health ? C.g('  health: ') + health.trim() : C.r('  health: sem resposta'))
  console.log(urls())
}

const REPO_SLUG = process.env.ROOKERY_REPO || 'r2luna/rookery'
const VERSION_FILE = join(REPO, '.version')

// Self-hosted update. Two modes, auto-detected:
//  • server (only out/+bin/ shipped, no scripts/) → download the prebuilt tarball from
//    the latest GitHub release via `gh` and swap it in. No toolchain, no inbound access.
//  • dev/source checkout (has scripts/) → git pull + rebuild.
// Either way the browser web-bridge auto-reconnects, so the ~1s restart blip is invisible.
function cmdUpdate() {
  const hasToolchain = existsSync(join(REPO, 'scripts/build-server.mjs'))
  if (!hasToolchain || process.argv.includes('--release')) return updateFromRelease()

  const isRepo = existsSync(join(REPO, '.git'))
  const hasUpstream =
    isRepo && spawnSync('git', ['-C', REPO, 'rev-parse', '--abbrev-ref', '@{u}'], { stdio: 'ignore' }).status === 0
  if (hasUpstream && !process.argv.includes('--no-pull')) {
    console.log(C.b('git pull…'))
    spawnSync('git', ['-C', REPO, 'pull', '--ff-only'], { stdio: 'inherit' })
  } else if (isRepo) {
    console.log(C.d('(sem upstream — build direto do que está commitado aqui)'))
  }
  if (existsSync(join(REPO, 'scripts/build-server.mjs'))) {
    console.log(C.b('build…'))
    const r1 = spawnSync(process.execPath, [join(REPO, 'scripts/build-server.mjs')], { cwd: REPO, stdio: 'inherit' })
    const r2 = spawnSync('pnpm', ['exec', 'electron-vite', 'build'], { cwd: REPO, stdio: 'inherit' })
    if (r1.status || r2.status) {
      console.log(C.r('build falhou — não reiniciei (server segue no ar com a versão antiga)'))
      process.exit(1)
    }
  } else {
    console.log(C.d('(sem fonte/toolchain aqui — assumindo out/ já atualizado via deploy)'))
  }
  if (hasSystemd()) sc('restart', 'rookery')
  console.log(C.g('✓ atualizado e reiniciado'))
}

// Download the latest release tarball and swap out/ + bin/ in place (server mode).
function updateFromRelease() {
  if (!has('gh')) {
    console.log(C.r('gh não encontrado — precisa do GitHub CLI autenticado pra baixar o release'))
    process.exit(1)
  }
  // Pick the newest server-* release — NOT `gh release view` (that returns the overall
  // "Latest", which is the desktop app release and has no rookery-server-*.tgz asset).
  const view = spawnSync('gh', ['release', 'list', '--repo', REPO_SLUG, '--limit', '30', '--json', 'tagName', '-q', '[.[].tagName | select(startswith("server-"))][0]'], { encoding: 'utf8' })
  if (view.status !== 0) {
    console.log(C.r('não achei release (gh autenticado? acesso ao repo?)'))
    process.exit(1)
  }
  const latest = view.stdout.trim()
  if (!latest) {
    console.log(C.r('nenhum release server-* publicado ainda (o workflow build-server rodou com sucesso?)'))
    process.exit(1)
  }
  const current = existsSync(VERSION_FILE) ? readFileSync(VERSION_FILE, 'utf8').trim() : ''
  if (latest === current && !process.argv.includes('--force')) {
    console.log(C.d(`já na ${latest} — nada a fazer (use --force pra reaplicar)`))
    return
  }
  console.log(C.b(`baixando ${latest}…`))
  const tmp = join('/tmp', `rookery-${latest}.tgz`)
  const dl = spawnSync('gh', ['release', 'download', latest, '--repo', REPO_SLUG, '--pattern', 'rookery-server-*.tgz', '--output', tmp, '--clobber'], { stdio: 'inherit' })
  if (dl.status) { console.log(C.r('download falhou')); process.exit(1) }
  // The tarball carries only out/ bin/ package.json — no node_modules — so the server's
  // native deps (node-pty) survive the extract untouched.
  // ponytail: package.json is overwritten but deps aren't reinstalled; run `pnpm i` by
  //   hand on the rare release that bumps dependencies.
  const ex = spawnSync('tar', ['xzf', tmp, '-C', REPO], { stdio: 'inherit' })
  if (ex.status) { console.log(C.r('extract falhou — server segue na versão antiga')); process.exit(1) }
  writeFileSync(VERSION_FILE, latest)
  if (hasSystemd()) sc('restart', 'rookery')
  console.log(C.g(`✓ atualizado para ${latest} e reiniciado`))
}

// ── support stack (docker compose) ─────────────────────────────────────────────
// Shared MySQL + Postgres + Adminer + Caddy on the server box. One database per
// worktree lives in the shared DBs (provisioning creates them), so N worktrees
// don't spawn N DB containers. Caddy fronts rookery/adminer with valid TLS.
const SUPPORT_DIR = join(REPO, 'deploy/support')
const SUPPORT_COMPOSE = join(SUPPORT_DIR, 'docker-compose.yml')
const SUPPORT_LOCAL = join(SUPPORT_DIR, 'docker-compose.local.yml')
const SUPPORT_ENV = join(DATA_DIR, 'support.env')

// `--local` layers the HTTP-only override (no Cloudflare, no port collisions) for
// testing on a dev machine.
const dockerCompose = (...args) => {
  const files = ['-f', SUPPORT_COMPOSE]
  if (process.argv.includes('--local')) files.push('-f', SUPPORT_LOCAL)
  return spawnSync('docker', ['compose', '--project-directory', SUPPORT_DIR, ...files, '--env-file', SUPPORT_ENV, ...args], { stdio: 'inherit' })
}

// Docker isn't in the setup deps (it's server-only). Install on Arch (the Beelink);
// elsewhere point at the convenience script. Returns whether docker is usable now.
function ensureDocker() {
  if (has('docker')) return true
  console.log(C.r('✗') + ' docker não encontrado')
  if (distro() === 'arch') {
    const steps = [
      ['sudo', ['pacman', '-S', '--needed', '--noconfirm', 'docker', 'docker-compose']],
      ['sudo', ['systemctl', 'enable', '--now', 'docker']],
      ['sudo', ['usermod', '-aG', 'docker', userInfo().username]]
    ]
    if (process.argv.includes('--yes')) {
      for (const [c, a] of steps) spawnSync(c, a, { stdio: 'inherit' })
      console.log(C.d('  → faça logout/login pro grupo docker valer, e rode de novo'))
    } else {
      console.log(C.d('  ' + steps.map(([c, a]) => [c, ...a].join(' ')).join('\n  ')))
      console.log(C.d('  (rode com --yes pra instalar)'))
    }
  } else {
    console.log(C.d('  curl -fsSL https://get.docker.com | sudo sh'))
  }
  return has('docker')
}

// Seed ~/.rookery/support.env from the example on first run; return false (halt)
// when we just created it, so the user fills in the token/passwords before `up`.
function ensureSupportEnv() {
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 })
  if (existsSync(SUPPORT_ENV)) return true
  writeFileSync(SUPPORT_ENV, readFileSync(join(SUPPORT_DIR, '.env.example'), 'utf8'))
  console.log(C.g('✓') + ` env criado: ${SUPPORT_ENV}`)
  console.log(C.r('  → preencha CLOUDFLARE_API_TOKEN e as senhas, depois rode `rookery server support up` de novo'))
  return false
}
function supportDomain() {
  try {
    return /^DOMAIN=(.*)$/m.exec(readFileSync(SUPPORT_ENV, 'utf8'))?.[1]?.trim() || 'pinguim.io'
  } catch {
    return 'pinguim.io'
  }
}
function cmdSupport(sub) {
  if (!ensureDocker()) process.exit(1)
  if (sub === 'up') {
    if (!ensureSupportEnv()) process.exit(1)
    if (dockerCompose('up', '-d', '--build').status) process.exit(1)
    const d = supportDomain()
    console.log(C.g('✓ support stack no ar'))
    console.log(`  ${C.d('ide:')} https://ide.${d}`)
    console.log(`  ${C.d('db:')}  https://db.dev.${d}`)
    console.log(`  ${C.d('mysql:')} 127.0.0.1:3306  ${C.d('postgres:')} 127.0.0.1:5432  ${C.d('redis:')} 127.0.0.1:6379`)
  } else if (sub === 'down') {
    dockerCompose('down')
  } else if (sub === 'status') {
    dockerCompose('ps')
  } else if (sub === 'logs') {
    dockerCompose('logs', '-f', '--tail=100')
  } else {
    console.log(`${C.b('rookery server support')} <up|down|status|logs>\n  up      sobe MySQL+Postgres+Redis+DBGate (edge/TLS = Caddy do host)\n  down    para o stack\n  status  docker compose ps\n  logs    segue os logs`)
  }
}

// ── worktree instances ───────────────────────────────────────────────────────
// One isolated Rookery per worktree: own port + own data dir + own systemd unit.
// `rookery worktree up` (inside a worktree) auto-detects the branch and a free port.
const WT_HOST = process.env.ROOKERY_WT_HOST || '127.0.0.1' // reverse-proxied by Caddy/tailscale serve
const WT_BASE_PORT = Number(process.env.ROOKERY_WT_BASE || 41601)

const gitOut = (args) => {
  const r = spawnSync('git', args, { encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim() : null
}
const slugify = (s) => s.replace(/[^a-zA-Z0-9]+/g, '-').replace(/(^-|-$)/g, '').toLowerCase()
const wtUnit = (slug) => `rookery-wt-${slug}`
const wtUnitPath = (slug) => join(homedir(), '.config/systemd/user', `${wtUnit(slug)}.service`)
const unitPort = (path) => {
  if (!existsSync(path)) return null
  const m = /ROOKERY_PORT=(\d+)/.exec(readFileSync(path, 'utf8'))
  return m ? Number(m[1]) : null
}
function usedPorts() {
  const ports = new Set([Number(PORT)])
  const dir = join(homedir(), '.config/systemd/user')
  if (existsSync(dir))
    for (const f of readdirSync(dir))
      if (/^rookery-wt-.*\.service$/.test(f)) {
        const p = unitPort(join(dir, f))
        if (p) ports.add(p)
      }
  return ports
}
function portListening(p) {
  const ss = spawnSync('ss', ['-ltnH'], { encoding: 'utf8' })
  if (ss.status === 0) return new RegExp(`:${p}(\\s|$)`, 'm').test(ss.stdout)
  const lsof = spawnSync('lsof', ['-nP', `-iTCP:${p}`, '-sTCP:LISTEN'], { encoding: 'utf8' })
  return !!(lsof.stdout || '').trim()
}
function firstFreePort() {
  const used = usedPorts()
  for (let p = WT_BASE_PORT; p < WT_BASE_PORT + 500; p++) if (!used.has(p) && !portListening(p)) return p
  throw new Error('sem porta livre')
}
function currentWorktree() {
  const root = gitOut(['rev-parse', '--show-toplevel'])
  const branch = gitOut(['rev-parse', '--abbrev-ref', 'HEAD'])
  if (!root || !branch || branch === 'HEAD') {
    console.log(C.r('rode dentro de uma worktree git com uma branch (HEAD destacado não serve)'))
    process.exit(1)
  }
  return { root, branch, slug: slugify(branch) }
}
// A fresh worktree has no node_modules; reuse the main checkout's via a symlink.
function ensureNodeModules(root) {
  if (existsSync(join(root, 'node_modules'))) return
  const main = (gitOut(['worktree', 'list', '--porcelain']) || '')
    .split('\n')
    .find((l) => l.startsWith('worktree '))
    ?.slice(9)
  if (main && main !== root && existsSync(join(main, 'node_modules'))) {
    symlinkSync(join(main, 'node_modules'), join(root, 'node_modules'))
    console.log(C.d(`  node_modules linkado de ${main}`))
  }
}
function writeWtUnit(slug, root, branch, port) {
  const path = wtUnitPath(slug)
  mkdirSync(dirname(path), { recursive: true })
  const dataDir = join(homedir(), `.rookery-wt-${slug}`)
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const envPath = ['/usr/local/bin', join(homedir(), '.local/bin'), join(homedir(), '.local/share/mise/shims'), '/usr/bin', '/bin'].join(':')
  writeFileSync(
    path,
    `[Unit]
Description=Rookery worktree — ${branch}
After=network-online.target

[Service]
Type=simple
ExecStart=${process.execPath} ${join(root, 'out/server/index.js')}
Environment=ROOKERY_PORT=${port}
Environment=ROOKERY_HOST=${WT_HOST}
Environment=ROOKERY_DATA_DIR=${dataDir}
Environment=ROOKERY_RENDERER_DIR=${join(root, 'out/renderer')}
Environment=PATH=${envPath}
WorkingDirectory=${root}
Restart=on-failure
RestartSec=2
MemoryMax=${process.env.ROOKERY_WT_MEMORY_MAX || '8G'}
CPUQuota=${process.env.ROOKERY_WT_CPU_QUOTA || '300%'}
TasksMax=2048

[Install]
WantedBy=default.target
`
  )
}
function cmdWtUp() {
  const { root, branch, slug } = currentWorktree()
  const port = unitPort(wtUnitPath(slug)) || firstFreePort() // reuse this branch's port; else first free
  if (!existsSync(join(root, 'out/server/index.js')) || process.argv.includes('--build')) {
    ensureNodeModules(root)
    console.log(C.b(`build (${branch})…`))
    const r1 = spawnSync(process.execPath, [join(root, 'scripts/build-server.mjs')], { cwd: root, stdio: 'inherit' })
    const r2 = spawnSync('pnpm', ['exec', 'electron-vite', 'build'], { cwd: root, stdio: 'inherit' })
    if (r1.status || r2.status) {
      console.log(C.r('build falhou'))
      process.exit(1)
    }
  }
  writeWtUnit(slug, root, branch, port)
  if (hasSystemd()) {
    sc('daemon-reload')
    sc('enable', wtUnit(slug))
    sc('restart', wtUnit(slug))
    const tn = tailnetName()
    console.log(C.g(`✓ worktree "${branch}" up`) + C.d(`  porta ${port}`))
    console.log(`  ${C.d('local:')}   http://127.0.0.1:${port}/`)
    if (tn) console.log(`  ${C.d('tailnet:')} http://${tn}:${port}/   ${C.d(`(→ ${slug}.rookery.<domínio> via Caddy)`)}`)
  } else {
    console.log(C.d(`(sem systemd) porta ${port} — rode: ROOKERY_PORT=${port} ROOKERY_DATA_DIR=~/.rookery-wt-${slug} node ${join(root, 'out/server/index.js')}`))
  }
}
function cmdWtDown() {
  const { branch, slug } = currentWorktree()
  if (hasSystemd()) {
    sc('stop', wtUnit(slug))
    sc('disable', wtUnit(slug))
  }
  console.log(C.g(`✓ worktree "${branch}" down`))
}
function cmdWtList() {
  const dir = join(homedir(), '.config/systemd/user')
  const units = existsSync(dir) ? readdirSync(dir).filter((f) => /^rookery-wt-.*\.service$/.test(f)) : []
  if (!units.length) return console.log(C.d('(nenhuma worktree up)'))
  for (const f of units) {
    const slug = f.replace(/^rookery-wt-|\.service$/g, '')
    const port = unitPort(join(dir, f))
    const active = hasSystemd() ? scq('is-active', f) : '?'
    console.log(`${active === 'active' ? C.g('●') : C.r('○')} ${slug}  ${C.d('porta ' + port + '  http://127.0.0.1:' + port + '/')}`)
  }
}

// ── container command router ─────────────────────────────────────────────────
// `rookery <artisan|bun|composer|php|node|npm|npx|pnpm|yarn|bunx> …` runs the
// command INSIDE this worktree's app container (the serversideup image is built
// with node+bun baked in). The same `rookery <cmd>` process command therefore
// works containerized on the server and — when there's no worktree compose file —
// falls back to running on the host (macOS desktop). This is why FleetView process
// commands are prefixed with `rookery`: the prefix routes them into Docker.
const CONTAINER_CMDS = new Set(['artisan', 'bun', 'bunx', 'composer', 'php', 'node', 'npm', 'npx', 'pnpm', 'yarn'])

function findWorktreeCompose(start) {
  let dir = start
  for (;;) {
    const p = join(dir, '.rookery', 'docker-compose.yml')
    if (existsSync(p)) return p
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

function routeContainer(argv) {
  // `artisan …` is shorthand for `php artisan …` inside the container.
  const inner = argv[0] === 'artisan' ? ['php', 'artisan', ...argv.slice(1)] : argv
  const compose = findWorktreeCompose(process.cwd())
  if (!compose) {
    // No container here (desktop/host) — run it directly so the command is portable.
    const r = spawnSync(inner[0], inner.slice(1), { stdio: 'inherit' })
    process.exit(r.status ?? 1)
  }

  // `docker exec` DOESN'T tie the in-container process to the client: kill the client
  // and the process is reparented to PID 1 and keeps running (orphaned vite/worker).
  // So run the command inside its own session (`setsid -w`, which stays attached so
  // logs stream and the exit code propagates) and record its pgid; on any termination
  // signal we kill that whole group in the container — taking down bun AND the vite it
  // spawned. ponytail: the pgid file is per-rookery-pid, so two runs never collide.
  const tty = process.stdin.isTTY
  const base = ['compose', '-f', compose, 'exec', ...(tty ? [] : ['-T']), 'app']
  const pgidFile = `/tmp/rookery-${process.pid}.pgid`
  const wrapped = ['setsid', '-w', 'sh', '-c', `echo $$ > ${pgidFile}; exec "$@"`, 'rookery', ...inner]
  const child = spawn('docker', [...base, ...wrapped], { stdio: 'inherit' })

  let cleaning = false
  const cleanup = (sig) => {
    if (cleaning) return
    cleaning = true
    spawnSync(
      'docker',
      ['compose', '-f', compose, 'exec', '-T', 'app', 'sh', '-c', `kill -TERM -"$(cat ${pgidFile} 2>/dev/null)" 2>/dev/null; rm -f ${pgidFile}`],
      { stdio: 'ignore', timeout: 5000 }
    )
    child.kill(sig)
  }
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => cleanup(sig))
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
}

// ── schedules ────────────────────────────────────────────────────────────────
// `rookery schedule:run` is the dumb cron trigger (system cron fires it every
// minute); the running server process owns the actual "what's due" decision —
// see src/main/schedules.ts. Just asks the already-running server to tick.
async function cmdScheduleRun() {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/schedule/run?token=${encodeURIComponent(token())}`)
  const text = await res.text()
  if (!res.ok) {
    console.error(C.r('schedule:run failed'), text)
    process.exit(1)
  }
  console.log(text)
}

// ── dispatch ─────────────────────────────────────────────────────────────────
const serverMap = {
  setup: cmdSetup,
  up: cmdUp,
  down: () => (hasSystemd() ? sc('stop', 'rookery') : console.log('n/a')),
  restart: () => (hasSystemd() ? sc('restart', 'rookery') : console.log('n/a')),
  update: cmdUpdate,
  status: cmdStatus,
  support: () => cmdSupport(group === 'server' ? process.argv[4] : process.argv[3]),
  'schedule:run': cmdScheduleRun
}
const wtMap = { up: cmdWtUp, down: cmdWtDown, list: cmdWtList }

const group = process.argv[2]
if (group === 'worktree') {
  const sub = process.argv[3]
  if (wtMap[sub]) wtMap[sub]()
  else console.log(`${C.b('rookery worktree')} <up|down|list>\n  up    sobe esta worktree (branch + porta automáticos); --build p/ rebuildar\n  down  para esta worktree\n  list  worktrees no ar`)
} else {
  // `rookery server <cmd>` and back-compat bare `rookery <cmd>`
  const cmd = group === 'server' ? process.argv[3] : group
  if (serverMap[cmd]) serverMap[cmd]()
  else if (CONTAINER_CMDS.has(group)) routeContainer(process.argv.slice(2))
  else {
    console.log(`${C.b('rookery server')} <command>\n  setup    bootstrap idempotente da máquina\n  up       inicia o serviço principal\n  down     para o serviço\n  restart  reinicia\n  update   baixa último release do GitHub (server) ou git pull+build (dev) e reinicia\n  status   estado + saúde + URLs\n  support  <up|down|status|logs> — DBs+DBGate+Caddy compartilhados (docker)\n  schedule:run   dispara a checagem de cron jobs agendados (chamar do crontab a cada minuto)\n\n${C.b('rookery worktree')} <up|down|list>   instância isolada por worktree (porta automática)`)
    process.exit(cmd ? 1 : 0)
  }
}
