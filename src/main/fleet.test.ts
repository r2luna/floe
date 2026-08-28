import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { createServer, type Server } from 'node:http'
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Same in-memory loader hook as mcpServer.test.ts: main's modules use
// extensionless relative imports and named `electron` imports, neither of which
// raw Node ESM resolves. `app.getPath` → /tmp, so dataDir() (the token file and
// fleet.jsonl) lands somewhere disposable.
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
    const src = [
      "export const app = { getPath: () => '/tmp' };",
      'export class BrowserWindow {}',
      'export const Menu = { setApplicationMenu(){}, buildFromTemplate: () => ({}) };',
      'export class Notification {}',
      'export const dialog = {};',
      'export const ipcMain = { handle(){}, on(){} };',
      'export const nativeTheme = { on(){}, get shouldUseDarkColors(){ return false } };',
      'export const safeStorage = { isEncryptionAvailable: () => false };',
      'export const shell = {};',
      'export default {};'
    ].join('\\n')
    return { format: 'module', shortCircuit: true, source: src }
  }
  return next(url, context)
}
`
const hookUrl = 'data:text/javascript,' + encodeURIComponent(hookSource)
register(hookUrl, import.meta.url)

const fleet = await import('./fleet.ts')
const { deriveState, stateStart, recordEdge, recentEdges, resetEdges, handleFleet, fleetToken, usageBlocks, loadEdges, publishPort } = fleet
type SessionRuntime = import('./agent.ts').SessionRuntime
type FocusResult = import('./fleet.ts').FocusResult

void fileURLToPath
void pathToFileURL

const rt = (over: Partial<SessionRuntime> = {}): SessionRuntime => ({
  live: false,
  running: false,
  waiting: false,
  since: 0,
  lastLine: '',
  ...over
})

// --- state derivation ------------------------------------------------------

test('state precedence: error > waiting > running > idle', () => {
  assert.equal(deriveState(rt()), 'idle')
  assert.equal(deriveState(rt({ live: true })), 'idle', 'a live conn with no turn is idle, not running')
  assert.equal(deriveState(rt({ live: true, running: true })), 'running')
  // A turn blocked on a permission prompt is technically still active — but what
  // it needs is a human, so `waiting` wins.
  assert.equal(deriveState(rt({ live: true, running: true, waiting: true })), 'waiting')
  // The watchdog's recovery kills the conn, so the error arrives on a session
  // that otherwise looks plain idle. It still has to shout.
  assert.equal(deriveState(rt({ error: { at: 1, message: 'stopped responding' } })), 'error')
  assert.equal(
    deriveState(rt({ live: true, running: true, waiting: true, error: { at: 1, message: 'x' } })),
    'error'
  )
})

test('since is the moment the CURRENT state began', () => {
  const now = 10_000
  // running/error carry their own timestamp — exact, not first-observed.
  assert.equal(stateStart('a', 'running', rt({ running: true, since: 4_242 }), now), 4_242)
  assert.equal(stateStart('b', 'error', rt({ error: { at: 777, message: 'x' } }), now), 777)

  // idle/waiting have none, so the first tick that sees the transition stamps it
  // and later ticks keep reporting that same start — otherwise the card's elapsed
  // time would reset to zero every 2 seconds.
  assert.equal(stateStart('c', 'idle', rt(), now), now)
  assert.equal(stateStart('c', 'idle', rt(), now + 5_000), now)
  // …and a real transition re-stamps.
  assert.equal(stateStart('c', 'waiting', rt({ live: true, waiting: true }), now + 6_000), now + 6_000)
  assert.equal(stateStart('c', 'waiting', rt({ live: true, waiting: true }), now + 9_000), now + 6_000)
})

test('a Home session resolves to the Home workspace, not a blank card', async () => {
  // Home is synthetic — injected by the renderer, never in projects.json — so it
  // isn't in listProjects() and its sessions used to come back with an empty
  // project/branch (seen live: every `~` session was a nameless card).
  const store = '/tmp/sessions.json' // dataDir() → the stubbed app.getPath('userData')
  const prev = existsSync(store) ? readFileSync(store, 'utf8') : null
  writeFileSync(
    store,
    JSON.stringify({ created: [{ id: 'home-1', worktreePath: homedir(), title: 'Terminal', createdAt: 1 }] })
  )
  try {
    const snap = await fleet.snapshot()
    const session = snap.sessions.find((s) => s.id === 'home-1')
    assert.equal(session?.project, 'Home')
    assert.equal(session?.exists, true)
    // And main can point the renderer at it — Home's project path IS the home dir.
    assert.deepEqual(await fleet.locateSession('home-1'), { worktreePath: homedir(), projectPath: homedir() })
  } finally {
    if (prev === null) rmSync(store, { force: true })
    else writeFileSync(store, prev)
  }
})

// --- the edge log ----------------------------------------------------------

test('recordEdge keeps the pair, the direction and whether the caller is blocked', () => {
  resetEdges()
  recordEdge({ from: 'sess-a', to: 'sess-b', kind: 'send_message', preview: 'check the migration', waited: true })
  recordEdge({ from: 'sess-b', to: 'codex:sess-b', kind: 'ask_codex', preview: 'second opinion', waited: true })
  const [first, second] = recentEdges()
  assert.equal(first.from, 'sess-a')
  assert.equal(first.to, 'sess-b')
  assert.equal(first.kind, 'send_message')
  assert.equal(first.waited, true, 'wait:true is the difference between "told them" and "is sitting there waiting"')
  assert.ok(first.at > 0, 'edges are timestamped')
  assert.equal(second.kind, 'ask_codex')
  assert.equal(second.to, 'codex:sess-b')
})

test('an ask_codex edge is a self-edge, not a wire to a node that has no card', () => {
  resetEdges()
  // Codex has no session of its own — it runs as an inline subagent of the
  // caller. Pointing the edge at a synthetic `codex:<caller>` id made the client
  // drop it (it won't draw a node it has no card for), so ask_codex traffic was
  // invisible on the board. from === to is the signal to badge the caller's card.
  recordEdge({ from: 'sess-a', to: 'sess-a', kind: 'ask_codex', preview: 'second opinion', waited: true })
  const [edge] = recentEdges()
  assert.equal(edge.from, edge.to)
  assert.equal(edge.kind, 'ask_codex')
})

test('usage blocks come out in the footer\'s shape', () => {
  const in90Min = Math.floor((Date.now() + 90 * 60_000) / 1000)
  const blocks = usageBlocks(
    { session: { pct: 10, resetsAt: 'Jun 13 at 1am (America/Denver)' }, week: { pct: 2 } },
    { primary: { usedPercent: 41.6, resetsAt: in90Min }, secondary: { usedPercent: 7 } }
  )
  assert.deepEqual(blocks, [
    {
      label: 'CLAUDE',
      rows: [
        ['session', 10, 'resets Jun 13 at 1am (America/Denver)'],
        ['week', 2, undefined]
      ]
    },
    {
      label: 'CODEX',
      rows: [
        ['5h', 42, 'resets in 1h30'],
        ['weekly', 7, undefined]
      ]
    }
  ])
  // Nothing probed yet → no blocks at all, so the snapshot omits `usage` rather
  // than shipping an empty footer.
  assert.deepEqual(usageBlocks({}, undefined), [])
})

test('recordEdge truncates the preview and caps the ring buffer at 200', () => {
  resetEdges()
  recordEdge({ from: 'a', to: 'b', kind: 'send_message', preview: 'x'.repeat(5_000), waited: false })
  assert.equal(recentEdges()[0].preview.length, 200, 'a whole prompt must not ride in the ring buffer')

  resetEdges()
  for (let i = 0; i < 250; i++)
    recordEdge({ from: 'a', to: 'b', kind: 'send_message', preview: `msg ${i}`, waited: false })
  const edges = recentEdges()
  assert.equal(edges.length, 200)
  assert.equal(edges[0].preview, 'msg 50', 'the oldest edges fall off the front')
  assert.equal(edges[199].preview, 'msg 249')
})

test('recordEdge appends the edge to fleet.jsonl', () => {
  resetEdges()
  const marker = `probe-${Date.now()}`
  recordEdge({ from: marker, to: 'b', kind: 'send_message', preview: 'hi', waited: false })
  const file = '/tmp/fleet.jsonl' // dataDir() → the stubbed app.getPath('userData')
  assert.ok(existsSync(file), 'the append-only log should exist')
  const lines = readFileSync(file, 'utf8').trim().split('\n')
  const parsed = JSON.parse(lines[lines.length - 1])
  assert.equal(parsed.from, marker)
  assert.equal(parsed.kind, 'send_message')
  assert.equal(parsed.waited, false)
})

test('a create_session edge survives the round-trip', () => {
  // The spawn is the only edge an inline-prompt hand-off ever produces: the parent
  // never calls send_message, so if this kind doesn't make it to the ring and the
  // log, the Fleet board draws the pair with no wire between them.
  resetEdges()
  const marker = `spawn-${Date.now()}`
  recordEdge({ from: marker, to: 'child-1', kind: 'create_session', preview: 'fix the migration', waited: false })
  const [edge] = recentEdges()
  assert.equal(edge.from, marker)
  assert.equal(edge.to, 'child-1')
  assert.equal(edge.kind, 'create_session')

  const lines = readFileSync('/tmp/fleet.jsonl', 'utf8').trim().split('\n')
  const parsed = JSON.parse(lines[lines.length - 1])
  assert.equal(parsed.from, marker)
  assert.equal(parsed.to, 'child-1')
  assert.equal(parsed.kind, 'create_session')
})

test('loadEdges re-seeds the ring from fleet.jsonl and skips a torn line', () => {
  resetEdges()
  const marker = `reload-${Date.now()}`
  const good = JSON.stringify({ at: Date.now(), from: marker, to: 'b', kind: 'send_message', preview: 'hi', waited: true })
  writeFileSync('/tmp/fleet.jsonl', `${good}\n{"at":1,"from":"torn"\n`)
  loadEdges()
  const edges = recentEdges()
  assert.equal(edges.length, 1, 'the half-written trailing line must not land on the board')
  assert.equal(edges[0].from, marker)
  assert.equal(edges[0].waited, true)

  loadEdges() // a second boot-time call must not double the history
  assert.equal(recentEdges().length, 1)
})

test('publishPort advertises the bound port and reaps a dead instance', () => {
  const dir = '/tmp/fleet-ports'
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  writeFileSync(`${dir}/999999`, '40000') // a pid that cannot be alive
  publishPort(60755)
  assert.equal(readFileSync(`${dir}/${process.pid}`, 'utf8'), '60755', 'the fallback port must be discoverable')
  assert.ok(!existsSync(`${dir}/999999`), 'a crashed instance must not leave a phantom endpoint')
})

// --- HTTP contract ---------------------------------------------------------
// The Fleet client is a separate app coding against these exact routes, so the
// auth gate, the CORS headers and the focus reply are part of the contract.

let server: Server
let base = ''
let focusCalls: string[] = []
let focusReply: FocusResult = { ok: true, raised: true, focused: 'window', message: 'ok' }

before(async () => {
  server = createServer((req, res) => {
    void handleFleet(req, res, {
      focus: (sessionId: string) => {
        focusCalls.push(sessionId)
        return focusReply
      }
    }).then((handled) => {
      if (!handled) res.writeHead(418).end('fell through')
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
})

after(() => server.close())

test('every route is gated by the token', async () => {
  for (const path of ['/fleet/snapshot', '/fleet/stream', '/fleet/focus']) {
    const res = await fetch(base + path, { method: path.endsWith('focus') ? 'POST' : 'GET' })
    assert.equal(res.status, 401, `${path} must not answer unauthenticated — focus is remote control of the editor`)
    await res.text()
  }
  // The MCP path token is not a secret (in-app sessions carry their own key,
  // external ones share the literal 'global'), so it must not open this either.
  const res = await fetch(`${base}/fleet/snapshot?token=global`)
  assert.equal(res.status, 401)
  await res.text()
})

test('a non-fleet path falls through to the host', async () => {
  const res = await fetch(`${base}/mcp/whatever`)
  assert.equal(res.status, 418, 'handleFleet must return false so the caller keeps its own routing')
  await res.text()
})

test('snapshot answers CORS-wide with the session list', async () => {
  const res = await fetch(`${base}/fleet/snapshot?token=${fleetToken()}`)
  assert.equal(res.status, 200)
  // Fleet is a file:// or localhost page hitting this cross-origin; without this
  // header nothing it does client-side can work.
  assert.equal(res.headers.get('access-control-allow-origin'), '*')
  const body = (await res.json()) as { host: string; sessions: unknown[]; edges: unknown[] }
  assert.equal(typeof body.host, 'string')
  assert.ok(Array.isArray(body.sessions))
  assert.ok(Array.isArray(body.edges), 'the snapshot carries the edge tail so a reconnect is not a blank board')
})

test('the POST preflight is answered', async () => {
  const res = await fetch(`${base}/fleet/focus`, { method: 'OPTIONS' })
  assert.equal(res.status, 204)
  assert.equal(res.headers.get('access-control-allow-origin'), '*')
  assert.match(res.headers.get('access-control-allow-headers') ?? '', /content-type/)
  await res.text()
})

test('focus routes the tap to the host and reports what happened', async () => {
  focusCalls = []
  const token = fleetToken()
  const post = (body: unknown): Promise<Response> =>
    fetch(`${base}/fleet/focus?token=${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })

  const bad = await post({})
  assert.equal(bad.status, 400)
  await bad.text()
  assert.deepEqual(focusCalls, [], 'a missing sessionId never reaches the host')

  const ok = await post({ sessionId: 'sess-1' })
  assert.equal(ok.status, 200)
  assert.deepEqual(await ok.json(), focusReply)
  assert.deepEqual(focusCalls, ['sess-1'])

  // A window that never came forward is a silent failure unless it's reported.
  focusReply = { ok: true, raised: false, focused: 'requested', message: 'switch manually' }
  const partial = await post({ sessionId: 'sess-2' })
  const body = (await partial.json()) as FocusResult
  assert.equal(body.ok, true)
  assert.equal(body.raised, false)
})

test('the stream opens as SSE and leads with a snapshot event', async () => {
  const ctl = new AbortController()
  const res = await fetch(`${base}/fleet/stream?token=${fleetToken()}`, { signal: ctl.signal })
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/)
  const reader = res.body!.getReader()
  const chunk = new TextDecoder().decode((await reader.read()).value)
  assert.match(chunk, /^event: snapshot\n/, 'a fresh client gets the whole board before any delta')
  ctl.abort()
})
