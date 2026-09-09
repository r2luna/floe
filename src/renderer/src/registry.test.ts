import assert from 'node:assert/strict'
import test from 'node:test'
import { COMMAND_IDS } from '../../shared/commandIds.ts'
import { listCommands, runCommand, type CommandContext } from './commands.ts'
import { laneOf, slotOf, type Lane, type Panel } from './lane.ts'
import { REGISTRY } from './registry.ts'

// The same shape App's `panelOf` builds, slot rule included — which is why that
// rule lives in lane.ts and not in a .tsx no plain test can import.
const panel = (kind: string, sub?: string): Panel => ({
  id: `${kind}:${sub ?? ''}`,
  kind,
  title: kind,
  sub,
  slot: slotOf(kind, sub)
})

function context(lane: Lane = laneOf(panel('projects'))): CommandContext & { lane: Lane } {
  const ctx = {
    lane,
    setLane: (fn: (l: Lane) => Lane) => {
      ctx.lane = fn(ctx.lane)
    },
    panelEl: () => null,
    rowsOf: () => [],
    makePanel: (kind: string, sub?: string) => panel(kind, sub),
    canOpen: () => true,
    editSkill: () => {},
    editPremise: () => {},
    openChat: () => {},
    whyCannotOpen: () => 'not available',
    patchFor: () => '',
    openPalette: () => {},
    openCommands: () => {},
    openFiles: () => {},
    openFind: () => {},
    findNext: () => {},
    addProject: () => {},
    createGroup: () => {},
    reloadProjects: () => {},
    moveProject: () => {},
    deleteProject: () => {},
    startMoveProject: () => {},
    stepMoveProject: () => {},
    endMoveProject: () => {},
    movingProject: false,
    deleteGroup: () => {},
    newWorktree: () => {},
    useBackend: () => {},
    deleteSession: () => {},
    markedSessions: [],
    markSession: () => {},
    clearMarkedSessions: () => {},
    cycleSession: () => {},
    askText: () => {},
    say: () => {},
    commands: {
      list: [],
      runs: {},
      loading: false,
      keyOf: (id: string) => `#${id}`,
      runOf: () => undefined,
      start: () => {},
      stop: () => {},
      restart: () => {},
      startAll: () => {},
      reload: () => {},
      add: async () => {},
      update: async () => {},
      remove: async () => {},
      setScope: async () => {}
    },
    merge: {
      active: false,
      failed: false,
      awaitingReview: false,
      canStash: false,
      start: () => {},
      approve: () => {},
      retry: () => {},
      stashRetry: () => {},
      cancel: () => {}
    },
    remove: {
      active: false,
      failed: false,
      awaitingForce: false,
      start: () => {},
      force: () => {},
      retry: () => {},
      cancel: () => {}
    },
    provision: {
      active: false,
      idle: false,
      start: () => {},
      retry: () => {},
      dismiss: () => {}
    },
    setup: {
      active: false,
      failed: false,
      awaitingChoice: false,
      canStart: false,
      start: () => {},
      retry: () => {},
      cancel: () => {},
      openChat: () => {}
    }
  }
  return ctx
}

test('every registry command is in the shared id list', () => {
  // main/keybindings.ts validates a user config against COMMAND_IDS, and the
  // MCP list_commands tool answers from it. A command missing here is one the
  // user cannot bind and Claude cannot see.
  for (const c of REGISTRY.values())
    assert.ok(COMMAND_IDS.includes(c.id), `${c.id} missing from shared/commandIds.ts`)
})

test('the shared id list has no commands the registry lacks', () => {
  for (const id of COMMAND_IDS)
    assert.ok(REGISTRY.has(id), `${id} is advertised but not implemented`)
})

test('every command is described well enough for a palette and for MCP', () => {
  for (const c of REGISTRY.values()) {
    assert.ok(c.title.trim(), `${c.id} has no title`)
    assert.ok(c.group.trim(), `${c.id} has no group`)
  }
})

test('an unknown id is refused, not thrown', () => {
  // Both remote callers — the palette and an MCP tool — need a reportable miss.
  const res = runCommand(REGISTRY, context(), 'nope.nope')
  assert.deepEqual(res, { ok: false, error: 'unknown command: nope.nope' })
})

test('a disabled command is refused with its reason', () => {
  // No chat panel open, so there is nothing to write into.
  const res = runCommand(REGISTRY, context(), 'composer.focus')
  assert.equal(res.ok, false)
  assert.match((res as { error: string }).error, /not available now/)
})

test('panel.goto opens, focuses and closes through the same id', () => {
  const ctx = context()
  runCommand(REGISTRY, ctx, 'panel.goto', 'worktrees')
  assert.deepEqual(ctx.lane.panels.map((p) => p.kind), ['projects', 'worktrees'])
  runCommand(REGISTRY, ctx, 'panel.goto', 'worktrees')
  assert.deepEqual(ctx.lane.panels.map((p) => p.kind), ['projects'], 'focused → closed')
})

test('panel.focusAt takes its argument as a string, the way MCP sends it', () => {
  const ctx = context()
  runCommand(REGISTRY, ctx, 'panel.goto', 'worktrees')
  runCommand(REGISTRY, ctx, 'panel.focusAt', '0')
  assert.equal(ctx.lane.focus, 0)
})

test('listCommands reports what is available right now', () => {
  const rows = listCommands(REGISTRY, context())
  const compose = rows.find((r) => r.id === 'composer.focus')
  assert.equal(compose?.enabled, false, 'no chat panel open')
  assert.equal(rows.find((r) => r.id === 'panel.right')?.enabled, true)
})

test('panel.goto refuses with a reason instead of doing nothing', () => {
  // A key press has no row to dim, so a silent refusal is indistinguishable from
  // a broken binding — which is exactly how ⌘K F read before this.
  const ctx = { ...context(), canOpen: () => false, whyCannotOpen: () => 'files — select a worktree first' }
  const res = runCommand(REGISTRY, ctx, 'panel.goto', 'files')
  assert.equal(res.ok, false)
  assert.equal((res as { error: string }).error, 'files — select a worktree first')
  assert.deepEqual(ctx.lane.panels.map((p) => p.kind), ['projects'], 'and opens nothing')
})

test('panel.goto is judged per argument, not per command', () => {
  // `worktrees` is always reachable; `files` needs a checked-out tree. One
  // command id, two answers — which is why `enabled` takes the argument.
  const ctx = { ...context(), canOpen: (kind: string) => kind !== 'files' }
  assert.equal(runCommand(REGISTRY, ctx, 'panel.goto', 'worktrees').ok, true)
  assert.equal(runCommand(REGISTRY, ctx, 'panel.goto', 'files').ok, false)
})

/* --- queries side by side -------------------------------------------------- */

const query = (harness: string): Panel => ({
  ...panel('query', harness),
  title: harness,
  session: { id: `s1~${harness}`, worktreePath: '/w' }
})

const twoQueries = (): Lane => ({
  panels: [{ ...panel('chat'), session: { id: 's1', worktreePath: '/w' } }, query('codex'), query('claude')],
  focus: 0
})

test('go to the query walks the queries when several are open', () => {
  const ctx = context(twoQueries())
  runCommand(REGISTRY, ctx, 'query.focus')
  assert.equal(ctx.lane.focus, 1, 'from the chat, the leftmost')
  runCommand(REGISTRY, ctx, 'query.focus')
  assert.equal(ctx.lane.focus, 2, 'again, the next one')
  runCommand(REGISTRY, ctx, 'query.focus')
  assert.equal(ctx.lane.focus, 1, 'and it wraps')
})

test('merging from the chat with two queries open asks which, instead of guessing', () => {
  // Two panels on screen and no reason to prefer either: merging the one the
  // lane happens to list first would end a conversation on a coin toss.
  const said: string[] = []
  const ctx = { ...context(twoQueries()), say: (t: string) => said.push(t) }
  const res = runCommand(REGISTRY, ctx, 'query.merge')
  assert.equal(res.ok, true, 'the command is available — a query IS open')
  assert.match(said[0] ?? '', /Several queries open/)
})

test('“show every open query” puts a panel back for each one', async () => {
  // ⌘W closes a panel, not the query. Without this (and the dock row that does
  // the same for one), a query left running had no way back on screen.
  const listed = [
    { id: 's1~codex', harness: 'codex' },
    { id: 's1~claude', harness: 'claude' },
    { id: 's1~opencode', harness: 'opencode', outcome: 'merged' }
  ]
  const said: string[] = []
  const ctx = context({
    panels: [{ ...panel('chat'), session: { id: 's1', worktreePath: '/w' } }],
    focus: 0
  })
  ctx.say = (t: string) => said.push(t)
  const before = globalThis.window
  // @ts-expect-error — the registry reaches for the preload bridge; a plain
  // node run has none, and this command is exactly the seam that needs one.
  globalThis.window = { floe: { query: { list: async () => listed } } }
  try {
    assert.equal(runCommand(REGISTRY, ctx, 'query.showAll').ok, true)
    await new Promise((r) => setTimeout(r, 0))
  } finally {
    globalThis.window = before
  }
  assert.deepEqual(ctx.lane.panels.map((p) => p.kind), ['chat', 'query', 'query'])
  assert.deepEqual(
    ctx.lane.panels.slice(1).map((p) => p.session?.id),
    ['s1~codex', 's1~claude'],
    'the merged one stays closed — reopen is its door'
  )
  assert.deepEqual(said, [])
})
