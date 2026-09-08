import assert from 'node:assert/strict'
import test from 'node:test'
import type { Query } from '../../shared/types.ts'
import { dockRows, namesOf } from './queryDock.ts'

const query = (harness: string, at: number, extra: Partial<Query> = {}): Query => ({
  id: `s1~${harness}`,
  sessionId: 's1',
  harness,
  mode: 'plan',
  openedAt: at,
  ...extra
})

test('an idle query still gets a row', () => {
  // The whole point of the dock: ⌘W closes a panel, not the conversation, and
  // a query nobody is waiting on is still one you want back on screen.
  const rows = dockRows([query('codex', 10)], new Set(), new Map())
  assert.deepEqual(rows.map((r) => [r.harness, r.running]), [['codex', false]])
})

test('a merged or discarded query is not listed', () => {
  const rows = dockRows(
    [query('codex', 10, { outcome: 'merged' }), query('claude', 20, { outcome: 'discarded' })],
    new Set(),
    new Map()
  )
  assert.deepEqual(rows, [])
})

test('a turn running under the CLI’s own id still reads as running', () => {
  // A Claude query's turn runs under the id the CLI minted, not under the query
  // key — matching the key alone showed a working query as idle.
  const q = query('claude', 10, { claudeId: 'cli-1' })
  const rows = dockRows([q], new Set(['cli-1']), new Map())
  assert.equal(rows[0].running, true)
  assert.deepEqual(namesOf(q), ['s1~claude', 'cli-1'])
})

test('the tool and the clock come from the event stream while it runs', () => {
  const rows = dockRows(
    [query('codex', 10)],
    new Set(['s1~codex']),
    new Map([['s1~codex', { tool: 'grep', at: 500 }]])
  )
  assert.deepEqual([rows[0].tool, rows[0].since], ['grep', 500])
})

test('an idle row keeps the clock it was opened on, not a stale turn’s', () => {
  const rows = dockRows([query('codex', 10)], new Set(), new Map())
  assert.deepEqual([rows[0].tool, rows[0].since], [undefined, 10])
})

test('rows read in the order the queries were asked, whatever is running', () => {
  // Same order as the panels stand in the lane. A dock that sorted by activity
  // would move the row out from under the pointer every time a turn started.
  const rows = dockRows(
    [query('claude', 30), query('codex', 10), query('opencode', 20)],
    new Set(['s1~opencode']),
    new Map([['s1~opencode', { at: 900 }]])
  )
  assert.deepEqual(rows.map((r) => r.harness), ['codex', 'opencode', 'claude'])
})
