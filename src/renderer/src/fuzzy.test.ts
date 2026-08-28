import assert from 'node:assert/strict'
import test from 'node:test'
import { capGroups, filterItems, subsequence, type PaletteItem } from './fuzzy.ts'

const item = (title: string, detail?: string): PaletteItem => ({ id: title, title, detail })

test('subsequence matches letters in order, not as a substring', () => {
  // r-o-o-k-e-r-y: the k is at 3 and the next r at 5.
  assert.deepEqual(subsequence('rookery-rust', 'rkr'), [0, 3, 5])
  assert.equal(subsequence('rookery-rust', 'xyz'), null)
  // Order matters: the letters are all there, but not in that sequence.
  assert.equal(subsequence('abc', 'cba'), null)
})

test('an empty query matches everything', () => {
  assert.deepEqual(subsequence('anything', ''), [])
  const all = filterItems([item('a'), item('b')], '')
  assert.equal(all.length, 2)
})

test('matching is case-insensitive both ways', () => {
  assert.deepEqual(subsequence('Rookery', 'rk'), [0, 3])
  assert.deepEqual(subsequence('rookery', 'RK'), [0, 3])
})

test('a tighter, earlier match ranks first', () => {
  const items = [item('very-long-name-with-r-and-k'), item('rkanban')]
  const out = filterItems(items, 'rk')
  assert.equal(out[0].item.title, 'rkanban', 'adjacent letters at the start win')
})

test('detail is for reading, not for matching', () => {
  // Every project shares a group name, so matching the detail made short
  // queries return the whole list — the filter stopped filtering.
  const items = [item('zebra', 'Projects'), item('rookery', 'Projects')]
  assert.deepEqual(
    filterItems(items, 'ro').map((o) => o.item.title),
    ['rookery'],
    'ro is a subsequence of "Projects" too, and must not count'
  )
})

test('items that match nothing are dropped', () => {
  const out = filterItems([item('alpha'), item('beta')], 'zzz')
  assert.equal(out.length, 0)
})

test('hits point at the characters to highlight', () => {
  const [first] = filterItems([item('rookery')], 'rke')
  assert.deepEqual(first.hits, [0, 3, 4])
  assert.equal(
    first.hits.map((i) => 'rookery'[i]).join(''),
    'rke',
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
  const items = [item('rookery'), { id: 'add', title: 'Add project…', pinned: true }]
  const found = filterItems(items, 'rook').map((o) => o.item.title)
  assert.deepEqual(found, ['rookery', 'Add project…'], 'after the matches')

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
