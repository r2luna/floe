import test from 'node:test'
import assert from 'node:assert/strict'
import { handleRows, routeAll, routeAt, rosterOf, splitMentions, unrouted } from './mentions.ts'
import type { TranscriptItem } from '../../main/claudeSessions.ts'

test('a handle is split out of the sentence around it', () => {
  assert.deepEqual(splitMentions('pede pro @codex revisar'), [
    { text: 'pede pro ' },
    { text: '@codex', nick: 'codex' },
    { text: ' revisar' }
  ])
})

test('an address is not a handle', () => {
  assert.deepEqual(splitMentions('manda pro rafael@lunardelli.me'), [
    { text: 'manda pro rafael@lunardelli.me' }
  ])
})

test('two handles in one line are two chips', () => {
  assert.deepEqual(
    splitMentions('@explore-3fa9 e @floe-8f acharam a mesma coisa').filter((p) => p.nick),
    [
      { text: '@explore-3fa9', nick: 'explore-3fa9' },
      { text: '@floe-8f', nick: 'floe-8f' }
    ]
  )
})

const roster = (items: TranscriptItem[]) =>
  rosterOf(items, { you: 'pinguim', model: 'claude', runtimes: ['codex'] }).map((h) => [h.nick, h.kind])

test('the channel always holds you and whoever is answering', () => {
  assert.deepEqual(roster([]), [
    ['pinguim', 'you'],
    ['claude', 'model'],
    ['codex', 'runtime']
  ])
})

test('everyone who spoke is addressable, newest first', () => {
  const items: TranscriptItem[] = [
    { role: 'user', text: 'faz aí' },
    { role: 'subagent', toolUseId: 'toolu_aa3f', agentType: 'Explore', summary: 'mapear', harness: 'claude' },
    { role: 'assistant', from: 'explore-aa3f', text: 'achei' },
    { role: 'user', from: 'floe-8f', text: 'não mexe em skills.ts' }
  ]
  assert.deepEqual(roster(items), [
    ['pinguim', 'you'],
    ['claude', 'model'],
    ['floe-8f', 'session'],
    ['explore-aa3f', 'agent'],
    ['codex', 'runtime']
  ])
})

test('a runtime that already spoke is listed once, as itself', () => {
  const items: TranscriptItem[] = [
    { role: 'subagent', toolUseId: 'codex:k:1', agentType: 'codex', harness: 'codex', summary: 'revisar' },
    { role: 'assistant', from: 'codex', text: 'P1 — o replay não guarda subagentes' }
  ]
  assert.deepEqual(roster(items), [
    ['pinguim', 'you'],
    ['claude', 'model'],
    ['codex', 'agent']
  ])
})

/* --- routing: a handle at the start hands the message over ---------------- */

const HARNESSES = ['claude', 'codex', 'lmstudio']

test('a handle opening the line routes, and comes off the prompt', () => {
  assert.deepEqual(routeAt('@codex revisa o diff', HARNESSES), {
    harness: 'codex',
    model: undefined,
    effort: undefined,
    prompt: 'revisa o diff'
  })
})

test('a handle mid-sentence is a name, not an address', () => {
  assert.equal(routeAt('pergunta pro @codex sobre isso', HARNESSES), null)
})

test('a handle nobody can run is left in the sentence', () => {
  assert.equal(routeAt('@explore-3fa9 o que voce achou', HARNESSES), null)
})

test('the handle names the model, the effort, or both', () => {
  assert.deepEqual(routeAt('@codex:gpt-5.6-sol:high vai', HARNESSES), {
    harness: 'codex',
    model: 'gpt-5.6-sol',
    effort: 'high',
    prompt: 'vai'
  })
  // Effort is a closed set of five words and no slug is called "max", so one
  // part is enough to say which of the two it is.
  assert.deepEqual(routeAt('@codex:max vai', HARNESSES), {
    harness: 'codex',
    model: undefined,
    effort: 'max',
    prompt: 'vai'
  })
  assert.deepEqual(routeAt('@lmstudio:qwen/qwen3.6-35b-a3b vai', HARNESSES), {
    harness: 'lmstudio',
    model: 'qwen/qwen3.6-35b-a3b',
    effort: undefined,
    prompt: 'vai'
  })
})

test('a handle with nothing after it still routes, with an empty prompt', () => {
  assert.deepEqual(routeAt('@codex', HARNESSES), {
    harness: 'codex',
    model: undefined,
    effort: undefined,
    prompt: ''
  })
})

test('a longer name starting with a harness is not that harness', () => {
  assert.equal(routeAt('@codexicon faz isso', HARNESSES), null)
})

test('the whole handle is one chip, coloured by the name alone', () => {
  assert.deepEqual(splitMentions('@codex:gpt-5.6-sol:high vai'), [
    { text: '@codex:gpt-5.6-sol:high', nick: 'codex' },
    { text: ' vai' }
  ])
})

/* --- the menu behind the handle ------------------------------------------- */

test('only a harness narrows: models, then efforts under each', () => {
  const rows = handleRows(
    [
      { nick: 'you', kind: 'you' },
      { nick: 'codex', kind: 'runtime' },
      { nick: 'explore-3fa9', kind: 'agent' }
    ],
    {
      harnesses: ['codex'],
      modelsOf: () => [{ slug: 'gpt-5.6-sol', label: 'GPT-5.6' }]
    }
  )
  assert.equal(rows[0].variants, undefined)
  assert.equal(rows[2].variants, undefined)
  // Its own default leads, then the models it lists.
  assert.deepEqual(
    rows[1].variants?.map((v) => v.id),
    ['@codex', '@codex:gpt-5.6-sol']
  )
  assert.deepEqual(
    rows[1].variants?.[1].variants?.map((v) => v.id),
    [
      '@codex:gpt-5.6-sol:low',
      '@codex:gpt-5.6-sol:medium',
      '@codex:gpt-5.6-sol:high',
      '@codex:gpt-5.6-sol:xhigh',
      '@codex:gpt-5.6-sol:max'
    ]
  )
})

test('an addressed turn is not the session speaking', () => {
  const items = [
    { role: 'user', text: 'oi' },
    { role: 'assistant', text: 'ola', provider: undefined },
    { role: 'user', text: '@lmstudio conte uma piada' },
    { role: 'assistant', text: 'uma piada', provider: 'lmstudio' }
  ]
  assert.deepEqual(
    unrouted(items, HARNESSES).map((i) => i.text),
    ['oi', 'ola', '@lmstudio conte uma piada']
  )
})

test('everything an addressed turn produced goes, not just its last word', () => {
  const items = [
    { role: 'user', text: '@codex arruma' },
    { role: 'tool', text: 'edit' },
    { role: 'assistant', text: 'pronto' },
    { role: 'user', text: 'obrigado' },
    { role: 'assistant', text: 'de nada' }
  ]
  assert.deepEqual(
    unrouted(items, HARNESSES).map((i) => i.text),
    ['@codex arruma', 'obrigado', 'de nada']
  )
})

test('a model whose own name has a colon survives the parse', () => {
  // Ollama names them `llama3.2:latest`, and the submenu writes exactly that.
  assert.deepEqual(routeAt('@ollama:llama3.2:latest resuma', ['ollama']), {
    harness: 'ollama',
    model: 'llama3.2:latest',
    effort: undefined,
    prompt: 'resuma'
  })
  assert.deepEqual(routeAt('@ollama:llama3.2:latest:max resuma', ['ollama']), {
    harness: 'ollama',
    model: 'llama3.2:latest',
    effort: 'max',
    prompt: 'resuma'
  })
})

test('the punctuation of the sentence is not part of the handle', () => {
  assert.deepEqual(routeAt('@codex, revisa', HARNESSES), {
    harness: 'codex',
    model: undefined,
    effort: undefined,
    prompt: 'revisa'
  })
  assert.deepEqual(routeAt('@codex:high, revisa', HARNESSES), {
    harness: 'codex',
    model: undefined,
    effort: 'high',
    prompt: 'revisa'
  })
})

test('a full stop ends the sentence, it does not end up in the slug', () => {
  assert.deepEqual(routeAt('@codex:high. revisa', HARNESSES), {
    harness: 'codex',
    model: undefined,
    effort: 'high',
    prompt: 'revisa'
  })
  assert.deepEqual(routeAt('@codex:gpt-5.6-sol. revisa', HARNESSES), {
    harness: 'codex',
    model: 'gpt-5.6-sol',
    effort: undefined,
    prompt: 'revisa'
  })
  assert.deepEqual(routeAt('@ollama:llama3.2:latest. resuma', ['ollama'])?.model, 'llama3.2:latest')
})

test('@all is one message to several, and names none of them', () => {
  // The targets are not in the text and must not be: fanning out to every
  // harness the machine has installed is the failure this shape prevents (R7).
  assert.deepEqual(routeAll('@all o que voces acham disso'), {
    effort: undefined,
    prompt: 'o que voces acham disso'
  })
})

test('@all:high sets one effort for everybody', () => {
  assert.deepEqual(routeAll('@all:high revisa o diff'), {
    effort: 'high',
    prompt: 'revisa o diff'
  })
  // Not an effort: `@all:opus` would otherwise go out at a level nobody chose.
  assert.equal(routeAll('@all:opus revisa'), null)
})

test('@all mid-sentence is a word', () => {
  assert.equal(routeAll('manda isso pro @all depois'), null)
  assert.equal(routeAll('@allowlist do repo'), null)
})
