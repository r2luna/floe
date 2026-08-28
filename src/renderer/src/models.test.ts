import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  addressOf,
  describeChoice,
  hostOf,
  lastChoice,
  loadChoice,
  speakerKey,
  windowOf
} from './models.ts'

test('the vendor prefix is not part of who answered', () => {
  assert.equal(hostOf('claude-opus-5'), 'opus-5')
})

test('a release stamp is noise', () => {
  assert.equal(hostOf('claude-haiku-4-5-20251001'), 'haiku-4-5')
})

test('another vendor keeps its own shape', () => {
  assert.equal(hostOf('gpt-5.6-sol'), 'gpt-5.6-sol')
})

test('a synthetic reply has no model, so it gets no host', () => {
  assert.equal(hostOf('<synthetic>'), undefined)
  assert.equal(hostOf(undefined), undefined)
  assert.equal(hostOf(''), undefined)
})

test('the full address names who, how hard, and on what', () => {
  assert.deepEqual(addressOf('claude', 'claude-opus-5', 'max'), {
    nick: 'claude',
    ident: 'max',
    host: 'opus-5'
  })
})

test('an unknown part is dropped, never guessed', () => {
  // No effort recorded (older transcripts, or a turn the CLI did not stamp).
  assert.deepEqual(addressOf('claude', 'claude-opus-5', undefined), {
    nick: 'claude',
    ident: undefined,
    host: 'opus-5'
  })
})

test('a synthetic reply is a bare nick — no model means no turn to describe', () => {
  assert.deepEqual(addressOf('claude', '<synthetic>', 'high'), {
    nick: 'claude',
    ident: undefined,
    host: undefined
  })
})

test('the user has no model and no effort', () => {
  assert.deepEqual(addressOf('rafael'), { nick: 'rafael', ident: undefined, host: undefined })
})

// The five addresses one real session actually produced — same nick throughout,
// two models, three efforts. Every change of either has to break the run.
test('a change of model OR effort is a change of speaker', () => {
  const key = (model?: string, effort?: string) => speakerKey(addressOf('claude', model, effort))
  const seen = [
    key('claude-sonnet-5', 'medium'),
    key('claude-sonnet-5', 'low'),
    key('claude-opus-5', 'high'),
    key('claude-haiku-4-5-20251001', undefined),
    key('claude-opus-5', 'medium')
  ]
  assert.equal(new Set(seen).size, 5, 'each address is its own speaker')
  // …and the same address twice in a row is one speaker, so the run holds.
  assert.equal(key('claude-opus-5', 'high'), key('claude-opus-5', 'high'))
})

test('a choice from another runtime survives a reload', () => {
  // MODELS is Claude's list; validating a Codex or LM Studio model against it
  // would silently reset the picker to Opus every time the app started.
  const stored = { model: 'gpt-5.5', effort: 'high', provider: 'codex' }
  const store = new Map([['rookery.model', JSON.stringify(stored)]])
  ;(globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v)
  }
  assert.deepEqual(loadChoice(), { model: 'gpt-5.5', effort: 'high', provider: 'codex' })
})

test('a Claude model that no longer exists falls back', () => {
  const store = new Map([['rookery.model', JSON.stringify({ model: 'sonnet-3', effort: 'low' })]])
  ;(globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: () => {}
  }
  assert.deepEqual(loadChoice(), { model: 'opus', effort: 'low' })
})

const AGENTS = [
  { id: 'lmstudio', models: [{ slug: 'kimi-k2.7-code', contextWindow: 262_144 }] },
  { id: 'codex', models: [{ slug: 'gpt-5.5', contextWindow: 272_000 }] },
  { id: 'gemini', models: [] }
]

test('the window comes from whoever knows it', () => {
  assert.equal(windowOf({ model: 'opus', effort: 'high' }, AGENTS), 1_000_000)
  assert.equal(windowOf({ model: 'haiku', effort: 'low' }, AGENTS), 200_000)
  assert.equal(
    windowOf({ model: 'kimi-k2.7-code', effort: 'high', provider: 'lmstudio' }, AGENTS),
    262_144
  )
})

test('an unknown window is undefined, not Claude’s million', () => {
  // A 262k model measured against a million reads as empty when it is full —
  // guessing here would make the gauge lie rather than say nothing.
  assert.equal(windowOf({ model: '', effort: 'high', provider: 'gemini' }, AGENTS), undefined)
  assert.equal(windowOf({ model: 'sonnet-9', effort: 'high' }, AGENTS), undefined)
})

test('the picker button names the harness, the model and the effort', () => {
  assert.deepEqual(describeChoice({ model: 'opus', effort: 'high' }), {
    harness: 'claude',
    model: 'Opus 5',
    effort: 'high'
  })
  assert.deepEqual(
    describeChoice({ model: 'gpt-5.4-mini', effort: 'medium', provider: 'codex' }),
    { harness: 'codex', model: 'gpt-5.4-mini', effort: 'medium' }
  )
})

test('a runtime with no named model shows the harness alone, never "default"', () => {
  // "default High" was the old button, and it answered nothing: default of what?
  assert.deepEqual(describeChoice({ model: '', effort: 'high', provider: 'gemini' }), {
    harness: 'gemini',
    model: '',
    effort: 'high'
  })
})

test('a session answers as whoever answered it last', () => {
  // Codex logs the slug it ran; it goes back to the picker unchanged.
  assert.deepEqual(
    lastChoice([
      { role: 'assistant', model: 'claude-opus-5', effort: 'high' },
      { role: 'user' },
      { role: 'assistant', model: 'gpt-5.6-luna', effort: 'high', provider: 'codex' }
    ]),
    { model: 'gpt-5.6-luna', effort: 'high', provider: 'codex' }
  )
  // Claude logs the id it resolved; only the alias can be sent back.
  assert.deepEqual(lastChoice([{ role: 'assistant', model: 'claude-haiku-4-5-20251001' }]), {
    model: 'haiku',
    effort: 'high'
  })
  // Nothing to go on: leave the picker alone rather than guess.
  assert.equal(lastChoice([{ role: 'user' }]), null)
  assert.equal(lastChoice([{ role: 'assistant', model: 'some-model-we-cannot-map' }]), null)
})
