import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { installHook } from './config/hook.test-helper.ts'
import type { Worktree } from '../shared/types'
import { waitFor } from './watch.test-helper.ts'

// Hermetic boot of the real server: the loader hook stubs `electron` and
// rewrites extensionless imports so the whole main-process graph loads under
// plain `node --test`, then the MCP client SDK connects over streamable HTTP —
// the same transport a spawned `claude` uses.

// The boot path auto-registers with the `claude` CLI when it lands on the
// preferred port — a test must never shell out `claude mcp add`.
process.env.FLOE_MCP_NO_REGISTER = '1'

// The skills tools write through configDir(), which honours XDG_CONFIG_HOME —
// point it at a scratch dir so the test exercises the real CRUD without ever
// touching ~/.config/floe.
const scratchConfig = mkdtempSync(join(tmpdir(), 'floe-mcp-test-'))
process.env.XDG_CONFIG_HOME = scratchConfig

installHook()

// sessions.json lives under dataDir() — repoint it too, so create_session
// exercises the real store without writing into the user's own.
const scratchData = mkdtempSync(join(tmpdir(), 'floe-mcp-data-'))
const { setSharedDataDir } = await import('./dataDir.ts')
setSharedDataDir(scratchData)

const {
  startMcpServer,
  port,
  mcpConfigFor,
  shutdown,
  connKeyFor,
  createdWorktree,
  pluginShape,
  projectRoot,
  redactServer,
  sendOptions,
  transcriptLine
} = await import('./mcpServer.ts')
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js')

before(async () => {
  startMcpServer(() => undefined) // no window — the tools exercised here don't need one
  // Wait for the port: the preferred one, or the ephemeral fallback when a real
  // Floe instance is running on this machine.
  await waitFor(() => port() > 0, 5000, 'the server to bind a port')
})

after(() => {
  shutdown()
  rmSync(scratchConfig, { recursive: true, force: true })
  rmSync(scratchData, { recursive: true, force: true })
})

function connect(): Promise<InstanceType<typeof Client>> {
  const url = new URL(`http://127.0.0.1:${port()}/mcp/test-key`)
  const transport = new StreamableHTTPClientTransport(url)
  const client = new Client({ name: 'test', version: '1.0.0' })
  return client.connect(transport).then(() => client)
}

test('lists the floe tools over the token-routed HTTP transport', async () => {
  const client = await connect()
  try {
    const { tools } = await client.listTools()
    const names = tools.map((t) => t.name).sort()
    // The hooks (main/hooks.ts) steer sessions to these exact names — a rename
    // here must update them too.
    for (const expected of [
      'list_projects',
      'list_worktrees',
      'create_worktree',
      'remove_worktree',
      'merge_worktree',
      'worktree_status',
      'worktree_premise',
      'list_branches',
      'changed_files',
      'file_diff',
      'list_sessions',
      'recent_sessions',
      'create_session',
      'send_message',
      'ask_peer',
      'ask_codex',
      'read_session_output',
      'open_query',
      'ask_all',
      'list_queries',
      'peek_query',
      'merge_query',
      'discard_query',
      'stop_session',
      'select_session',
      'create_followup',
      'list_followups',
      'cancel_followup',
      'list_plans',
      'read_plan',
      'open_plan',
      'list_drawings',
      'read_drawing',
      'create_drawing',
      'draw_elements',
      'erase_elements',
      'move_elements',
      'promote_drawing',
      'open_drawing',
      'present_decision',
      'start_merge',
      'colony_board',
      'colony_add_task',
      'colony_start_task',
      'colony_remove_task',
      'list_skills',
      'read_skill',
      'create_skill',
      'update_skill',
      'rename_skill',
      'delete_skill',
      'list_mcp_servers',
      'add_mcp_server',
      'update_mcp_server',
      'remove_mcp_server',
      'list_project_commands',
      'add_project_command',
      'mcp_server_status',
      'authenticate_mcp_server',
      'add_project',
      'remove_project',
      'update_project',
      'run_project_command',
      'stop_project_command',
      'read_command_output',
      'remove_project_command',
      'session_prompts',
      'answer_session_prompt',
      'update_session',
      'close_session',
      'list_commits',
      'commit_diff',
      'set_review_base',
      'harness_usage',
      'plan_phases',
      'copy_plan',
      'open_browser',
      'browser_navigate',
      'browser_snapshot',
      'browser_click',
      'browser_type',
      'browser_press',
      'browser_evaluate',
      'browser_screenshot',
      'browser_history',
      'browser_devtools',
      'browser_screenshot_to_desk',
      'list_commands',
      'run_command'
    ]) {
      assert.ok(names.includes(expected), `tools/list should include ${expected} (got ${names.join(', ')})`)
    }
  } finally {
    await client.close()
  }
})

test('calls list_projects and returns a JSON text result', async () => {
  const client = await connect()
  try {
    const result = await client.callTool({ name: 'list_projects', arguments: {} })
    const content = result.content as Array<{ type: string; text: string }>
    assert.equal(content[0].type, 'text')
    // Whatever the local project list is, the tool must return parseable JSON
    // (an array) rather than throwing.
    const parsed = JSON.parse(content[0].text)
    assert.ok(Array.isArray(parsed), 'list_projects should return a JSON array')
  } finally {
    await client.close()
  }
})

test('run_command without a window answers with an error, not a hang', async () => {
  const client = await connect()
  try {
    const result = await client.callTool({ name: 'run_command', arguments: { command_id: 'panel.right' } })
    const content = result.content as Array<{ type: string; text: string }>
    const parsed = JSON.parse(content[0].text) as { error?: string }
    assert.ok(parsed.error, 'with no window the tool must return an error explaining that')
  } finally {
    await client.close()
  }
})

test('open_browser without a window answers with an error, not a UI timeout', async () => {
  const client = await connect()
  try {
    const result = await client.callTool({ name: 'open_browser', arguments: { url: 'localhost:3000' } })
    const content = result.content as Array<{ type: string; text: string }>
    assert.match(content[0].text, /No Floe window is open/)
  } finally {
    await client.close()
  }
})

test('rejects browser-shaped requests (Origin header) with 403', async () => {
  const res = await fetch(`http://127.0.0.1:${port()}/mcp/test-key`, {
    method: 'POST',
    headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
    body: '{}'
  })
  assert.equal(res.status, 403)
})

test('mcpConfigFor writes a config file pointing at the token url', () => {
  const path = mcpConfigFor('abc-123')
  assert.ok(existsSync(path), 'config file should be written')
  assert.ok(path.endsWith('floe-mcp-abc-123.json'), 'file name is what hooks.ts DETECT_FLOE greps for')
  const cfg = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(cfg.mcpServers.floe.type, 'http')
  assert.match(cfg.mcpServers.floe.url, /\/mcp\/abc-123$/)
})

test('skills lifecycle over MCP: create, update, read, rename, delete', async () => {
  const client = await connect()
  const call = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const result = await client.callTool({ name, arguments: args })
    const content = result.content as Array<{ type: string; text: string }>
    return JSON.parse(content[0].text) as Record<string, unknown>
  }
  try {
    // The whole run lives in the scratch XDG_CONFIG_HOME set above — the real
    // ~/.config/floe is never touched.
    const made = await call('create_skill', { name: 'mcp-test-skill', scope: 'global' })
    assert.equal(made.name, 'mcp-test-skill')

    const body = '---\nname: mcp-test-skill\ndescription: test\n---\n\nHello from the test.\n'
    const updated = await call('update_skill', { name: 'mcp-test-skill', content: body })
    assert.equal(updated.ok, true)

    const read = await call('read_skill', { name: 'mcp-test-skill' })
    assert.equal(read.content, body)

    const renamed = await call('rename_skill', { name: 'mcp-test-skill', to: 'mcp-test-skill-2' })
    assert.equal(renamed.name, 'mcp-test-skill-2')

    const listed = await call('list_skills', {})
    const names = (listed as unknown as Array<{ name: string }>).map((s) => s.name)
    assert.ok(names.includes('mcp-test-skill-2'), `list_skills should show the renamed skill (got ${names.join(', ')})`)
    assert.ok(!names.includes('mcp-test-skill'), 'the old name must be gone after rename')

    const gone = await call('delete_skill', { name: 'mcp-test-skill-2' })
    assert.equal(gone.ok, true)
    const missing = await call('read_skill', { name: 'mcp-test-skill-2' })
    assert.ok(missing.error, 'reading a deleted skill must answer an error, not throw')
  } finally {
    await client.close()
  }
})

test('mcpConfigFor merges the enabled registry entries into the per-session config', async () => {
  const { addMcpServer, removeMcpServer } = await import('./config/mcpServers.ts')
  addMcpServer('global', { name: 'merged', transport: 'http', url: 'https://example.com/mcp' })
  addMcpServer('global', { name: 'dark', transport: 'http', url: 'https://example.com/off', enabled: false })
  try {
    const cfg = JSON.parse(readFileSync(mcpConfigFor('merge-check'), 'utf8'))
    assert.equal(cfg.mcpServers.merged.url, 'https://example.com/mcp')
    assert.equal(cfg.mcpServers.dark, undefined, 'a disabled entry must not reach a session')
    assert.ok(cfg.mcpServers.floe, "floe's own server always rides along")
  } finally {
    removeMcpServer('merged')
    removeMcpServer('dark')
  }
})

test('send_message can name the harness, and reads a handle when it does not', async () => {
  const client = await connect()
  try {
    const { tools } = await client.listTools()
    const send = tools.find((t) => t.name === 'send_message')
    assert.ok(send, 'send_message is registered')
    const props = (send.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}
    // Everything the composer's picker can say, an agent can say too — that is
    // the agent-first rule, and the schema is where it is either true or not.
    for (const key of ['harness', 'model', 'effort', 'mode'])
      assert.ok(key in props, `send_message should take ${key} (got ${Object.keys(props).join(', ')})`)
    // And the literal parity: `@codex …` in the prompt does what it does in the box.
    assert.match(String((props.prompt as { description?: string }).description), /@codex/)
  } finally {
    await client.close()
  }
})

// --- The pieces registerTools was split into ------------------------------
// Each of these was a branch buried inside one 153-complexity function; lifted
// out, they can be asserted on directly instead of only through a live turn.

test('transcriptLine labels a line with who said it, not with its role', () => {
  // A subagent's or a peer session's line read back as `user:` is how an agent
  // ends up quoting someone else's words as its own user's instructions.
  assert.equal(transcriptLine({ role: 'assistant', from: 'codex', text: 'looks fine' }), 'codex: looks fine')
  assert.equal(transcriptLine({ role: 'user', text: 'ship it' }), 'user: ship it')
  assert.equal(transcriptLine({ role: 'image' }), '[image]')
  assert.equal(transcriptLine({ role: 'tool', name: 'Read', summary: 'src/main/git.ts' }), '[tool Read] src/main/git.ts')
  // Only the trailing space is trimmed; the one inside the brackets is the
  // format, and pinning it here keeps a "tidy-up" from changing what agents read.
  assert.equal(transcriptLine({ role: 'tool' }), '[tool ]')
  assert.equal(transcriptLine({ role: 'assistant' }), 'assistant: ')
})

test('pluginShape converts a plugin param declaration into a zod raw shape', () => {
  const shape = pluginShape({
    count: { type: 'number' },
    force: { type: 'boolean', optional: true },
    name: { type: 'string', description: 'What to call it.' }
  })
  assert.deepEqual(Object.keys(shape).sort(), ['count', 'force', 'name'])
  assert.equal(shape.count.parse(3), 3)
  assert.throws(() => shape.count.parse('3'), 'a number param must reject a string')
  // optional is what lets a caller leave the argument out entirely.
  assert.equal(shape.force.parse(undefined), undefined)
  assert.throws(() => shape.name.parse(undefined), 'a param without `optional` stays required')
  assert.equal(shape.name.description, 'What to call it.')
  // No params at all is a tool that takes none, not a crash.
  assert.deepEqual(pluginShape(undefined), {})
})

test('connKeyFor falls back to the resume convention when no conn is live', () => {
  const base = { worktreePath: '/tmp/wt', title: 'T', createdAt: 0 }
  // Nothing is live in this process, so it must answer `claudeId ?? id` — the
  // key the renderer panels a resumed session under.
  assert.equal(connKeyFor({ ...base, id: 'floe-1', claudeId: 'claude-9' }), 'claude-9')
  assert.equal(connKeyFor({ ...base, id: 'floe-1' }), 'floe-1')
  // A past claude id is walked, but never returned when it is not live.
  assert.equal(connKeyFor({ ...base, id: 'floe-1', claudeId: 'claude-9', pastClaudeIds: ['claude-8'] }), 'claude-9')
})

test('createdWorktree picks the branch it was asked for, then the path, then the newest', () => {
  const wt = (path: string, branch: string): Worktree => ({ path, branch }) as Worktree
  const list = [wt('/tmp/a', 'main'), wt('/tmp/feat-x', 'feat/x'), wt('/tmp/z', 'other')]
  assert.equal(createdWorktree(list, 'feat/x')?.path, '/tmp/feat-x')
  // No branch match: the path ending in the branch name is the one just cut.
  assert.equal(createdWorktree(list, 'z')?.path, '/tmp/z')
  // Neither: git listed it under some other name, so take the newest entry.
  assert.equal(createdWorktree(list, 'nothing-matches')?.path, '/tmp/z')
  assert.equal(createdWorktree([], 'anything'), undefined)
})

test('sendOptions: a handle in the prompt routes the same as naming the harness', () => {
  const target = { id: 'floe-1', worktreePath: '/tmp/wt', title: 'T', createdAt: 0 }

  // Nothing named anywhere: the session answers as itself, no query opened.
  const plain = sendOptions(target, 'just do it', {})
  assert.equal(plain.route, null)
  assert.equal(plain.prompt, 'just do it')
  assert.equal(plain.options.permissionMode, 'skip', 'an agent-driven session has no human to answer prompts')
  // A caller override still lands on the session's own options.
  assert.equal(sendOptions(target, 'x', { model: 'opus' }).options.model, 'opus')

  // A handle: routed, and the handle is stripped from what the harness reads
  // but kept in what the transcript shows.
  const handled = sendOptions(target, '@codex revisa isso', {})
  assert.equal(handled.route?.harness, 'codex')
  assert.equal(handled.route?.prompt, 'revisa isso')
  assert.equal(handled.prompt, 'revisa isso')
  assert.equal(handled.options.shown, '@codex revisa isso')
  assert.equal(handled.options.provider, 'codex')

  // Named in the arguments: also routed, and it overrides the handle — so the
  // prompt is not stripped, because no handle was read.
  const named = sendOptions(target, '@codex revisa isso', { harness: 'claude' })
  assert.equal(named.route?.harness, 'claude')
  assert.equal(named.route?.prompt, '@codex revisa isso')
  assert.equal(named.options.shown, undefined)
})

// --- The lifted tool handlers, over the real transport --------------------

async function callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const client = await connect()
  try {
    const result = await client.callTool({ name, arguments: args })
    const content = result.content as Array<{ type: string; text: string }>
    return JSON.parse(content[0].text) as Record<string, unknown>
  } finally {
    await client.close()
  }
}

test('create_session stores the session, and refuses a first prompt with no window', async () => {
  const made = await callTool('create_session', { worktree: '/tmp/floe-mcp-wt', title: 'From MCP' })
  assert.equal(made.title, 'From MCP')
  assert.ok(typeof made.sessionId === 'string' && made.sessionId.length > 0, 'a session id must come back')

  // It really went into the store, which is what list_sessions reads.
  const listed = (await callTool('list_sessions', { worktree: '/tmp/floe-mcp-wt' })) as unknown as Array<
    Record<string, unknown>
  >
  assert.ok(
    listed.some((s) => s.id === made.sessionId && s.title === 'From MCP'),
    'the created session must show up in list_sessions for its worktree'
  )

  // A first prompt needs a window to dispatch the turn into. No window is an
  // answer, not a throw and not a hang — tools never throw.
  const withPrompt = await callTool('create_session', { worktree: '/tmp/floe-mcp-wt', prompt: 'hello' })
  assert.match(String(withPrompt.error), /No window available/)

  // The title defaults to the head of the prompt when none is given.
  const untitled = await callTool('create_session', { worktree: '/tmp/floe-mcp-wt2', prompt: 'do the thing' })
  assert.match(String(untitled.error), /No window available/)
})

test('read_session_output answers a note, not an error, for a session with nothing to show', async () => {
  const out = await callTool('read_session_output', { session_id: 'no-such-session', limit: 5 })
  assert.equal(out.output, '')
  assert.match(String(out.note), /No output yet/)
  assert.equal(out.error, undefined, 'an unknown session is empty, not a failure')
})

test('open_query names the session it could not find, and needs a window to open a panel', async () => {
  const unknown = await callTool('open_query', { session_id: 'no-such-session', harness: 'codex' })
  assert.match(String(unknown.error), /Unknown session: no-such-session/)

  const made = await callTool('create_session', { worktree: '/tmp/floe-mcp-wt', title: 'Query host' })
  const noWindow = await callTool('open_query', { session_id: made.sessionId as string, harness: 'codex' })
  assert.match(String(noWindow.error), /No window available/)
})

test('ask_peer refuses when the caller is not a Floe session', async () => {
  // The client connects as /mcp/test-key, which resolves to no session — so
  // there is no chat for the peer to answer into, and nothing is spawned.
  const out = await callTool('ask_peer', { harness: 'codex', prompt: 'review this' })
  assert.match(String(out.error), /must be called from a Floe session/)
  // Any harness, in any direction: a codex session asking claude is the same
  // call with the other name in it.
  const back = await callTool('ask_peer', { harness: 'claude', prompt: 'and you?' })
  assert.match(String(back.error), /must be called from a Floe session/)
  // The old name still answers, so sessions written against it keep working.
  const legacy = await callTool('ask_codex', { prompt: 'review this' })
  assert.match(String(legacy.error), /must be called from a Floe session/)
})

test('list_queries and stop_session report an unknown session by name', async () => {
  assert.match(String((await callTool('list_queries', { session_id: 'nope' })).error), /Unknown session: nope/)
  assert.match(String((await callTool('stop_session', { session_id: 'nope' })).error), /Unknown session: nope/)
})

test('start_merge refuses a path no Floe project contains', async () => {
  const out = await callTool('start_merge', { worktree: '/tmp/not-a-floe-worktree' })
  assert.match(String(out.error), /No Floe project contains this worktree/)
})

test('the registry carries credentials, and never hands them back', async () => {
  const made = await callTool('add_mcp_server', {
    name: 'paid',
    scope: 'global',
    transport: 'http',
    url: 'https://mcp.example/mcp',
    headers: { Authorization: 'Bearer s3cret' }
  })
  assert.deepEqual(made.headers, { Authorization: '***' }, 'the name of the header, never its value')

  const listed = (await callTool('list_mcp_servers', {})) as unknown as Array<Record<string, unknown>>
  const found = listed.find((e) => e.name === 'paid')
  assert.deepEqual(found?.headers, { Authorization: '***' })

  // The value really is on disk, though — a redacted read must not mean a
  // redacted write.
  const onDisk = readFileSync(join(scratchConfig, 'floe', 'mcp.toml'), 'utf8')
  assert.match(onDisk, /Authorization = "Bearer s3cret"/)

  const patched = await callTool('update_mcp_server', { name: 'paid', headers: {} })
  assert.equal(patched.headers, undefined, 'an empty table drops the credentials')
  await callTool('remove_mcp_server', { name: 'paid' })
})

test('redactServer masks every value it is given, and invents none', () => {
  const entry = {
    name: 'x',
    scope: 'global' as const,
    transport: 'stdio' as const,
    command: 'npx',
    enabled: true,
    file: '/tmp/mcp.toml',
    index: 0,
    env: { A: '1', B: '2' }
  }
  assert.deepEqual(redactServer(entry).env, { A: '***', B: '***' })
  assert.equal(redactServer({ ...entry, env: undefined }).env, undefined)
})

test('a project path is resolved before it is used, never handed back as typed', () => {
  // `/tmp` is a symlink to `/private/tmp` on macOS. A tool that answered with
  // the caller's spelling let `add_project_command` create a SECOND project
  // directory for a repo Floe already had — and then the command it wrote was
  // invisible to every tool that resolved the path properly.
  const real = mkdtempSync(join(realpathSync(tmpdir()), 'floe-mcp-alias-'))
  assert.equal(projectRoot(real), real, 'a resolved path is left alone')

  const alias = join(tmpdir(), basename(real))
  assert.equal(projectRoot(alias), real, 'an alias resolves to the path the store keeps')
  assert.equal(projectRoot('/tmp/floe-mcp-never-existed'), '/tmp/floe-mcp-never-existed', 'a path that is not there is answered as given')
  rmSync(real, { recursive: true, force: true })
})

test('the project tools refuse what is not a project, and report what they did', async () => {
  const notARepo = await callTool('add_project', { path: '/tmp/floe-mcp-not-a-repo' })
  assert.ok(notARepo.error, 'a path that is not a git repository cannot be added')

  const unknown = await callTool('update_project', { path: '/tmp/nope', pinned: true })
  assert.match(String(unknown.error), /not a registered project/)

  // A remove that matched nothing used to answer with the whole project list —
  // indistinguishable from having worked.
  const gone = await callTool('remove_project', { path: '/tmp/nope' })
  assert.match(String(gone.error), /not a registered project/)
})

test('the command tools need a project that owns the worktree', async () => {
  for (const name of ['run_project_command', 'stop_project_command', 'read_command_output', 'remove_project_command']) {
    const out = await callTool(name, { worktree: '/tmp/floe-mcp-orphan', command: 'dev' })
    assert.match(String(out.error), /no registered project owns/, `${name} must say why it cannot run`)
  }
})

test('session_prompts and answer_session_prompt only speak for sessions this caller made', async () => {
  assert.match(String((await callTool('session_prompts', { session_id: 'nope' })).error), /Unknown session: nope/)

  // Created by /mcp/test-key... but through the tool, so spawnedBy is set to
  // exactly this caller — the owner check has to pass for its own child.
  const mine = await callTool('create_session', { worktree: '/tmp/floe-mcp-wt', title: 'Child' })
  const prompts = (await callTool('session_prompts', { session_id: mine.sessionId as string })) as unknown as unknown[]
  assert.deepEqual(prompts, [], 'a session with no live conn is parked on nothing')

  // A session nobody claims is not answerable from here.
  const store = await import('./sessionStore.ts')
  store.addCreatedSession({ id: 'floe-mcp-orphan-session', worktreePath: '/tmp/floe-mcp-wt', title: 'Theirs' })
  const refused = await callTool('answer_session_prompt', {
    session_id: 'floe-mcp-orphan-session',
    request_id: 'r1',
    answer: 'yes'
  })
  assert.match(String(refused.error), /only its owner may answer for it/)

  // A request id nothing is waiting on used to answer `{answered: r1}` — the
  // responders take an unknown id without complaint.
  const stale = await callTool('answer_session_prompt', {
    session_id: mine.sessionId as string,
    request_id: 'r1',
    answer: 'yes'
  })
  assert.match(String(stale.error), /Nothing is waiting on r1/)
})

test('update_session writes the picker, and close_session takes the row away', async () => {
  const made = await callTool('create_session', { worktree: '/tmp/floe-mcp-wt', title: 'Steer me' })
  const id = made.sessionId as string

  // Give it a claude model first, so the switch below has something to clear.
  await callTool('update_session', { session_id: id, model: 'opus' })
  const updated = await callTool('update_session', { session_id: id, title: 'Steered', harness: 'codex', mode: 'default' })
  assert.equal(updated.title, 'Steered')
  // codex has no "ask": the mode snaps to the nearest thing it can honestly do
  // (shared/modes.ts walks lightest first, so "ask" lands on plan) rather than
  // failing the turn later.
  const store = await import('./sessionStore.ts')
  assert.equal(store.getCreatedSession(id)?.permissionMode, 'plan')
  assert.equal(store.getCreatedSession(id)?.provider, 'codex')
  // `opus` is a claude model: carrying it into codex would fail the next turn.
  assert.equal(store.getCreatedSession(id)?.model, '')

  assert.equal((await callTool('close_session', { session_id: id })).closed, id)
  assert.equal(store.getCreatedSession(id), undefined, 'the session is gone from the store')
  assert.match(String((await callTool('update_session', { session_id: id })).error), /Unknown session/)
})

test('the review tools answer for a directory that is not a repository', async () => {
  const commits = await callTool('list_commits', { worktree: '/tmp/floe-mcp-not-a-repo' })
  assert.ok(commits.error || Array.isArray(commits), 'either the commits or a reason, never a throw')

  // commit_diff answers with the diff itself, so an empty one is empty text —
  // not JSON, and not an error either.
  const client = await connect()
  try {
    const raw = await client.callTool({
      name: 'commit_diff',
      arguments: { worktree: '/tmp/floe-mcp-not-a-repo', commit: 'HEAD', path: 'x.ts' }
    })
    assert.equal((raw.content as Array<{ type: string }>)[0].type, 'text')
  } finally {
    await client.close()
  }

  const base = await callTool('set_review_base', { worktree: '/tmp/floe-mcp-not-a-repo', action: 'status' })
  assert.equal(base.cleared, false)
  const usage = await callTool('harness_usage', {})
  assert.equal(typeof usage, 'object', 'usage answers for whatever harnesses are installed')
})

test('copy_plan refuses to write over a plan of the same name', async () => {
  const wt = mkdtempSync(join(tmpdir(), 'floe-mcp-plans-'))
  const dest = mkdtempSync(join(tmpdir(), 'floe-mcp-plans-dest-'))
  mkdirSync(join(wt, '.floe', 'plans'), { recursive: true })
  mkdirSync(join(dest, '.floe', 'plans'), { recursive: true })
  writeFileSync(join(wt, '.floe', 'plans', 'p.md'), '# plan')

  const copied = await callTool('copy_plan', { worktree: wt, path: '.floe/plans/p.md', destination: dest })
  assert.equal(copied.name, 'p.md')
  const again = await callTool('copy_plan', { worktree: wt, path: '.floe/plans/p.md', destination: dest })
  assert.match(String(again.error), /already exists/)

  // The phases reader answers an empty list for a worktree with no spec.
  assert.deepEqual(await callTool('plan_phases', { worktree: wt }), [] as unknown as Record<string, unknown>)
  rmSync(wt, { recursive: true, force: true })
  rmSync(dest, { recursive: true, force: true })
})

test('every registered tool name is unique across the domain registrars', async () => {
  // registerTools is now a dispatcher over one registrar per domain. Two of them
  // registering the same name would throw inside the SDK; a name lost in the
  // split would just quietly stop existing.
  const client = await connect()
  try {
    const { tools } = await client.listTools()
    const names = tools.map((t) => t.name)
    assert.equal(new Set(names).size, names.length, 'no tool may be registered twice')
    for (const t of tools) assert.ok(t.description && t.description.length > 0, `${t.name} must describe itself`)
  } finally {
    await client.close()
  }
})
