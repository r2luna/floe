import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  isUnread,
  markRead,
  markUnread,
  readOpen,
  resetUnread,
  subscribeUnread,
  unreadMarks
} from './unreadStore.ts'

// The store writes to localStorage, which a `node --test` process has none of.
// A Map is the whole contract it uses. Safe after the import because the store
// reads lazily, on the first call — which is also what keeps the registry
// importable by a plain test.
const store = new Map<string, string>()
;(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k)
}

test('a mark is set and taken off again under every name a session answers to', () => {
  resetUnread()
  markUnread(['floe-id', 'claude-id'])
  assert.equal(isUnread(['claude-id']), true)
  markRead(['floe-id', 'claude-id'])
  assert.equal(isUnread(['floe-id']), false)
})

test('a mark set under one name is found under the other', () => {
  // The bug this exists for: the events carry whichever id the conn spawned
  // with, so a mark looked for under the panel's id would never appear.
  resetUnread()
  markUnread(['claude-id'])
  assert.equal(isUnread(['floe-id', 'claude-id']), true)
})

test('opening a chat reads it', () => {
  resetUnread()
  markUnread(['other'])
  readOpen(['other'])
  assert.equal(isUnread(['other']), false)
})

test('a mark you put on the chat you are IN survives the panel it is in', () => {
  // "Read it later" on the open chat, and the list re-renders (or remounts)
  // with that chat still open: the clear-on-open pass must not wipe the mark
  // that was the whole point of pressing the key.
  resetUnread()
  markUnread(['open'], { open: true })
  readOpen(['open'])
  readOpen(['open'])
  assert.equal(isUnread(['open']), true)
})

test('leaving and coming back reads the held mark', () => {
  resetUnread()
  markUnread(['open'], { open: true })
  readOpen(['elsewhere'])
  readOpen(['open'])
  assert.equal(isUnread(['open']), false)
})

test('the hold is dropped under the session other name too', () => {
  resetUnread()
  markUnread(['floe-id', 'claude-id'], { open: true })
  readOpen(['claude-id'])
  assert.equal(isUnread(['floe-id']), true, 'same chat — held')
  readOpen(['elsewhere'])
  readOpen(['floe-id', 'claude-id'])
  assert.equal(isUnread(['claude-id']), false)
})

test('a mark on a chat you are not in is read the moment you open it', () => {
  // No hold: only the open chat gets one, or every mark would need a visit to
  // somewhere else before it could be read.
  resetUnread()
  markUnread(['other'])
  readOpen(['other'])
  assert.equal(isUnread(['other']), false)
})

test('taking a mark off by hand drops its hold', () => {
  resetUnread()
  markUnread(['open'], { open: true })
  markRead(['open'])
  markUnread(['open'])
  readOpen(['open'])
  assert.equal(isUnread(['open']), false)
})

test('the set is returned by identity while it does not change, so the list does not re-render', () => {
  resetUnread()
  markUnread(['a'])
  const before = unreadMarks()
  markUnread(['a'])
  assert.equal(unreadMarks(), before)
  markRead(['b'])
  assert.equal(unreadMarks(), before)
})

test('subscribers hear every change, and stop when they unsubscribe', () => {
  resetUnread()
  let beats = 0
  const off = subscribeUnread(() => beats++)
  markUnread(['a'])
  markRead(['a'])
  off()
  markUnread(['b'])
  assert.equal(beats, 2)
})

test('marks outlive the window', () => {
  resetUnread()
  markUnread(['persisted'])
  assert.deepEqual(JSON.parse(store.get('floe.unread') ?? '[]'), ['persisted'])
})
