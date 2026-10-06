import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  arrange,
  clear,
  expire,
  IDLE_MS,
  idsFor,
  join,
  keysOf,
  leave,
  prune,
  seed,
  toggleFavorite,
  type ActiveGroup,
  type ActiveState
} from './activeStore.ts'
import type { ActiveSession } from '../../shared/types'

const NOW = 10 * IDLE_MS
const EMPTY: ActiveState = { members: {}, favorites: [], seeded: [] }

const row = (id: string, over: Partial<ActiveSession> = {}): ActiveSession => ({
  projectPath: '/p/floe',
  projectName: 'floe',
  worktreePath: '/p/floe',
  branch: 'main',
  sessionId: id,
  title: id,
  lastActivityAt: NOW,
  createdAt: 0,
  running: false,
  needsYou: false,
  backend: 'local',
  ...over
})

const ids = (rows: ActiveSession[]): string[] => rows.map((s) => s.sessionId)
/** Every chat in a group, worktree by worktree. */
const all = (g: ActiveGroup): ActiveSession[] => g.worktrees.flatMap((w) => w.rows)
const members = (...keys: string[]): ActiveState =>
  keys.reduce((st, k) => join(st, k, NOW), EMPTY)

test('projects sort A→Z and chats inside by creation, never by activity or status', () => {
  const rows = [
    row('late', { createdAt: 2, lastActivityAt: NOW - 1 }),
    row('os1', { projectPath: '/p/os', projectName: 'os', worktreePath: '/p/os', createdAt: 1 }),
    row('early', { createdAt: 1, running: true, needsYou: true }),
    row('a1', { projectPath: '/p/a', projectName: '00.life', worktreePath: '/p/a', createdAt: 5 })
  ]
  const { favorites, groups } = arrange(rows, members('local:late', 'local:os1', 'local:early', 'local:a1'))
  assert.deepEqual(favorites, [])
  assert.deepEqual(
    groups.map((g) => [g.project, ids(all(g))]),
    [
      ['00.life', ['a1']],
      ['floe', ['early', 'late']],
      ['os', ['os1']]
    ]
  )
})

test('only members show, plus anything waiting on you', () => {
  const rows = [row('in', { createdAt: 1 }), row('out', { createdAt: 2 }), row('asking', { needsYou: true, createdAt: 3 })]
  const { groups } = arrange(rows, members('local:in'))
  assert.deepEqual(ids(all(groups[0])), ['in', 'asking'])
})

test('a member matches under either of its ids', () => {
  const rows = [row('floe-id', { claudeId: 'cli-id' })]
  assert.equal(arrange(rows, members('local:cli-id')).groups.length, 1)
})

test('the same session id on two machines is two rows in two groups', () => {
  const rows = [row('s'), row('s', { backend: 'link' })]
  const { groups } = arrange(rows, members('local:s', 'link:s'))
  assert.deepEqual(
    groups.map((g) => g.backend),
    ['link', 'local']
  )
})

test('a chat listed under two projects shows once, under the one whose folder holds it', () => {
  const wt = { worktreePath: '/p/floe/.worktrees/jev', branch: 'jev' }
  const rows = [
    row('s', { ...wt, projectPath: '/p/floe/.worktrees/native', projectName: 'native' }),
    row('s', wt)
  ]
  const { groups } = arrange(rows, members('local:s'))
  assert.deepEqual(
    groups.map((g) => [g.project, ids(all(g))]),
    [['floe', ['s']]]
  )
})

test('every worktree gets its own head: main first, then the others A→Z by branch', () => {
  const jev = { worktreePath: '/p/floe/.worktrees/jev', branch: 'jev' }
  const abc = { worktreePath: '/p/floe/.worktrees/abc', branch: 'abc' }
  const rows = [row('j', jev), row('m', { createdAt: 2 }), row('a', abc), row('m0', { createdAt: 1 })]
  const [g] = arrange(rows, members('local:j', 'local:m', 'local:a', 'local:m0')).groups
  assert.deepEqual(
    g.worktrees.map((w) => [w.branch, w.main, ids(w.rows)]),
    [
      ['main', true, ['m0', 'm']],
      ['abc', false, ['a']],
      ['jev', false, ['j']]
    ]
  )
})

test('a lone worktree still gets its head', () => {
  const [g] = arrange([row('a')], members('local:a')).groups
  assert.deepEqual(
    g.worktrees.map((w) => w.branch),
    ['main']
  )
})

test('favourites sit on top in the same tree and leave the lower one', () => {
  let st = members('local:a', 'local:b', 'local:c', 'local:o')
  st = toggleFavorite(st, ['local:c'], NOW)
  st = toggleFavorite(st, ['local:o'], NOW)
  const os = { projectPath: '/p/os', projectName: 'os', worktreePath: '/p/os' }
  const { favorites, groups } = arrange([row('a'), row('b'), row('c'), row('o', os)], st)
  assert.deepEqual(
    favorites.map((g) => [g.project, ids(all(g))]),
    [
      ['floe', ['c']],
      ['os', ['o']]
    ]
  )
  assert.deepEqual(
    groups.map((g) => [g.project, ids(all(g))]),
    [['floe', ['a', 'b']]]
  )
})

test('unstarring puts the row back in its group; starring a non-member makes it one', () => {
  let st = toggleFavorite(EMPTY, ['local:a'], NOW)
  assert.ok('local:a' in st.members)
  st = toggleFavorite(st, ['local:a', 'local:cli'], NOW)
  assert.deepEqual(st.favorites, [])
  assert.deepEqual(ids(all(arrange([row('a')], st).groups[0])), ['a'])
})

test('remove takes a chat off the list and off the favourites, under every name', () => {
  let st = toggleFavorite(members('local:a', 'local:cli'), ['local:a'], NOW)
  st = leave(st, ['local:a', 'local:cli'])
  assert.deepEqual(st, { ...EMPTY, members: {}, favorites: [] })
})

test('clear empties the list but keeps the favourites; a later send joins again', () => {
  let st = toggleFavorite(members('local:a', 'local:b', 'local:c'), ['local:b'], NOW)
  st = clear(st)
  assert.deepEqual(st.members, { 'local:b': NOW })
  assert.deepEqual(st.favorites, ['local:b'])
  const rows = [row('a'), row('b'), row('c'), row('d', { needsYou: true })]
  const layout = arrange(rows, join(st, 'local:c', NOW))
  assert.deepEqual(ids(all(layout.favorites[0])), ['b'])
  assert.deepEqual(ids(all(layout.groups[0])), ['c', 'd'])
})

test('24h idle drops a member, but not a favourite, a running chat or a fresh one', () => {
  const old = NOW - IDLE_MS - 1
  let st: ActiveState = {
    ...EMPTY,
    members: { 'local:idle': old, 'local:fav': old, 'local:busy': old, 'local:touched': old, 'link:idle': old }
  }
  st = toggleFavorite(st, ['local:fav'], old)
  st = { ...st, members: { ...st.members, 'local:fav': old } }
  const rows = [
    row('idle', { lastActivityAt: old }),
    row('busy', { lastActivityAt: old, running: true }),
    row('touched', { lastActivityAt: NOW - 1000 })
  ]
  const next = expire(st, 'local', rows, NOW)
  assert.deepEqual(Object.keys(next.members).sort(), ['link:idle', 'local:busy', 'local:fav', 'local:touched'])
  // Nothing to drop is the same object, so the store writes nothing.
  assert.equal(expire(next, 'local', rows, NOW), next)
})

test('the first answer from a machine seeds the list with the last day, once', () => {
  const rows = [row('fresh'), row('stale', { lastActivityAt: NOW - IDLE_MS - 1 })]
  const st = seed(EMPTY, 'local', rows, NOW)
  assert.deepEqual(Object.keys(st.members), ['local:fresh'])
  assert.deepEqual(st.seeded, ['local'])
  assert.equal(seed(leave(st, ['local:fresh']), 'local', rows, NOW).members['local:fresh'], undefined)
})

test('a chat asked for by id that did not come back was closed and leaves', () => {
  let st = toggleFavorite(members('local:a', 'local:b', 'link:c'), ['local:b'], NOW)
  assert.deepEqual(idsFor(st, 'local').sort(), ['a', 'b'])
  st = prune(st, 'local', ['a', 'b'], [row('a')])
  assert.deepEqual(Object.keys(st.members).sort(), ['link:c', 'local:a'])
  assert.deepEqual(st.favorites, [])
})

test('a key that joined after the question was asked is not pruned by its answer', () => {
  const st = members('local:a', 'local:new')
  assert.equal(prune(st, 'local', ['a'], [row('a')]), st)
})

test('keysOf names the machine, Floe id first', () => {
  assert.deepEqual(keysOf(row('x', { claudeId: 'y', backend: 'link' })), ['link:x', 'link:y'])
  assert.deepEqual(keysOf(row('x', { backend: undefined })), ['local:x'])
})
