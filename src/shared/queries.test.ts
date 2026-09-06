import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isQueryKey, parentKeyOf, parseQueryKey, queryKey } from './queries.ts'

test('a query key is its two halves, and reads back as them', () => {
  const key = queryKey('6f1c2f4a-1b0e-4a3a-9d0f-0a1b2c3d4e5f', 'codex')
  assert.equal(key, '6f1c2f4a-1b0e-4a3a-9d0f-0a1b2c3d4e5f~codex')
  assert.deepEqual(parseQueryKey(key), {
    sessionId: '6f1c2f4a-1b0e-4a3a-9d0f-0a1b2c3d4e5f',
    harness: 'codex'
  })
})

test('a resumed session id keeps its own colon', () => {
  const key = queryKey('claude:abc-123', 'gemini')
  assert.deepEqual(parseQueryKey(key), { sessionId: 'claude:abc-123', harness: 'gemini' })
})

test('a plain session id is not a query', () => {
  for (const id of ['sess-1', 'claude:abc', '', '~', '~codex', 'sess~', 'sess~Codex', 'sess~-x'])
    assert.equal(isQueryKey(id), false, id)
})

test('the parent of a query is the session, and of a session is itself', () => {
  assert.equal(parentKeyOf('sess-1~codex'), 'sess-1')
  assert.equal(parentKeyOf('sess-1'), 'sess-1')
})
