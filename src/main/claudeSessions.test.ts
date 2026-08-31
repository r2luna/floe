import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// claudeSessions.ts uses extensionless relative imports (./plans, ./sessionStore,
// …) — resolved by electron-vite at build time, not by raw Node ESM. Register the
// same in-memory hook the other main-process tests use to rewrite `./x` → `./x.ts`
// before importing the module. (No electron in this graph, so no stub needed.)
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
    const src = "export const app = { getPath: () => '/tmp' }; export class BrowserWindow {}; export const ipcMain = { handle(){}, on(){} }; export default {};"
    return { format: 'module', shortCircuit: true, source: src }
  }
  return next(url, context)
}
`
const hookUrl = 'data:text/javascript,' + encodeURIComponent(hookSource)
register(hookUrl, import.meta.url)

const { generateWorktreeDesc } = await import('./claudeSessions.ts')

// The regen guard: when a `.gw-desc` marker is newer than the spec it summarises,
// generateWorktreeDesc must short-circuit to null *before* shelling out to claude.
// This is what stops every sidebar refresh from spawning a Haiku process (and any
// regen loop). We prove it without the claude binary: a stale-spec/fresh-marker
// worktree returns null, and it returns fast (no 20s CLI timeout).
test('generateWorktreeDesc: fresh marker skips regeneration (no claude call)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'floe-desc-'))
  try {
    const specDir = join(root, 'specs', 'feat-x')
    mkdirSync(specDir, { recursive: true })
    const spec = join(specDir, 'spec.md')
    writeFileSync(spec, '# Feature\nDoes a thing.\n')
    const marker = join(root, '.gw-desc')
    writeFileSync(marker, 'Existing description.\n')
    // Marker 10s newer than the spec → the gate sees it as fresh.
    const old = Date.now() / 1000 - 100
    utimesSync(spec, old, old)
    utimesSync(marker, old + 10, old + 10)

    const started = Date.now()
    const result = await generateWorktreeDesc(root, 'feat-x')
    assert.equal(result, null)
    // Well under the 20s CLI timeout — proves it never spawned claude.
    assert.ok(Date.now() - started < 2000)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// No spec folder at all → null (nothing to summarise), also without a claude call.
test('generateWorktreeDesc: no spec returns null', async () => {
  const root = mkdtempSync(join(tmpdir(), 'floe-desc-'))
  try {
    const result = await generateWorktreeDesc(root, 'feat-x')
    assert.equal(result, null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// --- subagents, rebuilt from the JSONL -------------------------------------
// A reopened chat has to show WHO was called and for what. The live part (the
// tool it was on, its token fill) only ever existed while it ran, so the row
// comes back as a finished line — never as a fabricated one.

const { loadClaudeTranscript } = await import('./claudeSessions.ts')

/** Write a session file where the loader looks for it, and point HOME at it. */
function seedSession(worktree: string, id: string, lines: unknown[]): string {
  const home = mkdtempSync(join(tmpdir(), 'floe-home-'))
  const dir = join(home, '.claude', 'projects', worktree.replace(/[/.]/g, '-'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n'))
  process.env.HOME = home
  return home
}

test('two parallel Task calls reload as two subagent rows, the finished one closed', () => {
  const home = process.env.HOME
  const worktree = '/tmp/wt'
  const dir = seedSession(worktree, 'sess', [
    { type: 'user', timestamp: '2026-08-29T10:00:00.000Z', message: { content: 'faz aí' } },
    {
      type: 'assistant',
      timestamp: '2026-08-29T10:00:05.000Z',
      message: {
        model: 'claude-opus-5',
        content: [
          { type: 'text', text: 'abrindo duas frentes' },
          { type: 'tool_use', id: 't1', name: 'Task', input: { subagent_type: 'Explore', description: 'mapear o pipeline' } },
          { type: 'tool_use', id: 't2', name: 'Task', input: { subagent_type: 'general-purpose', description: 'portar o renderer' } }
        ]
      }
    },
    // The child's own work, written into the same file: not this transcript.
    {
      type: 'assistant',
      isSidechain: true,
      timestamp: '2026-08-29T10:00:06.000Z',
      message: { content: [{ type: 'text', text: 'segredo do subagente' }] }
    },
    {
      type: 'user',
      timestamp: '2026-08-29T10:00:47.000Z',
      message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'achei' }] }
    }
  ])
  try {
    const items = loadClaudeTranscript(worktree, 'sess')
    const subs = items.filter((i) => i.role === 'subagent')
    assert.deepEqual(
      subs.map((s) => [s.toolUseId, s.agentType, s.summary, s.harness, s.running]),
      [
        ['t1', 'Explore', 'mapear o pipeline', 'claude', false],
        ['t2', 'general-purpose', 'portar o renderer', 'claude', true]
      ]
    )
    // The one that returned carries how long it took; the one still open does not.
    assert.deepEqual([subs[0].ms, subs[1].ms], [42_000, undefined])
    // The parent's numbers stay the parent's.
    assert.ok(subs.every((s) => s.contextTokens === undefined && s.model === undefined))
    assert.ok(!items.some((i) => i.text === 'segredo do subagente'), 'sidechain lines are the child transcript')
    // The launching line is still the assistant's own text, not a tool chip.
    assert.equal(items[1].text, 'abrindo duas frentes')
  } finally {
    process.env.HOME = home
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an attached image reloads under the message it came with', () => {
  const home = process.env.HOME
  const worktree = '/tmp/wt-img'
  const dir = seedSession(worktree, 'sess', [
    {
      type: 'user',
      timestamp: '2026-08-31T00:22:00.000Z',
      message: {
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } },
          { type: 'text', text: 'olha esse bug [Image #1]' }
        ]
      }
    }
  ])
  try {
    const items = loadClaudeTranscript(worktree, 'sess')
    assert.deepEqual(
      items.map((i) => [i.role, i.text ?? i.data]),
      [
        ['user', 'olha esse bug [Image #1]'],
        ['image', 'AAAA']
      ]
    )
    assert.equal(items[1].mediaType, 'image/jpeg')
    assert.equal(items[1].at, Date.parse('2026-08-31T00:22:00.000Z'))
  } finally {
    process.env.HOME = home
    rmSync(dir, { recursive: true, force: true })
  }
})
