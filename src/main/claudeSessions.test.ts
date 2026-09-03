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

// A background agent reports back by injecting its whole result as a user
// message to resume the turn. It must never reload as something you said.
test('a task-notification does not reload as a user message', () => {
  const home = process.env.HOME
  const worktree = '/tmp/wt-notify'
  const dir = seedSession(worktree, 'sess', [
    { type: 'user', timestamp: '2026-08-31T00:56:00.000Z', message: { content: 'mapeia as duas coisas' } },
    {
      type: 'assistant',
      timestamp: '2026-08-31T00:56:02.000Z',
      message: { content: [{ type: 'tool_use', id: 't1', name: 'Agent', input: { subagent_type: 'Explore', description: 'Map rookery MCP server' } }] }
    },
    {
      type: 'user',
      timestamp: '2026-08-31T00:58:00.000Z',
      message: {
        content:
          '<task-notification>\n<task-id>a4521fc</task-id>\n<tool-use-id>t1</tool-use-id>\n<status>completed</status>\n<result>Here is the complete picture…</result>\n</task-notification>'
      }
    },
    {
      type: 'assistant',
      timestamp: '2026-08-31T00:58:10.000Z',
      message: { content: [{ type: 'text', text: 'pronto, achei' }] }
    }
  ])
  try {
    const items = loadClaudeTranscript(worktree, 'sess')
    // The notification itself is plumbing and never reloads as a user line; what
    // survives of it is the agent's report, spoken under the agent's own nick.
    assert.deepEqual(
      items.map((i) => [i.role, i.from ?? null]),
      [
        ['user', null],
        ['subagent', null],
        ['assistant', 'explore-t1'],
        ['assistant', null]
      ]
    )
    assert.ok(!items.some((i) => (i.text ?? '').includes('task-notification')))
    assert.equal(items[2].text, 'Here is the complete picture…')
    // The notification did not restart the turn clock: the answer is still
    // timed from the message that was actually sent.
    assert.equal(items[3].ms, 130_000)
  } finally {
    process.env.HOME = home
    rmSync(dir, { recursive: true, force: true })
  }
})

// --- another session speaking ----------------------------------------------

test("a peer session's message reloads under its own nick, body only", () => {
  const home = process.env.HOME
  const worktree = '/tmp/wt-peer'
  const dir = seedSession(worktree, 'sess', [
    { type: 'user', timestamp: '2026-09-01T11:00:00.000Z', message: { content: 'toca o barco' } },
    {
      type: 'user',
      timestamp: '2026-09-01T11:08:00.000Z',
      message: {
        content:
          'Another Claude session sent a message:\n' +
          '<cross-session-message from="uds:/tmp/cc-socks/24482.sock" from-name="floe-8f" from-mode="bypass">\n' +
          'Vou mexer em skills.ts, não toca nele.\n' +
          '</cross-session-message>\n\n' +
          'This came from another Claude session — not typed by your user, but very likely working on their behalf.'
      }
    }
  ])
  try {
    const items = loadClaudeTranscript(worktree, 'sess')
    assert.deepEqual(
      items.map((i) => [i.role, i.from]),
      [
        ['user', undefined],
        ['user', 'floe-8f']
      ]
    )
    // Only what the peer actually said: the preamble and the trailer are the
    // harness talking to the model, not a message anyone can read as one.
    assert.equal(items[1].text, 'Vou mexer em skills.ts, não toca nele.')
  } finally {
    process.env.HOME = home
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a Task's result comes back as the agent's own line, under its nick", () => {
  const home = process.env.HOME
  const worktree = '/tmp/wt-reply'
  const dir = seedSession(worktree, 'sess', [
    { type: 'user', timestamp: '2026-09-01T09:00:00.000Z', message: { content: 'mapeia o pipeline' } },
    {
      type: 'assistant',
      timestamp: '2026-09-01T09:00:05.000Z',
      message: {
        model: 'claude-opus-5',
        content: [{ type: 'tool_use', id: 'toolu_a3f', name: 'Task', input: { subagent_type: 'Explore', description: 'mapear' } }]
      }
    },
    {
      type: 'user',
      timestamp: '2026-09-01T09:01:00.000Z',
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_a3f', content: [{ type: 'text', text: 'o pipeline passa por agent.ts' }] }] }
    }
  ])
  try {
    const items = loadClaudeTranscript(worktree, 'sess')
    assert.deepEqual(
      items.map((i) => [i.role, i.from ?? null]),
      [
        ['user', null],
        ['subagent', null],
        ['assistant', 'explore-ua3f']
      ]
    )
    assert.equal(items[2].text, 'o pipeline passa por agent.ts')
    // The row it was launched from still closes, and still times itself.
    assert.equal(items[1].running, false)
    assert.equal(items[1].ms, 55_000)
  } finally {
    process.env.HOME = home
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an async agent keeps its row open on the launch ack and speaks in its notification', () => {
  const home = process.env.HOME
  const worktree = '/tmp/wt-async'
  const dir = seedSession(worktree, 'sess', [
    { type: 'user', timestamp: '2026-09-01T09:00:00.000Z', message: { content: 'auditar o bundle' } },
    {
      type: 'assistant',
      timestamp: '2026-09-01T09:00:05.000Z',
      message: {
        model: 'claude-opus-5',
        content: [{ type: 'tool_use', id: 'toolu_b7c', name: 'Agent', input: { subagent_type: 'general-purpose', description: 'auditar' } }]
      }
    },
    {
      type: 'user',
      timestamp: '2026-09-01T09:00:06.000Z',
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_b7c', content: [{ type: 'text', text: 'Async agent launched (task id ad8330)' }] }] }
    },
    {
      type: 'user',
      timestamp: '2026-09-01T09:04:05.000Z',
      message: {
        content:
          '<task-notification>\n<task-id>ad8330</task-id>\n<tool-use-id>toolu_b7c</tool-use-id>\n<status>completed</status>\n<result>O bundle do renderer não é minificado.</result>\n</task-notification>'
      }
    }
  ])
  try {
    const items = loadClaudeTranscript(worktree, 'sess')
    assert.deepEqual(
      items.map((i) => [i.role, i.from ?? null]),
      [
        ['user', null],
        ['subagent', null],
        ['assistant', 'general-purpose-ub7c']
      ],
      'the launch ack says nothing — only the notification carries what it found'
    )
    assert.equal(items[2].text, 'O bundle do renderer não é minificado.')
    assert.equal(items[1].running, false)
    // Timed from the launch to the notification, not to the ack it answered with.
    assert.equal(items[1].ms, 240_000)
  } finally {
    process.env.HOME = home
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an envelope quoted inside a message of your own stays your message', () => {
  const home = process.env.HOME
  const worktree = '/tmp/wt-quoted'
  const dir = seedSession(worktree, 'sess', [
    {
      type: 'user',
      timestamp: '2026-09-01T11:20:00.000Z',
      message: {
        content:
          'olha o formato que chega: <cross-session-message from-name="floe-8f" from-mode="bypass">\nnão sou eu falando\n</cross-session-message> — dá pra parsear isso?'
      }
    }
  ])
  try {
    const items = loadClaudeTranscript(worktree, 'sess')
    assert.deepEqual(items.map((i) => [i.role, i.from ?? null]), [['user', null]])
    assert.match(items[0].text ?? '', /dá pra parsear isso\?$/)
  } finally {
    process.env.HOME = home
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a failed Task closes its row without putting the error in the agent\'s mouth', () => {
  const home = process.env.HOME
  const worktree = '/tmp/wt-failed'
  const dir = seedSession(worktree, 'sess', [
    { type: 'user', timestamp: '2026-09-01T09:00:00.000Z', message: { content: 'roda o explore' } },
    {
      type: 'assistant',
      timestamp: '2026-09-01T09:00:05.000Z',
      message: { content: [{ type: 'tool_use', id: 'toolu_c9d', name: 'Task', input: { subagent_type: 'Explore', description: 'mapear' } }] }
    },
    {
      type: 'user',
      timestamp: '2026-09-01T09:00:09.000Z',
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_c9d', is_error: true, content: 'Error: permission denied' }] }
    }
  ])
  try {
    const items = loadClaudeTranscript(worktree, 'sess')
    assert.deepEqual(items.map((i) => i.role), ['user', 'subagent'])
    assert.equal(items[1].running, false, 'the row still closes — it really did end')
  } finally {
    process.env.HOME = home
    rmSync(dir, { recursive: true, force: true })
  }
})

// A message typed while the turn was running. The CLI queues it, folds it into
// the turn in flight, and records what it absorbed as one `attachment` line —
// there is no user message for it anywhere else in the file.
test('a steer reloads as the line you typed, where you typed it', () => {
  const home = process.env.HOME
  const worktree = '/tmp/wt-steer'
  const dir = seedSession(worktree, 'sess', [
    { type: 'user', timestamp: '2026-09-02T21:36:17.000Z', message: { content: 'roda os quatro comandos' } },
    {
      type: 'assistant',
      timestamp: '2026-09-02T21:36:21.000Z',
      message: { content: [{ type: 'tool_use', id: 'toolu_a1', name: 'Bash', input: { command: 'sleep 10; date' } }] }
    },
    {
      type: 'user',
      timestamp: '2026-09-02T21:36:31.000Z',
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_a1', content: 'Wed Sep 2' }] }
    },
    // What the CLI writes for the steer: the enqueue mark, then the message.
    { type: 'queue-operation', operation: 'enqueue', timestamp: '2026-09-02T21:36:25.000Z', content: 'lembra do 42' },
    {
      type: 'attachment',
      timestamp: '2026-09-02T21:36:25.000Z',
      attachment: { type: 'queued_command', prompt: 'lembra do 42', commandMode: 'prompt' }
    },
    { type: 'queue-operation', operation: 'remove', reason: 'absorbed_mid_turn', timestamp: '2026-09-02T21:36:31.000Z', content: 'lembra do 42' },
    {
      type: 'assistant',
      timestamp: '2026-09-02T21:36:36.000Z',
      message: { content: [{ type: 'text', text: '1/4 pronta, 42 anotado.' }] }
    }
  ])
  try {
    const items = loadClaudeTranscript(worktree, 'sess')
    assert.deepEqual(
      items.map((i) => [i.role, i.text ?? i.name]),
      [
        ['user', 'roda os quatro comandos'],
        ['tool', 'Bash'],
        ['user', 'lembra do 42'],
        ['assistant', '1/4 pronta, 42 anotado.']
      ],
      'the queue bookkeeping is not a message; the steer is'
    )
    assert.equal(items[2].at, Date.parse('2026-09-02T21:36:25.000Z'), 'stamped when it was typed')
    // The steer must not restart the turn clock it joined.
    assert.equal(items[3].ms, 19_000, 'the answer is still timed from the turn you started')
  } finally {
    process.env.HOME = home
    rmSync(dir, { recursive: true, force: true })
  }
})
