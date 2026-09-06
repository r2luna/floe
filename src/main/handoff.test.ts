import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Same in-memory hook the other main-process tests use: rewrite `./x` → `./x.ts`
// and serve a stub for electron. `app.getPath` reads an env var so each test can
// point the runtime transcript log at its own directory.
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
    const src = "export const app = { getPath: () => process.env.FLOE_TEST_USERDATA || '/tmp' }; export class BrowserWindow {}; export const ipcMain = { handle(){}, on(){} }; export const dialog = {}; export const shell = {}; export const safeStorage = { isEncryptionAvailable: () => false }; export default {};"
    return { format: 'module', shortCircuit: true, source: src }
  }
  return next(url, context)
}
`
register('data:text/javascript,' + encodeURIComponent(hookSource), import.meta.url)

const { seedFor, forgetSeen, forgetRead, packetFrom, sessionTranscript } = await import('./handoff.ts')
const { PACKET_OPEN } = await import('../shared/handoff.ts')
const { relayPrompt } = await import('../shared/relay.ts')

const WORKTREE = '/tmp/wt'
let clock = 0

/** A fresh HOME + userData, so no test can see another's transcript. */
function fresh(): string {
  const home = mkdtempSync(join(tmpdir(), 'floe-handoff-'))
  process.env.HOME = home
  process.env.FLOE_TEST_USERDATA = home
  clock = Date.parse('2026-09-01T10:00:00.000Z')
  return home
}

const tick = (): number => (clock += 1000)

/** Append to Claude's own JSONL, where loadClaudeTranscript looks for it. */
function claudeSaid(id: string, role: 'user' | 'assistant', text: string): void {
  const dir = join(process.env.HOME!, '.claude', 'projects', WORKTREE.replace(/[/.]/g, '-'))
  mkdirSync(dir, { recursive: true })
  const line = {
    type: role,
    timestamp: new Date(tick()).toISOString(),
    message: role === 'assistant' ? { model: 'claude-opus-5', content: text } : { content: text }
  }
  appendFileSync(join(dir, `${id}.jsonl`), JSON.stringify(line) + '\n')
}

/** Append to Floe's own log, where every other runtime is recorded. */
function runtimeSaid(id: string, item: Record<string, unknown>): void {
  const dir = join(process.env.FLOE_TEST_USERDATA!, 'runtime-transcripts')
  mkdirSync(dir, { recursive: true })
  // Same name runtimeLog.fileFor mints — a query key holds a `~`, which it
  // sanitises away, and writing the raw name would leave the log unreadable.
  const file = `${id.replace(/[^\w.-]/g, '_')}.jsonl`
  appendFileSync(join(dir, file), JSON.stringify({ at: tick(), ...item }) + '\n')
}

test('a session that has only ever been Claude hands Claude nothing', () => {
  fresh()
  claudeSaid('solo', 'user', 'add the parser')
  claudeSaid('solo', 'assistant', 'added it')
  // Its own JSONL is its memory, and `claude --resume` already re-reads it.
  assert.equal(seedFor(null, 'solo', WORKTREE, 'claude'), '')
})

test('switching harness hands the newcomer everything it missed', () => {
  fresh()
  claudeSaid('mixed', 'user', 'add the parser')
  claudeSaid('mixed', 'assistant', 'added it in src/parse.ts')
  const packet = seedFor(null, 'mixed', WORKTREE, 'codex')
  assert.ok(packet.startsWith(PACKET_OPEN))
  assert.ok(packet.includes('add the parser'))
  assert.ok(packet.includes('src/parse.ts'))
})

test('a harness that remembers is handed nothing twice', () => {
  fresh()
  claudeSaid('twice', 'user', 'add the parser')
  claudeSaid('twice', 'assistant', 'added it')
  assert.notEqual(seedFor(null, 'twice', WORKTREE, 'codex'), '')
  // Same process, same thread: codex is holding the conversation now.
  assert.equal(seedFor(null, 'twice', WORKTREE, 'codex'), '')
})

// Caught driving the real app: two codex turns in a row, and the second was
// handed the first one back. The watermark is stamped when a turn starts, so
// that turn's own prompt and answer land after it — and codex was given the
// prompt directly and wrote the answer itself.
test('a harness is not handed back the turn it just ran', () => {
  fresh()
  claudeSaid('own', 'user', 'the opening request')
  claudeSaid('own', 'assistant', 'claude answered')
  assert.notEqual(seedFor(null, 'own', WORKTREE, 'codex'), '')
  runtimeSaid('own', { role: 'user', text: 'a question for codex' })
  runtimeSaid('own', { role: 'assistant', text: 'codex answered', provider: 'codex' })
  assert.equal(seedFor(null, 'own', WORKTREE, 'codex'), '')
  // Claude was away for it, so the same two entries ARE its gap.
  const packet = seedFor(null, 'own', WORKTREE, 'claude')
  assert.ok(packet.includes('a question for codex'))
  assert.ok(packet.includes('codex answered'))
})

test('gemini is handed the conversation every turn, because it keeps none', () => {
  fresh()
  runtimeSaid('gem', { role: 'user', text: 'first question' })
  runtimeSaid('gem', { role: 'assistant', text: 'first answer', provider: 'gemini' })
  assert.notEqual(seedFor(null, 'gem', WORKTREE, 'gemini'), '')
  const second = seedFor(null, 'gem', WORKTREE, 'gemini')
  assert.ok(second.includes('first answer'))
})

test('a closed session leaves no watermark behind for the next one on that key', () => {
  fresh()
  claudeSaid('reused', 'user', 'something')
  claudeSaid('reused', 'assistant', 'done')
  assert.notEqual(seedFor(null, 'reused', WORKTREE, 'codex'), '')
  forgetSeen('reused')
  // Closing dropped codex's thread, so it is a stranger again — and told so.
  assert.notEqual(seedFor(null, 'reused', WORKTREE, 'codex'), '')
})

test('Claude is handed back what another harness did while it was away', () => {
  fresh()
  claudeSaid('back', 'user', 'start it')
  claudeSaid('back', 'assistant', 'started')
  runtimeSaid('back', { role: 'user', text: 'now switch to codex' })
  runtimeSaid('back', { role: 'assistant', text: 'codex finished the migration', provider: 'codex' })
  const packet = seedFor(null, 'back', WORKTREE, 'claude')
  assert.ok(packet.includes('codex finished the migration'))
  // Claude already has its own half on disk; re-reading it to itself is waste.
  assert.ok(!packet.includes('started'))
})

test('a packet is never read back as conversation, or shipped inside the next one', () => {
  fresh()
  claudeSaid('loop', 'user', 'the original request')
  claudeSaid('loop', 'assistant', 'the original answer')
  const first = seedFor(null, 'loop', WORKTREE, 'codex')
  // Claude writes whatever we send into its JSONL — including a packet.
  claudeSaid('loop', 'user', first + 'carry on')
  claudeSaid('loop', 'assistant', 'carried on')
  const items = sessionTranscript(WORKTREE, 'loop')
  assert.ok(!items.some((i) => (i.text ?? '').includes(PACKET_OPEN)))
  assert.ok(items.some((i) => i.text === 'carry on'))
  const second = seedFor(null, 'loop', WORKTREE, 'gemini')
  assert.equal(second.split(PACKET_OPEN).length - 1, 1)
})

test('the handoff is recorded in the transcript, but only when it is a handoff', () => {
  fresh()
  claudeSaid('chip', 'user', 'do it')
  claudeSaid('chip', 'assistant', 'done')
  seedFor(null, 'chip', WORKTREE, 'codex')
  const chips = sessionTranscript(WORKTREE, 'chip').filter((i) => i.name === 'handoff')
  assert.equal(chips.length, 1)
  assert.ok(chips[0].summary?.startsWith('claude → codex'))
  // A refresh is not a handoff: gemini re-reading its own history is routine.
  fresh()
  runtimeSaid('quiet', { role: 'user', text: 'hello' })
  runtimeSaid('quiet', { role: 'assistant', text: 'hi', provider: 'gemini' })
  seedFor(null, 'quiet', WORKTREE, 'gemini')
  seedFor(null, 'quiet', WORKTREE, 'gemini')
  assert.equal(sessionTranscript(WORKTREE, 'quiet').filter((i) => i.name === 'handoff').length, 0)
})

test('an empty session hands nothing to anybody', () => {
  fresh()
  const dir = join(process.env.FLOE_TEST_USERDATA!, 'runtime-transcripts')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'blank.jsonl'), '')
  assert.equal(seedFor(null, 'blank', WORKTREE, 'codex'), '')
  assert.equal(seedFor(null, 'blank', WORKTREE, 'claude'), '')
})

/** Link a Floe session to a Claude id, the way the store does after a turn. */
function linked(id: string, claudeId: string): void {
  writeFileSync(
    join(process.env.FLOE_TEST_USERDATA!, 'sessions.json'),
    JSON.stringify({
      meta: {},
      created: [{ id, claudeId, worktreePath: WORKTREE, title: id, createdAt: 0 }],
      view: {},
      prefs: {},
      reviewCheckpoints: {},
      threadComments: {}
    })
  )
}

test('a chat both harnesses have spoken in reads whole, under either of its names', () => {
  fresh()
  linked('floe-id', 'claude-id')
  // Written under the key each turn actually ran under: Floe's own id for the
  // codex turn, the CLI's for the one after it. Asked for by either name, the
  // conversation has to come back whole — reading one file alone is how codex
  // dropped out of a chat it had just answered in.
  runtimeSaid('floe-id', { role: 'user', text: '@codex olha isso' })
  runtimeSaid('floe-id', { role: 'assistant', text: 'olhei', provider: 'codex' })
  claudeSaid('claude-id', 'assistant', 'concordo com o codex')
  for (const name of ['floe-id', 'claude-id']) {
    const said = sessionTranscript(WORKTREE, name).map((i) => i.text)
    assert.deepEqual(said, ['@codex olha isso', 'olhei', 'concordo com o codex'])
  }
})

test('a relay envelope is plumbing, and never reads back as something you typed', () => {
  fresh()
  linked('relay-id', 'relay-claude')
  runtimeSaid('relay-id', { role: 'user', text: '@codex e ai?' })
  runtimeSaid('relay-id', { role: 'assistant', text: 'e ai', provider: 'codex' })
  claudeSaid('relay-claude', 'user', relayPrompt('codex', 0))
  claudeSaid('relay-claude', 'assistant', 'meu parecer')
  assert.deepEqual(
    sessionTranscript(WORKTREE, 'relay-id').map((i) => i.text),
    ['@codex e ai?', 'e ai', 'meu parecer']
  )
})

// --- packetFrom: one conversation packaged for another to read --------------
//
// What peek and merge send. The watermark it keeps is its own — `watermark()`
// above reads Claude's off ITS transcript, and Claude never speaks inside a
// codex query, so it would read 0 forever and a merge after a peek would
// re-ship every line.

test('a peek sends what the chat has not read, and a merge sends the rest', () => {
  fresh()
  forgetRead('sess~codex')
  runtimeSaid('sess~codex', { role: 'user', text: 'analisa o schema' })
  runtimeSaid('sess~codex', { role: 'assistant', provider: 'codex', text: 'sessions.json e um array plano' })

  const peek = packetFrom(WORKTREE, 'sess~codex', 'sess', { since: 'watermark', to: 'claude' })
  assert.equal(peek?.entries, 2)
  assert.match(peek!.packet, /array plano/)

  // Nothing new since: the caller is told so rather than starting a turn whose
  // whole content is an empty block.
  assert.equal(packetFrom(WORKTREE, 'sess~codex', 'sess', { since: 'watermark', to: 'claude' }), null)

  // The query went on talking. A merge now carries the REST, not the lot.
  runtimeSaid('sess~codex', { role: 'user', text: 'e o hook de reload?' })
  runtimeSaid('sess~codex', { role: 'assistant', provider: 'codex', text: 'o reload rele sessions.json' })
  const merge = packetFrom(WORKTREE, 'sess~codex', 'sess', { since: 'watermark', to: 'claude' })
  assert.equal(merge?.entries, 2)
  assert.match(merge!.packet, /rele sessions.json/)
  assert.doesNotMatch(merge!.packet, /array plano/)
})

test('since:all ignores what has already been read', () => {
  fresh()
  forgetRead('sess2~codex')
  runtimeSaid('sess2~codex', { role: 'assistant', provider: 'codex', text: 'primeira' })
  packetFrom(WORKTREE, 'sess2~codex', 'sess2', { since: 'watermark', to: 'claude' })
  const all = packetFrom(WORKTREE, 'sess2~codex', 'sess2', { since: 'all', to: 'claude' })
  assert.equal(all?.entries, 1)
  assert.match(all!.packet, /primeira/)
})

test('the query chip is bookkeeping, and never travels inside a packet', () => {
  fresh()
  forgetRead('sess3~codex')
  runtimeSaid('sess3~codex', { role: 'tool', name: 'query', summary: 'codex query open' })
  runtimeSaid('sess3~codex', { role: 'assistant', provider: 'codex', text: 'a resposta' })
  const out = packetFrom(WORKTREE, 'sess3~codex', 'sess3', { since: 'watermark', to: 'claude' })
  assert.equal(out?.entries, 1)
  assert.doesNotMatch(out!.packet, /query open/)
})

test('a closed query leaves no read mark behind for the next one on that key', () => {
  fresh()
  forgetRead('sess4~codex')
  runtimeSaid('sess4~codex', { role: 'assistant', provider: 'codex', text: 'primeira' })
  packetFrom(WORKTREE, 'sess4~codex', 'sess4', { since: 'watermark', to: 'claude' })
  // Discard, then ask the same harness again: the reopened query starts unread.
  forgetRead('sess4~codex')
  const again = packetFrom(WORKTREE, 'sess4~codex', 'sess4', { since: 'watermark', to: 'claude' })
  assert.equal(again?.entries, 1)
})
