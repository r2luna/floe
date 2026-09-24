import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Same in-memory hook the other main-process tests use. HOME points at a temp
// dir so floe.toml is this test's, not the machine's.
// The four modules turn.ts calls out to are stubbed — but only when turn.ts is
// the importer, so the real sessionStore and floe.toml reader still answer. The
// stubs record what would have happened: which turn was started, on which key,
// and whether the relay was armed. That is the whole of what dispatchTurn and
// startTurn decide, and none of it needs a child process.
const hookSource = `
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
const STUBS = { './agent': 'stub:agent', './relay': 'stub:relay', './runtimes': 'stub:runtimes', './queries': 'stub:queries' }
export async function resolve(specifier, context, next) {
  if (specifier === 'electron') return { url: 'stub:electron', shortCircuit: true, format: 'module' }
  if (STUBS[specifier] && (context.parentURL ?? '').endsWith('/turn.ts'))
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
  'stub:electron': "export const app = { getPath: () => process.env.FLOE_TEST_USERDATA || '/tmp' }; export class BrowserWindow {}; export const ipcMain = { handle(){}, on(){} }; export const dialog = {}; export const shell = {}; export const safeStorage = { isEncryptionAvailable: () => false }; export default {};",
  'stub:agent':
    "export function sendToAgent(win, key, wt, prompt, options) { globalThis.__started.push({ key, prompt, options, on: 'claude' }) }",
  'stub:runtimes':
    "export function runRuntime(win, key, wt, prompt, provider, model, effort, permissionMode, shown) { globalThis.__started.push({ key, prompt, options: { provider, model, effort, permissionMode, shown }, on: provider }) }",
  'stub:relay':
    "export function armRelay(win, key) { globalThis.__armed.push({ kind: 'relay', key }) }" +
    "\\nexport function armAddress(win, key) { globalThis.__armed.push({ kind: 'address', key }) }",
  'stub:queries':
    "export const QUERY_MODE = 'plan'" +
    "\\nexport function canOpenQuery(h) { return globalThis.__canOpen.includes(h) }" +
    "\\nexport function refuseReason(h) { return h + ' has no read-only mode' }" +
    "\\nexport function canRunInQuery(win, key, harness) { return !globalThis.__busyQ.includes(key) }" +
    "\\nexport function openQueryFor(win, parentKey, wt, spec) {" +
    "\\n  if (!globalThis.__canOpen.includes(spec.harness)) return null" +
    "\\n  const key = parentKey + '~' + spec.harness" +
    "\\n  const query = { id: key, sessionId: parentKey, harness: spec.harness, openedBy: spec.openedBy }" +
    "\\n  globalThis.__opened.push(query)" +
    "\\n  return { query, key }" +
    "\\n}" +
    "\\nexport function noteOpened() {}" +
    "\\nexport function echoOpening(win, key, text) { globalThis.__echoed.push({ key, text }) }" +
    "\\nexport function refuse(win, key, reason) { globalThis.__refused.push({ key, reason }) }" +
    "\\nexport function queryOptions(base) { return { ...base, permissionMode: 'plan' } }" +
    "\\nexport function withOpeningContext(win, key, parent, wt, harness, prompt, start) { start(globalThis.__prefix) }"
}
export async function load(url, context, next) {
  if (SOURCE[url]) return { format: 'module', shortCircuit: true, source: SOURCE[url] }
  return next(url, context)
}
`
register('data:text/javascript,' + encodeURIComponent(hookSource), import.meta.url)

const home = mkdtempSync(join(tmpdir(), 'floe-turn-'))
process.env.HOME = home
process.env.XDG_CONFIG_HOME = join(home, '.config')
process.env.FLOE_TEST_USERDATA = home
mkdirSync(join(home, '.config', 'floe'), { recursive: true })
writeFileSync(
  join(home, '.config', 'floe', 'floe.toml'),
  [
    '[agent]',
    'model  = "opus"',
    'effort = "medium"',
    '',
    '[harness.codex]',
    'model  = "gpt-5.6-sol"',
    'effort = "xhigh"',
    ''
  ].join('\n')
)

interface TurnStarted {
  key: string
  prompt: string
  options: { provider?: string; permissionMode?: string }
  on: string
}
interface QueryOpened {
  id: string
  harness: string
  openedBy?: string
}
declare global {
  // eslint-disable-next-line no-var
  var __started: TurnStarted[]
  // eslint-disable-next-line no-var
  var __armed: Array<{ kind: string; key: string }>
  // eslint-disable-next-line no-var
  var __opened: QueryOpened[]
  // eslint-disable-next-line no-var
  var __echoed: Array<{ key: string; text: string }>
  // eslint-disable-next-line no-var
  var __refused: Array<{ key: string; reason: string }>
  // The harnesses that can hold a query in this test — the `plan` gate.
  // eslint-disable-next-line no-var
  var __canOpen: string[]
  /** What the stubbed opening context puts in front of a query's turn. */
  // eslint-disable-next-line no-var
  var __prefix: string
  /** Query keys already answering, for the one-turn-at-a-time guard. */
  // eslint-disable-next-line no-var
  var __busyQ: string[]
}

const { routeOf, optionsForRoute, dispatchTurn, startTurn } = await import('./turn.ts')
const { addCreatedSession, getCreatedSession } = await import('./sessionStore.ts')

const WIN = {} as never
const CLAUDE = { provider: 'claude', model: 'opus', effort: 'medium', permissionMode: 'skip' } as never

function fresh(): void {
  globalThis.__started = []
  globalThis.__armed = []
  globalThis.__opened = []
  globalThis.__echoed = []
  globalThis.__refused = []
  globalThis.__canOpen = ['claude', 'codex', 'opencode']
  globalThis.__busyQ = []
  globalThis.__prefix = ''
}

test('a handle is read the same way whichever door the prompt came in', () => {
  assert.deepEqual(routeOf('@codex revisa isso'), {
    harness: 'codex',
    model: undefined,
    effort: undefined,
    prompt: 'revisa isso'
  })
  // Mid-sentence it is a name, not an address — the composer's rule, unchanged.
  assert.equal(routeOf('pergunta pro @codex sobre isso'), null)
  // Every harness Floe can run, not the ones installed: an agent naming one
  // this machine lacks is told so by that harness, not answered by Claude.
  assert.equal(routeOf('@ollama resume')?.harness, 'ollama')
  assert.equal(routeOf('@nobody resume'), null)
})

test('a routed message takes the harness block, then falls back', () => {
  const codex = optionsForRoute({ harness: 'codex', prompt: 'x' })
  assert.equal(codex.provider, 'codex')
  assert.equal(codex.model, 'gpt-5.6-sol')
  assert.equal(codex.effort, 'xhigh')
  // codex has no "ask", so the agent default snaps to what it can do.
  assert.equal(codex.permissionMode, 'skip')

  // What the handle itself names beats the file.
  const named = optionsForRoute({ harness: 'codex', model: 'o3', effort: 'low', prompt: 'x' })
  assert.equal(named.model, 'o3')
  assert.equal(named.effort, 'low')

  // Nothing configured: no model is invented, and Claude alone borrows one.
  assert.equal(optionsForRoute({ harness: 'ollama', prompt: 'x' }).model, '')
  const claude = optionsForRoute({ harness: 'claude', prompt: 'x' })
  assert.equal(claude.provider, 'claude')
  assert.equal(claude.model, 'opus')
  assert.equal(claude.effort, 'medium')
})

test('a message with no handle is the session\'s own turn', () => {
  fresh()
  const out = dispatchTurn({
    win: WIN,
    parentKey: 'sess',
    worktreePath: '/wt',
    prompt: 'segue',
    origin: 'user',
    options: CLAUDE
  })
  assert.equal(out.key, 'sess')
  assert.equal(out.query, undefined)
  assert.deepEqual(globalThis.__opened, [])
  assert.equal(globalThis.__started[0].key, 'sess')
})

test('a chat begun on codex is codex\'s: its answer does not hand the turn to Claude', () => {
  fresh()
  const id = 'codex-chat'
  addCreatedSession({ id, worktreePath: '/wt' })
  const CODEX = { provider: 'codex', model: 'gpt-5.6-sol', effort: 'xhigh', permissionMode: 'skip' } as never
  dispatchTurn({ win: WIN, parentKey: id, worktreePath: '/wt', prompt: 'segue', origin: 'user', options: CODEX })
  assert.equal(globalThis.__started[0].on, 'codex')
  // Its own voice: watched for a handle it writes, not relayed back to Claude.
  assert.deepEqual(globalThis.__armed, [{ kind: 'address', key: id }])
  assert.equal(getCreatedSession(id)?.provider, 'codex')

  // And a later Claude turn in the same chat takes the role back the same way.
  fresh()
  dispatchTurn({ win: WIN, parentKey: id, worktreePath: '/wt', prompt: 'agora tu', origin: 'user', options: CLAUDE })
  assert.deepEqual(globalThis.__armed, [{ kind: 'address', key: id }])
  assert.equal(getCreatedSession(id)?.provider, undefined)
})

test('a routed message opens the query and runs there, not in the session', () => {
  fresh()
  const out = dispatchTurn({
    win: WIN,
    parentKey: 'sess',
    worktreePath: '/wt',
    prompt: '@codex analisa isso',
    route: { harness: 'codex', prompt: 'analisa isso' },
    origin: 'user'
  })
  assert.equal(out.key, 'sess~codex')
  assert.equal(out.query, true)
  assert.equal(globalThis.__opened[0].harness, 'codex')
  const [turn] = globalThis.__started
  assert.equal(turn.key, 'sess~codex')
  // The handle came off on the way, exactly as it does for a session turn.
  assert.equal(turn.prompt, 'analisa isso')
  // Read-only, whatever the parent is on. The parent here is `skip`.
  assert.equal(turn.options.permissionMode, 'plan')
  // And the panel shows the line that opened it.
  assert.deepEqual(globalThis.__echoed, [{ key: 'sess~codex', text: '@codex analisa isso' }])
})

test("a query's opening context goes in front of the prompt, and the line stays as typed", () => {
  fresh()
  globalThis.__prefix = '[chat summary]\n'
  dispatchTurn({
    win: WIN,
    parentKey: 'sess',
    worktreePath: '/wt',
    prompt: '@codex confere o erro',
    route: { harness: 'codex', prompt: 'confere o erro' },
    origin: 'user'
  })
  const [turn] = globalThis.__started
  assert.equal(turn.prompt, '[chat summary]\nconfere o erro')
  assert.equal((turn.options as { shown?: string }).shown, 'confere o erro')
})

test('a turn on a query key arms neither the relay nor the address', () => {
  fresh()
  startTurn(WIN, 'sess~codex', '/wt', 'e o hook de reload?', {
    provider: 'codex',
    model: '',
    effort: 'medium',
    permissionMode: 'plan'
  })
  // Nothing watches a query\'s answer: merge and peek are what read it, under
  // your command. Armed here, the parent\'s own model would take a turn inside
  // the query panel the second codex finished.
  assert.deepEqual(globalThis.__armed, [])
  assert.equal(globalThis.__started[0].on, 'codex')
})

test('a session turn still arms, so nothing else changed', () => {
  fresh()
  startTurn(WIN, 'sess', '/wt', 'segue', CLAUDE)
  assert.equal(globalThis.__armed.length, 1)
})

test('a query cannot open another query', () => {
  fresh()
  const out = dispatchTurn({
    win: WIN,
    parentKey: 'sess~codex',
    worktreePath: '/wt',
    prompt: '@gemini o que achas',
    route: { harness: 'gemini', prompt: 'o que achas' },
    origin: 'agent'
  })
  assert.match(out.error ?? '', /cannot open another query/)
  assert.deepEqual(globalThis.__opened, [])
  assert.deepEqual(globalThis.__started, [])
  assert.equal(globalThis.__refused[0].key, 'sess~codex')
})

test('a harness with no read-only mode is refused, not approximated', () => {
  fresh()
  const out = dispatchTurn({
    win: WIN,
    parentKey: 'sess',
    worktreePath: '/wt',
    prompt: '@gemini revisa',
    route: { harness: 'gemini', prompt: 'revisa' },
    origin: 'user'
  })
  assert.match(out.error ?? '', /gemini has no read-only mode/)
  assert.deepEqual(globalThis.__started, [])
  // Said in the chat that asked, so the refusal is not silent.
  assert.equal(globalThis.__refused[0].key, 'sess')
})

test('who opened it is carried through, so an agent-opened panel says so', () => {
  fresh()
  dispatchTurn({
    win: WIN,
    parentKey: 'sess',
    worktreePath: '/wt',
    prompt: 'revisa',
    route: { harness: 'codex', prompt: 'revisa' },
    origin: 'agent'
  })
  assert.equal(globalThis.__opened[0].openedBy, 'agent')
})

test('a second message into a busy query does not start a turn beside the first', () => {
  fresh()
  globalThis.__busyQ = ['sess~codex']
  const out = dispatchTurn({
    win: WIN,
    parentKey: 'sess',
    worktreePath: '/wt',
    prompt: '@codex e mais isso',
    route: { harness: 'codex', prompt: 'e mais isso' },
    origin: 'user'
  })
  assert.match(out.error ?? '', /still answering/)
  // One conversation, one turn: a second `codex exec` on the same thread races
  // the first, and whichever finishes last overwrites the other's bookkeeping.
  assert.deepEqual(globalThis.__started, [])
})
