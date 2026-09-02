import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_HOPS, hasRelay, relayBack, relayMark, relayPrompt, stripRelay } from './relay.ts'

const HARNESSES = ['claude', 'codex', 'gemini', 'opencode', 'lmstudio', 'ollama']

test('the first relay says the message was not the model\'s to begin with', () => {
  const p = relayPrompt('codex', 0)
  assert.match(p, /addressed to codex, not to you/)
  // And how to answer it back — the whole point is that the two can talk.
  assert.match(p, /START your reply with `@codex `/)
})

test('a later relay is codex answering the model, not the user', () => {
  const p = relayPrompt('codex', 1)
  assert.match(p, /codex answered what you asked it/)
})

test('the last exchange it is allowed says so, instead of inviting another', () => {
  const p = relayPrompt('codex', MAX_HOPS - 1)
  assert.match(p, /last exchange with codex/)
  assert.doesNotMatch(p, /START your reply/)
})

test('a reply routes back only when it OPENS with a handle', () => {
  assert.equal(relayBack('@codex e o teste?', HARNESSES, 1)?.prompt, 'e o teste?')
  // Mid-sentence it is a name: the model talking ABOUT codex is not talking to it.
  assert.equal(relayBack('concordo com o @codex aqui', HARNESSES, 1), null)
  // A handle with nothing after it is not a question, and must not spend a hop.
  assert.equal(relayBack('@codex', HARNESSES, 1), null)
  assert.equal(relayBack('@nobody responde', HARNESSES, 1), null)
})

test('the hop cap is the end of it, whatever the model writes', () => {
  assert.ok(relayBack('@codex mais uma', HARNESSES, MAX_HOPS - 1))
  assert.equal(relayBack('@codex mais uma', HARNESSES, MAX_HOPS), null)
})

test('the envelope is recognised and taken back out', () => {
  const p = relayPrompt('codex', 0)
  assert.ok(hasRelay(p))
  // Nothing left — the transcript then drops the line, so a relay reads as
  // codex answering and the model replying, with no note in between.
  assert.equal(stripRelay(p), '')
  assert.equal(stripRelay(relayMark('claude')), '')
  // What was said around one survives it.
  assert.equal(stripRelay(`antes\n${relayMark('claude')}`), 'antes')
  assert.equal(hasRelay('nada aqui'), false)
  assert.equal(stripRelay('nada aqui'), 'nada aqui')
})
