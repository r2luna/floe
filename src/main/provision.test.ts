import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { BrowserWindow } from 'electron'
import type { ProvisionEvent } from '../shared/types.ts'

// Provisioning is decision logic wrapped around three things a test must not
// really do: spawn processes, start PTYs, and enter a bwrap sandbox. Those three
// are stubbed — and only when provision.ts is the importer, so the real project
// store, command store and compose writer still run. What is left to test is what
// the recipes decide: which command line gets built, what it does with the exit
// code, and which steps the checklist is told about.

const trash: string[] = []
function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  trash.push(dir)
  return dir
}
after(() => {
  for (const dir of trash) rmSync(dir, { recursive: true, force: true })
})

// A private HOME + XDG dir: readSupportConfig (~/.floe/support.env), the global
// composer auth and the project store all read real paths, and none of them may
// see the machine's own. compose.ts resolves support.env at import time, so this
// has to happen before the dynamic import below.
const HOME = tmp('floe-home-')
process.env.HOME = HOME
process.env.XDG_CONFIG_HOME = join(HOME, '.config')
process.env.COMPOSER_HOME = join(HOME, '.composer')
mkdirSync(join(HOME, '.floe'), { recursive: true })
writeFileSync(
  join(HOME, '.floe', 'support.env'),
  'DOMAIN=test.example\nMYSQL_ROOT_PASSWORD=rootpw\nPOSTGRES_PASSWORD=pgpw\n'
)
// The premise interview is off for the recipe tests: it is a real `claude`
// spawn (premise.ts is not behind the child_process stub below) and it would
// put its own row on every checklist these tests assert on. Its own test turns
// it back on with the model faked.
mkdirSync(join(HOME, '.config', 'floe'), { recursive: true })
writeFileSync(join(HOME, '.config', 'floe', 'floe.toml'), '[premise]\nenabled = false\n')

const hookSource = `
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
const STUBS = {
  'node:child_process': 'stub:child_process',
  './commandRunner': 'stub:commandRunner',
  './sandbox': 'stub:sandbox'
}
export async function resolve(specifier, context, next) {
  if (specifier === 'electron') return { url: 'stub:electron', shortCircuit: true, format: 'module' }
  if (STUBS[specifier] && (context.parentURL ?? '').endsWith('/provision.ts'))
    return { url: STUBS[specifier], shortCircuit: true, format: 'module' }
  // premise.ts spawns the interview's model. Same stub, so the one test that
  // turns the interview on decides what the model said.
  if (specifier === 'node:child_process' && (context.parentURL ?? '').endsWith('/premise.ts'))
    return { url: 'stub:child_process', shortCircuit: true, format: 'module' }
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\\.[a-z]+$/i.test(specifier)) {
    try {
      const base = context.parentURL ? new URL(specifier, context.parentURL) : pathToFileURL(specifier)
      const tsPath = fileURLToPath(base) + '.ts'
      if (existsSync(tsPath)) return next(specifier + '.ts', context)
    } catch {}
  }
  return next(specifier, context)
}
const SOURCE = {
  'stub:electron': "export const app = { getPath: () => '/tmp' }; export const dialog = {}; export class BrowserWindow {}; export default {};",
  'stub:commandRunner':
    "export function userShell() { return '/bin/zsh' }" +
    "\\nexport function startCommand(win, key, cwd, branch, command, cols, rows, watch, autoRestart) {" +
    "\\n  globalThis.__provStarted.push({ key, cwd, branch, command, cols, rows, watch, autoRestart })" +
    "\\n}",
  'stub:sandbox':
    "export const sandboxDisabled = () => globalThis.__provSandbox.disabled" +
    "\\nexport const bwrapPresent = () => globalThis.__provSandbox.bwrap" +
    "\\nexport const sandboxedSpawn = (cwd) => ({ cmd: 'bwrap', args: ['--bind', cwd, cwd], env: { SANDBOX: '1' } })",
  // A child that answers the way the real one does: data on stdout/stderr, then
  // either an 'error' or an 'exit' with the planned code.
  'stub:child_process':
    "import { EventEmitter } from 'node:events'" +
    "\\nexport function spawn(cmd, args, opts) {" +
    "\\n  const plan = globalThis.__provSpawnPlan(cmd, args) ?? {}" +
    "\\n  globalThis.__provSpawns.push({ cmd, args, cwd: opts.cwd, env: opts.env })" +
    "\\n  if (plan.throwOnSpawn) throw new Error(plan.throwOnSpawn)" +
    "\\n  const child = new EventEmitter()" +
    "\\n  child.stdout = new EventEmitter()" +
    "\\n  child.stderr = new EventEmitter()" +
    "\\n  queueMicrotask(() => {" +
    "\\n    if (plan.stdout) child.stdout.emit('data', Buffer.from(plan.stdout))" +
    "\\n    if (plan.stderr) child.stderr.emit('data', Buffer.from(plan.stderr))" +
    "\\n    if (plan.errno) child.emit('error', Object.assign(new Error('spawn failed'), { code: plan.errno }))" +
    "\\n    else child.emit('exit', plan.code === undefined ? 0 : plan.code)" +
    "\\n  })" +
    "\\n  return child" +
    "\\n}" +
    "\\nexport function execFile(cmd, args, opts, cb) {" +
    "\\n  const plan = globalThis.__provSpawnPlan(cmd, args) ?? {}" +
    "\\n  globalThis.__provSpawns.push({ cmd, args, cwd: opts.cwd, env: opts.env })" +
    "\\n  queueMicrotask(() => cb(null, plan.stdout ?? '', ''))" +
    "\\n  return {}" +
    "\\n}"
}
export async function load(url, context, next) {
  if (SOURCE[url]) return { format: 'module', shortCircuit: true, source: SOURCE[url] }
  return next(url, context)
}
`
register('data:text/javascript,' + encodeURIComponent(hookSource), import.meta.url)

interface SpawnPlan {
  code?: number
  stdout?: string
  stderr?: string
  errno?: string
  throwOnSpawn?: string
}
interface SpawnCall {
  cmd: string
  args: string[]
  cwd: string
  env: Record<string, string>
}
interface StartedCommand {
  key: string
  cwd: string
  branch: string
  command: string
  watch?: string[]
  autoRestart?: boolean
}
declare global {
  // eslint-disable-next-line no-var
  var __provSpawns: SpawnCall[]
  // eslint-disable-next-line no-var
  var __provSpawnPlan: (cmd: string, args: string[]) => SpawnPlan
  // eslint-disable-next-line no-var
  var __provStarted: StartedCommand[]
  // eslint-disable-next-line no-var
  var __provSandbox: { disabled: boolean; bwrap: boolean }
}

const {
  answerProvisionAsk,
  dropWorktreeDatabase,
  ensureContainerUp,
  getAppUrl,
  provisionWorktree,
  unlinkWorktreeSite
} = await import('./provision.ts')
const { invalidateFloeConfig } = await import('./config/floe.ts')
const store = await import('./config/projectStore.ts')

function reset(): void {
  globalThis.__provSpawns = []
  globalThis.__provStarted = []
  globalThis.__provSpawnPlan = () => ({ code: 0 })
  globalThis.__provSandbox = { disabled: true, bwrap: false }
}
reset()

// ── fixtures ─────────────────────────────────────────────────────────────────

function write(dir: string, files: Record<string, string>): void {
  for (const [rel, body] of Object.entries(files)) {
    const path = join(dir, rel)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, body)
  }
}

function checkout(prefix: string, files: Record<string, string>): string {
  const dir = tmp(prefix)
  write(dir, files)
  return dir
}

const LARAVEL = { artisan: '#!/usr/bin/env php\n', 'composer.json': '{}\n' }

// The DB name provisioning derives: `<project>-<slug>` with everything else
// flattened to underscores.
const dbNameFor = (root: string, branch: string): string =>
  `${basename(root)}-${branch.replace(/\//g, '-')}`.replace(/[^A-Za-z0-9_]/g, '_')

function containerProject(root: string, db: 'mysql' | 'postgres'): void {
  store.createProject(root)
  store.setProjectEnvValue(root, 'mode', 'container')
  store.setProjectEnvValue(root, 'db', db)
}

// ── provisioning driver ──────────────────────────────────────────────────────

type StepEvent = Extract<ProvisionEvent, { kind: 'step' }>

async function provision(
  root: string,
  worktree: string,
  branch = 'feat/one',
  opts: { from?: string; skip?: string[] } | null = {},
  destroyed = false
): Promise<ProvisionEvent[]> {
  const events: ProvisionEvent[] = []
  const win = {
    isDestroyed: () => destroyed,
    webContents: {
      send: (_channel: string, event: ProvisionEvent) => {
        events.push(event)
      }
    }
  } as unknown as BrowserWindow
  await provisionWorktree(win, root, worktree, branch, opts)
  return events
}

const stepEvents = (events: ProvisionEvent[], id: string): StepEvent[] =>
  events.filter((e): e is StepEvent => e.kind === 'step' && e.id === id)
const status = (events: ProvisionEvent[], id: string): string | undefined => stepEvents(events, id).at(-1)?.status
const detail = (events: ProvisionEvent[], id: string): string | undefined => stepEvents(events, id).at(-1)?.detail
const logOf = (events: ProvisionEvent[], id: string): string =>
  events.map((e) => (e.kind === 'log' && e.id === id ? e.text : '')).join('')
const planIds = (events: ProvisionEvent[]): string[] => {
  const plan = events.find((e) => e.kind === 'plan')
  return plan?.kind === 'plan' ? plan.steps.map((s) => s.id) : []
}
const finished = (events: ProvisionEvent[]): boolean | undefined => {
  const last = events.at(-1)
  return last?.kind === 'done' ? last.ok : undefined
}

// Off Windows every command runs as `$SHELL -lc '<quoted line>'`, so the last
// argument is the command line a test asserts on.
const lines = (): string[] => globalThis.__provSpawns.map((s) => s.args.at(-1) ?? '')
const call = (needle: string): SpawnCall | undefined =>
  globalThis.__provSpawns.find((s) => (s.args.at(-1) ?? '').includes(needle))
const line = (needle: string): string => call(needle)?.args.at(-1) ?? ''

// ── the .env reader ──────────────────────────────────────────────────────────

test('getAppUrl reads APP_URL from the worktree .env', () => {
  const dir = checkout('floe-appurl-', {
    '.env': 'APP_NAME=Test\nAPP_URL="https://foo.dev.pinguim.io"\n# APP_URL=commented\nDB_CONNECTION=mysql\n'
  })
  assert.equal(getAppUrl(dir), 'https://foo.dev.pinguim.io')
})

test('getAppUrl returns null when APP_URL is unset or .env is missing', () => {
  const dir = checkout('floe-appurl-', { '.env': 'APP_NAME=Test\n' })
  assert.equal(getAppUrl(dir), null)
  assert.equal(getAppUrl(join(dir, 'nope')), null)
})

// ── runShell ─────────────────────────────────────────────────────────────────

test('a command runs through the login shell and streams both streams into the step log', async () => {
  reset()
  globalThis.__provSpawnPlan = () => ({ code: 0, stdout: 'added 1 package\n', stderr: 'warn: deprecated\n' })
  const root = checkout('floe-root-', { 'package.json': '{}' })
  const wt = checkout('floe-wt-', { 'package.json': '{}', 'bun.lock': '' })

  const events = await provision(root, wt)

  assert.equal(status(events, 'node-install'), 'done')
  const install = call("'bun' 'install'")
  assert.ok(install, `no bun install spawn in ${JSON.stringify(lines())}`)
  assert.equal(install.cmd, '/bin/zsh')
  assert.deepEqual(install.args, ['-lc', "'bun' 'install'"])
  assert.equal(install.cwd, wt)
  assert.equal(install.env.FORCE_COLOR, '0')
  assert.match(logOf(events, 'node-install'), /\$ bun install\nadded 1 package\nwarn: deprecated\n/)
})

test('exit 127 from the login shell reads as "<cmd> not found"', async () => {
  reset()
  globalThis.__provSpawnPlan = (_cmd, args) => ({ code: args.at(-1)?.includes("'herd'") ? 127 : 0 })
  const root = checkout('floe-root-', LARAVEL)
  const wt = checkout('floe-wt-', LARAVEL)

  const events = await provision(root, wt)

  assert.equal(status(events, 'herd'), 'skipped')
  assert.match(logOf(events, 'herd'), /herd not found — skipping/)
  assert.equal(finished(events), true) // a missing Herd is not a failed provision
})

test('a non-zero exit fails the step and stops the recipe there', async () => {
  reset()
  globalThis.__provSpawnPlan = (_cmd, args) => ({ code: args.at(-1)?.includes("'composer'") ? 3 : 0 })
  const root = checkout('floe-root-', LARAVEL)
  const wt = checkout('floe-wt-', LARAVEL)

  const events = await provision(root, wt)

  assert.equal(status(events, 'composer'), 'failed')
  assert.equal(detail(events, 'composer'), 'composer exited with code 3')
  assert.equal(stepEvents(events, 'herd').length, 0) // the step after it never ran
  assert.equal(finished(events), false)
})

test('an unknown exit code still names the command', async () => {
  reset()
  globalThis.__provSpawnPlan = () => ({ code: null as unknown as number })
  const root = checkout('floe-root-', { 'package.json': '{}' })
  const wt = checkout('floe-wt-', { 'package.json': '{}' })

  const events = await provision(root, wt)

  assert.equal(detail(events, 'node-install'), 'npm exited with code unknown')
})

test('ENOENT on the child becomes "<cmd> not found"', async () => {
  reset()
  globalThis.__provSpawnPlan = () => ({ errno: 'ENOENT' })
  const wt = checkout('floe-wt-', LARAVEL)
  const logged: string[] = []

  assert.equal(await unlinkWorktreeSite(wt, (t) => logged.push(t)), 'skipped')
  assert.match(logged.join(''), /herd not found — skipping/)
})

test('any other spawn error propagates as-is', async () => {
  reset()
  globalThis.__provSpawnPlan = () => ({ errno: 'EACCES' })
  const wt = checkout('floe-wt-', LARAVEL)
  const logged: string[] = []

  // Not a "not found", so it is reported rather than swallowed as a skip.
  assert.equal(await unlinkWorktreeSite(wt, (t) => logged.push(t)), 'skipped')
  assert.match(logged.join(''), /herd unlink: spawn failed/)
})

test('a spawn that throws fails the step with the throw', async () => {
  reset()
  globalThis.__provSpawnPlan = () => ({ throwOnSpawn: 'EMFILE: too many open files' })
  const root = checkout('floe-root-', { 'package.json': '{}' })
  const wt = checkout('floe-wt-', { 'package.json': '{}' })

  const events = await provision(root, wt)

  assert.equal(status(events, 'node-install'), 'failed')
  assert.equal(detail(events, 'node-install'), 'EMFILE: too many open files')
})

test('an install runs inside bwrap, with the allowlisted environment and no login shell', async () => {
  reset()
  globalThis.__provSandbox = { disabled: false, bwrap: true }
  const root = checkout('floe-root-', { 'package.json': '{}' })
  const wt = checkout('floe-wt-', { 'package.json': '{}', 'pnpm-lock.yaml': '' })

  const events = await provision(root, wt)

  assert.equal(status(events, 'node-install'), 'done')
  const install = globalThis.__provSpawns[0]
  assert.equal(install.cmd, 'bwrap')
  assert.deepEqual(install.args, ['--bind', wt, wt, '/bin/sh', '-c', "'pnpm' 'install'"])
  // The point of the sandbox: the user's environment does not come along.
  assert.deepEqual(install.env, { SANDBOX: '1' })
})

test('off Linux, a missing bwrap runs the install unsandboxed and says so', async () => {
  reset()
  globalThis.__provSandbox = { disabled: false, bwrap: false }
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
  try {
    const root = checkout('floe-root-', { 'package.json': '{}' })
    const wt = checkout('floe-wt-', { 'package.json': '{}' })

    const events = await provision(root, wt)

    assert.equal(status(events, 'node-install'), 'done')
    assert.match(logOf(events, 'node-install'), /dependency sandbox unsupported on this platform/)
    assert.equal(globalThis.__provSpawns[0].cmd, '/bin/zsh')
  } finally {
    Object.defineProperty(process, 'platform', platform)
  }
})

test('on Linux, a missing bwrap fails closed rather than installing with full access', async () => {
  reset()
  globalThis.__provSandbox = { disabled: false, bwrap: false }
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
  try {
    const root = checkout('floe-root-', { 'package.json': '{}' })
    const wt = checkout('floe-wt-', { 'package.json': '{}' })

    const events = await provision(root, wt)

    assert.equal(status(events, 'node-install'), 'failed')
    assert.match(detail(events, 'node-install') ?? '', /bwrap not found — refusing to run install/)
    assert.deepEqual(globalThis.__provSpawns, []) // nothing was spawned at all
  } finally {
    Object.defineProperty(process, 'platform', platform)
  }
})

test('on Windows the command is spawned directly, not through a shell', async () => {
  reset()
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  try {
    const wt = checkout('floe-wt-', LARAVEL)
    assert.equal(await unlinkWorktreeSite(wt, () => {}), 'unlinked')
    assert.equal(globalThis.__provSpawns[0].cmd, 'herd')
    assert.deepEqual(globalThis.__provSpawns[0].args, ['unlink'])
  } finally {
    Object.defineProperty(process, 'platform', platform)
  }
})

// ── unlinking the Herd site ──────────────────────────────────────────────────

test('a worktree that was never Laravel has no Herd site to unlink', async () => {
  reset()
  const wt = checkout('floe-wt-', { 'package.json': '{}' })
  const logged: string[] = []

  assert.equal(await unlinkWorktreeSite(wt, (t) => logged.push(t)), 'skipped')
  assert.deepEqual(globalThis.__provSpawns, [])
  assert.match(logged.join(''), /Not a Laravel worktree/)
})

test('unlink runs in the worktree it is removing', async () => {
  reset()
  const wt = checkout('floe-wt-', LARAVEL)

  assert.equal(await unlinkWorktreeSite(wt, () => {}), 'unlinked')
  assert.equal(line("'herd' 'unlink'"), "'herd' 'unlink'")
  assert.equal(globalThis.__provSpawns[0].cwd, wt)
})

// ── the Electron repair ──────────────────────────────────────────────────────

const ELECTRON_BIN = 'Electron.app/Contents/MacOS/Electron'
const healthyElectron = (prefix: string, version: string): Record<string, string> => ({
  [`${prefix}/package.json`]: JSON.stringify({ version }),
  [`${prefix}/path.txt`]: ELECTRON_BIN,
  [`${prefix}/dist/${ELECTRON_BIN}`]: 'binary'
})

test('a blank path.txt is repaired by linking the main checkout dist', async () => {
  reset()
  const pnpmDir = 'node_modules/.pnpm/electron@30.0.1_abc123/node_modules/electron'
  const root = checkout('floe-root-', {
    'package.json': '{}',
    ...healthyElectron('node_modules/electron', '30.0.1')
  })
  const wt = checkout('floe-wt-', {
    'package.json': '{}',
    [`${pnpmDir}/package.json`]: '{"version":"30.0.1"}',
    [`${pnpmDir}/path.txt`]: '',
    [`${pnpmDir}/dist/.partial`]: '' // a half-finished download, replaced by the link
  })

  const events = await provision(root, wt)

  assert.equal(status(events, 'electron-repair'), 'done')
  assert.match(logOf(events, 'electron-repair'), /Linked Electron 30\.0\.1 from the main checkout/)
  assert.equal(readFileSync(join(wt, pnpmDir, 'path.txt'), 'utf8'), ELECTRON_BIN)
  const dist = join(wt, pnpmDir, 'dist')
  assert.ok(lstatSync(dist).isSymbolicLink())
  assert.equal(readlinkSync(dist), join(root, 'node_modules', 'electron', 'dist'))
  assert.ok(existsSync(join(dist, ELECTRON_BIN)))
})

test('an Electron that already works is left alone', async () => {
  reset()
  const root = checkout('floe-root-', { 'package.json': '{}' })
  const wt = checkout('floe-wt-', {
    'package.json': '{}',
    // A .pnpm dir without an electron entry must fall through to the flat layout.
    'node_modules/.pnpm/vite@5.0.0/node_modules/vite/package.json': '{}',
    ...healthyElectron('node_modules/electron', '30.0.1')
  })

  const events = await provision(root, wt)

  assert.equal(status(events, 'electron-repair'), 'skipped')
  assert.match(logOf(events, 'electron-repair'), /already present/)
})

test('a main checkout on another Electron version is not borrowed from', async () => {
  reset()
  const root = checkout('floe-root-', {
    'package.json': '{}',
    ...healthyElectron('node_modules/electron', '29.4.0')
  })
  const wt = checkout('floe-wt-', {
    'package.json': '{}',
    'node_modules/electron/package.json': '{"version":"30.0.1"}'
  })

  const events = await provision(root, wt)

  assert.equal(status(events, 'electron-repair'), 'skipped')
  assert.match(logOf(events, 'electron-repair'), /Main checkout Electron \(29\.4\.0\) can't satisfy worktree \(30\.0\.1\)/)
  assert.ok(!existsSync(join(wt, 'node_modules/electron/path.txt')))
})

test('an unreadable Electron package.json counts as no Electron at all', async () => {
  reset()
  const root = checkout('floe-root-', {
    'package.json': '{}',
    'node_modules/electron/package.json': 'not json'
  })
  const wt = checkout('floe-wt-', {
    'package.json': '{}',
    'node_modules/electron/package.json': '{"version":"30.0.1"}'
  })

  const events = await provision(root, wt)

  assert.equal(status(events, 'electron-repair'), 'skipped')
  assert.match(logOf(events, 'electron-repair'), /No Electron in the main checkout to borrow from/)
})

test('a project without Electron has nothing to repair', async () => {
  reset()
  const root = checkout('floe-root-', { 'package.json': '{}' })
  const wt = checkout('floe-wt-', { 'package.json': '{}' })

  const events = await provision(root, wt)

  assert.equal(status(events, 'electron-repair'), 'skipped')
  assert.match(logOf(events, 'electron-repair'), /No Electron dependency/)
})

// ── the node recipe ──────────────────────────────────────────────────────────

test('the node recipe copies local config, installs, and reports its commands', async () => {
  reset()
  const root = checkout('floe-root-', {
    'package.json': '{}',
    '.env': 'APP_NAME=Main\n',
    'auth.json': '{"http-basic":{}}'
  })
  const wt = checkout('floe-wt-', { 'package.json': '{}' })

  const events = await provision(root, wt)

  assert.deepEqual(planIds(events), ['copy-env', 'node-install', 'electron-repair', 'commands', 'start'])
  assert.equal(status(events, 'copy-env'), 'done')
  assert.equal(readFileSync(join(wt, '.env'), 'utf8'), 'APP_NAME=Main\n')
  assert.equal(readFileSync(join(wt, 'auth.json'), 'utf8'), '{"http-basic":{}}')
  assert.match(logOf(events, 'copy-env'), /Copied \.env, auth\.json/)
  assert.equal(status(events, 'start'), 'skipped')
  assert.deepEqual(globalThis.__provStarted, [])
  assert.equal(finished(events), true)
})

test('copy-env skips files the worktree already has', async () => {
  reset()
  const root = checkout('floe-root-', { 'package.json': '{}', '.env': 'APP_NAME=Main\n' })
  const wt = checkout('floe-wt-', { 'package.json': '{}', '.env': 'APP_NAME=Mine\n' })

  const events = await provision(root, wt)

  assert.equal(status(events, 'copy-env'), 'skipped')
  assert.match(logOf(events, 'copy-env'), /Nothing to copy/)
  assert.equal(readFileSync(join(wt, '.env'), 'utf8'), 'APP_NAME=Mine\n') // not clobbered
})

test('a worktree with no recognised stack gets an empty plan, not a failure', async () => {
  reset()
  const root = checkout('floe-root-', { 'README.md': '#\n' })
  const wt = checkout('floe-wt-', { 'README.md': '#\n' })

  const events = await provision(root, wt)

  assert.deepEqual(planIds(events), [])
  assert.equal(finished(events), true)
  assert.deepEqual(globalThis.__provSpawns, [])
})

// ── the premise interview ────────────────────────────────────────────────────
//
// Off for every other test in this file (see the floe.toml written at the top).
// These turn it on with the model's answers planned, and drive the questions the
// way the checklist does.

/** Run with the interview enabled, restoring the config afterwards. */
async function withInterview<T>(run: () => Promise<T>): Promise<T> {
  const path = join(HOME, '.config', 'floe', 'floe.toml')
  writeFileSync(path, '[premise]\nenabled = true\nprovider = "claude"\nmodel = "sonnet"\n')
  invalidateFloeConfig()
  try {
    return await run()
  } finally {
    writeFileSync(path, '[premise]\nenabled = false\n')
    invalidateFloeConfig()
  }
}

/** The question currently on screen, once main has asked it. */
function currentAsk(events: ProvisionEvent[]): Extract<ProvisionEvent, { kind: 'ask' }>['ask'] {
  return events.filter((e) => e.kind === 'ask').at(-1)?.ask ?? null
}

/** Let the interview's pending model call / await settle. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

test('the interview asks, then writes the premise the answer composes', async () => {
  reset()
  // One model call: the composed file. The question itself is fixed.
  globalThis.__provSpawnPlan = (cmd) =>
    cmd === 'claude' ? { stdout: '## Goal\nShip the premise flow.' } : { code: 0 }

  const root = checkout('floe-root-', { 'README.md': '#\n' })
  const wt = checkout('floe-wt-', { 'README.md': '#\n' })

  await withInterview(async () => {
    const events = await provision(root, wt)
    assert.deepEqual(planIds(events), ['premise'], 'the row is on the checklist even with no stack')

    await settle()
    const ask = currentAsk(events)
    assert.match(ask!.question, /deliver/)
    assert.equal(ask?.index, 1)
    assert.equal(ask?.total, 1)
    assert.deepEqual(globalThis.__provSpawns, [], 'the question costs no model call')

    answerProvisionAsk(ask!.requestId, 'the premise flow')
    await settle()
    await settle()

    assert.equal(currentAsk(events), null, 'the question is withdrawn when the interview ends')
    assert.equal(status(events, 'premise'), 'done')
    assert.equal(readFileSync(join(wt, '.floe', 'premise.md'), 'utf8'), '## Goal\nShip the premise flow.\n')
  })
})

test('skipping the interview leaves no premise and no more questions', async () => {
  reset()
  globalThis.__provSpawnPlan = (cmd) => (cmd === 'claude' ? { stdout: '## Goal\nUnused.' } : { code: 0 })

  const root = checkout('floe-root-', { 'README.md': '#\n' })
  const wt = checkout('floe-wt-', { 'README.md': '#\n' })

  await withInterview(async () => {
    const events = await provision(root, wt)
    await settle()
    const first = currentAsk(events)
    assert.ok(first)

    answerProvisionAsk(first!.requestId, null)
    await settle()

    assert.equal(currentAsk(events), null)
    assert.equal(status(events, 'premise'), 'skipped')
    assert.equal(existsSync(join(wt, '.floe', 'premise.md')), false, 'a refused interview writes nothing')
  })
})

test('a worktree that already has a premise is not interviewed again', async () => {
  reset()
  const root = checkout('floe-root-', { 'README.md': '#\n' })
  const wt = checkout('floe-wt-', { 'README.md': '#\n', '.floe/premise.md': '## Goal\nAlready written.\n' })

  await withInterview(async () => {
    const events = await provision(root, wt)
    await settle()
    assert.deepEqual(planIds(events), [])
    assert.deepEqual(globalThis.__provSpawns, [], 'no model call either')
  })
})

test('a destroyed window swallows the events instead of throwing', async () => {
  reset()
  const root = checkout('floe-root-', { 'package.json': '{}' })
  const wt = checkout('floe-wt-', { 'package.json': '{}' })

  const events = await provision(root, wt, 'feat/one', {}, true)

  assert.deepEqual(events, [])
  assert.ok(globalThis.__provSpawns.length > 0) // the recipe still ran
})

// ── the host Laravel recipe ──────────────────────────────────────────────────

test('the Laravel recipe rewrites .env, prepares storage, links Herd and migrates', async () => {
  reset()
  const root = checkout('floe-root-', {
    ...LARAVEL,
    '.env': 'APP_NAME=Main\nAPP_URL=http://main.test\nDB_CONNECTION=mysql\nDB_DATABASE=main\nDB_PASSWORD=secret\n'
  })
  const wt = checkout('floe-wt-', LARAVEL)
  const db = dbNameFor(root, 'feat/one')
  const domain = `${basename(root)}-feat-one.test`

  const events = await provision(root, wt)

  assert.deepEqual(planIds(events), [
    'copy-env',
    'env-vars',
    'storage-dirs',
    'composer',
    'herd',
    'node-install',
    'migrate',
    'seed',
    'commands',
    'start'
  ])
  const env = readFileSync(join(wt, '.env'), 'utf8')
  assert.match(env, new RegExp(`^APP_URL=http://${domain}$`, 'm'))
  assert.match(env, new RegExp(`^DB_DATABASE=${db}$`, 'm'))
  assert.match(env, /^DB_PASSWORD=secret$/m) // untouched keys stay
  assert.ok(existsSync(join(wt, 'storage/framework/views')))
  assert.ok(existsSync(join(wt, 'bootstrap/cache')))
  assert.equal(status(events, 'herd'), 'done')
  assert.match(logOf(events, 'herd'), new RegExp(`Linked as ${domain}`))
  assert.equal(status(events, 'node-install'), 'skipped') // no package.json here

  // The database is created before migrating, with the password off the command line.
  const create = call('CREATE DATABASE IF NOT EXISTS')
  assert.ok(create)
  assert.equal(
    create.args.at(-1),
    `'mysql' '--protocol=TCP' '--host=127.0.0.1' '--port=3306' '--user=root' '-e' 'CREATE DATABASE IF NOT EXISTS \`${db}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci'`
  )
  assert.equal(create.env.MYSQL_PWD, 'secret')
  assert.ok(lines().indexOf(create.args.at(-1) ?? '') < lines().indexOf("'php' 'artisan' 'migrate' '--force'"))
  assert.equal(line("'php' 'artisan' 'db:seed' '--force'"), "'php' 'artisan' 'db:seed' '--force'")
  assert.equal(finished(events), true)
})

test('the DB host, port and user come from the worktree .env', async () => {
  reset()
  const root = checkout('floe-root-', {
    ...LARAVEL,
    '.env': 'DB_CONNECTION=mariadb\nDB_HOST=db.internal\nDB_PORT=3307\nDB_USERNAME=floe\n'
  })
  const wt = checkout('floe-wt-', LARAVEL)

  await provision(root, wt)

  const create = call('CREATE DATABASE IF NOT EXISTS')
  assert.ok(create)
  assert.match(create.args.at(-1) ?? '', /'--host=db\.internal' '--port=3307' '--user=floe'/)
  assert.equal(create.env.MYSQL_PWD, undefined) // no password in .env, none passed
})

test('a sqlite project migrates without creating a database first', async () => {
  reset()
  const root = checkout('floe-root-', { ...LARAVEL, '.env': 'DB_CONNECTION=sqlite\n' })
  const wt = checkout('floe-wt-', LARAVEL)

  const events = await provision(root, wt)

  assert.equal(status(events, 'migrate'), 'done')
  assert.equal(call('CREATE DATABASE'), undefined)
  assert.equal(line("'php' 'artisan' 'migrate' '--force'"), "'php' 'artisan' 'migrate' '--force'")
})

test('env-vars is skipped when there is no .env to rewrite', async () => {
  reset()
  const root = checkout('floe-root-', LARAVEL)
  const wt = checkout('floe-wt-', LARAVEL)

  const events = await provision(root, wt)

  assert.equal(status(events, 'env-vars'), 'skipped')
  assert.match(logOf(events, 'env-vars'), /No \.env to update/)
})

test('the autoStart commands are started, the watcher is not', async () => {
  reset()
  const root = checkout('floe-root-', LARAVEL)
  const wt = checkout('floe-wt-', LARAVEL)

  const events = await provision(root, wt, 'feat/one')

  assert.equal(status(events, 'commands'), 'done')
  assert.match(logOf(events, 'commands'), /4 command\(s\) configured/)
  assert.deepEqual(
    globalThis.__provStarted.map((c) => c.command).sort(),
    ['npm run dev', 'php artisan queue:work', 'php artisan schedule:work']
  )
  assert.ok(globalThis.__provStarted.every((c) => c.key.startsWith(`${wt}#`) && c.cwd === wt && c.branch === 'feat/one'))
})

// ── the container recipe ─────────────────────────────────────────────────────

test('the container recipe points .env at the shared services and brings the app up', async () => {
  reset()
  const root = checkout('floe-root-', { ...LARAVEL, '.env': 'APP_NAME=Main\nDB_CONNECTION=mysql\n' })
  const wt = checkout('floe-wt-', LARAVEL)
  containerProject(root, 'mysql')
  const db = dbNameFor(root, 'feat/one')
  const slug = 'feat-one' // the container host is keyed by the branch alone

  const events = await provision(root, wt)

  assert.deepEqual(planIds(events), [
    'copy-env',
    'env-vars',
    'storage-dirs',
    'compose-up',
    'composer',
    'create-db',
    'migrate',
    'seed',
    'node-install'
  ])
  const env = readFileSync(join(wt, '.env'), 'utf8')
  assert.match(env, new RegExp(`^APP_URL=https://${slug}\\.dev\\.test\\.example$`, 'm'))
  assert.match(env, /^DB_CONNECTION=mysql$/m)
  assert.match(env, /^DB_HOST=mysql$/m)
  assert.match(env, /^DB_PORT=3306$/m)
  assert.match(env, /^DB_USERNAME=root$/m)
  assert.match(env, /^DB_PASSWORD=rootpw$/m)
  assert.match(env, new RegExp(`^DB_DATABASE=${db}$`, 'm'))
  assert.match(env, /^REDIS_HOST=redis$/m)
  assert.match(env, new RegExp(`^REDIS_PREFIX=${slug}_$`, 'm'))
  assert.match(env, new RegExp(`^CACHE_PREFIX=${slug}_$`, 'm'))

  const compose = join(wt, '.floe', 'docker-compose.yml')
  assert.ok(existsSync(compose))
  assert.equal(line("'up' '-d' '--build'"), `'docker' 'compose' '-f' '${compose}' 'up' '-d' '--build'`)
  assert.equal(
    line("'composer' 'install'"),
    `'docker' 'compose' '-f' '${compose}' 'exec' '-T' 'app' 'composer' 'install'`
  )
  assert.match(logOf(events, 'composer'), /No global COMPOSER_HOME\/auth\.json found/)
  assert.equal(
    line("'php' 'artisan' 'migrate'"),
    `'docker' 'compose' '-f' '${compose}' 'exec' '-T' 'app' 'php' 'artisan' 'migrate' '--force'`
  )
  assert.equal(
    line("'php' 'artisan' 'db:seed'"),
    `'docker' 'compose' '-f' '${compose}' 'exec' '-T' 'app' 'php' 'artisan' 'db:seed' '--force'`
  )
  // The database is created on the SHARED container, not from inside the app.
  assert.equal(
    line('CREATE DATABASE IF NOT EXISTS'),
    `'docker' 'exec' 'floe-support-mysql-1' 'mysql' '-uroot' '-prootpw' '-e' 'CREATE DATABASE IF NOT EXISTS \`${db}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci'`
  )
  assert.equal(status(events, 'node-install'), 'skipped')
  assert.equal(finished(events), true)
})

test('a postgres project gets pgsql settings and a guarded CREATE DATABASE', async () => {
  reset()
  const root = checkout('floe-root-', { ...LARAVEL, '.env': 'DB_CONNECTION=mysql\n' })
  const wt = checkout('floe-wt-', { ...LARAVEL, 'package.json': '{}', 'bun.lock': '' })
  containerProject(root, 'postgres')
  const db = dbNameFor(root, 'feat/one')

  const events = await provision(root, wt)

  const env = readFileSync(join(wt, '.env'), 'utf8')
  assert.match(env, /^DB_CONNECTION=pgsql$/m)
  assert.match(env, /^DB_HOST=postgres$/m)
  assert.match(env, /^DB_PORT=5432$/m)
  assert.match(env, /^DB_USERNAME=postgres$/m)
  assert.match(env, /^DB_PASSWORD=pgpw$/m)

  const create = call('CREATE DATABASE')
  assert.ok(create)
  assert.match(create.args.at(-1) ?? '', /'docker' 'exec' '-e' 'PGPASSWORD=pgpw' 'floe-support-postgres-1' 'sh' '-c'/)
  // Check-then-create: Postgres has no CREATE DATABASE IF NOT EXISTS.
  const script = create.args.at(-1) ?? ''
  assert.ok(script.includes('SELECT 1 FROM pg_database WHERE datname='))
  assert.ok(script.includes('grep -q 1 ||'))
  assert.ok(script.includes(`CREATE DATABASE "${db}"`))
  // JS deps install inside the container too — the server host has no runtime.
  assert.match(line("'bun' 'install'"), /'exec' '-T' 'app' 'bun' 'install'$/)
  assert.equal(status(events, 'node-install'), 'done')
})

test('the global composer auth is forwarded into the container', async () => {
  reset()
  write(HOME, { '.composer/auth.json': '{"http-basic":{"repo.example":{}}}' })
  try {
    const root = checkout('floe-root-', { ...LARAVEL, '.env': 'DB_CONNECTION=mysql\n' })
    const wt = checkout('floe-wt-', LARAVEL)
    containerProject(root, 'mysql')

    const events = await provision(root, wt)

    assert.equal(status(events, 'composer'), 'done')
    assert.match(
      line("'composer' 'install'"),
      /'-e' 'COMPOSER_AUTH=\{"http-basic":\{"repo\.example":\{\}\}\}' 'app' 'composer' 'install'/
    )
  } finally {
    rmSync(join(HOME, '.composer'), { recursive: true, force: true })
  }
})

test('ensureContainerUp brings a container worktree back, and leaves host ones alone', async () => {
  reset()
  const host = checkout('floe-root-', LARAVEL)
  await ensureContainerUp(host, host, 'feat/one')
  assert.deepEqual(globalThis.__provSpawns, []) // not a container project

  const root = checkout('floe-root-', LARAVEL)
  const wt = checkout('floe-wt-', LARAVEL)
  containerProject(root, 'mysql')
  await ensureContainerUp(root, wt, 'feat/one')
  assert.deepEqual(globalThis.__provSpawns, []) // container project, never provisioned

  const compose = join(wt, '.floe', 'docker-compose.yml')
  write(wt, { '.floe/docker-compose.yml': 'services: {}\n' })
  await ensureContainerUp(root, wt, 'feat/one')
  assert.equal(line("'up' '-d'"), `'docker' 'compose' '-f' '${compose}' 'up' '-d'`)
})

// ── retry, skip and resume ───────────────────────────────────────────────────

test('`from` reports the earlier steps done without re-running them', async () => {
  reset()
  const root = checkout('floe-root-', { 'package.json': '{}' })
  const wt = checkout('floe-wt-', { 'package.json': '{}' })

  const events = await provision(root, wt, 'feat/one', { from: 'commands' })

  assert.equal(detail(events, 'copy-env'), 'already done')
  assert.equal(detail(events, 'node-install'), 'already done')
  assert.deepEqual(globalThis.__provSpawns, []) // the install did not run again
  assert.equal(status(events, 'commands'), 'done')
})

test('a skipped step is neither run nor reported as already done', async () => {
  reset()
  const root = checkout('floe-root-', { 'package.json': '{}', '.env': 'A=1\n' })
  const wt = checkout('floe-wt-', { 'package.json': '{}' })

  const events = await provision(root, wt, 'feat/one', { from: 'node-install', skip: ['copy-env', 'node-install'] })

  const plan = events.find((e) => e.kind === 'plan')
  assert.equal(plan?.kind === 'plan' && plan.steps.find((s) => s.id === 'copy-env')?.status, 'skipped')
  assert.deepEqual(stepEvents(events, 'copy-env'), []) // skipped AND before `from`: silent
  assert.ok(!existsSync(join(wt, '.env')))
  assert.equal(status(events, 'node-install'), 'skipped')
  assert.deepEqual(globalThis.__provSpawns, [])
  assert.equal(finished(events), true)
})

test('a null opts (the web bridge sends one) provisions normally', async () => {
  reset()
  const root = checkout('floe-root-', { 'package.json': '{}' })
  const wt = checkout('floe-wt-', { 'package.json': '{}' })

  const events = await provision(root, wt, 'feat/one', null)

  assert.equal(status(events, 'node-install'), 'done')
  assert.equal(finished(events), true)
})

// ── dropping the database ────────────────────────────────────────────────────

test('a MySQL worktree database is dropped with the password off the command line', async () => {
  reset()
  const main = checkout('floe-root-', { '.env': 'DB_DATABASE=main_app\n' })
  const wt = checkout('floe-wt-', {
    '.env': 'DB_CONNECTION=mysql\nDB_DATABASE=app_feat_one\nDB_PASSWORD=secret\nDB_HOST=db.internal\nDB_PORT=3307\nDB_USERNAME=floe\n'
  })
  const logged: string[] = []

  assert.equal(await dropWorktreeDatabase(wt, main, (t) => logged.push(t)), 'dropped')
  const drop = call('DROP DATABASE')
  assert.ok(drop)
  assert.equal(
    drop.args.at(-1),
    "'mysql' '--protocol=TCP' '--host=db.internal' '--port=3307' '--user=floe' '-e' 'DROP DATABASE IF EXISTS `app_feat_one`'"
  )
  assert.equal(drop.env.MYSQL_PWD, 'secret')
  assert.match(logged.join(''), /Dropping database `app_feat_one`/)
})

test('a Postgres worktree database is dropped from the maintenance database', async () => {
  reset()
  const main = checkout('floe-root-', {})
  const wt = checkout('floe-wt-', { '.env': 'DB_CONNECTION=pgsql\nDB_DATABASE=app_feat_one\nDB_PASSWORD=pw\n' })

  assert.equal(await dropWorktreeDatabase(wt, main, () => {}), 'dropped')
  const drop = call('DROP DATABASE')
  assert.ok(drop)
  assert.equal(
    drop.args.at(-1),
    `'psql' '--host=127.0.0.1' '--port=5432' '--username=postgres' '--dbname=postgres' '--no-password' '-c' 'DROP DATABASE IF EXISTS "app_feat_one" WITH (FORCE)'`
  )
  assert.equal(drop.env.PGPASSWORD, 'pw')
})

test('the main checkout database is never dropped', async () => {
  reset()
  const main = checkout('floe-root-', { '.env': 'DB_DATABASE=shared\n' })
  const wt = checkout('floe-wt-', { '.env': 'DB_CONNECTION=mysql\nDB_DATABASE=shared\n' })
  const logged: string[] = []

  assert.equal(await dropWorktreeDatabase(wt, main, (t) => logged.push(t)), 'skipped')
  assert.deepEqual(globalThis.__provSpawns, [])
  assert.match(logged.join(''), /Refusing to drop `shared` — it's the main checkout's database/)
})

test('a SQLite or nameless connection has nothing to drop', async () => {
  reset()
  const main = checkout('floe-root-', {})
  const sqlite = checkout('floe-wt-', { '.env': 'DB_CONNECTION=sqlite\nDB_DATABASE=database/db.sqlite\n' })
  const bare = checkout('floe-wt-', { '.env': 'APP_NAME=x\n' })
  const logged: string[] = []

  assert.equal(await dropWorktreeDatabase(sqlite, main, (t) => logged.push(t)), 'skipped')
  assert.equal(await dropWorktreeDatabase(bare, main, (t) => logged.push(t)), 'skipped')
  assert.deepEqual(globalThis.__provSpawns, [])
  assert.match(logged.join(''), /connection=sqlite/)
  assert.match(logged.join(''), /connection=mysql/) // no .env keys at all: the default
})

test('a failed drop is raised, not swallowed', async () => {
  reset()
  globalThis.__provSpawnPlan = () => ({ code: 1 })
  const main = checkout('floe-root-', {})
  const wt = checkout('floe-wt-', { '.env': 'DB_CONNECTION=mysql\nDB_DATABASE=app_feat_one\n' })

  await assert.rejects(dropWorktreeDatabase(wt, main, () => {}), /mysql exited with code 1/)
})

// ── container teardown ───────────────────────────────────────────────────────

test('a container worktree is composed down before its database is dropped', async () => {
  reset()
  const main = checkout('floe-root-', {})
  const wt = checkout('floe-wt-', {
    '.env': 'DB_CONNECTION=mysql\nDB_DATABASE=app_feat_one\n',
    '.floe/docker-compose.yml': 'services: {}\n'
  })
  const compose = join(wt, '.floe', 'docker-compose.yml')

  assert.equal(await dropWorktreeDatabase(wt, main, () => {}), 'dropped')
  assert.deepEqual(lines(), [
    `'docker' 'compose' '-f' '${compose}' 'down'`,
    "'docker' 'exec' 'floe-support-mysql-1' 'mysql' '-uroot' '-prootpw' '-e' 'DROP DATABASE IF EXISTS `app_feat_one`'"
  ])
})

test('a container Postgres database is dropped on the shared container', async () => {
  reset()
  const main = checkout('floe-root-', {})
  const wt = checkout('floe-wt-', {
    '.env': 'DB_CONNECTION=postgresql\nDB_DATABASE=app_feat_one\n',
    '.floe/docker-compose.yml': 'services: {}\n'
  })

  assert.equal(await dropWorktreeDatabase(wt, main, () => {}), 'dropped')
  assert.equal(
    lines().at(-1),
    `'docker' 'exec' '-e' 'PGPASSWORD=pgpw' 'floe-support-postgres-1' 'psql' '-U' 'postgres' '-c' 'DROP DATABASE IF EXISTS "app_feat_one" WITH (FORCE)'`
  )
})

test('a container that will not come down still gets its database dropped', async () => {
  reset()
  globalThis.__provSpawnPlan = (_cmd, args) => ({ code: args.at(-1)?.includes("'down'") ? 1 : 0 })
  const main = checkout('floe-root-', {})
  const wt = checkout('floe-wt-', {
    '.env': 'DB_CONNECTION=mysql\nDB_DATABASE=app_feat_one\n',
    '.floe/docker-compose.yml': 'services: {}\n'
  })
  const logged: string[] = []

  assert.equal(await dropWorktreeDatabase(wt, main, (t) => logged.push(t)), 'dropped')
  assert.match(logged.join(''), /docker exited with code 1/)
  assert.ok(call('DROP DATABASE'))
})

test('a container worktree with no database in .env drops nothing', async () => {
  reset()
  const main = checkout('floe-root-', {})
  const wt = checkout('floe-wt-', { '.env': 'APP_NAME=x\n', '.floe/docker-compose.yml': 'services: {}\n' })
  const logged: string[] = []

  assert.equal(await dropWorktreeDatabase(wt, main, (t) => logged.push(t)), 'skipped')
  assert.equal(lines().length, 1) // the compose down, and nothing else
  assert.match(logged.join(''), /No DB_DATABASE in \.env — nothing to drop/)
})
