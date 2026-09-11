import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// claudeSessions.ts uses extensionless relative imports (./plans, ./sessionStore,
// …) — resolved by electron-vite at build time, not by raw Node ESM. Register the
// same in-memory hook the other main-process tests use to rewrite `./x` → `./x.ts`
// before importing the module. The `electron` stub reads FLOE_TEST_USERDATA so the
// session store (via ./dataDir) can be pointed at a tmpdir per test.
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
    const src = "export const app = { getPath: () => process.env.FLOE_TEST_USERDATA || '/tmp' }; export class BrowserWindow {}; export const ipcMain = { handle(){}, on(){} }; export default {};"
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

// The CLI's own slug for a cwd: every non-alphanumeric character becomes '-'.
// Written here exactly as the CLI writes it, so a path the two rules disagree
// about (anything with an underscore) is a real test and not a tautology.
const cliSlug = (worktree: string): string => worktree.replace(/[^a-zA-Z0-9]/g, '-')

/** Write a session file where the loader looks for it, and point HOME at it. */
function seedSession(worktree: string, id: string, lines: unknown[]): string {
  const home = mkdtempSync(join(tmpdir(), 'floe-home-'))
  const dir = join(home, '.claude', 'projects', cliSlug(worktree))
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

// A worktree whose path holds an underscore. The CLI slugs it to '-' like every
// other non-alphanumeric; Floe only replaced '/' and '.', so it looked for a
// directory the CLI never writes and every read came back empty — the chat
// opened on "Nothing said yet." with its whole transcript sitting on disk.
test('a worktree path with underscores finds its transcript', () => {
  const home = process.env.HOME
  const worktree = '/tmp/clients/__.macs'
  const dir = seedSession(worktree, 'sess', [
    { type: 'user', timestamp: '2026-09-08T20:00:00.000Z', message: { content: 'oi' } },
    {
      type: 'assistant',
      timestamp: '2026-09-08T20:00:01.000Z',
      message: { model: 'claude-opus-5', content: [{ type: 'text', text: 'olá' }] }
    }
  ])
  try {
    assert.deepEqual(
      loadClaudeTranscript(worktree, 'sess').map((i) => [i.role, i.text]),
      [
        ['user', 'oi'],
        ['assistant', 'olá']
      ]
    )
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
          { type: 'text', text: 'olha esse bug image 01' }
        ]
      }
    }
  ])
  try {
    const items = loadClaudeTranscript(worktree, 'sess')
    assert.deepEqual(
      items.map((i) => [i.role, i.text ?? i.data]),
      [
        ['user', 'olha esse bug image 01'],
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

// A task that finishes while the turn is running is enqueued, and the CLI keeps
// only that queued copy — no `user` line follows it. Reloading it verbatim
// pasted the raw notification into the chat under the user's own nick.
test('a QUEUED task-notification does not reload as a user message', () => {
  const home = process.env.HOME
  const worktree = '/tmp/wt-queued-notify'
  const dir = seedSession(worktree, 'sess', [
    { type: 'user', timestamp: '2026-09-03T16:30:00.000Z', message: { content: 'sobe o daemon e mapeia o resto' } },
    {
      type: 'assistant',
      timestamp: '2026-09-03T16:30:04.000Z',
      message: { content: [{ type: 'tool_use', id: 't2', name: 'Agent', input: { subagent_type: 'Explore', description: 'Map the boot path' } }] }
    },
    // A background Bash command that died: no <result>, only a <summary>.
    {
      type: 'attachment',
      timestamp: '2026-09-03T16:34:00.000Z',
      attachment: {
        type: 'queued_command',
        prompt:
          '<task-notification>\n<task-id>bwm4core5</task-id>\n<tool-use-id>toolu_01Mtvk</tool-use-id>\n<status>failed</status>\n<summary>Background command "Start a local test daemon" failed with exit code 143</summary>\n</task-notification>'
      }
    },
    // An async agent finishing the same way: its report is the only copy there is.
    {
      type: 'attachment',
      timestamp: '2026-09-03T16:34:30.000Z',
      attachment: {
        type: 'queued_command',
        prompt: '<task-notification>\n<task-id>a91</task-id>\n<tool-use-id>t2</tool-use-id>\n<status>completed</status>\n<result>O boot passa por webBoot.</result>\n</task-notification>'
      }
    },
    {
      type: 'assistant',
      timestamp: '2026-09-03T16:34:40.000Z',
      message: { content: [{ type: 'text', text: 'o daemon caiu, mas o mapa veio' }] }
    }
  ])
  try {
    const items = loadClaudeTranscript(worktree, 'sess')
    assert.ok(!items.some((i) => (i.text ?? '').includes('task-notification')), 'no raw notification in the chat')
    assert.deepEqual(
      items.map((i) => [i.role, i.from ?? null]),
      [
        ['user', null],
        ['subagent', null],
        ['assistant', 'explore-t2'],
        ['assistant', null]
      ]
    )
    assert.equal(items[1].running, false, 'the queued notification still closes the row it names')
    assert.equal(items[2].text, 'O boot passa por webBoot.')
    // Neither notification restarted the turn clock.
    assert.equal(items[3].ms, 280_000)
  } finally {
    process.env.HOME = home
    rmSync(dir, { recursive: true, force: true })
  }
})

// --- questions, asked and answered -----------------------------------------

test('an AskUserQuestion round-trips as the question asked and the answer given', () => {
  const home = process.env.HOME
  const worktree = '/tmp/wt-ask'
  const dir = seedSession(worktree, 'sess', [
    { type: 'user', timestamp: '2026-09-04T10:00:00.000Z', message: { content: 'escolhe por mim' } },
    {
      type: 'assistant',
      timestamp: '2026-09-04T10:00:05.000Z',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'q1',
            name: 'AskUserQuestion',
            input: {
              questions: [
                { header: 'Auth method', question: 'Which auth flow?' },
                // header === question: printing it twice would just be noise.
                { header: 'Library', question: 'Library' },
                { question: 'Ship it?' },
                { header: '', question: '' }
              ]
            }
          }
        ]
      }
    },
    {
      type: 'user',
      timestamp: '2026-09-04T10:01:00.000Z',
      message: { content: [{ type: 'tool_result', tool_use_id: 'q1', content: [{ type: 'text', text: 'OAuth' }] }] }
    }
  ])
  try {
    const items = loadClaudeTranscript(worktree, 'sess')
    assert.deepEqual(
      items.map((i) => [i.role, i.text]),
      [
        ['user', 'escolhe por mim'],
        ['assistant', 'Auth method — Which auth flow?\nLibrary\nShip it?'],
        // The answer is the user's line, not a bare tool chip pointing nowhere.
        ['user', 'OAuth']
      ]
    )
  } finally {
    process.env.HOME = home
    rmSync(dir, { recursive: true, force: true })
  }
})

// Nothing readable to ask → it is just a tool call, and reloads as the chip any
// other tool gets. A blank "assistant said nothing" line would be worse.
test('an AskUserQuestion with no questions falls back to a tool row', () => {
  const home = process.env.HOME
  const worktree = '/tmp/wt-ask-empty'
  const dir = seedSession(worktree, 'sess', [
    {
      type: 'assistant',
      timestamp: '2026-09-04T10:00:05.000Z',
      message: {
        content: [
          { type: 'tool_use', id: 'q1', name: 'AskUserQuestion', input: { questions: [] } },
          { type: 'tool_use', id: 'q2', name: 'AskUserQuestion', input: { description: 'malformed' } }
        ]
      }
    },
    // Its "answer" has no question to belong to, so it stays out of the chat.
    {
      type: 'user',
      timestamp: '2026-09-04T10:01:00.000Z',
      message: { content: [{ type: 'tool_result', tool_use_id: 'q1', content: 'whatever' }] }
    }
  ])
  try {
    const items = loadClaudeTranscript(worktree, 'sess')
    assert.deepEqual(
      items.map((i) => [i.role, i.name, i.summary]),
      [
        ['tool', 'AskUserQuestion', undefined],
        ['tool', 'AskUserQuestion', 'malformed']
      ]
    )
  } finally {
    process.env.HOME = home
    rmSync(dir, { recursive: true, force: true })
  }
})

// --- the store-backed lists -------------------------------------------------
// listClaudeSessions / listResumableSessions / computeProjectActivity read both
// `~/.claude/projects` (HOME) and Floe's own sessions.json (the electron stub's
// userData). A world is one tmpdir for each, torn down after the test.

const { listClaudeSessions, listResumableSessions, computeProjectActivity, sessionHasUnansweredQuestion, readAiTitle, firstUserTitle } =
  await import('./claudeSessions.ts')

interface World {
  home: string
  data: string
}

function projectDirOf(w: World, worktree: string): string {
  return join(w.home, '.claude', 'projects', cliSlug(worktree))
}

function writeTranscript(w: World, worktree: string, id: string, lines: unknown[] | string): string {
  const dir = projectDirOf(w, worktree)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${id}.jsonl`)
  writeFileSync(file, typeof lines === 'string' ? lines : lines.map((l) => JSON.stringify(l)).join('\n'))
  return file
}

function writeStore(w: World, store: unknown): void {
  writeFileSync(join(w.data, 'sessions.json'), JSON.stringify(store))
}

async function inWorld(body: (w: World) => void | Promise<void>): Promise<void> {
  const prevHome = process.env.HOME
  const prevData = process.env.FLOE_TEST_USERDATA
  const w: World = { home: mkdtempSync(join(tmpdir(), 'floe-home-')), data: mkdtempSync(join(tmpdir(), 'floe-data-')) }
  process.env.HOME = w.home
  process.env.FLOE_TEST_USERDATA = w.data
  try {
    await body(w)
  } finally {
    process.env.HOME = prevHome
    if (prevData === undefined) delete process.env.FLOE_TEST_USERDATA
    else process.env.FLOE_TEST_USERDATA = prevData
    rmSync(w.home, { recursive: true, force: true })
    rmSync(w.data, { recursive: true, force: true })
  }
}

// The sidebar lists only what Floe knows about, in creation order, with each
// row's recency taken from the best source it has.
test('listClaudeSessions: creation order, transcript mtime, stored rename', () =>
  inWorld((w) => {
    const wt = '/tmp/wt-list'
    const linked = writeTranscript(w, wt, 'c1', [{ type: 'user', message: { content: 'oi' } }])
    // Newest transcript on the FIRST-created session: the list must not reorder.
    utimesSync(linked, Date.now() / 1000, Date.now() / 1000)
    writeStore(w, {
      meta: { c1: { title: 'Renamed by hand' } },
      created: [
        { id: 's1', worktreePath: wt, title: 'Placeholder', createdAt: 1000, claudeId: 'c1', model: 'opus', effort: 'high' },
        { id: 's2', worktreePath: wt, title: '', createdAt: 2000 },
        { id: 's3', worktreePath: wt, title: '', createdAt: 3000, claudeId: 'c3-abcdefgh', usedAt: 4000 },
        { id: 'other', worktreePath: '/tmp/elsewhere', title: 'Not here', createdAt: 500 }
      ]
    })

    const rows = listClaudeSessions(wt)
    assert.deepEqual(
      rows.map((r) => [r.id, r.title]),
      [
        // The rename wins over the created-session title…
        ['s1', 'Renamed by hand'],
        // …an untitled, unlinked session falls back to a constant…
        ['s2', 'Session'],
        // …and a linked one to the head of its Claude id.
        ['s3', 'c3-abcde']
      ],
      'creation order, never mtime order — a busy session must not jump'
    )
    assert.equal(rows[0].mtime, statSync(linked).mtimeMs)
    assert.equal(rows[0].active, true)
    assert.deepEqual([rows[0].model, rows[0].effort], ['opus', 'high'])
    // No transcript on disk: `usedAt` is the fallback, and nothing that old is active.
    assert.deepEqual(
      [rows[1].mtime, rows[1].active, rows[2].mtime, rows[2].active],
      [2000, false, 4000, false]
    )
  }))

// The Resume picker offers every real session on disk except the ones already in
// the app — and reads each one's title (and TUI-vs-headless) off its head.
test('listResumableSessions: drops adopted/empty/untitled files, newest first', () =>
  inWorld((w) => {
    const wt = '/tmp/wt-resume'
    const files: Record<string, string> = {
      // Interactive: opens with a setup entry, and Claude wrote it a title.
      a: [
        JSON.stringify({ type: 'mode', mode: 'default' }),
        JSON.stringify({ type: 'ai-title', title: '# Rewrite the JSONL parser' }),
        JSON.stringify({ type: 'user', message: { content: 'parser please' } }),
        '{"type":"user","message":{"cont' // a truncated tail line must not throw
      ].join('\n'),
      // Headless/SDK: opens with queue-operation and has no ai-title.
      b: [
        JSON.stringify({ type: 'queue-operation', operation: 'enqueue' }),
        JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'headless run' }] } })
      ].join('\n'),
      // Headless-looking, but bridged — the marker makes it interactive.
      c: [
        JSON.stringify({ type: 'queue-operation', operation: 'enqueue' }),
        JSON.stringify({ type: 'bridge-session', id: 'x' }),
        JSON.stringify({ type: 'user', message: { content: 'bridged' } })
      ].join('\n'),
      d: JSON.stringify({ type: 'user', message: { content: 'already in the app' } }),
      // No user message anywhere → subagent/system noise, not a session.
      e: JSON.stringify({ type: 'summary', summary: 'nope' }),
      f: '' // never written to
    }
    for (const [id, body] of Object.entries(files)) writeTranscript(w, wt, id, body)
    writeFileSync(join(projectDirOf(w, wt), 'notes.txt'), 'not a transcript')
    const base = Date.now() / 1000 - 3600
    utimesSync(join(projectDirOf(w, wt), 'a.jsonl'), base + 1, base + 1)
    utimesSync(join(projectDirOf(w, wt), 'b.jsonl'), base + 3, base + 3)
    utimesSync(join(projectDirOf(w, wt), 'c.jsonl'), base + 2, base + 2)
    writeStore(w, {
      meta: { c: { title: 'Renamed bridge' } },
      created: [{ id: 's1', worktreePath: wt, title: 't', createdAt: 1, claudeId: 'd' }]
    })

    assert.deepEqual(
      listResumableSessions(wt).map((r) => [r.claudeId, r.title, r.interactive, r.active]),
      [
        ['b', 'headless run', false, false],
        ['c', 'Renamed bridge', true, false],
        // The ai-title wins over the first message, cleaned of its markdown.
        ['a', 'Rewrite the JSONL parser', true, false]
      ],
      'newest first; d is adopted, e has no title, f is empty, notes.txt is not a session'
    )
    // The same head, read through the two title accessors.
    assert.equal(readAiTitle(wt, 'a'), 'Rewrite the JSONL parser')
    assert.equal(firstUserTitle(wt, 'a'), 'parser please')
    assert.equal(readAiTitle(wt, 'b'), '')
    // A file that isn't there reads as no title rather than throwing.
    assert.equal(firstUserTitle(wt, 'missing'), '')
    assert.deepEqual(listResumableSessions('/tmp/never-used'), [])
  }))

// --- the "needs you" scan ---------------------------------------------------

const askLine = (id: string): unknown => ({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', id, name: 'AskUserQuestion', input: { questions: [{ header: 'Go?', question: 'Go?' }] } }] }
})
const answerLine = (id: string): unknown => ({
  type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'yes' }] }
})

test('sessionHasUnansweredQuestion: only an ask with no matching result counts', () =>
  inWorld((w) => {
    const wt = '/tmp/wt-ask-scan'
    writeTranscript(w, wt, 'open', [{ type: 'user', message: { content: 'vai' } }, askLine('a1')])
    writeTranscript(w, wt, 'closed', [askLine('a1'), answerLine('a1')])
    // Answered, then asked again: the last one is still open.
    writeTranscript(w, wt, 'again', [askLine('a1'), answerLine('a1'), askLine('a2')])
    writeTranscript(w, wt, 'other-tool', [
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'ls' } }] } }
    ])
    // Only the tail is read, so a huge transcript still answers: the padding
    // pushes the cut into the middle of a line, which must be skipped, not throw.
    const pad = Array.from({ length: 900 }, (_, i) => JSON.stringify({ type: 'user', message: { content: 'x'.repeat(80) + i } }))
    writeTranscript(w, wt, 'huge', [...pad, JSON.stringify(askLine('z9'))].join('\n'))

    assert.equal(sessionHasUnansweredQuestion(wt, 'open'), true)
    assert.equal(sessionHasUnansweredQuestion(wt, 'closed'), false)
    assert.equal(sessionHasUnansweredQuestion(wt, 'again'), true)
    assert.equal(sessionHasUnansweredQuestion(wt, 'other-tool'), false)
    assert.equal(sessionHasUnansweredQuestion(wt, 'huge'), true)
    assert.equal(sessionHasUnansweredQuestion(wt, 'gone'), false)
  }))

// --- the projects rail ------------------------------------------------------

test('computeProjectActivity: nothing worked today drops the project', () =>
  inWorld((w) => {
    const wt = '/tmp/wt-rail-old'
    const yesterday = new Date()
    yesterday.setHours(0, 0, 0, 0)
    const stamp = (yesterday.getTime() - 3_600_000) / 1000
    const file = writeTranscript(w, wt, 'c1', [askLine('a1')])
    utimesSync(file, stamp, stamp)
    writeStore(w, { meta: {}, created: [{ id: 's1', worktreePath: wt, title: 't', createdAt: 1000, claudeId: 'c1' }] })

    assert.equal(computeProjectActivity([wt]), null)
  }))

test('computeProjectActivity: the worst status across the worktrees wins', () =>
  inWorld((w) => {
    const busy = '/tmp/wt-rail-a'
    const quiet = '/tmp/wt-rail-b'
    const asking = writeTranscript(w, busy, 'c1', [{ type: 'user', message: { content: 'vai' } }, askLine('a1')])
    const working = writeTranscript(w, quiet, 'c2', [askLine('a1'), answerLine('a1')])
    const now = Date.now()
    writeStore(w, {
      meta: {},
      created: [
        { id: 's1', worktreePath: busy, title: 't', createdAt: 1000, claudeId: 'c1' },
        { id: 's2', worktreePath: quiet, title: 't', createdAt: 1000, claudeId: 'c2' },
        // No claudeId → nothing on disk to scan, and it is not today's work.
        { id: 's3', worktreePath: quiet, title: 't', createdAt: 1000 }
      ]
    })

    // Both touched right now, so both are inside the 2-minute active window.
    const a = computeProjectActivity([busy, quiet], () => false)
    assert.deepEqual(a, {
      status: 'ask',
      sessionsToday: 2,
      activeCount: 2,
      askCount: 1,
      lastActivityAt: Math.max(statSync(asking).mtimeMs, statSync(working).mtimeMs)
    })
    // `isConnected` false did not clear it: a session touched seconds ago is
    // trusted even when its conn already dropped — the kill races the poll.
    assert.ok(a && a.lastActivityAt >= now - 60_000)

    // With no open question anywhere, an active project is merely 'pending'.
    writeTranscript(w, busy, 'c1', [askLine('a1'), answerLine('a1')])
    assert.equal(computeProjectActivity([busy, quiet])?.status, 'pending')
  }))

// --- the worktree description, with a stand-in for the CLI -------------------
// `claude` is resolved off PATH, so a two-line shell script in a tmpdir is a
// complete stand-in: it exercises the real execFile path without a real model.

function fakeClaude(body: string): string {
  const bin = mkdtempSync(join(tmpdir(), 'floe-bin-'))
  const file = join(bin, 'claude')
  writeFileSync(file, `#!/bin/sh\n${body}\n`)
  chmodSync(file, 0o755)
  process.env.PATH = `${bin}:${process.env.PATH}`
  return bin
}

async function withFakeClaude(body: string, run: () => Promise<void>): Promise<void> {
  const prevPath = process.env.PATH
  const bin = fakeClaude(body)
  try {
    await run()
  } finally {
    process.env.PATH = prevPath
    rmSync(bin, { recursive: true, force: true })
  }
}

/** A worktree whose spec.md is older than any marker written from now on. */
function seedSpec(root: string, branch: string, text: string): void {
  const dir = join(root, 'specs', branch)
  mkdirSync(dir, { recursive: true })
  const spec = join(dir, 'spec.md')
  writeFileSync(spec, text)
  const old = Date.now() / 1000 - 600
  utimesSync(spec, old, old)
}

test('generateWorktreeDesc: writes the marker, collapses the CLI output, then goes quiet', async () => {
  const root = mkdtempSync(join(tmpdir(), 'floe-desc-'))
  try {
    seedSpec(root, 'feat-y', '# Draw\nAn Excalidraw panel.\n')
    await withFakeClaude("printf 'Adds a  draw\\n  panel to the sidebar.\\n'", async () => {
      const desc = await generateWorktreeDesc(root, 'feat-y')
      assert.equal(desc, 'Adds a draw panel to the sidebar.')
      assert.equal(readFileSync(join(root, '.gw-desc'), 'utf8'), 'Adds a draw panel to the sidebar.\n')
      // The marker it just wrote is now newer than the spec, so the next sidebar
      // refresh must not spawn the CLI again.
      assert.equal(await generateWorktreeDesc(root, 'feat-y'), null)
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('generateWorktreeDesc: a failed or silent CLI leaves no marker', async () => {
  const failed = mkdtempSync(join(tmpdir(), 'floe-desc-'))
  const silent = mkdtempSync(join(tmpdir(), 'floe-desc-'))
  try {
    seedSpec(failed, 'feat-z', '# Z\nSomething.\n')
    seedSpec(silent, 'feat-z', '# Z\nSomething.\n')
    await withFakeClaude('exit 1', async () => {
      assert.equal(await generateWorktreeDesc(failed, 'feat-z'), null)
    })
    await withFakeClaude('exit 0', async () => {
      assert.equal(await generateWorktreeDesc(silent, 'feat-z'), null)
    })
    // Nothing was cached, so the next call still gets a chance to generate.
    assert.equal(existsSync(join(failed, '.gw-desc')), false)
    assert.equal(existsSync(join(silent, '.gw-desc')), false)
  } finally {
    rmSync(failed, { recursive: true, force: true })
    rmSync(silent, { recursive: true, force: true })
  }
})

// A `.gw-desc` with no spec behind it was borrowed from another worktree by the
// old fallback: it describes somebody else's feature, so it has to go.
test('generateWorktreeDesc: a marker with no matching spec is deleted', async () => {
  const root = mkdtempSync(join(tmpdir(), 'floe-desc-'))
  try {
    const marker = join(root, '.gw-desc')
    writeFileSync(marker, 'Borrowed from another branch.\n')
    assert.equal(await generateWorktreeDesc(root, 'feat-none'), null)
    assert.equal(existsSync(marker), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// An empty spec says nothing worth summarising — and must not burn a CLI call.
test('generateWorktreeDesc: an empty spec returns null', async () => {
  const root = mkdtempSync(join(tmpdir(), 'floe-desc-'))
  try {
    seedSpec(root, 'feat-blank', '   \n\n')
    const started = Date.now()
    assert.equal(await generateWorktreeDesc(root, 'feat-blank'), null)
    assert.ok(Date.now() - started < 2000)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// --- harness skills ---------------------------------------------------------

test('a skill reloads as the chip that ran it, not as its instructions', () => {
  const home = process.env.HOME
  const worktree = '/tmp/wt-skill'
  const body =
    'Base directory for this skill: /tmp/wt-skill/.claude/skills/ds-specify\n\n' +
    '## User Input\n\n```text\n388\n```\n\n## Outline\n\nFour hundred lines of instructions.'
  const dir = seedSession(worktree, 'sess', [
    {
      type: 'user',
      timestamp: '2026-09-09T22:04:00.000Z',
      message: {
        content:
          '<command-message>ds-specify</command-message> <command-name>/ds-specify</command-name> <command-args>388</command-args>'
      }
    },
    {
      type: 'user',
      isMeta: true,
      timestamp: '2026-09-09T22:04:00.500Z',
      message: { content: [{ type: 'text', text: body }] }
    },
    {
      type: 'assistant',
      timestamp: '2026-09-09T22:04:10.000Z',
      message: { content: [{ type: 'text', text: "I'll load the config first." }] }
    }
  ])
  try {
    const items = loadClaudeTranscript(worktree, 'sess')
    // The chip you ran, then the answer. The injected SKILL.md is not a message
    // anyone sent, and printing it buries the chat it belongs to.
    assert.deepEqual(
      items.map((i) => [i.role, i.name ?? i.text]),
      [
        ['tool', '/ds-specify'],
        ['assistant', "I'll load the config first."]
      ]
    )
    assert.equal(items[0].summary, '388')
    assert.ok(!items.some((i) => (i.text ?? '').includes('Base directory for this skill')))
  } finally {
    process.env.HOME = home
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a skill the model called shows which skill it was', () => {
  const home = process.env.HOME
  const worktree = '/tmp/wt-skill-tool'
  const dir = seedSession(worktree, 'sess', [
    { type: 'user', timestamp: '2026-09-09T22:04:00.000Z', message: { content: 'commit everything' } },
    {
      type: 'assistant',
      timestamp: '2026-09-09T22:04:02.000Z',
      message: { content: [{ type: 'tool_use', id: 't1', name: 'Skill', input: { skill: 'commit', args: 'commit everything' } }] }
    },
    {
      type: 'user',
      isMeta: true,
      timestamp: '2026-09-09T22:04:03.000Z',
      message: { content: [{ type: 'text', text: 'Base directory for this skill: /tmp/wt-skill-tool/.claude/skills/commit\n\nrun git commit.' }] }
    }
  ])
  try {
    const items = loadClaudeTranscript(worktree, 'sess')
    assert.deepEqual(
      items.map((i) => [i.role, i.name ?? i.text]),
      [
        ['user', 'commit everything'],
        ['tool', 'Skill']
      ]
    )
    // Without a summary the row reads "Skill" and says nothing about which one.
    assert.equal(items[1].summary, 'commit')
  } finally {
    process.env.HOME = home
    rmSync(dir, { recursive: true, force: true })
  }
})
