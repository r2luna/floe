import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Same loader hook as handoff.test.ts: extensionless relative imports + an
// `electron` stub whose userData follows an env var, for the runtime log.
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
    const src = "export const app = { getPath: () => process.env.FLOE_TEST_USERDATA || '/tmp' }; export default {};"
    return { format: 'module', shortCircuit: true, source: src }
  }
  return next(url, context)
}
`
register('data:text/javascript,' + encodeURIComponent(hookSource), import.meta.url)

const { setSharedDataDir } = await import('./dataDir.ts')
const { listHarnessSessions, resumeHarnessSession } = await import('./harnessHistory.ts')
const { rolloutMeta, rolloutMessage, loadCodexRollout } = await import('./codexSessions.ts')
const { getCreatedSession } = await import('./sessionStore.ts')
const { readRuntimeTranscript } = await import('./runtimeLog.ts')
const { wrapPremise } = await import('../shared/premise.ts')

const WT = '/tmp/wt-resume'

/** A fresh HOME, userData and codex root, so no test sees another's sessions. */
function fresh(): { codex: string; home: string } {
  const home = mkdtempSync(join(tmpdir(), 'floe-resume-'))
  process.env.HOME = home
  process.env.FLOE_TEST_USERDATA = home
  setSharedDataDir(join(home, 'data'))
  return { codex: join(home, 'codex-sessions'), home }
}

const meta = (id: string, cwd: string, extra = ''): string =>
  `{"timestamp":"2026-09-20T10:00:00.000Z","type":"session_meta","payload":{"session_id":"${id}","id":"${id}","cwd":${JSON.stringify(cwd)},"originator":"codex-tui"${extra},"base_instructions":{"text":"long"}}}`

const said = (type: 'UserMessage' | 'AgentMessage', text: string, at: string): string =>
  JSON.stringify({
    timestamp: at,
    type: 'event_msg',
    payload: {
      type: 'item_completed',
      item: { type, content: [{ type: type === 'UserMessage' ? 'text' : 'Text', text }] }
    }
  })

function rollout(root: string, id: string, lines: string[]): string {
  const dir = join(root, '2026', '09', '20')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `rollout-2026-09-20T10-00-00-${id}.jsonl`)
  writeFileSync(file, lines.join('\n') + '\n')
  return file
}

function claudeSession(id: string, text: string): void {
  const dir = join(process.env.HOME!, '.claude', 'projects', WT.replace(/[^a-zA-Z0-9]/g, '-'))
  mkdirSync(dir, { recursive: true })
  const line = { type: 'user', timestamp: '2026-09-20T09:00:00.000Z', message: { content: text } }
  writeFileSync(join(dir, `${id}.jsonl`), JSON.stringify(line) + '\n')
}

test('rolloutMeta reads the thread, cwd and origin off an unparseable head', () => {
  const head = meta('t-1', '/a "quoted" path', ',"source":{"subagent":{}}').slice(0, 100)
  assert.deepEqual(rolloutMeta(head + '\n'), null, 'a head cut before cwd names nothing')
  const full = rolloutMeta(meta('t-1', '/a "quoted" path', ',"source":{"subagent":{}}') + '\n{}')
  assert.deepEqual(full, { threadId: 't-1', cwd: '/a "quoted" path', subagent: true, originator: 'codex-tui' })
  assert.equal(rolloutMeta('{"type":"turn_context"}'), null)
})

test('rolloutMessage keeps what was said and drops Floe framing', () => {
  const user = rolloutMessage(
    said('UserMessage', '<!-- floe:house-rules:v1 -->\nrules\n<!-- /floe:house-rules:v1 -->\nfix the bug', '2026-09-20T10:00:01.000Z')
  )
  assert.deepEqual(user, { role: 'user', text: 'fix the bug', at: Date.parse('2026-09-20T10:00:01.000Z') })
  const premised = rolloutMessage(said('UserMessage', wrapPremise('the brief') + '\n\nship it', '2026-09-20T10:00:01.000Z'))
  assert.equal(premised?.text, 'ship it')
  const reply = rolloutMessage(said('AgentMessage', 'done', '2026-09-20T10:00:02.000Z'))
  assert.equal(reply?.provider, 'codex')
  assert.equal(rolloutMessage(said('UserMessage', '<!-- floe:house-rules:v1 -->x<!-- /floe:house-rules:v1 -->', 'x')), null)
  assert.equal(rolloutMessage('{"type":"event_msg","payload":{"type":"item_completed","item":{"type":"Reasoning"}}}'), null)
  assert.equal(rolloutMessage('not json "item_completed"'), null)
})

test('listHarnessSessions merges both harnesses for the worktree, newest first', () => {
  const { codex } = fresh()
  claudeSession('c-1', 'claude question')
  rollout(codex, 't-mine', [meta('t-mine', WT), said('UserMessage', 'codex question', '2026-09-20T10:00:01.000Z')])
  rollout(codex, 't-other', [meta('t-other', '/elsewhere'), said('UserMessage', 'not here', '2026-09-20T10:00:01.000Z')])
  rollout(codex, 't-sub', [meta('t-sub', WT, ',"source":{"subagent":{}}'), said('UserMessage', 'sub', '2026-09-20T10:00:01.000Z')])
  rollout(codex, 't-empty', [meta('t-empty', WT)])
  const list = listHarnessSessions(WT, codex)
  assert.deepEqual(
    list.map((s) => [s.harness, s.id, s.title]).sort(),
    [
      ['claude', 'c-1', 'claude question'],
      ['codex', 't-mine', 'codex question']
    ]
  )
})

test('resuming a codex thread records it, copies its history once, and dedupes', () => {
  const { codex } = fresh()
  const file = rollout(codex, 't-1', [
    meta('t-1', WT),
    said('UserMessage', 'hello', '2026-09-20T10:00:01.000Z'),
    said('AgentMessage', 'hi there', '2026-09-20T10:00:02.000Z')
  ])
  const first = resumeHarnessSession(WT, 'codex', 't-1', codex)
  assert.equal(first.sessionId, 'codex:t-1')
  const stored = getCreatedSession(first.sessionId)
  assert.equal(stored?.provider, 'codex')
  assert.deepEqual(stored?.threads, { codex: 't-1' })
  assert.deepEqual(
    readRuntimeTranscript(first.sessionId).map((i) => [i.role, i.text]),
    loadCodexRollout(file).map((i) => [i.role, i.text])
  )
  const again = resumeHarnessSession(WT, 'codex', 't-1', codex)
  assert.equal(again.sessionId, first.sessionId)
  assert.equal(readRuntimeTranscript(first.sessionId).length, 2, 'history is copied once')
  assert.equal(listHarnessSessions(WT, codex).length, 0, 'an adopted thread leaves the list')
})

test('resuming a claude session adopts it by its id', () => {
  const { codex } = fresh()
  claudeSession('c-1', 'claude question')
  const { sessionId, title } = resumeHarnessSession(WT, 'claude', 'c-1', codex)
  assert.equal(sessionId, 'claude:c-1')
  assert.equal(title, 'claude question')
  assert.equal(resumeHarnessSession(WT, 'claude', 'c-1', codex).sessionId, sessionId)
})

test('resuming something that is not there says so', () => {
  const { codex } = fresh()
  assert.throws(() => resumeHarnessSession(WT, 'codex', 'nope', codex), /No codex thread/)
  assert.throws(() => resumeHarnessSession(WT, 'claude', 'nope', codex), /No Claude session/)
})
