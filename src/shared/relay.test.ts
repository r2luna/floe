import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_HOPS, hasRelay, relayBack, relayMark, relayPrompt, stripRelay } from './relay.ts'

const HARNESSES = ['claude', 'codex', 'gemini', 'opencode', 'lmstudio', 'ollama']

test('the first relay says the message was not the model\'s to begin with', () => {
  const p = relayPrompt('codex', 0)
  assert.match(p, /addressed to codex, not to you/)
  // And how to answer it back — the whole point is that the two can talk.
  assert.match(p, /at the START of a line/)
})

test('a later relay is codex answering the model, not the user', () => {
  const p = relayPrompt('codex', 1)
  assert.match(p, /codex answered what you asked it/)
})

test('the last exchange it is allowed says so, instead of inviting another', () => {
  const p = relayPrompt('codex', MAX_HOPS - 1)
  assert.match(p, /last exchange with codex/)
  assert.doesNotMatch(p, /at the START of a line/)
})

test('a reply routes back only when a handle OPENS a line', () => {
  assert.equal(relayBack('@codex e o teste?', HARNESSES, 1)?.prompt, 'e o teste?')
  // Mid-sentence it is a name: the model talking ABOUT codex is not talking to it.
  assert.equal(relayBack('concordo com o @codex aqui', HARNESSES, 1), null)
  // A handle with nothing after it anywhere is not a question, and must not
  // spend a hop.
  assert.equal(relayBack('@codex', HARNESSES, 1), null)
  assert.equal(relayBack('@nobody responde', HARNESSES, 1), null)
})

test('the model says its piece first and addresses codex last', () => {
  // What actually arrives here is the whole turn, joined — the sentence it
  // opened with and then the line for codex. Reading only offset 0 meant this
  // never routed, which is the bug.
  const reply = 'Concordo com a análise, mas falta o caso vazio.\n\n@codex e o teste de regressão?'
  assert.equal(relayBack(reply, HARNESSES, 1)?.harness, 'codex')
  assert.equal(relayBack(reply, HARNESSES, 1)?.prompt, 'e o teste de regressão?')
})

test('everything below the handle goes over with it', () => {
  const reply = 'Vou revisar.\n\n@codex duas coisas:\n\n1. o caso vazio\n2. o timeout'
  assert.equal(relayBack(reply, HARNESSES, 1)?.prompt, 'duas coisas:\n\n1. o caso vazio\n2. o timeout')
})

test('the LAST handle line wins — the question is what it ends on', () => {
  const reply = '@codex primeira\n\npensando melhor:\n\n@gemini segunda'
  const route = relayBack(reply, HARNESSES, 1)
  assert.equal(route?.harness, 'gemini')
  assert.equal(route?.prompt, 'segunda')
})

test('the handle still carries its model and effort from a line', () => {
  const reply = 'ok.\n\n@codex:gpt-5.6-sol:high revisa o diff'
  const route = relayBack(reply, HARNESSES, 1)
  assert.equal(route?.model, 'gpt-5.6-sol')
  assert.equal(route?.effort, 'high')
  assert.equal(route?.prompt, 'revisa o diff')
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

test('a handle inside code is a quote of one, in either spelling of a code block', () => {
  const fenced = 'Você pode escrever assim:\n\n```\n@codex revisa isso\n```\n\nÉ só isso.'
  assert.equal(relayBack(fenced, HARNESSES, 1), null)
  assert.equal(relayBack(fenced.replace(/```/g, '~~~'), HARNESSES, 1), null)
  // A fence that names its language is still a fence.
  assert.equal(relayBack('assim:\n\n```md\n@codex revisa\n```', HARNESSES, 1), null)
  // And four spaces mean the same thing in Markdown. Missing this was not
  // theoretical: an answer explaining the feature writes the example out.
  assert.equal(relayBack('Escreva assim:\n\n    @codex revisa\n\nfim.', HARNESSES, 1), null)
  assert.equal(relayBack('Escreva assim:\n\n\t@codex revisa\n\nfim.', HARNESSES, 1), null)
})

test('quoting a handle is not addressing it either', () => {
  assert.equal(relayBack('ele disse:\n\n> @codex revisa\n\nfim.', HARNESSES, 1), null)
  assert.equal(relayBack('use `@codex revisa` no começo da linha.', HARNESSES, 1), null)
})
