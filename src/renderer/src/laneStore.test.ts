import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  load,
  persistable,
  remember,
  rememberSession,
  rememberWorktree,
  save,
  scopedOf,
  sessionKeyOf,
  withScoped
} from './laneStore.ts'
import type { Lane, Panel } from './lane.ts'

// The store writes to localStorage, which a `node --test` process has none of.
// A Map is the whole contract it uses.
const store = new Map<string, string>()
;(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k)
}

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
  const saved = persistable([
    panel('chat', 30, {
      firstPrompt: 'hello',
      firstAttached: { images: [{ id: 'a1', mediaType: 'image/png', data: 'x' }], files: [] },
      sub: 'x'
    })
  ])
  assert.equal('firstPrompt' in saved[0], false)
  // Its attachments go with it — resent on every launch, and base64 in
  // localStorage besides.
  assert.equal('firstAttached' in saved[0], false)
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

test('a project remembers the worktree it was left on', () => {
  let by: Record<string, string> = {}
  by = rememberWorktree(by, '/proj', '/proj/wt-a')
  by = rememberWorktree(by, '/proj', '/proj/wt-b')
  assert.deepEqual(by, { '/proj': '/proj/wt-b' })
})

// The difference between "left empty" and "never been here": one restores the
// launcher because you closed the chat, the other because there is nothing yet.
test('a worktree remembers an empty chat as an answer, not as a gap', () => {
  const by = rememberSession({ '/wt': 's1' }, '/wt', null)
  assert.equal(by['/wt'], null)
  assert.equal('/wt' in by, true)
})

test('the places you have not been in a hundred switches fall off', () => {
  let by: Record<string, string | null> = {}
  for (let i = 0; i < 105; i++) by = rememberSession(by, `/wt${i}`, `s${i}`)
  assert.equal(Object.keys(by).length, 100)
  assert.equal('/wt0' in by, false)
  assert.equal(by['/wt104'], 's104')
})

// The project's checklists are keyed by project root, not by session, so a
// session switch must leave them exactly where they are. The setup flow is why
// this is not a nicety: its `choose` step sends you to the session's chat to
// answer, and that switch used to close the very checklist you were answering.
test('a project checklist survives a session switch', () => {
  const lane = laneWith('s1', panel('setup', 41), panel('changes', 40))
  assert.deepEqual(
    scopedOf(lane).map((p) => p.kind),
    ['changes'],
    'the checklist is not the session’s to carry'
  )
  assert.deepEqual(
    withScoped(lane, [panel('diff', 50, { sub: 'a.ts' })]).panels.map((p) => p.kind),
    ['projects', 'worktrees', 'chat', 'setup', 'diff']
  )
})

test('merge and remove are project checklists too', () => {
  for (const kind of ['merge', 'remove']) {
    const lane = laneWith('s1', panel(kind, 41))
    assert.deepEqual(scopedOf(lane), [], `${kind} belongs to the project`)
    assert.ok(
      withScoped(lane, []).panels.some((p) => p.kind === kind),
      `${kind} should survive the swap`
    )
  }
})

// A set remembered before these panels became project-owned still names one.
test('a remembered checklist is not added a second time', () => {
  const lane = laneWith('s1', panel('setup', 41))
  const next = withScoped(lane, [panel('setup', 41)])
  assert.equal(next.panels.filter((p) => p.kind === 'setup').length, 1)
})

// The lane is sorted by `order` everywhere else (see open()), and a swap is no
// exception: a kept checklist (41) must not push the restored changes list (40)
// to the wrong side of it.
test('a restored set lands at its order, not behind the kept checklist', () => {
  const lane = laneWith('s1', panel('setup', 41))
  assert.deepEqual(
    withScoped(lane, [panel('changes', 40), panel('diff', 50, { sub: 'a.ts' })]).panels.map(
      (p) => p.kind
    ),
    ['projects', 'worktrees', 'chat', 'changes', 'setup', 'diff']
  )
})

// The flows live in the hooks, not in storage: a checklist restored on the next
// launch has nothing to show, so it is not written down in the first place.
test('a checklist is not persisted', () => {
  const panels = [panel('worktrees', 10), panel('setup', 41), panel('changes', 40)]
  assert.deepEqual(
    persistable(panels).map((p) => p.kind),
    ['worktrees', 'changes']
  )
})

test('the saved focus never points past what was saved', () => {
  const lane = { panels: [panel('worktrees', 10), panel('setup', 41)], focus: 1 }
  save({ lane, bySession: {}, byProject: {}, byWorktree: {} })
  const back = load()
  assert.deepEqual(back?.lane.panels.map((p) => p.kind), ['worktrees'])
  assert.equal(back?.lane.focus, 0, 'the checklist it pointed at is gone')
})
