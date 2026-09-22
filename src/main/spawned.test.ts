import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'

// Same loader hook the other main-process tests use. Three stubs: `./agent`
// parks the waiter and collects what is sent, `./sessionStore` is the store
// this reads and writes, `./log` is noise. The real ones spawn CLIs and touch
// disk — what is worth testing here is the bookkeeping: who gets the report,
// and when the row goes.
const hookSource = `
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
const STUBS = { './agent': 'stub:agent', './sessionStore': 'stub:store', './sessionClose': 'stub:close', './log': 'stub:log' }
export async function resolve(specifier, context, next) {
  if (specifier === 'electron') return { url: 'stub:electron', shortCircuit: true, format: 'module' }
  if (STUBS[specifier] && (context.parentURL ?? '').endsWith('/spawned.ts'))
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
  'stub:electron': "export class BrowserWindow {}; export const app = { getPath: () => '/tmp' }; export default {};",
  'stub:log': "export const log = () => {};",
  'stub:agent':
    "export function onceTurnDone(key, cb) { (globalThis.__waiters[key] ??= []).push(cb) }" +
    "\\nexport function sendAgentEvent(win, key, event) { globalThis.__peerSent.push({ key, event }) }",
  'stub:store':
    "export function getCreatedSession(id) { return globalThis.__sessions.find((s) => s.id === id || s.claudeId === id) }" +
    "\\nexport function getAllCreatedSessions() { return globalThis.__sessions }",
  'stub:close':
    "export function closeSessionFully(win, opts) { globalThis.__closed.push(opts); globalThis.__sessions = globalThis.__sessions.filter((s) => s.id !== opts.id) }"
}
export async function load(url, context, next) {
  if (SOURCE[url]) return { format: 'module', shortCircuit: true, source: SOURCE[url] }
  return next(url, context)
}
`
register('data:text/javascript,' + encodeURIComponent(hookSource), import.meta.url)

interface Session {
  id: string
  worktreePath: string
  title?: string
  claudeId?: string
  spawnedBy?: string
}
declare global {
  // eslint-disable-next-line no-var
  var __waiters: Record<string, Array<(text: string) => void>>
  // eslint-disable-next-line no-var
  var __peerSent: Array<{ key: string; event: { kind: string; from?: string; text?: string } }>
  // eslint-disable-next-line no-var
  var __closed: Array<{ id: string }>
  // eslint-disable-next-line no-var
  var __sessions: Session[]
}

const { armSpawnedClose, cancelSpawnedClose, __idleMs } = await import('./spawned.ts')

const WIN = { webContents: { send: () => {} } } as never

/** A parent chat and one lane it opened. */
function fresh(t: TestContext, sessions: Session[]): void {
  globalThis.__waiters = {}
  globalThis.__peerSent = []
  globalThis.__closed = []
  globalThis.__sessions = sessions
  t.mock.timers.enable({ apis: ['setTimeout'] })
}

/** The turn on `key` ends, saying this. */
function ends(key: string, text: string): void {
  const waiters = globalThis.__waiters[key] ?? []
  globalThis.__waiters[key] = []
  for (const w of waiters) w(text)
}

/** Past the idle window, where the close fires. */
const idle = (t: TestContext): void => t.mock.timers.tick(__idleMs + 1_000)

const LANE: Session = { id: 'lane', worktreePath: '/wt', title: 'crap: agent.ts', spawnedBy: 'parent' }
const PARENT: Session = { id: 'parent', worktreePath: '/wt', title: 'the chat' }

test('a lane reports to its parent and closes once it goes idle', (t) => {
  fresh(t, [PARENT, LANE])
  armSpawnedClose(WIN, 'lane')
  ends('lane', 'moved the handler out of the switch')

  // Nothing yet: the turn ending is not the work ending, and `send_message`
  // is very likely still holding this same `done`.
  assert.deepEqual(globalThis.__closed, [])
  assert.deepEqual(globalThis.__peerSent, [])

  idle(t)
  assert.deepEqual(globalThis.__peerSent, [
    { key: 'parent', event: { kind: 'peer', from: 'crap: agent.ts', text: 'moved the handler out of the switch' } }
  ])
  assert.deepEqual(globalThis.__closed, [{ id: 'lane', worktreePath: '/wt', claudeId: undefined }])
})

test('a new turn calls the close off — a lane lives as long as its parent talks to it', (t) => {
  fresh(t, [PARENT, LANE])
  armSpawnedClose(WIN, 'lane')
  ends('lane', 'first answer')
  // What `send_message` does next: another turn, before the idle window is up.
  t.mock.timers.tick(__idleMs / 2)
  armSpawnedClose(WIN, 'lane')
  idle(t)
  assert.deepEqual(globalThis.__closed, [], 'the lane is still being talked to')
  assert.deepEqual(globalThis.__peerSent, [])
})

test('the report goes to the parent under BOTH its names', (t) => {
  // The parent called MCP in with its Floe id; its chat is keyed by the claudeId.
  fresh(t, [{ ...PARENT, claudeId: 'parent-cc' }, LANE])
  armSpawnedClose(WIN, 'lane')
  ends('lane', 'done')
  idle(t)
  assert.deepEqual(
    globalThis.__peerSent.map((s) => s.key),
    ['parent', 'parent-cc']
  )
})

test('a lane that answered nothing keeps its row', (t) => {
  fresh(t, [PARENT, LANE])
  armSpawnedClose(WIN, 'lane')
  ends('lane', '   ')
  idle(t)
  assert.deepEqual(globalThis.__closed, [], 'a lane with no answer is the one you want to open')
  assert.deepEqual(globalThis.__peerSent, [])
})

test('a session a person opened is never touched', (t) => {
  fresh(t, [PARENT])
  armSpawnedClose(WIN, 'parent')
  ends('parent', 'an ordinary answer')
  idle(t)
  assert.deepEqual(globalThis.__closed, [])
  assert.deepEqual(globalThis.__peerSent, [])
  assert.equal(globalThis.__waiters['parent']?.length ?? 0, 0, 'no waiter is even parked')
})

test('cancelSpawnedClose stops a close already armed', (t) => {
  fresh(t, [PARENT, LANE])
  armSpawnedClose(WIN, 'lane')
  ends('lane', 'done')
  cancelSpawnedClose('lane')
  idle(t)
  assert.deepEqual(globalThis.__closed, [])
})
