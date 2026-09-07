import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { register } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The probe spawns `claude` and deletes a session file under ~/.claude. Both are
// faked: a module hook swaps `node:child_process` for a stub that hands back the
// FakeChild below, and HOME points at a tmpdir so the cleanup unlink is real but
// harmless. Same register-then-dynamic-import shape as appSettings.test.ts.
const hookSource = `
export async function resolve(specifier, context, next) {
  if (specifier === 'node:child_process' && String(context.parentURL).includes('claudeInfo.ts'))
    return { url: 'stub:child_process', shortCircuit: true, format: 'module' }
  return next(specifier, context)
}
export async function load(url, context, next) {
  if (url === 'stub:child_process')
    return {
      format: 'module',
      shortCircuit: true,
      source: 'export const spawn = (...a) => globalThis.__floeSpawn(...a)'
    }
  return next(url, context)
}
`
register('data:text/javascript,' + encodeURIComponent(hookSource), import.meta.url)

const HOME = mkdtempSync(join(tmpdir(), 'floe-claudeinfo-'))
process.env.HOME = HOME
const WORKTREE = '/tmp/floe-probe-worktree'
const sessionDir = join(HOME, '.claude', 'projects', WORKTREE.replace(/[/.]/g, '-'))

class FakeStream extends EventEmitter {
  setEncoding(): void {}
}

/** Just enough ChildProcess for the probe: two streams, a stdin, a kill. */
class FakeChild extends EventEmitter {
  written: string[] = []
  signals: string[] = []
  stdout = new FakeStream()
  stderr = new FakeStream()
  stdin = {
    write: (s: string): boolean => {
      this.written.push(s)
      return true
    }
  }
  kill(signal: string): boolean {
    this.signals.push(signal)
    return true
  }
}

let child: FakeChild
let spawnArgs: string[] = []
let spawnCwd: string | undefined
let spawnThrows: Error | null = null

;(globalThis as { __floeSpawn?: unknown }).__floeSpawn = (
  _cmd: string,
  args: string[],
  opts: { cwd?: string }
): FakeChild => {
  spawnArgs = args
  spawnCwd = opts.cwd
  if (spawnThrows) throw spawnThrows
  child = new FakeChild()
  return child
}

const { getClaudeInfo, getContextUsage, parseContextUsage, parseTokenCount } = await import('./claudeInfo.ts')

/** The cleanup unlink is callback-based; give the loop a turn to run it. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 10))

const send = (...lines: string[]): void => {
  child.stdout.emit('data', lines.map((l) => l + '\n').join(''))
}

const INIT = {
  type: 'system',
  subtype: 'init',
  session_id: 'sess-1',
  model: 'claude-opus-5',
  claude_code_version: '2.1.222',
  cwd: WORKTREE,
  permissionMode: 'default',
  apiKeySource: 'none',
  mcp_servers: [
    { name: 'floe', status: 'connected' },
    { name: 'rookery' },
    { status: 'connected' }
  ],
  skills: ['deploy', 42, 'run'],
  plugins: [{ name: 'ponytail', source: 'local' }, { name: 'kelp' }, {}]
}

test.beforeEach(() => {
  spawnThrows = null
})

test('getClaudeInfo: the init event fills every panel and /usage fills the text', async () => {
  const p = getClaudeInfo(WORKTREE, '/tmp/mcp.json')

  // The CLI is asked for /usage over stdin, as a real session would be.
  assert.equal(spawnCwd, WORKTREE)
  assert.deepEqual(JSON.parse(child.written[0]), {
    type: 'user',
    message: { role: 'user', content: '/usage' }
  })
  assert.ok(spawnArgs.includes('--mcp-config') && spawnArgs.includes('/tmp/mcp.json'))

  // Split mid-line: the reader has to buffer until the newline arrives.
  const init = JSON.stringify(INIT)
  child.stdout.emit('data', init.slice(0, 40))
  child.stdout.emit('data', init.slice(40) + '\n')
  send(
    'not json at all',
    JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'thinking' }, { type: 'text', text: 'Session 12%' }] }
    }),
    JSON.stringify({ type: 'result', result: 'ignored, the assistant text won' })
  )

  const info = await p
  assert.equal(info.model, 'claude-opus-5')
  assert.equal(info.version, '2.1.222')
  assert.equal(info.cwd, WORKTREE)
  assert.equal(info.permissionMode, 'default')
  assert.equal(info.apiKeySource, 'none')
  assert.equal(info.sessionId, 'sess-1')
  assert.equal(info.usageText, 'Session 12%')
  // Nameless servers and plugins are dropped; a missing status reads "unknown".
  assert.deepEqual(info.mcpServers, [
    { name: 'floe', status: 'connected' },
    { name: 'rookery', status: 'unknown' }
  ])
  assert.deepEqual(info.skills, ['deploy', 'run'])
  assert.deepEqual(info.plugins, [
    { name: 'ponytail', source: 'local' },
    { name: 'kelp', source: undefined }
  ])
  // The probe is a throwaway: it gets killed, not left running.
  assert.deepEqual(child.signals, ['SIGTERM'])
})

test('getClaudeInfo: an init with nothing in it leaves the panels empty', async () => {
  const p = getClaudeInfo(WORKTREE)
  assert.equal(spawnArgs.includes('--mcp-config'), false)
  send(
    JSON.stringify({ type: 'system', subtype: 'init', mcp_servers: 'nope', skills: null, plugins: 7 }),
    // No message object at all, so there is no text block to take.
    JSON.stringify({ type: 'assistant' }),
    JSON.stringify({ type: 'result', result: 'the fallback text' })
  )
  const info = await p
  assert.deepEqual(info, {
    mcpServers: [],
    skills: [],
    plugins: [],
    sessionId: undefined,
    usageText: 'the fallback text'
  })
})

test('getClaudeInfo: the probe session file is deleted, not left in the Resume picker', async () => {
  mkdirSync(sessionDir, { recursive: true })
  const file = join(sessionDir, 'sess-1.jsonl')
  writeFileSync(file, '{}\n')

  const p = getClaudeInfo(WORKTREE)
  send(JSON.stringify(INIT))
  child.emit('close')
  await p
  await settle()
  assert.equal(existsSync(file), false)
})

test('getClaudeInfo: a spawn that throws is reported, not raised', async () => {
  spawnThrows = new Error('EACCES: bad cwd')
  const info = await getClaudeInfo(WORKTREE)
  assert.equal(info.error, 'EACCES: bad cwd')
  assert.deepEqual(info.mcpServers, [])
})

test('getClaudeInfo: a missing CLI says so in plain words', async () => {
  const p = getClaudeInfo(WORKTREE)
  child.emit('error', new Error('spawn claude ENOENT'))
  assert.equal((await p).error, 'claude CLI not found')
})

test('getClaudeInfo: dying with only stderr reports what the CLI printed', async () => {
  const p = getClaudeInfo(WORKTREE)
  child.stderr.emit('data', '  Invalid API key  ')
  child.emit('close')
  assert.equal((await p).error, 'Invalid API key')
})

test('getContextUsage: the /context report is parsed off the result event', async () => {
  const p = getContextUsage(WORKTREE, 'sess-2')
  assert.deepEqual(JSON.parse(child.written[0]), {
    type: 'user',
    message: { role: 'user', content: '/context' }
  })
  // Resuming a live session forks it so the user's own transcript is untouched.
  assert.ok(spawnArgs.includes('--resume') && spawnArgs.includes('--fork-session'))

  mkdirSync(sessionDir, { recursive: true })
  const fork = join(sessionDir, 'fork-9.jsonl')
  writeFileSync(fork, '{}\n')

  send(
    'torn line',
    JSON.stringify({ type: 'system', session_id: 'fork-9' }),
    JSON.stringify({ type: 'result', result: '**Tokens:** 59.8k / 1m (6%)' })
  )
  const usage = await p
  assert.equal(usage.used, 59_800)
  assert.equal(usage.window, 1_000_000)
  assert.deepEqual(child.signals, ['SIGTERM'])

  child.emit('close')
  await settle()
  assert.equal(existsSync(fork), false)
})

test('getContextUsage: no report means an error, not silent zeros', async () => {
  const p = getContextUsage(WORKTREE)
  assert.equal(spawnArgs.includes('--resume'), false)
  child.emit('close')
  assert.equal((await p).error, 'no context report')
})

test('getContextUsage: stderr wins over the generic message', async () => {
  const p = getContextUsage(WORKTREE)
  child.stderr.emit('data', 'not logged in\n')
  child.emit('close')
  assert.equal((await p).error, 'not logged in')
})

test('getContextUsage: spawn failures land in the error field', async () => {
  spawnThrows = new Error('EACCES')
  assert.equal((await getContextUsage(WORKTREE)).error, 'EACCES')

  spawnThrows = null
  const p = getContextUsage(WORKTREE)
  child.emit('error', new Error('spawn claude ENOENT'))
  assert.equal((await p).error, 'claude CLI not found')
})

test('parseTokenCount: k/m suffixes, plain numbers, junk', () => {
  assert.equal(parseTokenCount('3.5k'), 3500)
  assert.equal(parseTokenCount(' 1m '), 1_000_000)
  assert.equal(parseTokenCount('632'), 632)
  assert.equal(parseTokenCount('< 20'), 20)
  assert.equal(parseTokenCount('—'), 0)
})

test('parseContextUsage: model, totals and the category table (free space dropped)', () => {
  const report = [
    '## Context Usage',
    '',
    '**Model:** claude-opus-5[1m]  ',
    '**Tokens:** 59.8k / 1m (6%)',
    '',
    '### Estimated usage by category',
    '',
    '| Category | Tokens | Percentage |',
    '|----------|--------|------------|',
    '| System prompt | 3.5k | 0.3% |',
    '| MCP tools (deferred) | 62k | 6.2% |',
    '| Messages | 38.3k | 3.8% |',
    '| Free space | 940k | 94.0% |',
    '',
    '### MCP Tools',
    '',
    '| Tool | Server | Tokens |',
    '| mcp__floe__list_projects | floe | 415 |'
  ].join('\n')

  const usage = parseContextUsage(report)
  assert.equal(usage.model, 'claude-opus-5')
  assert.equal(usage.used, 59_800)
  assert.equal(usage.window, 1_000_000)
  assert.deepEqual(usage.categories, [
    { label: 'System prompt', tokens: 3500 },
    { label: 'MCP tools (deferred)', tokens: 62_000 },
    { label: 'Messages', tokens: 38_300 }
  ])
})

test('parseContextUsage: garbage in, empty breakdown out', () => {
  assert.deepEqual(parseContextUsage('this command is not available').categories, [])
})
