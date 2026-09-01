import test from 'node:test'
import assert from 'node:assert/strict'
import { agentNick } from './nicks.ts'

test('a subagent is nicked by its type and the tail of its tool_use id', () => {
  assert.equal(agentNick('Explore', 'toolu_01S9c1pKdMxZUgHmFqJQCa3f'), 'explore-ca3f')
  assert.equal(agentNick('general-purpose', 'toolu_01KjFQL7YQpXYe9RMLb3Ly2N'), 'general-purpose-ly2n')
})

test('two agents of the same type are two nicks — that is the whole point', () => {
  assert.notEqual(agentNick('Explore', 't1'), agentNick('Explore', 't2'))
})

test('a nameless agent still heads its report', () => {
  assert.equal(agentNick(undefined, 't1'), 'agent-t1')
  assert.equal(agentNick('', ''), 'agent')
  // Punctuation never lands in a nick: the id's underscore is not part of it.
  assert.equal(agentNick('  ', 'toolu_x'), 'agent-olux')
})
