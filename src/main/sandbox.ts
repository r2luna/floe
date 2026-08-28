import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'

// Sandbox the untrusted code that dependency installs run. npm/pnpm/bun/composer
// execute arbitrary scripts (preinstall/postinstall, composer plugins) from
// transitive deps — the classic supply-chain vector — with the user's full
// environment. This module wraps an install in bubblewrap (bwrap) so that script
// can't read the secrets that would let it do real damage: ~/.ssh keys, the gh
// token, the sops age key, or the sibling projects in ~/code.
//
// Strategy: tmpfs over $HOME (which hides ~/.ssh, ~/.config/gh, ~/.config/sops
// AND every sibling under ~/code, since they all live under $HOME), then bind
// back ONLY the worktree (read-write, the install target), the language toolchain
// (read-only, so the package manager binary resolves) and the package-manager
// caches (read-write, so installs stay fast). The environment is an allowlist,
// not process.env passthrough — notably SSH_AUTH_SOCK and *_TOKEN are dropped, so
// a forwarded agent or a leaked token can't be used even indirectly.
//
// Linux only: bwrap is a Linux tool. macOS hardening (sandbox-exec) is a follow-up
// (Fase 1.5); on darwin callers run unsandboxed with a loud log, never silently.

// Scan $PATH for an executable, like `which`. Avoids spawning just to probe.
function whichSync(bin: string): boolean {
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    if (dir && existsSync(join(dir, bin))) return true
  }
  return false
}

// Opt-out escape hatch: ROOKERY_SANDBOX=0 disables sandboxing everywhere.
export const sandboxDisabled = (): boolean => process.env.ROOKERY_SANDBOX === '0'

// bwrap is present and usable on this (Linux) host. When false on Linux and the
// sandbox wasn't explicitly disabled, callers must fail closed rather than run an
// install with the full environment.
export const bwrapPresent = (): boolean => process.platform === 'linux' && whichSync('bwrap')

// The sandbox will actually be applied for a sandbox-requested run. Tests gate on
// this so they only run where bwrap can enforce the isolation they assert.
export const sandboxAvailable = (): boolean => !sandboxDisabled() && bwrapPresent()

// Env vars kept when entering the sandbox. Everything else is dropped — an
// allowlist is the safe default here (a denylist forgets the next secret var).
const ENV_KEEP = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'TERM', 'TMPDIR'
])
// Prefix-matched families the install legitimately reads (proxy + per-manager
// config). Kept broad on purpose; none of these carry the four target secrets.
const ENV_KEEP_PREFIX = [
  'LC_', 'npm_config_', 'NODE_', 'COREPACK_', 'BUN_', 'PNPM_', 'COMPOSER_',
  'http_proxy', 'https_proxy', 'no_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY'
]

function allowlistEnv(): Record<string, string> {
  const out: Record<string, string> = { FORCE_COLOR: '0' }
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue
    if (ENV_KEEP.has(k) || ENV_KEEP_PREFIX.some((p) => k.startsWith(p))) out[k] = v
  }
  // ponytail: ~/.npmrc / private-registry tokens are intentionally NOT re-exposed;
  // a private-dep install that needs them is an opt-in for a later phase.
  return out
}

export interface SandboxSpawn {
  cmd: string // always 'bwrap'
  args: string[] // bwrap flags, ending so the caller appends the real command
  env: Record<string, string> // allowlisted environment for the bwrap process
}

// Build the bwrap invocation that isolates an install running in `worktreePath`.
// The caller appends the actual command, e.g. `['/bin/sh', '-c', 'pnpm install']`,
// and spawns `cmd` with `args` + that command, using `env`. bwrap passes its own
// (allowlisted) environment through to the child, so no --setenv is needed.
export function sandboxedSpawn(worktreePath: string): SandboxSpawn {
  const home = process.env.HOME || '/root'
  const roBind = (src: string, dst = src): string[] => ['--ro-bind-try', src, dst]
  const rwBind = (src: string, dst = src): string[] => ['--bind-try', src, dst]

  const args: string[] = [
    '--die-with-parent',
    // System dirs read-only so the toolchain + libs + certs resolve. /etc gives
    // resolv.conf, ca-certificates and passwd (getpwuid for HOME); the resolve
    // stub covers systemd-resolved's symlinked resolv.conf so DNS works.
    ...roBind('/usr'), ...roBind('/bin'), ...roBind('/sbin'),
    ...roBind('/lib'), ...roBind('/lib64'), ...roBind('/opt'),
    ...roBind('/etc'), ...roBind('/run/systemd/resolve'),
    '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
    // Empty $HOME hides ~/.ssh, ~/.config/{gh,sops}, and every sibling in ~/code.
    '--tmpfs', home,
    // Toolchain back read-only so `npm`/`pnpm`/`bun`/`php`/`composer` on $PATH
    // resolve. --ro-bind-try silently skips whichever managers aren't installed.
    ...roBind(join(home, '.asdf')),
    ...roBind(join(home, '.local/share/mise')),
    ...roBind(join(home, '.nvm')),
    ...roBind(join(home, '.volta')),
    ...roBind(join(home, '.bun')),
    ...roBind(join(home, '.local/bin')),
    // Package-manager caches read-write so installs don't re-download every time.
    // These override the read-only toolchain binds above for their subpaths
    // (bwrap applies binds in order), e.g. ~/.bun/install/cache under ~/.bun.
    ...rwBind(join(home, '.npm')),
    ...rwBind(join(home, '.cache/yarn')),
    ...rwBind(join(home, '.cache/composer')),
    ...rwBind(join(home, '.config/composer')),
    ...rwBind(join(home, '.local/share/pnpm')),
    ...rwBind(join(home, '.bun/install/cache')),
    // The one writable project path: the install's actual target.
    '--bind', worktreePath, worktreePath,
    '--chdir', worktreePath,
    // Isolate everything, then re-share only the network — `install` needs the
    // registry. ponytail: --share-net also reaches the LAN/tailnet; with the
    // secrets already gone a reachable host has nothing to authenticate with, so
    // closing egress (pasta/slirp4netns + allowlist) is deferred to a later phase.
    '--unshare-all', '--share-net',
    '--'
  ]
  return { cmd: 'bwrap', args, env: allowlistEnv() }
}
