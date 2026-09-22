import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chatItems, chatKey, finderChats, mergeChats, type ChatRow } from './finderChats.ts'
import type { WorktreeRow } from './useWorktrees.ts'
import type { JumpSession } from '../../shared/types.ts'

const session = (id: string, at: number, over: Partial<JumpSession> = {}): JumpSession => ({
  projectPath: '/p/one',
  projectName: 'one',
  worktreePath: '/p/one',
  branch: 'main',
  sessionId: id,
  title: id,
  lastActivityAt: at,
  running: false,
  ...over
})

const row = (path: string, branch: string, sessions: WorktreeRow['sessions']): WorktreeRow => ({
  worktree: { path, branch } as WorktreeRow['worktree'],
  sessions
})

test('a machine answering replaces only its own rows', () => {
  const prev: ChatRow[] = [
    { ...session('a', 1), backend: 'local' },
    { ...session('x', 2), backend: 'link' }
  ]
  const next = mergeChats(prev, [session('b', 3)], 'local')
  assert.deepEqual(
    next.map((s) => `${s.backend}:${s.sessionId}`),
    ['link:x', 'local:b']
  )
})

test('the union spans projects, newest first', () => {
  const union: ChatRow[] = [
    { ...session('old', 10, { projectName: 'two', projectPath: '/p/two' }), backend: 'local' },
    { ...session('new', 30, { projectName: 'three', projectPath: '/p/three' }), backend: 'link' }
  ]
  const chats = finderChats(union, [], undefined)
  assert.deepEqual(
    chats.map((c) => c.sessionId),
    ['new', 'old']
  )
  assert.equal(chats[0].backend, 'link')
  assert.equal(chats[0].projectName, 'three')
})

test('the open project adds the facts the index leaves out, and the session it has not seen', () => {
  const union: ChatRow[] = [{ ...session('a', 10), backend: 'local' }]
  const chats = finderChats(
    union,
    [
      row('/p/one', 'develop', [
        { id: 'a', claudeId: 'ca', title: 'A', mtime: 20, active: false, model: 'opus', permissionMode: 'skip' },
        { id: 'fresh', title: 'just made', mtime: 25, active: false }
      ] as WorktreeRow['sessions'])
    ],
    { backend: 'local', projectPath: '/p/one', projectName: 'one' }
  )
  // One row for the session both sources hold — not two.
  assert.deepEqual(
    chats.map((c) => c.sessionId),
    ['fresh', 'a']
  )
  const a = chats.find((c) => c.sessionId === 'a')!
  assert.equal(a.id, 'ca')
  assert.equal(a.model, 'opus')
  assert.equal(a.mode, 'skip')
  assert.equal(a.branch, 'develop')
  assert.equal(a.mtime, 20)
})

test('a session on another machine keeps its own identity', () => {
  const union: ChatRow[] = [
    { ...session('same', 10), backend: 'local' },
    { ...session('same', 20, { projectName: 'two' }), backend: 'link' }
  ]
  assert.equal(finderChats(union, [], undefined).length, 2)
})

test('a row says which project and which machine', () => {
  const union: ChatRow[] = [
    { ...session('a', 10, { projectName: 'one', branch: 'develop' }), backend: 'local' },
    { ...session('b', 20, { projectName: 'two' }), backend: 'link' }
  ]
  const { items, map } = chatItems(finderChats(union, [], undefined), () => '3d', (id) => id.toUpperCase())
  assert.equal(items[0].detail, 'two · main · 3d')
  assert.equal(items[0].badge, 'LINK')
  // This machine's rows stay plain.
  assert.equal(items[1].badge, undefined)
  assert.equal(items[1].detail, 'one · develop · 3d')
  assert.equal(map.get(chatKey('local', 'a'))?.title, 'a')
})
