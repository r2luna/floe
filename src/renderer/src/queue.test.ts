import assert from 'node:assert/strict'
import test from 'node:test'
import { takeBatch, type Queued } from './queue.ts'

const q = (text: string, linked = false): Queued => ({ id: text, text, linked })

test('an empty queue has nothing to send', () => {
  assert.equal(takeBatch([]), null)
})

test('one message per boundary', () => {
  // The rule that keeps every turn a clean request and response: the queue does
  // not flush in one shot just because the model went idle.
  const out = takeBatch([q('one'), q('two'), q('three')])!
  assert.equal(out.text, 'one')
  assert.deepEqual(
    out.rest.map((r) => r.text),
    ['two', 'three']
  )
})

test('a run of linked messages goes out as one', () => {
  const out = takeBatch([q('first'), q('and this', true), q('and this too', true), q('later')])!
  assert.equal(out.text, 'first\n\nand this\n\nand this too')
  assert.deepEqual(
    out.rest.map((r) => r.text),
    ['later']
  )
})

test('the run stops at the first unlinked message', () => {
  const out = takeBatch([q('a'), q('b', true), q('c'), q('d', true)])!
  assert.equal(out.text, 'a\n\nb')
  assert.deepEqual(
    out.rest.map((r) => r.text),
    ['c', 'd']
  )
})

test('a linked flag on the head is ignored', () => {
  // Nothing above it in this batch to link to — it must not swallow the next
  // message on the strength of a flag that no longer means anything.
  const out = takeBatch([q('head', true), q('next')])!
  assert.equal(out.text, 'head')
  assert.equal(out.rest.length, 1)
})

test('attachments ride with the batch that carries their text', () => {
  const img = (id: string): Queued['images'] => [{ id, mediaType: 'image/png', data: 'x' }]
  const out = takeBatch([
    { ...q('a'), images: img('1') },
    { ...q('b', true), images: img('2') },
    { ...q('c'), images: img('3') }
  ])!
  assert.deepEqual(
    out.images!.map((i) => i.id),
    ['1', '2']
  )
  // The unlinked message keeps its own image for its own turn.
  assert.deepEqual(out.rest[0].images?.map((i) => i.id), ['3'])
})

test('a queued message keeps the harness it was addressed to', () => {
  const batch = takeBatch([
    { id: '1', text: 'revisa isso', shown: '@codex revisa isso', choice: { model: 'gpt-5.6-sol', effort: 'high', provider: 'codex' }, linked: false },
    { id: '2', text: 'depois', linked: false }
  ])
  assert.equal(batch?.text, 'revisa isso')
  assert.equal(batch?.shown, '@codex revisa isso')
  assert.equal(batch?.choice?.provider, 'codex')
})

test('a message that named nobody still remembers what the picker said', () => {
  // The panel that drains it may be a fresh mount (you switched chats and came
  // back), whose own ref says the default. In a codex query that default is
  // Claude — so the item carries the pick, and a linked line still joins it.
  const codex = { model: '', effort: 'medium' as const, provider: 'codex' }
  const batch = takeBatch([
    { id: '1', text: 'first', picked: codex, linked: false },
    { id: '2', text: 'and this', picked: codex, linked: true }
  ])
  assert.equal(batch?.text, 'first\n\nand this')
  assert.equal(batch?.choice, undefined, 'it named nobody')
  assert.equal(batch?.picked?.provider, 'codex')
})

test('a linked run is one message, so it goes to one harness', () => {
  const batch = takeBatch([
    { id: '1', text: 'revisa isso', shown: '@codex revisa isso', choice: { model: '', effort: 'high', provider: 'codex' }, linked: false },
    { id: '2', text: 'e isso tambem', linked: true }
  ])
  assert.equal(batch?.text, 'revisa isso\n\ne isso tambem')
  // The second line said "and this too", not "and ask someone else".
  assert.equal(batch?.shown, '@codex revisa isso\n\ne isso tambem')
  assert.equal(batch?.choice?.provider, 'codex')
})

test('a linked run stops where the target changes', () => {
  const ollama = { model: 'llama3.2:latest', effort: 'high' as const, provider: 'ollama' }
  const gemini = { model: '', effort: 'high' as const, provider: 'gemini' }
  const batch = takeBatch([
    { id: '1', text: 'analise A', shown: '@ollama analise A', choice: ollama, linked: false },
    { id: '2', text: 'analise B', shown: '@gemini analise B', choice: gemini, linked: true }
  ])
  assert.equal(batch?.text, 'analise A')
  assert.equal(batch?.choice?.provider, 'ollama')
  // B is still there, and still linked — it takes its own turn, on its own
  // harness, rather than being read out to the wrong one.
  assert.equal(batch?.rest.length, 1)
  assert.equal(batch?.rest[0].choice?.provider, 'gemini')
})
