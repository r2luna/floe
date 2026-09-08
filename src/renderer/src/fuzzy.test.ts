import assert from 'node:assert/strict'
import test from 'node:test'
import { capGroups, filterItems, splitTitle, subsequence, type PaletteItem } from './fuzzy.ts'

const item = (title: string, detail?: string): PaletteItem => ({ id: title, title, detail })

test('subsequence matches letters in order, not as a substring', () => {
  // f-l-o-e---r-u-s-t: the s is at 7 and the t at 8.
  assert.deepEqual(subsequence('floe-rust', 'fst'), [0, 7, 8])
  assert.equal(subsequence('floe-rust', 'xyz'), null)
  // Order matters: the letters are all there, but not in that sequence.
  assert.equal(subsequence('abc', 'cba'), null)
})

test('an empty query matches everything', () => {
  assert.deepEqual(subsequence('anything', ''), [])
  const all = filterItems([item('a'), item('b')], '')
  assert.equal(all.length, 2)
})

test('matching is case-insensitive both ways', () => {
  assert.deepEqual(subsequence('Floe', 'fe'), [0, 3])
  assert.deepEqual(subsequence('floe', 'FE'), [0, 3])
})

test('a tighter, earlier match ranks first', () => {
  const items = [item('very-long-name-with-r-and-k'), item('rkanban')]
  const out = filterItems(items, 'rk')
  assert.equal(out[0].item.title, 'rkanban', 'adjacent letters at the start win')
})

test('detail is for reading, not for matching', () => {
  // Every project shares a group name, so matching the detail made short
  // queries return the whole list — the filter stopped filtering.
  const items = [item('zebra', 'Projects'), item('floe', 'Projects')]
  assert.deepEqual(
    filterItems(items, 'oe').map((o) => o.item.title),
    ['floe'],
    'oe is a subsequence of "Projects" too, and must not count'
  )
})

test('items that match nothing are dropped', () => {
  const out = filterItems([item('alpha'), item('beta')], 'zzz')
  assert.equal(out.length, 0)
})

test('hits point at the characters to highlight', () => {
  const [first] = filterItems([item('floe')], 'foe')
  assert.deepEqual(first.hits, [0, 2, 3])
  assert.equal(
    first.hits.map((i) => 'floe'[i]).join(''),
    'foe',
    'the highlighted characters are the ones typed'
  )
})

test('equal scores keep the order they were given', () => {
  // Projects arrive in the user's own arrangement; ties must not reshuffle it.
  const out = filterItems([item('ab'), item('ac'), item('ad')], 'a')
  assert.deepEqual(
    out.map((o) => o.item.title),
    ['ab', 'ac', 'ad']
  )
})

test('a pinned item survives any query and sorts last', () => {
  const items = [item('floe'), { id: 'add', title: 'Add project…', pinned: true }]
  const found = filterItems(items, 'floe').map((o) => o.item.title)
  assert.deepEqual(found, ['floe', 'Add project…'], 'after the matches')

  // The case that matters: nothing matched, so the action is all that is left.
  const none = filterItems(items, 'zzzz').map((o) => o.item.title)
  assert.deepEqual(none, ['Add project…'], 'still offered when the search fails')
})

test('capGroups keeps at most n rows of each group', () => {
  const rows = [
    { id: 'a', title: 'a', group: 'sessions' },
    { id: 'b', title: 'b', group: 'sessions' },
    { id: 'c', title: 'c', group: 'sessions' },
    { id: 'd', title: 'd', group: 'files' },
    { id: 'e', title: 'e', group: 'files' }
  ].map((item) => ({ item, hits: [], score: 0 }))
  assert.deepEqual(
    capGroups(rows, 2).map((r) => r.item.id),
    ['a', 'b', 'd', 'e'],
    'the files survive the long list of sessions above them'
  )
})

test('capGroups caps each group at its own number', () => {
  const rows = [
    { id: 'a', title: 'a', group: 'chats' },
    { id: 'b', title: 'b', group: 'chats' },
    { id: 'c', title: 'c', group: 'chats' },
    { id: 'd', title: 'd', group: 'files' },
    { id: 'e', title: 'e', group: 'files' },
    { id: 'f', title: 'f', group: 'files' }
  ].map((item) => ({ item, hits: [], score: 0 }))
  assert.deepEqual(
    capGroups(rows, { chats: 2 }).map((r) => r.item.id),
    ['a', 'b', 'd', 'e', 'f'],
    '⌘P: the chats have a ceiling and the files, which the map does not name, have none'
  )
})

test('splitTitle keeps the highlight on both halves of a path', () => {
  // "srcweb" matches across the split: three characters in the directory, three
  // in the file name.
  const hits = subsequence('src/main/webServer.ts', 'srcweb')
  assert.ok(hits, 'the path matches')
  const { dir, name, dirHits, nameHits } = splitTitle('src/main/webServer.ts', hits)
  assert.equal(dir, 'src/main/')
  assert.equal(name, 'webServer.ts')
  assert.deepEqual(dirHits, [0, 1, 2], 'the directory keeps its own indices')
  assert.deepEqual(nameHits, [0, 1, 2], 'the name is re-based, so "web" lights up in it')
})

test('splitTitle leaves a title with no directory alone', () => {
  const { dir, name, nameHits } = splitTitle('git: merge worktree', [0, 1, 2])
  assert.equal(dir, '', 'a command has no context half')
  assert.equal(name, 'git: merge worktree')
  assert.deepEqual(nameHits, [0, 1, 2])
})
