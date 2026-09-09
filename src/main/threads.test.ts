import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installHook } from './config/hook.test-helper.ts'

// The point of this module is that a thread id OUTLIVES the process, so the
// test asserts on the file as well as on the getter: a value that only ever
// lived in a Map would pass a read-back check and still lose the conversation
// on quit.
installHook()

const dataDir = mkdtempSync(join(tmpdir(), 'floe-threads-'))
process.env.FLOE_TEST_USERDATA = dataDir
const { setSharedDataDir } = await import('./dataDir.ts')
setSharedDataDir(dataDir)

const { addCreatedSession, linkCreatedSession } = await import('./sessionStore.ts')
const { threadFor, rememberThread, forgetThreads } = await import('./threads.ts')

const stored = (): Record<string, unknown> =>
  JSON.parse(readFileSync(join(dataDir, 'sessions.json'), 'utf8')) as Record<string, unknown>

test('a session thread is written to disk, not just remembered', () => {
  addCreatedSession({ id: 'floe-1', worktreePath: '/w' })
  rememberThread('floe-1', 'codex', 'th-1')
  assert.equal(threadFor('floe-1', 'codex'), 'th-1')

  const created = stored().created as { id: string; threads?: Record<string, string> }[]
  assert.deepEqual(created.find((c) => c.id === 'floe-1')?.threads, { codex: 'th-1' })
})

test('the same conversation under any of its names is one thread', () => {
  // A panel keys itself by the claudeId the CLI minted, and `claude --resume`
  // forks that id on every respawn. A thread stored under one name has to be
  // found under the others, or codex starts over every time Claude re-spawns.
  linkCreatedSession('floe-1', 'cl-aaa')
  assert.equal(threadFor('cl-aaa', 'codex'), 'th-1')
  rememberThread('cl-aaa', 'opencode', 'oc-1')
  assert.equal(threadFor('floe-1', 'opencode'), 'oc-1')

  linkCreatedSession('floe-1', 'cl-bbb') // respawn: the old id becomes a past id
  assert.equal(threadFor('cl-aaa', 'codex'), 'th-1', 'a past name still resolves')
  assert.equal(threadFor('cl-bbb', 'codex'), 'th-1')
})

test('a key that names no session keeps its thread in memory', () => {
  // Query keys, mostly: they are closed by the same restart that would have
  // needed the file, so there is nothing to persist.
  rememberThread('query:floe-1:codex', 'codex', 'th-q')
  assert.equal(threadFor('query:floe-1:codex', 'codex'), 'th-q')
  assert.equal(stored().created instanceof Array, true)
  assert.ok(!readFileSync(join(dataDir, 'sessions.json'), 'utf8').includes('th-q'))
})

test('forgetting takes one harness, or all of them', () => {
  forgetThreads('floe-1', 'codex')
  assert.equal(threadFor('floe-1', 'codex'), undefined)
  assert.equal(threadFor('floe-1', 'opencode'), 'oc-1', 'the others are untouched')

  forgetThreads('floe-1')
  assert.equal(threadFor('floe-1', 'opencode'), undefined)

  forgetThreads('query:floe-1:codex')
  assert.equal(threadFor('query:floe-1:codex', 'codex'), undefined)
})

test('an empty id is not a thread', () => {
  rememberThread('floe-1', 'gemini', '')
  assert.equal(threadFor('floe-1', 'gemini'), undefined)
})
