import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hasPremise, premiseIn, PREMISE_NOTE, stripPremise, wrapPremise } from './premise.ts'

const BRIEF = '## Goal\nShip the thing.\n\n## Done when\nIt ships.'

test('the block carries the note and the brief, and ends clear of the prompt', () => {
  const seed = wrapPremise(BRIEF)
  assert.match(seed, /^<worktree-premise>\n/)
  assert.match(seed, /<\/worktree-premise>\n\n$/)
  assert.ok(seed.includes(PREMISE_NOTE))
  assert.ok(seed.includes('Ship the thing.'))
})

test('the brief comes back out without the note we wrapped it in', () => {
  assert.equal(premiseIn(wrapPremise(BRIEF) + 'is ai-memory working?'), BRIEF)
  assert.equal(premiseIn('nothing here'), null)
})

test('a block written without our note comes back whole rather than empty', () => {
  const old = '<worktree-premise>\n## Goal\nSomething older.\n</worktree-premise>'
  assert.equal(premiseIn(old), '## Goal\nSomething older.')
})

test('stripping leaves the message the user actually typed', () => {
  const sent = wrapPremise(BRIEF) + 'is ai-memory working?'
  assert.ok(hasPremise(sent))
  assert.equal(stripPremise(sent), 'is ai-memory working?')
  assert.equal(hasPremise(stripPremise(sent)), false)
})

test('a prompt with no block is returned untouched', () => {
  assert.equal(stripPremise('just a message'), 'just a message')
  assert.equal(hasPremise('just a message'), false)
})
