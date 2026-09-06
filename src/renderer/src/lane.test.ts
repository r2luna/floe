import assert from 'node:assert/strict'
import test from 'node:test'
import { clearSize, close, closePanel, columnsOf, focusAt, focusBy, laneOf, open, focusDir, resizePanel, setCursor, toggleDock, toggleKind, type Lane, type Panel } from './lane.ts'

// Distinct kinds: same-kind panels replace each other, which these tests are
// not about.
const p = (id: string): Panel => ({ id, kind: id, title: id })
const ids = (lane: { panels: Panel[] }) => lane.panels.map((x) => x.id)

const ranked = (id: string, kind: string, order: number): Panel => ({ id, kind, title: id, order })

test('a panel lands at its order, not at the end', () => {
  let lane = laneOf(ranked('projects', 'projects', 0))
  lane = open(lane, ranked('chat', 'chat', 30))
  lane = open(lane, ranked('worktrees', 'worktrees', 10))
  assert.deepEqual(ids(lane), ['projects', 'worktrees', 'chat'])
  assert.equal(lane.focus, 1, 'focus follows the panel, not the position it was added at')
})

test('reopening a closed panel restores its place', () => {
  let lane = laneOf(ranked('projects', 'projects', 0))
  lane = open(lane, ranked('worktrees', 'worktrees', 10))
  lane = open(lane, ranked('chat', 'chat', 30))
  lane = close(lane, 0)
  assert.deepEqual(ids(lane), ['worktrees', 'chat'])
  lane = open(lane, ranked('projects', 'projects', 0))
  assert.deepEqual(ids(lane), ['projects', 'worktrees', 'chat'], 'back to the left, not the end')
})

test('a panel of the same kind is replaced, never stacked', () => {
  let lane = laneOf(ranked('projects', 'projects', 0))
  lane = open(lane, ranked('chat:a', 'chat', 30))
  lane = open(lane, ranked('chat:b', 'chat', 30))
  assert.deepEqual(ids(lane), ['projects', 'chat:b'])
  assert.equal(lane.focus, 1)
})

test('reopening something already in the lane just focuses it', () => {
  let lane = laneOf(ranked('projects', 'projects', 0))
  lane = open(lane, ranked('chat', 'chat', 30))
  lane = focusAt(lane, 0)
  lane = open(lane, ranked('chat', 'chat', 30))
  assert.deepEqual(ids(lane), ['projects', 'chat'])
  assert.equal(lane.focus, 1)
})

test('panels with the same order keep the order they arrived in', () => {
  let lane = laneOf(ranked('projects', 'projects', 0))
  lane = open(lane, ranked('a', 'a', 40))
  lane = open(lane, ranked('b', 'b', 40))
  assert.deepEqual(ids(lane), ['projects', 'a', 'b'])
})

test('closing removes that panel and leaves its neighbours alone', () => {
  let lane = laneOf(p('root'))
  lane = open(lane, p('a'))
  lane = open(lane, p('b'))
  lane = close(lane, 1)
  assert.deepEqual(ids(lane), ['root', 'b'], 'the panel to the right survives')
})

test('any panel can be closed, including the first', () => {
  const lane = open(laneOf(p('root')), p('a'))
  assert.deepEqual(ids(close(lane, 0)), ['a'])
})

test('closing shifts focus so it still points at the same panel', () => {
  let lane = laneOf(p('root'))
  lane = open(lane, p('a'))
  lane = open(lane, p('b')) // focus is 2
  lane = close(lane, 0)
  assert.deepEqual(ids(lane), ['a', 'b'])
  assert.equal(lane.focus, 1, 'still on b')
})

test('the lane can be emptied', () => {
  const lane = close(laneOf(p('root')), 0)
  assert.deepEqual(ids(lane), [])
  assert.equal(lane.focus, 0)
})

test('toggleKind: closed opens, elsewhere focuses, focused closes', () => {
  const make = () => ({ id: 'w', kind: 'worktrees', title: 'w' })
  let lane = laneOf(p('root'))

  lane = toggleKind(lane, 'worktrees', make)
  assert.deepEqual(ids(lane), ['root', 'w'], 'closed → opens')
  assert.equal(lane.focus, 1, 'and focuses')

  lane = focusAt(lane, 0)
  lane = toggleKind(lane, 'worktrees', make)
  assert.equal(lane.focus, 1, 'open elsewhere → focuses')
  assert.deepEqual(ids(lane), ['root', 'w'], 'without reopening')

  lane = toggleKind(lane, 'worktrees', make)
  assert.deepEqual(ids(lane), ['root'], 'open and focused → closes')
})

test('focus never leaves the lane', () => {
  const lane = open(laneOf(p('root')), p('a'))
  assert.equal(focusBy(lane, 5).focus, 1)
  assert.equal(focusBy(lane, -5).focus, 0)
  assert.equal(focusAt(lane, 99).focus, 1)
})


test('a panel remembers its cursor across a visit elsewhere', () => {
  let lane = laneOf(p('root'))
  lane = open(lane, p('other'))
  lane = setCursor(lane, 0, 4)
  lane = focusAt(lane, 1)
  lane = setCursor(lane, 1, 2)
  lane = focusAt(lane, 0)
  assert.equal(lane.panels[0].cursor, 4, 'came back to where it left')
  assert.equal(lane.panels[1].cursor, 2, 'the other panel kept its own')
})

test('setCursor returns the same lane when nothing moved', () => {
  // Identity matters: this runs on every keypress and a new object each time
  // would re-render every panel in the lane.
  const lane = setCursor(laneOf(p('root')), 0, 3)
  assert.equal(setCursor(lane, 0, 3), lane)
})

test('setCursor ignores a panel that is not there', () => {
  const lane = laneOf(p('root'))
  assert.equal(setCursor(lane, 9, 1), lane)
})

test('two kinds sharing a slot replace each other', () => {
  // The launcher and the chat are one session slot: showing a session and its
  // own empty state side by side would be nonsense.
  const launcher: Panel = { id: 'branch:x', kind: 'branch', title: 'x', slot: 'session', order: 30 }
  const chat: Panel = { id: 'chat:y', kind: 'chat', title: 'y', slot: 'session', order: 30 }

  let lane = laneOf(p('projects'))
  lane = open(lane, launcher)
  assert.deepEqual(ids(lane), ['projects', 'branch:x'])
  lane = open(lane, chat)
  assert.deepEqual(ids(lane), ['projects', 'chat:y'], 'the chat took the launcher’s place')
  lane = open(lane, launcher)
  assert.deepEqual(ids(lane), ['projects', 'branch:x'], 'and back the other way')
})

test('a docked panel joins the column on its left', () => {
  const lane: Lane = {
    panels: [
      { id: 'chat', kind: 'chat', title: 'chat' },
      { id: 'term', kind: 'terminal', title: 'terminal', dock: 'below' },
      { id: 'diff', kind: 'diff', title: 'diff' }
    ],
    focus: 0
  }
  assert.deepEqual(
    columnsOf(lane).map((col) => col.map((c) => c.panel.id)),
    [['chat', 'term'], ['diff']]
  )
})

test('docking flips back and forth', () => {
  const lane: Lane = {
    panels: [
      { id: 'chat', kind: 'chat', title: 'chat' },
      { id: 'term', kind: 'terminal', title: 'terminal' }
    ],
    focus: 1
  }
  const docked = toggleDock(lane, 1)
  assert.equal(docked.panels[1].dock, 'below')
  assert.equal(toggleDock(docked, 1).panels[1].dock, undefined)
})

test('the leftmost panel has nothing to dock under', () => {
  const lane: Lane = { panels: [{ id: 'chat', kind: 'chat', title: 'chat' }], focus: 0 }
  assert.equal(toggleDock(lane, 0), lane)
})

test('a drag sizes the width of an ordinary panel', () => {
  const lane: Lane = { panels: [{ id: 'a', kind: 'chat', title: 'chat' }], focus: 0 }
  assert.equal(resizePanel(lane, 0, 640.4).panels[0].width, 640)
  assert.equal(resizePanel(lane, 0, 640).panels[0].height, undefined)
})

test('a docked panel is sized by height — its column owns the width', () => {
  const lane: Lane = {
    panels: [{ id: 't', kind: 'terminal', title: 'terminal', dock: 'below' }],
    focus: 0
  }
  const sized = resizePanel(lane, 0, 300)
  assert.equal(sized.panels[0].height, 300)
  assert.equal(sized.panels[0].width, undefined)
})

test('a drag past the floor stops at the floor', () => {
  const lane: Lane = { panels: [{ id: 'a', kind: 'chat', title: 'chat' }], focus: 0 }
  assert.equal(resizePanel(lane, 0, 10, 260).panels[0].width, 260)
})

test('clearing a size hands the panel back to its default', () => {
  const lane: Lane = { panels: [{ id: 'a', kind: 'chat', title: 'chat', width: 900 }], focus: 0 }
  assert.equal(clearSize(lane, 0).panels[0].width, undefined)
  // Nothing to clear: the same lane, so React sees no change.
  const plain: Lane = { panels: [{ id: 'a', kind: 'chat', title: 'chat' }], focus: 0 }
  assert.equal(clearSize(plain, 0), plain)
})

// projects | worktrees | chat+terminal — the shape most sessions end up in.
function gridLane(): Lane {
  return {
    panels: [
      { id: 'p', kind: 'projects', title: 'projects' },
      { id: 'w', kind: 'worktrees', title: 'worktrees' },
      { id: 'c', kind: 'chat', title: 'chat' },
      { id: 't', kind: 'terminal', title: 'terminal', dock: 'below' }
    ],
    focus: 2 // chat
  }
}

test('⌃L at the rightmost column stays — never drops onto what is docked below', () => {
  // From chat (the rightmost column), right is nothing. Wrongly falling through
  // to flat-index-plus-one would land on the docked terminal instead.
  const next = focusDir(gridLane(), 1, 0)
  assert.equal(next.panels[next.focus].id, 'c')
})

test('⌃H crosses left, landing on the column, not down into its stack', () => {
  const lane = { ...gridLane(), focus: 3 } // terminal, docked under chat
  const next = focusDir(lane, -1, 0)
  assert.equal(next.panels[next.focus].id, 'w')
})

test('⌃J moves down within the stack; ⌃L from there still goes sideways', () => {
  const lane = { ...gridLane(), focus: 2 } // chat
  const down = focusDir(lane, 0, 1)
  assert.equal(down.panels[down.focus].id, 't')
  // ⌃H from the docked terminal must not silently jump back to chat via row 0
  // of a shorter neighbour and then get read as "up" — it's a column move.
  const left = focusDir(down, -1, 0)
  assert.equal(left.panels[left.focus].id, 'w')
})

test('⌃K at the top of a stack stays — there is nothing above', () => {
  const next = focusDir(gridLane(), 0, -1)
  assert.equal(next.focus, 2)
})

test('crossing into a shorter column clamps to its last row', () => {
  const lane = { ...gridLane(), focus: 3 } // terminal, row 1 of the chat column
  const next = focusDir(lane, -1, 0) // worktrees column has only row 0
  assert.equal(next.panels[next.focus].id, 'w')
})

test('crossing into a taller column keeps the same row', () => {
  // worktrees | chat+terminal — go right from worktrees at row 0, then down,
  // then back left: should return to worktrees, not fall through to terminal.
  const lane: Lane = {
    panels: [
      { id: 'w', kind: 'worktrees', title: 'worktrees' },
      { id: 'c', kind: 'chat', title: 'chat' },
      { id: 't', kind: 'terminal', title: 'terminal', dock: 'below' }
    ],
    focus: 0
  }
  const right = focusDir(lane, 1, 0)
  assert.equal(right.panels[right.focus].id, 'c')
})

test('changing project keeps the worktrees panel exactly where it was', () => {
  // The panel id carries what it shows, so another project is another panel.
  // Everything about its box must survive that swap.
  const lane: Lane = {
    panels: [
      { id: 'projects:', kind: 'projects', title: 'projects', order: 0 },
      {
        id: 'worktrees:floe',
        kind: 'worktrees',
        title: 'worktrees',
        sub: 'floe',
        order: 10,
        width: 508,
        dock: 'below',
        cursor: 7
      }
    ],
    focus: 1
  }
  const next = open(lane, {
    id: 'worktrees:os',
    kind: 'worktrees',
    title: 'worktrees',
    sub: 'os',
    order: 10
  })
  const panel = next.panels[1]
  assert.equal(panel.sub, 'os', 'the content changed')
  assert.equal(panel.width, 508, 'the width you dragged to survived')
  assert.equal(panel.dock, 'below', 'so did the stacking')
  assert.equal(next.focus, 1, 'and it is still the same slot')
  // The cursor is an index into a list that is now a different list.
  assert.equal(panel.cursor, undefined)
})

test('a fresh slot gets its own defaults, not a neighbour’s', () => {
  const lane: Lane = {
    panels: [{ id: 'chat:a', kind: 'chat', title: 'chat', order: 30, width: 900 }],
    focus: 0
  }
  const next = open(lane, { id: 'diff:x.ts', kind: 'diff', title: 'diff', order: 50 })
  assert.equal(next.panels[1].width, undefined)
})

test('two kinds sharing a slot hand over the layout too', () => {
  // The branch launcher IS the empty state of a session: swapping one for the
  // other must not resize the column under you.
  const lane: Lane = {
    panels: [
      { id: 'branch:main', kind: 'branch', title: 'branch', slot: 'session', order: 30, width: 720 }
    ],
    focus: 0
  }
  const next = open(lane, {
    id: 'chat:s1',
    kind: 'chat',
    title: 'chat',
    slot: 'session',
    order: 30
  })
  assert.equal(next.panels[0].kind, 'chat')
  assert.equal(next.panels[0].width, 720)
})

// --- closing a chat lands on the launcher --------------------------------

const chat = (id: string): Panel => ({
  id,
  kind: 'chat',
  title: id,
  order: 30,
  // The chat and the launcher share the session slot — the launcher IS the
  // chat's empty state. It is what tells `closePanel` which panel leaves one
  // behind, so the fixture carries it exactly as `panelOf` does.
  slot: 'session',
  session: { id: `s-${id}`, worktreePath: '/w' }
})
const launcher = (): Panel => ({ id: 'branch:', kind: 'branch', title: 'branch', order: 30 })

test('closing a chat leaves the launcher in its place, not a hole', () => {
  let lane = laneOf(ranked('worktrees', 'worktrees', 10))
  lane = open(lane, chat('c1'))
  assert.deepEqual(ids(lane), ['worktrees', 'c1'])
  lane = closePanel(lane, 1, launcher)
  assert.deepEqual(ids(lane), ['worktrees', 'branch:'], 'the session column stays, now empty')
  assert.equal(lane.panels[1].session, undefined, 'and carries no session over')
})

test('closing the only chat still leaves the launcher', () => {
  let lane = laneOf(chat('c1'))
  lane = closePanel(lane, 0, launcher)
  assert.deepEqual(ids(lane), ['branch:'], 'never an empty lane')
})

test('closing anything without a session closes plainly', () => {
  let lane = laneOf(ranked('worktrees', 'worktrees', 10))
  lane = open(lane, ranked('files', 'files', 40))
  lane = closePanel(lane, 1, launcher)
  assert.deepEqual(ids(lane), ['worktrees'], 'no launcher conjured by closing a file tree')
})

test('closing a chat keeps focus on the column it replaced', () => {
  let lane = laneOf(ranked('worktrees', 'worktrees', 10))
  lane = open(lane, chat('c1'))
  lane = closePanel(lane, 1, launcher)
  assert.equal(lane.focus, 1, 'focus stays where the conversation was')
})

test('closing a query leaves nothing behind, not a second launcher', () => {
  // A query panel carries a session too — its own key, `sess~codex` — but it is
  // not the conversation the branch is showing. Read as one, merging a query
  // put a second launcher in the lane beside the first.
  const query: Panel = {
    id: 'query:codex',
    kind: 'query',
    title: 'codex',
    order: 35,
    session: { id: 's-c1~codex', worktreePath: '/w' }
  }
  const lane: Lane = { panels: [chat('c1'), query], focus: 1 }
  const after = closePanel(lane, 1, launcher)
  assert.deepEqual(after.panels.map((p) => p.kind), ['chat'])
})
