import { test } from 'node:test'
import assert from 'node:assert/strict'
import { persistable, remember, scopedOf, sessionKeyOf, withScoped } from './laneStore.ts'
import type { Lane, Panel } from './lane.ts'

const panel = (kind: string, order: number, extra: Partial<Panel> = {}): Panel => ({
  id: `${kind}:${extra.sub ?? ''}`,
  kind,
  title: kind,
  order,
  ...extra
})

// projects → worktrees → chat → the panels that chat opened.
const laneWith = (sessionId: string, ...opened: Panel[]): Lane => ({
  panels: [
    panel('projects', 0),
    panel('worktrees', 10),
    panel('chat', 30, { session: { id: sessionId, worktreePath: '/w' } }),
    ...opened
  ],
  focus: 2
})

test('the lane knows which session it is showing', () => {
  assert.equal(sessionKeyOf(laneWith('s1')), 's1')
  assert.equal(sessionKeyOf({ panels: [panel('projects', 0)], focus: 0 }), null)
})

test('only what the session opened is session-scoped', () => {
  const lane = laneWith('s1', panel('changes', 40), panel('terminal', 60))
  assert.deepEqual(
    scopedOf(lane).map((p) => p.kind),
    ['changes', 'terminal']
  )
})

test('swapping in another session keeps the window panels put', () => {
  const lane = laneWith('s1', panel('changes', 40), panel('diff', 50, { sub: 'a.ts' }))
  const next = withScoped(lane, [panel('terminal', 60)])
  assert.deepEqual(
    next.panels.map((p) => p.kind),
    ['projects', 'worktrees', 'chat', 'terminal']
  )
})

test('a session with nothing open leaves just the window panels', () => {
  const lane = laneWith('s1', panel('changes', 40), panel('terminal', 60))
  assert.deepEqual(
    withScoped(lane, []).panels.map((p) => p.kind),
    ['projects', 'worktrees', 'chat']
  )
})

test('focus stays on the same panel when it survives the swap', () => {
  const lane = { ...laneWith('s1', panel('changes', 40)), focus: 1 } // worktrees
  assert.equal(withScoped(lane, []).focus, 1)
})

test('focus falls back to the session when the focused panel is gone', () => {
  const lane = { ...laneWith('s1', panel('terminal', 60)), focus: 3 } // the terminal
  const next = withScoped(lane, [])
  assert.equal(next.panels[next.focus].kind, 'chat')
})

// The opening message of a brand-new chat: replayed on restore it would send
// the message again, every launch.
test('the first prompt is never written down', () => {
  const saved = persistable([panel('chat', 30, { firstPrompt: 'hello', sub: 'x' })])
  assert.equal('firstPrompt' in saved[0], false)
  assert.equal(saved[0].sub, 'x')
})

test('remembering a session moves it to the most recent end', () => {
  let by: Record<string, Panel[]> = {}
  by = remember(by, 's1', [panel('terminal', 60)])
  by = remember(by, 's2', [panel('changes', 40)])
  by = remember(by, 's1', [panel('diff', 50)])
  assert.deepEqual(Object.keys(by), ['s2', 's1'])
  assert.deepEqual(by.s1.map((p) => p.kind), ['diff'])
})

test('old sessions fall off the end', () => {
  let by: Record<string, Panel[]> = {}
  for (let i = 0; i < 35; i++) by = remember(by, `s${i}`, [panel('terminal', 60)])
  assert.equal(Object.keys(by).length, 30)
  assert.equal('s0' in by, false)
  assert.equal('s34' in by, true)
})
