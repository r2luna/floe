import { existsSync, readFileSync, appendFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { join } from 'node:path'
import { hostname, homedir } from 'node:os'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dataDir } from './dataDir'
import { listProjects } from './projects'
import { listWorktrees } from './git'
import { getAllCreatedSessions } from './sessionStore'
import { sessionRuntime, type SessionRuntime } from './agent'
import { getCodexUsage } from './codex'
import { lastUsage } from './usageMonitor'
import type { CodexUsage, UsageStats } from '../shared/types'

// Fleet — the read-only HTTP surface the dashboard app (separate repo) reads to
// show every agent on this instance, and the one write it's allowed: focus.
//
// Mounted on BOTH targets: the desktop's MCP server (loopback :41573) and the
// headless server's HTTP server (src/server/index.ts, exposed over the tailnet),
// so one Fleet page can watch a Mac and `link` at once. Deliberately NOT on the
// WS bridge — that's single-active-client and a second client would park the
// Rookery tab.
//
// See docs/fleet.md.

// --- state ----------------------------------------------------------------

export type FleetState = 'running' | 'waiting' | 'error' | 'idle'

export interface FleetSession {
  id: string
  title: string
  project: string
  branch: string
  worktreePath: string
  state: FleetState
  since: number // ms epoch of when the CURRENT state began — what the card counts from
  lastLine: string
  live: boolean // a claude process exists at all — orthogonal to `state`
  exists: boolean // the worktree is still on disk
}

// The footer's limits, pre-shaped so neither side writes an adapter:
// rows are [name, pct 0-100, note]. Absent when nothing has been probed yet.
export interface FleetUsageBlock {
  label: string
  rows: Array<[string, number, string?]>
}

export interface FleetSnapshot {
  host: string
  at: number
  sessions: FleetSession[]
  edges: FleetEdge[]
  usage?: FleetUsageBlock[]
}

// State is derived, never stored: `error` outranks the rest because a failed
// session that then idles must still call for a human; `waiting` outranks
// `running` because a turn blocked on a permission prompt is technically still
// active but is really sitting there needing an answer.
//
// ponytail: a turn already in flight when Rookery restarted reads `idle` until
// the next turn boundary — the conn is back (`live:true`) but its turn-start was
// never observed, so `turnActive` is false for the rest of that turn. Known and
// left alone: it self-heals within one turn, and the alternative is persisting
// turn state across restarts to fix a card that's wrong for one turn.
export function deriveState(rt: SessionRuntime): FleetState {
  if (rt.error) return 'error'
  if (rt.waiting) return 'waiting'
  if (rt.running) return 'running'
  return 'idle'
}

// --- the worktree/project index -------------------------------------------
// The only git-touching part, so it's the only part that's cached. Sessions come
// from a flat store read (cheap); resolving each one's project + branch would
// otherwise mean a `git worktree list` per project on every SSE tick.
const INDEX_TTL_MS = 15_000
type Entry = { project: string; projectPath: string; branch: string }
let index: Map<string, Entry> | null = null
let indexAt = 0
let indexing: Promise<Map<string, Entry>> | null = null

async function buildIndex(): Promise<Map<string, Entry>> {
  const map = new Map<string, Entry>()
  // The Home workspace is synthetic — injected by the renderer, never in
  // projects.json — so it isn't in listProjects() and its sessions would other-
  // wise render as a card with a blank project. Its path IS the home dir, which
  // is also what the renderer uses as Home's project path.
  map.set(homedir(), { project: 'Home', projectPath: homedir(), branch: '' })
  for (const project of listProjects()) {
    let worktrees: Awaited<ReturnType<typeof listWorktrees>>
    try {
      worktrees = await listWorktrees(project.path)
    } catch {
      continue
    }
    for (const wt of worktrees)
      map.set(wt.path, { project: project.name, projectPath: project.path, branch: wt.branch })
  }
  return map
}

// Where a session lives, for a Fleet tap: the renderer needs the project to
// switch to, because the session is usually NOT in the project on screen — the
// whole point of the dashboard is jumping across them.
export async function locateSession(id: string): Promise<{ worktreePath: string; projectPath?: string } | undefined> {
  const session = getAllCreatedSessions().find((s) => s.id === id)
  if (!session) return undefined
  const entry = (await worktreeIndex()).get(session.worktreePath)
  return { worktreePath: session.worktreePath, projectPath: entry?.projectPath }
}

async function worktreeIndex(): Promise<Map<string, Entry>> {
  if (index && Date.now() - indexAt < INDEX_TTL_MS) return index
  // Collapse concurrent callers (an SSE tick landing on a snapshot request) onto
  // one git walk instead of N.
  if (!indexing) {
    indexing = buildIndex().then((map) => {
      index = map
      indexAt = Date.now()
      indexing = null
      return map
    })
  }
  return indexing
}

// When did the state we're reporting *begin*? `running` and `error` carry their
// own timestamp (turn start / the error event), so they're exact. `waiting` and
// `idle` have none, so the first tick that observes the transition stamps it.
// ponytail: that means a session already idle at boot reads "idle since boot",
// not since its last turn ended — the elapsed clock on a card nobody is watching.
// Persist the transition if that ever matters.
const stateSince = new Map<string, { state: FleetState; at: number }>()

export function stateStart(id: string, state: FleetState, rt: SessionRuntime, now: number): number {
  const prev = stateSince.get(id)
  if (!prev || prev.state !== state) stateSince.set(id, { state, at: now })
  if (state === 'running' && rt.since) return rt.since
  if (state === 'error' && rt.error) return rt.error.at
  return stateSince.get(id)?.at ?? now
}

// --- usage limits ---------------------------------------------------------
// Both probes spawn a CLI (claude ~20s, codex ~6s), so neither may ever run on a
// snapshot request. Claude usage is only refreshed by an explicit request; we
// read its last cached value. Codex's isn't polled by anything, so
// startFleetUsage() owns a timer for it. Before either probe lands, `usage` is
// simply absent.
const USAGE_REFRESH_MS = 5 * 60 * 1000
let codexUsage: CodexUsage | undefined
let usageTimer: NodeJS.Timeout | null = null

function refreshCodexUsage(): void {
  void getCodexUsage()
    .then((u) => {
      if (u) codexUsage = u
    })
    .catch(() => {
      /* codex not installed / not logged in — the block just stays out */
    })
}

export function startFleetUsage(): void {
  if (usageTimer) return
  refreshCodexUsage()
  usageTimer = setInterval(refreshCodexUsage, USAGE_REFRESH_MS)
  usageTimer.unref?.()
}

// "resets in 4h47" from a unix-seconds deadline; Claude's probe already hands us
// a human string ("Jun 13 at 1am (America/Denver)"), so that one passes through.
function resetsIn(at: number | undefined): string | undefined {
  if (!at) return undefined
  const mins = Math.round((at * 1000 - Date.now()) / 60_000)
  if (mins <= 0) return 'resetting'
  return mins < 60 ? `resets in ${mins}m` : `resets in ${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, '0')}`
}

export function usageBlocks(claude: UsageStats, codex: CodexUsage | undefined): FleetUsageBlock[] {
  const blocks: FleetUsageBlock[] = []
  const claudeRows: FleetUsageBlock['rows'] = []
  if (claude.session) claudeRows.push(['session', claude.session.pct, claude.session.resetsAt && `resets ${claude.session.resetsAt}`])
  if (claude.week) claudeRows.push(['week', claude.week.pct, claude.week.resetsAt && `resets ${claude.week.resetsAt}`])
  if (claude.month) claudeRows.push(['month', claude.month.pct, claude.month.resetsAt && `resets ${claude.month.resetsAt}`])
  if (claudeRows.length) blocks.push({ label: 'CLAUDE', rows: claudeRows })

  const codexRows: FleetUsageBlock['rows'] = []
  if (codex?.primary) codexRows.push(['5h', Math.round(codex.primary.usedPercent), resetsIn(codex.primary.resetsAt)])
  if (codex?.secondary) codexRows.push(['weekly', Math.round(codex.secondary.usedPercent), resetsIn(codex.secondary.resetsAt)])
  if (codexRows.length) blocks.push({ label: 'CODEX', rows: codexRows })
  return blocks
}

export async function snapshot(): Promise<FleetSnapshot> {
  const idx = await worktreeIndex()
  const now = Date.now()
  const seen = new Set<string>()
  const sessions = getAllCreatedSessions().map((s): FleetSession => {
    const rt = sessionRuntime(s.id)
    const entry = idx.get(s.worktreePath)
    const state = deriveState(rt)
    seen.add(s.id)
    return {
      id: s.id,
      title: s.title,
      // A session whose worktree isn't in the index belongs to a removed worktree
      // or an unregistered project — kept (the flags say so), never guessed at.
      project: entry?.project ?? '',
      branch: entry?.branch ?? '',
      worktreePath: s.worktreePath,
      state,
      since: stateStart(s.id, state, rt, now),
      lastLine: rt.lastLine,
      live: rt.live,
      exists: entry != null || existsSync(s.worktreePath)
    }
  })
  for (const id of stateSince.keys()) if (!seen.has(id)) stateSince.delete(id) // closed sessions
  const usage = usageBlocks(lastUsage(), codexUsage)
  return { host: hostname(), at: now, sessions, edges: edges.slice(), ...(usage.length ? { usage } : {}) }
}

// --- the conversation edge log --------------------------------------------

export interface FleetEdge {
  at: number
  // Both ends are session ids local to this instance. `from` is the MCP path
  // token, which IS the caller's session id — except the literal 'global' for a
  // `claude` Rookery never spawned, which has no card and no way to get one.
  // `ask_codex` is a SELF-edge (from === to): Codex runs as an inline subagent of
  // the caller, not as a session, so there's no second node to draw.
  // `create_session` is the spawn itself — the caller opened `to` and handed it
  // the first prompt inline, so no send_message ever follows to draw the wire.
  from: string
  to: string
  kind: 'send_message' | 'ask_codex' | 'create_session'
  preview: string
  waited: boolean // the caller passed wait:true and is blocked on the reply
}

const EDGE_CAP = 200
const PREVIEW_CAP = 200
const edges: FleetEdge[] = []
let edgeSeq = 0 // bumped per edge so the SSE tick knows there's something new

export function recordEdge(edge: Omit<FleetEdge, 'at' | 'preview'> & { preview: string }): FleetEdge {
  const full: FleetEdge = { ...edge, at: Date.now(), preview: edge.preview.slice(0, PREVIEW_CAP) }
  edges.push(full)
  if (edges.length > EDGE_CAP) edges.splice(0, edges.length - EDGE_CAP)
  edgeSeq++
  try {
    appendFileSync(join(dataDir(), 'fleet.jsonl'), JSON.stringify(full) + '\n')
  } catch {
    // Best-effort history: the ring buffer is the live source, the file is only
    // for reading back later. A full/read-only disk must not break send_message.
  }
  return full
}

// The ring is process memory, but "who talked to whom recently" outlives a
// restart — and recordEdge already appends every edge to fleet.jsonl. So seed the
// ring from the tail of that file at boot instead of starting the conversation
// half of the panel blank after every relaunch.
// ponytail: reads the whole file to take its tail (one line per agent→agent
// message — KBs, not MBs). Seek from the end if it ever gets big.
export function loadEdges(): void {
  if (edges.length) return
  let lines: string[]
  try {
    lines = readFileSync(join(dataDir(), 'fleet.jsonl'), 'utf8').split('\n')
  } catch {
    return // no history yet
  }
  for (const line of lines.slice(-EDGE_CAP)) {
    if (!line) continue
    try {
      const edge = JSON.parse(line) as FleetEdge
      // A killed write can leave a torn trailing line; require the fields the
      // client draws from rather than trusting the parse.
      if (typeof edge.at === 'number' && typeof edge.from === 'string' && typeof edge.to === 'string') edges.push(edge)
    } catch {
      /* torn line — skip */
    }
  }
}

// Test seam: the ring buffer is module state, so a test needs to start clean.
export function resetEdges(): void {
  edges.length = 0
  edgeSeq = 0
}

// --- instance discovery ---------------------------------------------------
// Two Rookery instances on one Mac is the normal working shape, not an accident:
// one attached to `link`, one running local sessions (plus ⌘⇧N, openNewInstance).
// Only the first to boot gets PREFERRED_PORT; the second silently falls back to an
// ephemeral one — so a dashboard that only knows the canonical port asks whichever
// instance won the race, and gets an honest "nothing is running" while the other
// one's agents work. An empty board is indistinguishable from a quiet machine,
// which is the one lie a monitoring panel can't tell.
//
// So every instance publishes the port it actually bound, one file per pid, and
// the client reads the directory. It's already a multi-endpoint aggregator (this
// Mac + `link`), so a second local endpoint is native to it.
//
// Siblings share this dataDir, hence the same session store: they serve the same
// rows and differ only in which ones are live HERE. The client dedupes by session
// id and keeps the busy row.
//
// ponytail: no cleanup on quit. A crash could never unpublish anyway, so the
// client has to tolerate a dead port regardless (it just refuses the connection)
// — and the boot-time reap below collects them. One mechanism, not two.
function portsDir(): string {
  return join(dataDir(), 'fleet-ports')
}

export function publishPort(port: number): void {
  try {
    mkdirSync(portsDir(), { recursive: true })
    for (const name of readdirSync(portsDir())) {
      const pid = Number(name)
      if (!pid) continue
      // kill(pid, 0) = "does this pid exist" — it sends no signal.
      try {
        process.kill(pid, 0)
      } catch {
        rmSync(join(portsDir(), name), { force: true })
      }
    }
    writeFileSync(join(portsDir(), String(process.pid)), String(port))
  } catch {
    // Discovery is a convenience — the client still has the hardcoded port.
  }
}

export function recentEdges(): FleetEdge[] {
  return edges.slice()
}

// --- auth -----------------------------------------------------------------
// Same token file the headless server already uses, so `link` needs no second
// secret and the desktop gets one on first use. The MCP path token can't gate
// this: in-app sessions carry their own key and external ones share the
// well-known 'global'.
let cachedToken: string | null = null

export function fleetToken(): string {
  if (cachedToken) return cachedToken
  const file = join(dataDir(), 'rookery-token')
  try {
    if (existsSync(file)) cachedToken = readFileSync(file, 'utf8').trim()
    else {
      cachedToken = randomBytes(32).toString('hex')
      writeFileSync(file, cachedToken, { mode: 0o600 })
    }
  } catch {
    // Unwritable dataDir: fall back to a process-lifetime token rather than
    // serving unauthenticated (focus is remote control of the user's editor).
    cachedToken = randomBytes(32).toString('hex')
  }
  return cachedToken
}

export function tokenOk(provided: string | undefined): boolean {
  if (!provided) return false
  const a = Buffer.from(provided)
  const b = Buffer.from(fleetToken())
  return a.length === b.length && timingSafeEqual(a, b)
}

// The token must be presented explicitly (query or Authorization), never via the
// server's `rk` cookie: Fleet is a cross-origin page, so we answer with a wildcard
// CORS header — and a wildcard plus cookie auth is exactly the shape that lets any
// page in the browser drive this. No credentials, no ambient authority.
function requestToken(req: IncomingMessage): string | undefined {
  const auth = req.headers.authorization
  if (auth?.startsWith('Bearer ')) return auth.slice(7).trim()
  const q = (req.url ?? '').split('?')[1]
  return q ? (new URLSearchParams(q).get('token') ?? undefined) : undefined
}

// --- HTTP -----------------------------------------------------------------

// `ok` = a live renderer took the select. `raised` = the window actually came
// forward. They come apart constantly: on `link` main can't raise anything (the
// UI is a tab or an attached window on another machine), and a browser tab
// usually ignores window.focus(). A tap that lands but never surfaces is a
// silent failure, so both are reported rather than a blind 200.
export type FocusResult = {
  ok: boolean
  raised: boolean
  focused: 'window' | 'requested' | 'none'
  message: string
}

// The host wires these: the desktop pushes an mcp:command + raises its own window;
// the server pushes the command and reports that the raise is up to the client.
export interface FleetHost {
  focus: (sessionId: string) => FocusResult | Promise<FocusResult>
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*'
  })
  res.end(JSON.stringify(body))
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        resolve(parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {})
      } catch {
        resolve({})
      }
    })
    req.on('error', () => resolve({}))
  })
}

const STREAM_TICK_MS = 2000
const KEEPALIVE_MS = 20_000

// SSE: re-derive the snapshot on a tick and send only what changed. main has no
// event bus (agent.ts pushes straight at win.webContents), so a tick reusing the
// exact snapshot derivation beats instrumenting every emit site — and the walk is
// a store read plus a cached index either way.
//
// Events, all one-object-per-event so the client can render from the event alone:
//   snapshot  FleetSnapshot   — once, on connect
//   open      FleetSession    — a session appeared (full object, no refetch)
//   state     FleetSession    — anything on the card changed (full object)
//   close     { id }          — the session is gone from the store
//   edge      FleetEdge       — one new conversation edge
// Plus a `: keepalive` comment every 20s, so a quiet fleet reads as alive.
function stream(res: ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'access-control-allow-origin': '*'
  })
  const event = (name: string, data: unknown): void => {
    res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  let prev = new Map<string, string>()
  let seenEdges = 0
  let closed = false

  const tick = async (): Promise<void> => {
    if (closed) return
    const snap = await snapshot()
    const first = prev.size === 0
    const next = new Map<string, string>()
    for (const s of snap.sessions) {
      // The identity of what a card draws — `lastLine` and `state` move, the rest
      // rarely does, and a card only needs redrawing when one of these changes.
      const sig = `${s.state}|${s.live}|${s.since}|${s.title}|${s.lastLine}|${s.project}|${s.branch}`
      next.set(s.id, sig)
      if (first) continue // the snapshot event already carries every session
      const before = prev.get(s.id)
      if (before === undefined) event('open', s)
      else if (before !== sig) event('state', s)
    }
    if (!first) for (const id of prev.keys()) if (!next.has(id)) event('close', { id })
    prev = next
    if (first) {
      event('snapshot', snap)
      seenEdges = edgeSeq // the snapshot carries the ring buffer
      return
    }
    if (edgeSeq > seenEdges) {
      for (const edge of edges.slice(-(edgeSeq - seenEdges))) event('edge', edge)
      seenEdges = edgeSeq
    }
  }

  void tick()
  const timer = setInterval(() => void tick(), STREAM_TICK_MS)
  timer.unref?.()
  // A comment frame keeps proxies from buffering the stream shut and lets the
  // client tell "nothing is happening" from "the link died".
  const ka = setInterval(() => res.write(': keepalive\n\n'), KEEPALIVE_MS)
  ka.unref?.()
  res.on('close', () => {
    closed = true
    clearInterval(timer)
    clearInterval(ka)
  })
}

// Handle a /fleet/* request. Returns false when the path isn't ours, so the
// caller falls through to its own routing.
export async function handleFleet(req: IncomingMessage, res: ServerResponse, host: FleetHost): Promise<boolean> {
  const path = (req.url ?? '').split('?')[0]
  if (!path.startsWith('/fleet/')) return false

  // Preflight for the cross-origin POST. No credentials — see requestToken().
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type, authorization'
    })
    res.end()
    return true
  }

  if (!tokenOk(requestToken(req))) {
    json(res, 401, { error: 'unauthorized' })
    return true
  }

  if (path === '/fleet/snapshot') {
    json(res, 200, await snapshot())
    return true
  }
  if (path === '/fleet/stream') {
    stream(res)
    return true
  }
  if (path === '/fleet/focus' && req.method === 'POST') {
    const body = await readJsonBody(req)
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
    if (!sessionId) {
      json(res, 400, { ok: false, focused: 'none', message: 'Missing "sessionId".' })
      return true
    }
    json(res, 200, await host.focus(sessionId))
    return true
  }

  json(res, 404, { error: 'not found' })
  return true
}
