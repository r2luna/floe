import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installHook } from './hook.test-helper.ts'

// The module reaches for `configDir()` and the project scan; the hook is what
// resolves the extensionless main-process imports under `node --test`.
installHook()

const { DEFAULT_COLONY, capOf, columnsFor, mergeColony, parseGlobalColony, parseProjectColony } =
  await import('./colony.ts')

test('an empty file is the built-in board — a fresh install has one that runs', () => {
  const { layer, errors } = parseGlobalColony('', 'floe.toml')
  assert.deepEqual(errors, [])
  assert.deepEqual(mergeColony([layer]), DEFAULT_COLONY)
})

test('the stage list is all-or-nothing: a layer that declares any replaces them all', () => {
  const { layer } = parseProjectColony(
    ['[[stage]]', 'name = "coder"', 'skill = "colony-implement"', '', '[[stage]]', 'name = "cleaner"', 'skill = "colony-refactor"', 'cap = 1'].join('\n'),
    'colony.toml'
  )
  const merged = mergeColony([layer])
  assert.deepEqual(
    merged.stages.map((s) => s.name),
    ['coder', 'cleaner']
  )
  // Not patched into the built-in six — the file shows exactly what the board is.
  assert.equal(merged.stages.length, 2)
})

test('scalars inherit, so "same stages, lower cap here" is one line', () => {
  const global = parseGlobalColony('[colony]\ncap = 8\n', 'floe.toml').layer
  const project = parseProjectColony('cap = 3\n', 'colony.toml').layer
  assert.equal(mergeColony([global]).cap, 8)
  assert.equal(mergeColony([global, project]).cap, 3)
  // And the stages fall all the way back to the built-in list.
  assert.deepEqual(mergeColony([global, project]).stages, DEFAULT_COLONY.stages)
})

test('a stage may lower its own cap; unset takes the board’s', () => {
  const { layer } = parseProjectColony(
    ['cap = 4', '[[stage]]', 'name = "coder"', 'skill = "x"', '', '[[stage]]', 'name = "cleaner"', 'skill = "y"', 'cap = 1'].join('\n'),
    'colony.toml'
  )
  const config = mergeColony([layer])
  assert.equal(capOf(config.stages[0], config), 4)
  assert.equal(capOf(config.stages[1], config), 1)
})

test('reading never throws — a bad value falls back and lands in errors', () => {
  const bad = parseProjectColony('cap = "lots"\n[[stage]]\nname = "coder"\n', 'colony.toml')
  assert.equal(bad.errors.length, 2, 'the cap and the skill-less stage')
  // The board still exists: nothing usable was declared, so it inherits.
  assert.deepEqual(mergeColony([bad.layer]), DEFAULT_COLONY)
})

test('the two ends cannot be declared as stages', () => {
  const { layer, errors } = parseProjectColony('[[stage]]\nname = "inbox"\nskill = "x"\n', 'colony.toml')
  assert.equal(errors.length, 1)
  assert.match(errors[0].reason, /board's own ends/)
  assert.deepEqual(layer.stages, [])
})

test('two stages with one name is rejected — the name is how a lane is addressed', () => {
  const { layer, errors } = parseProjectColony(
    ['[[stage]]', 'name = "coder"', 'skill = "a"', '[[stage]]', 'name = "coder"', 'skill = "b"'].join('\n'),
    'colony.toml'
  )
  assert.equal(errors.length, 1)
  assert.deepEqual(layer.stages?.map((s) => s.skill), ['a'])
})

test('a stage config forgot keeps its column, capped at 0, until it drains', () => {
  const config = mergeColony([])
  const columns = columnsFor(config, ['coder', 'polisher', 'inbox'])
  const gone = columns.find((c) => c.name === 'polisher')
  assert.ok(gone, 'the column a task still sits in stays on the board')
  assert.equal(capOf(gone, config), 0, 'and stops accepting new arrivals')
  // The two ends are the board's, never conjured as a stage.
  assert.equal(columns.some((c) => c.name === 'inbox'), false)
})

test('autonomous and cleanup are off by default, inherit, and a task’s own value wins', async () => {
  const { resolveFlag } = await import('./colony.ts')
  assert.equal(DEFAULT_COLONY.autonomous, false)
  assert.equal(DEFAULT_COLONY.cleanup, false)
  const global = parseGlobalColony('[colony]\nautonomous = true\n', 'floe.toml').layer
  const project = parseProjectColony('cleanup = true\n', 'colony.toml').layer
  const config = mergeColony([global, project])
  assert.equal(config.autonomous, true)
  assert.equal(config.cleanup, true)
  assert.equal(resolveFlag({}, config, 'cleanup'), true)
  assert.equal(resolveFlag({ cleanup: false }, config, 'cleanup'), false)
})

test('the step report is off by default and inherits like any scalar', () => {
  assert.equal(DEFAULT_COLONY.report, false)
  const global = parseGlobalColony('[colony]\nreport = true\n', 'floe.toml').layer
  assert.equal(mergeColony([global]).report, true)
  const project = parseProjectColony('report = false\n', 'colony.toml').layer
  assert.equal(mergeColony([global, project]).report, false)
})
