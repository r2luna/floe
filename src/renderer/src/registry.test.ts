import assert from 'node:assert/strict'
import test from 'node:test'
import { COMMAND_IDS } from '../../shared/commandIds.ts'
import { listCommands, runCommand, type CommandContext } from './commands.ts'
import { laneOf, type Lane, type Panel } from './lane.ts'
import { REGISTRY } from './registry.ts'

const panel = (kind: string, sub?: string): Panel => ({ id: `${kind}:${sub ?? ''}`, kind, title: kind, sub })

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
