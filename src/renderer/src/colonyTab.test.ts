import test from 'node:test'
import assert from 'node:assert/strict'
import { colonyCounts, colonyTab, setColonyCounts, setColonyTab, stepTab } from './colonyTab.ts'

test('[ and ] walk the tabs and wrap at both ends', () => {
  assert.equal(stepTab('overview', 1), 'ideas')
  assert.equal(stepTab('ideas', 1), 'board')
  assert.equal(stepTab('board', 1), 'overview')
  assert.equal(stepTab('overview', -1), 'board')
})

test('a project starts on the overview and keeps its own tab', () => {
  assert.equal(colonyTab(undefined), 'overview')
  assert.equal(colonyTab('/repo/a'), 'overview')
  setColonyTab('/repo/a', 'ideas')
  assert.equal(colonyTab('/repo/a'), 'ideas')
  assert.equal(colonyTab('/repo/b'), 'overview')
})

test('counts are per project and an unchanged write keeps the same object', () => {
  assert.equal(colonyCounts('/repo/a'), undefined)
  setColonyCounts('/repo/a', { asking: 2, ideas: 9, cards: 13 })
  const first = colonyCounts('/repo/a')
  setColonyCounts('/repo/a', { asking: 2, ideas: 9, cards: 13 })
  // Same object: useSyncExternalStore would otherwise re-render the head forever.
  assert.equal(colonyCounts('/repo/a'), first)
  assert.equal(colonyCounts('/repo/b'), undefined)
})
