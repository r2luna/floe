import assert from 'node:assert/strict'
import { test } from 'node:test'
import { clampMode, modeFromLabel, modeLabel, modesFor, nearestMode, supportsMode } from './modes.ts'

test('every runtime offers only what it can do', () => {
  assert.deepEqual(modesFor('claude'), ['plan', 'default', 'acceptEdits', 'skip'])
  assert.ok(!supportsMode('codex', 'default')) // codex cannot ask
  assert.ok(!supportsMode('gemini', 'plan')) // gemini has no read-only mode
  assert.deepEqual(modesFor('lmstudio'), []) // no tools, no mode
})

test('an unknown provider is treated as claude', () => {
  assert.deepEqual(modesFor(undefined), modesFor('claude'))
  assert.deepEqual(modesFor('something-new'), modesFor('claude'))
})

test('nearestMode never widens the blast radius on a tie', () => {
  // "ask" sits between plan and auto; codex offers both, and the safe one wins.
  assert.equal(nearestMode('default', 'codex'), 'plan')
  // opencode cannot go past auto.
  assert.equal(nearestMode('skip', 'opencode'), 'acceptEdits')
  // gemini has no plan, so the next lightest thing it does have.
  assert.equal(nearestMode('plan', 'gemini'), 'default')
  // A supported mode is returned untouched.
  assert.equal(nearestMode('acceptEdits', 'codex'), 'acceptEdits')
  // A runtime with no tools still answers with something sendable.
  assert.equal(nearestMode('skip', 'ollama'), 'default')
})

test('labels replace Claude jargon', () => {
  assert.equal(modeLabel('acceptEdits'), 'auto')
  assert.equal(modeLabel('skip'), 'bypass')
  assert.equal(modeLabel('plan'), 'plan')
})

test('the old "full" label still reads as skip', () => {
  assert.equal(modeFromLabel('full'), 'skip')
  assert.equal(modeFromLabel('bypass'), 'skip')
})

test('clampMode gives a peer no more than the session that asked for it', () => {
  // Asking for more than the caller has is answered with what the caller has.
  assert.equal(clampMode('skip', 'plan'), 'plan')
  assert.equal(clampMode('acceptEdits', 'default'), 'default')
  // Asking for less is honoured: a bypass session may still open a read-only
  // consult, and usually should.
  assert.equal(clampMode('plan', 'skip'), 'plan')
  assert.equal(clampMode('default', 'default'), 'default')
})
