import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// commands.ts imports ./dataDir → `electron`, via extensionless relative
// specifiers. Same in-memory hook the other main tests use: rewrite `./x` →
// `./x.ts` and stub `electron`.
const hookSource = `
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
export async function resolve(specifier, context, next) {
  if (specifier === 'electron') return { url: 'stub:electron', shortCircuit: true, format: 'module' }
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\\.[a-z]+$/i.test(specifier)) {
    try {
      const base = context.parentURL ? new URL(specifier, context.parentURL) : pathToFileURL(specifier)
      const tsPath = fileURLToPath(base) + '.ts'
      if (existsSync(tsPath)) return next(specifier + '.ts', context)
    } catch {}
  }
  return next(specifier, context)
}
export async function load(url, context, next) {
  if (url === 'stub:electron') {
    return { format: 'module', shortCircuit: true, source: "export const app = { getPath: () => '/tmp' }; export const dialog = {}; export default {};" }
  }
  return next(url, context)
}
`
register('data:text/javascript,' + encodeURIComponent(hookSource), import.meta.url)

const { containerizeViteCommand, containerizeCommand } = await import('./commands.ts')

// A worktree that looks containerized: it has the generated vite wrapper, and its
// project's `dev` script is plain vite.
function worktree(opts: { wrapper?: boolean; dev?: string | null } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'floe-cmd-'))
  if (opts.wrapper !== false) {
    mkdirSync(join(dir, '.floe'), { recursive: true })
    writeFileSync(join(dir, '.floe', 'vite.config.mjs'), '')
  }
  const dev = opts.dev === undefined ? 'vite' : opts.dev
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ scripts: dev === null ? {} : { dev } })
  )
  return dir
}

test('points the seeded Dev command at the generated wrapper', () => {
  const d = worktree()
  assert.equal(containerizeViteCommand('bun run dev', d, d), 'bun run dev -- --config .floe/vite.config.mjs')
})

test('handles the floe-prefixed form the container router uses', () => {
  const d = worktree()
  assert.equal(
    containerizeViteCommand('floe bun run dev', d, d),
    'floe bun run dev -- --config .floe/vite.config.mjs'
  )
})

test('covers every package manager the seeder can pick', () => {
  const d = worktree()
  for (const pm of ['bun', 'pnpm', 'yarn', 'npm']) {
    assert.match(containerizeViteCommand(`${pm} run dev`, d, d), /--config \.floe\/vite\.config\.mjs$/)
  }
})

// Guard the narrowness: a dev script that fans out wouldn't forward the extra
// args to vite, so rewriting it would break the command outright.
test('leaves a non-vite dev script alone', () => {
  const d = worktree({ dev: 'concurrently "vite" "php artisan serve"' })
  assert.equal(containerizeViteCommand('bun run dev', d, d), 'bun run dev')
})

test('leaves other commands alone', () => {
  const d = worktree()
  for (const cmd of ['php artisan queue:work', 'floe artisan schedule:work', 'bun run build']) {
    assert.equal(containerizeViteCommand(cmd, d, d), cmd)
  }
})

// Host-native worktrees never get the wrapper written, so they must stay untouched.
test('leaves the command alone without the generated wrapper', () => {
  const d = worktree({ wrapper: false })
  assert.equal(containerizeViteCommand('bun run dev', d, d), 'bun run dev')
})

test('is idempotent — an already-wrapped command is not appended to twice', () => {
  const d = worktree()
  const once = containerizeViteCommand('bun run dev', d, d)
  assert.equal(containerizeViteCommand(once, d, d), once)
})

// ── containerizeCommand ───────────────────────────────────────────────────────

function containerWorktree(): string {
  const dir = worktree()
  writeFileSync(join(dir, '.floe', 'docker-compose.yml'), '')
  return dir
}

test('routes container commands through the floe CLI', () => {
  const d = containerWorktree()
  assert.equal(containerizeCommand('php artisan queue:work', d), 'floe php artisan queue:work')
  assert.equal(containerizeCommand('bun run dev', d), 'floe bun run dev')
  assert.equal(containerizeCommand('composer install', d), 'floe composer install')
})

test('leaves host-native worktrees (no compose file) alone', () => {
  const d = worktree()
  assert.equal(containerizeCommand('php artisan queue:work', d), 'php artisan queue:work')
})

test('does not double-prefix or touch unroutable commands', () => {
  const d = containerWorktree()
  for (const cmd of ['floe artisan schedule:work', 'tail -f storage/logs/laravel.log', 'php']) {
    assert.equal(containerizeCommand(cmd, d), cmd)
  }
})

test('survives a project with no package.json', () => {
  const d = mkdtempSync(join(tmpdir(), 'floe-cmd-'))
  mkdirSync(join(d, '.floe'), { recursive: true })
  writeFileSync(join(d, '.floe', 'vite.config.mjs'), '')
  assert.equal(containerizeViteCommand('bun run dev', d, d), 'bun run dev')
})
