import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Everything queries.ts reaches OUT to is stubbed — the packet builder, the
// turn, the conn, the runtime thread, the transcript on disk — and only when
// queries.ts is the importer, so the real sessionStore still holds the
// registry. What is worth testing here is the shape of the three actions: what
// is sent, what closes, and what is thrown away. None of it needs a CLI.
const hookSource = `
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
const STUBS = {
  './agent': 'stub:agent',
  './handoff': 'stub:handoff',
  './runtimes': 'stub:runtimes',
  './peer': 'stub:peer',
  './runtimeLog': 'stub:runtimeLog',
  './turn': 'stub:turn',
  './log': 'stub:log'
}
export async function resolve(specifier, context, next) {
  if (specifier === 'electron') return { url: 'stub:electron', shortCircuit: true, format: 'module' }
  if (STUBS[specifier] && (context.parentURL ?? '').endsWith('/queries.ts'))
    return { url: STUBS[specifier], shortCircuit: true, format: 'module' }
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
  'stub:electron': "export const app = { getPath: () => process.env.FLOE_TEST_USERDATA || '/tmp' }; export class BrowserWindow {}; export default {};",
  'stub:log': "export const log = () => {};",
  'stub:agent':
    "export function sendAgentEvent(win, key, event) { globalThis.__events.push({ key, event }) }" +
    "\\nexport function stopAgent(win, key) { globalThis.__stopped.push(key) }" +
    "\\nexport function activeTurnKeys() { return globalThis.__busy }" +
    "\\nexport function onceTurnDone(key, cb) { (globalThis.__waits[key] ??= []).push(cb) }",
  'stub:runtimes': "export function forgetThread(key) { globalThis.__forgot.push(key) }",
  'stub:peer': "export function forgetPeers(key) { globalThis.__forgotPeers.push(key) }",
  'stub:runtimeLog':
    "export function logTurn(key, item) { globalThis.__logged.push({ key, item }) }" +
    "\\nexport function dropRuntimeTranscript(key) { globalThis.__dropped.push(key) }",
  // Models the real watermark: clearing the read mark puts the whole
  // conversation back on the unread pile. Stubbed any weaker and it hides the
  // bug it exists to catch: a second merge re-shipping the lot.
  'stub:handoff':
    "export function forgetSeen() {}" +
    "\\nexport function forgetRead(key) { globalThis.__forgotRead.push(key); globalThis.__unread[key] = globalThis.__said[key] ?? 0 }" +
    "\\nexport function packetFrom(wt, from, to, opts) {" +
    "\\n  const left = opts.since === 'all' ? (globalThis.__said[from] ?? 0) : (globalThis.__unread[from] ?? 0)" +
    "\\n  if (!left) return null" +
    "\\n  globalThis.__unread[from] = 0" +
    "\\n  return { packet: '[packet ' + left + ' from ' + from + ']', entries: left }" +
    "\\n}",
  'stub:turn':
    "export function startTurn(win, key, wt, prompt, options) { globalThis.__sent.push({ key, prompt, options }) }" +
    "\\nexport function optionsForSession(key) { return { provider: 'claude', model: 'opus', effort: 'medium', permissionMode: 'default' } }" +
    "\\nexport function optionsForRoute(route) { return { provider: route.harness, model: '', effort: route.effort, permissionMode: 'skip' } }"
}
export async function load(url, context, next) {
  if (SOURCE[url]) return { format: 'module', shortCircuit: true, source: SOURCE[url] }
  return next(url, context)
}
`
register('data:text/javascript,' + encodeURIComponent(hookSource), import.meta.url)

interface Sent {
  key: string
  prompt: string
  options: { shown?: string }
}
declare global {
  // eslint-disable-next-line no-var
  var __sent: Sent[]
  // eslint-disable-next-line no-var
  var __events: Array<{ key: string; event: { kind: string; summary?: string; fanoutId?: string } }>
  // eslint-disable-next-line no-var
  var __stopped: string[]
  // eslint-disable-next-line no-var
  var __forgot: string[]
  var __forgotPeers: string[]
  // eslint-disable-next-line no-var
  var __forgotRead: string[]
  // eslint-disable-next-line no-var
  var __logged: Array<{ key: string }>
  // eslint-disable-next-line no-var
  var __dropped: string[]
  /** How many entries the chat has not read of each query, per the fake packet. */
  // eslint-disable-next-line no-var
  var __unread: Record<string, number>
  /** Waiters parked on a query's `done`, for the fan-out's mirror. */
  // eslint-disable-next-line no-var
  var __waits: Record<string, Array<(text: string) => void>>
  /** Everything each query has ever said — what a cleared watermark exposes. */
  // eslint-disable-next-line no-var
  var __said: Record<string, number>
  /** The keys main would report as answering right now. */
  // eslint-disable-next-line no-var
  var __busy: string[]
}

const dataDir = mkdtempSync(join(tmpdir(), 'floe-queries-'))
process.env.FLOE_TEST_USERDATA = dataDir
const { setSharedDataDir } = await import('./dataDir.ts')
setSharedDataDir(dataDir)

const { addCreatedSession, findQuery } = await import('./sessionStore.ts')
const {
  canOpenQuery,
  canRunInQuery,
  discardQuery,
  fanOut,
  forgetQuery,
  mergeQuery,
  openQueryFor,
  peekQuery,
  queriesFor
} = await import('./queries.ts')

const WIN = { isDestroyed: () => false, webContents: { send: () => {} } } as never
const WT = '/tmp/wt'

let n = 0
/** A session with one open codex query, and `unread` entries waiting in it. */
function fresh(unread: number): { sessionId: string; qkey: string } {
  globalThis.__sent = []
  globalThis.__events = []
  globalThis.__stopped = []
  globalThis.__forgot = []
  globalThis.__forgotPeers = []
  globalThis.__forgotRead = []
  globalThis.__logged = []
  globalThis.__dropped = []
  globalThis.__unread = {}
  globalThis.__waits = {}
  globalThis.__said = {}
  globalThis.__busy = []
  const sessionId = `q-sess-${++n}`
  addCreatedSession({ id: sessionId, worktreePath: WT })
  const opened = openQueryFor(WIN, sessionId, WT, { harness: 'codex' })
  assert.ok(opened, 'codex can hold a query')
  globalThis.__unread[opened.key] = unread
  globalThis.__said[opened.key] = unread
  return { sessionId, qkey: opened.key }
}

test('only a harness with a real read-only mode can hold a query', () => {
  // The gate is `plan`, not an approximation of it: gemini has no read-only
  // setting, so `nearestMode` would land it on "ask" and it would start asking
  // permission to edit — in a conversation that promised never to write (R2).
  assert.equal(canOpenQuery('claude'), true)
  assert.equal(canOpenQuery('codex'), true)
  assert.equal(canOpenQuery('opencode'), true)
  assert.equal(canOpenQuery('gemini'), false)
  assert.equal(canOpenQuery('ollama'), false)
})

test('opening the same harness twice is one query, not two', () => {
  const { sessionId } = fresh(0)
  openQueryFor(WIN, sessionId, WT, { harness: 'codex' })
  assert.equal(queriesFor(sessionId).length, 1)
})

test('a peek sends the unread and leaves the query open', () => {
  const { sessionId, qkey } = fresh(3)
  const out = peekQuery(WIN, qkey)
  assert.equal(out.entries, 3)
  // Into the CHAT, not the query: peek is the chat reading.
  assert.equal(globalThis.__sent[0].key, sessionId)
  assert.match(globalThis.__sent[0].prompt, /\[packet 3/)
  // Shown as the envelope's stand-in: the words are already on screen in the
  // query's own panel, and printing them in the chat under the user's name
  // would say they typed what codex said.
  assert.match(globalThis.__sent[0].options.shown ?? '', /floe-relay from="codex"/)
  assert.equal(findQuery(qkey)?.closedAt, undefined)
  assert.deepEqual(globalThis.__stopped, [])
})

test('a merge after a peek sends the rest, and closes', () => {
  const { sessionId, qkey } = fresh(3)
  peekQuery(WIN, qkey)
  // Two more arrived in the query while the chat was reading the first three.
  globalThis.__unread[qkey] = 2
  const out = mergeQuery(WIN, qkey)
  assert.equal(out.entries, 2)
  assert.equal(globalThis.__sent[1].key, sessionId)
  assert.match(globalThis.__sent[1].prompt, /\[packet 2/)
  const closed = findQuery(qkey)
  assert.equal(closed?.outcome, 'merged')
  assert.ok(closed?.closedAt)
  // Everything the LIVE query was holding is let go — the conn, the one-shot
  // thread. Not the read mark: the entry and the transcript both outlive the
  // merge, so what the chat has already been shown has to outlive it too.
  assert.ok(globalThis.__stopped.includes(qkey))
  assert.ok(globalThis.__forgot.includes(qkey))
  // The peer windows and threads a query opened go with it, or the next query
  // on that key starts halfway through someone else's exchange count.
  assert.ok(globalThis.__forgotPeers.includes(qkey))
  assert.equal(globalThis.__forgotRead.includes(qkey), false)
})

test('merging twice is harmless — the second one has nothing left to send', () => {
  const { qkey } = fresh(2)
  mergeQuery(WIN, qkey)
  // The read mark has to SURVIVE the close. Wiped with the conn, the second
  // press of ⌘⇧M pasted the whole conversation the first had just delivered —
  // the entry and the transcript both outlive a merge, so the mark must too.
  const again = mergeQuery(WIN, qkey)
  assert.equal(again.entries, 0)
  // One turn, not two: a key that is bound to a shortcut gets pressed twice.
  assert.equal(globalThis.__sent.length, 1)
  assert.equal(findQuery(qkey)?.outcome, 'merged')
})

test('a discard produces no packet at all', () => {
  const { qkey } = fresh(5)
  const out = discardQuery(WIN, qkey)
  assert.equal(out.entries, 0)
  // The chat never sees a word of it. Not a shorter packet — none.
  assert.deepEqual(globalThis.__sent, [])
  assert.equal(findQuery(qkey)?.outcome, 'discarded')
})

test('an action on a query nobody has says so, rather than doing nothing', () => {
  fresh(0)
  for (const run of [peekQuery, mergeQuery, discardQuery])
    assert.match(run(WIN, 'nowhere~codex').error ?? '', /Unknown query/)
})

test('@all asks the harnesses it was given, and never any others', () => {
  const { sessionId } = fresh(0)
  // gemini has no read-only mode, so it is refused rather than approximated —
  // and the ones that can hold a query still go out (R2, R7).
  const out = fanOut(WIN, sessionId, WT, {
    harnesses: ['codex', 'claude', 'gemini'],
    prompt: 'o que voces acham'
  })
  assert.deepEqual(out.refused, ['gemini'])
  assert.deepEqual(out.keys, [`${sessionId}~codex`, `${sessionId}~claude`])
  // One turn each, in its OWN query — never in the chat.
  assert.deepEqual(globalThis.__sent.map((t) => t.key), out.keys)
  for (const t of globalThis.__sent) assert.equal(t.prompt, 'o que voces acham')
})

test('every answer to one @all shares its fan-out, so they read as columns', () => {
  const { sessionId } = fresh(0)
  const out = fanOut(WIN, sessionId, WT, { harnesses: ['codex', 'claude'], prompt: 'x' })
  for (const key of out.keys) for (const cb of globalThis.__waits[key] ?? []) cb(`from ${key}`)
  const mirrored = globalThis.__events.filter((e) => e.event.kind === 'fanout')
  assert.equal(mirrored.length, 2)
  // Into the CHAT — the comparison is what the chat gets; the conversation
  // stays in each query's own panel.
  for (const e of mirrored) assert.equal(e.key, sessionId)
  assert.equal(new Set(mirrored.map((e) => e.event.fanoutId)).size, 1)
})

test('a fan-out turn that came back with nothing draws no column', () => {
  const { sessionId } = fresh(0)
  const out = fanOut(WIN, sessionId, WT, { harnesses: ['codex'], prompt: 'x' })
  for (const cb of globalThis.__waits[out.keys[0]] ?? []) cb('   ')
  // An empty column is our own plumbing reported as an answer.
  assert.equal(globalThis.__events.filter((e) => e.event.kind === 'fanout').length, 0)
})

test('a discard keeps the transcript, because the dead line offers reopen', () => {
  const { qkey } = fresh(3)
  discardQuery(WIN, qkey)
  // Deleting it would break the one thing the discarded line is there for.
  // R4's accumulation is answered by `forgetQuery`, which runs when the record
  // itself goes — closing the session, removing the worktree.
  assert.equal(globalThis.__dropped.length, 0)
  forgetQuery(qkey)
  assert.ok(globalThis.__dropped.includes(qkey))
})

test('a merge that cannot deliver does not close the query', () => {
  const { qkey } = fresh(4)
  const out = mergeQuery(null, qkey)
  assert.match(out.error ?? '', /No window/)
  // Neither marked read nor marked merged: a merge that delivered nothing has
  // not merged, and there would be no second chance if it closed anyway.
  assert.equal(findQuery(qkey)?.outcome, undefined)
  assert.equal(mergeQuery(WIN, qkey).entries, 4)
})

test('a busy one-shot query is told to wait, not raced', () => {
  const { qkey } = fresh(0)
  globalThis.__busy = [qkey]
  assert.equal(canRunInQuery(WIN, qkey, 'codex'), false)
  // Claude is the exception, and it is the CLI's own: a second message joins
  // the turn in flight as a steer instead of starting one beside it.
  assert.equal(canRunInQuery(WIN, qkey, 'claude'), true)
  globalThis.__busy = []
  assert.equal(canRunInQuery(WIN, qkey, 'codex'), true)
})

test('@all skips a target already answering rather than running it twice', () => {
  const { sessionId } = fresh(0)
  globalThis.__busy = [`${sessionId}~codex`]
  const out = fanOut(WIN, sessionId, WT, { harnesses: ['codex', 'claude'], prompt: 'x' })
  assert.deepEqual(out.busy, ['codex'])
  assert.deepEqual(out.keys, [`${sessionId}~claude`])
  assert.deepEqual(globalThis.__sent.map((t) => t.key), [`${sessionId}~claude`])
})
