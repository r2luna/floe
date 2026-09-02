import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import type { AgentRunOptions } from '../shared/types'

// The same loader hook the other main-process tests use, plus stubs for the two
// modules the relay actually touches: `./agent` parks the waiter it waits on,
// `./turn` starts the turns it starts. Stubbed because the real ones spawn CLIs
// — what is worth testing here is the bookkeeping, not the child process.
const hookSource = `
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
const STUBS = { './agent': 'stub:agent', './turn': 'stub:turn', './log': 'stub:log' }
export async function resolve(specifier, context, next) {
  if (specifier === 'electron') return { url: 'stub:electron', shortCircuit: true, format: 'module' }
  if (STUBS[specifier] && (context.parentURL ?? '').endsWith('/relay.ts'))
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
    "\\nexport function activeTurnKeys() { return globalThis.__active }" +
    "\\nexport function sessionNames(key) { return [key] }",
  'stub:turn':
    "export function startTurn(win, key, worktreePath, prompt, options) { globalThis.__turns.push({ key, prompt, options }) }" +
    "\\nexport function optionsForRoute(route) { return { provider: route.harness, model: '', effort: 'medium' } }"
}
export async function load(url, context, next) {
  if (SOURCE[url]) return { format: 'module', shortCircuit: true, source: SOURCE[url] }
  return next(url, context)
}
`
register('data:text/javascript,' + encodeURIComponent(hookSource), import.meta.url)

interface Started {
  key: string
  prompt: string
  options: AgentRunOptions
}
declare global {
  // eslint-disable-next-line no-var
  var __waiters: Record<string, Array<(text: string) => void>>
  // eslint-disable-next-line no-var
  var __turns: Started[]
  // The keys main would report as answering right now.
  // eslint-disable-next-line no-var
  var __active: string[]
}

const { armRelay, cancelRelay } = await import('./relay.ts')
const { MAX_HOPS, relayMark } = await import('../shared/relay.ts')

const WIN = {} as never
const CLAUDE: AgentRunOptions = { provider: 'claude', model: 'opus', effort: 'medium', permissionMode: 'default' }

/**
 * A fresh chat: no waiters parked, no turns started, nothing else answering.
 *
 * The relay hands the boundary to whatever the panel does with it before taking
 * the turn, so every test drives the clock (see `settle`) rather than waiting.
 */
function fresh(t: TestContext, key: string): void {
  globalThis.__waiters = {}
  globalThis.__turns = []
  globalThis.__active = []
  cancelRelay(key)
  t.mock.timers.enable({ apis: ['setTimeout'] })
}

/** Past the yield, where the relay decides whether the turn is still its to take. */
const settle = (t: TestContext): void => t.mock.timers.tick(1_000)

/** The turn on `key` ends, saying this. */
function ends(t: TestContext, key: string, text: string): void {
  const waiters = globalThis.__waiters[key] ?? []
  globalThis.__waiters[key] = []
  for (const w of waiters) w(text)
  settle(t)
}

/** What turn.ts does for a routed turn — arm, then let the turn end. */
function routed(t: TestContext, key: string, harness: string, answer: string): void {
  armRelay(WIN, key, '/wt', harness, CLAUDE)
  ends(t, key, answer)
}

test('what the harness answered comes back to the session\'s own model', (t) => {
  fresh(t, 's1')
  routed(t, 's1', 'codex', 'o parser está errado na linha 30')
  assert.equal(globalThis.__turns.length, 1)
  const [turn] = globalThis.__turns
  assert.match(turn.prompt, /addressed to codex, not to you/)
  // At the session's own model, effort and mode: the relay is an ordinary turn
  // for it, not a special one.
  assert.deepEqual(turn.options, CLAUDE)
})

test('a turn that came back with nothing is not worth an opinion', (t) => {
  fresh(t, 's2')
  routed(t, 's2', 'codex', '   ')
  assert.equal(globalThis.__turns.length, 0)
})

test('the model can answer the harness back, and only from the front of the line', (t) => {
  fresh(t, 's3')
  routed(t, 's3', 'codex', 'errado na linha 30')
  ends(t, 's3', '@codex e o teste que passa hoje?')
  assert.equal(globalThis.__turns.length, 2)
  const back = globalThis.__turns[1]
  assert.equal(back.prompt, 'e o teste que passa hoje?')
  assert.equal(back.options.provider, 'codex')
  // Shown as nothing: the model's words are already in the chat above, under
  // its own name, and must not be reprinted as something the user typed.
  assert.equal(back.options.shown, relayMark('claude'))
})

test('a reply that only mentions the harness is not addressed to it', (t) => {
  fresh(t, 's4')
  routed(t, 's4', 'codex', 'errado na linha 30')
  ends(t, 's4', 'concordo com o @codex, vou arrumar')
  // One turn: the take on what codex said, and nothing handed back.
  assert.equal(globalThis.__turns.length, 1)
})

test('the two stop talking at the cap, however long they would keep going', (t) => {
  fresh(t, 's5')
  let harnessTurns = 0
  for (let i = 0; i < MAX_HOPS + 2; i++) {
    routed(t, 's5', 'codex', 'mais uma coisa')
    harnessTurns++
    ends(t, 's5', '@codex e isso aqui?')
    // Each hand-back is a routed turn, which turn.ts would arm again — the loop
    // above is that arm.
    if (globalThis.__turns.filter((t) => t.options.provider === 'codex').length < harnessTurns) break
  }
  assert.equal(globalThis.__turns.filter((t) => t.options.provider === 'codex').length, MAX_HOPS - 1)
})

test('a new question starts a fresh conversation, not the tail of the last one', (t) => {
  fresh(t, 's6')
  routed(t, 's6', 'codex', 'primeira resposta')
  ends(t, 's6', '@codex e mais?')
  globalThis.__turns = []
  // The hop the relay spent is consumed by the arm it belongs to; the next
  // `@codex` a person types arms with the count back at zero.
  routed(t, 's6', 'codex', 'segunda resposta')
  assert.match(globalThis.__turns[0].prompt, /answered what you asked it/)
  routed(t, 's6', 'codex', 'terceira resposta')
  assert.match(globalThis.__turns[1].prompt, /addressed to codex, not to you/)
})

test('stop stops the relay too — the answer to a turn you cancelled', (t) => {
  fresh(t, 's7')
  armRelay(WIN, 's7', '/wt', 'codex', CLAUDE)
  cancelRelay('s7')
  ends(t, 's7', 'o que deu tempo de sair')
  assert.equal(globalThis.__turns.length, 0)
})

test('a message you typed while it worked takes the boundary, and the relay stands down', (t) => {
  fresh(t, 's8')
  armRelay(WIN, 's8', '/wt', 'codex', CLAUDE)
  globalThis.__waiters['s8'].forEach((w) => w('errado na linha 30'))
  // The panel drained your queued message into a turn of its own before the
  // relay looked. What codex said still reaches the model — it rides in the
  // handoff packet under your message.
  globalThis.__active = ['s8']
  settle(t)
  assert.equal(globalThis.__turns.length, 0)
})
