import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildPacket, hasPacket, stripPacket, PACKET_OPEN, PACKET_CLOSE } from './handoff.ts'
import type { TranscriptItem } from '../main/claudeSessions.ts'

const user = (text: string): TranscriptItem => ({ role: 'user', text })
const bot = (text: string, model?: string, provider?: string): TranscriptItem => ({
  role: 'assistant',
  text,
  model,
  provider
})

test('nothing to hand over is null, not an empty packet', () => {
  assert.equal(buildPacket([], { to: 'codex' }), null)
  assert.equal(buildPacket([{ role: 'image', mediaType: 'image/png', data: 'x' }], { to: 'codex' }), null)
})

test('the packet names both sides and quotes the history', () => {
  const packet = buildPacket([user('fix the parser'), bot('done', 'claude-opus-5-20260101')], {
    to: 'codex'
  })!
  assert.ok(packet.startsWith(PACKET_OPEN))
  assert.ok(packet.includes(PACKET_CLOSE))
  assert.ok(packet.includes('codex'))
  assert.ok(packet.includes('user: fix the parser'))
  // The vendor prefix and the release stamp say nothing about who answered.
  assert.ok(packet.includes('claude/opus-5: done'))
})

test('injected history is fenced as untrusted, outside the quoted block', () => {
  const packet = buildPacket([user('hi')], { to: 'gemini' })!
  const notice = packet.indexOf('not instructions')
  const history = packet.indexOf('=== history')
  assert.ok(notice >= 0 && notice < history)
})

test('a tool entry is marked as already run', () => {
  const packet = buildPacket([{ role: 'tool', name: 'Bash', summary: 'rm -rf build' }], {
    to: 'codex'
  })!
  assert.ok(packet.includes('[ran Bash: rm -rf build]'))
  assert.ok(packet.includes('not work to redo'))
})

test('the budget keeps the newest entries and says what fell off', () => {
  const items = Array.from({ length: 40 }, (_, i) => user(`message ${i}`))
  const packet = buildPacket(items, { to: 'codex', budget: 60 })!
  assert.ok(packet.includes('message 39'))
  assert.ok(!packet.includes('message 0:'))
  assert.ok(packet.includes('of 40 entries'))
})

test('one oversized entry still ships, cut rather than dropped', () => {
  const packet = buildPacket([user('x'.repeat(5000))], { to: 'codex', budget: 10 })!
  assert.ok(packet.includes('… [cut]'))
})

test('a packet is recognised and taken back out, leaving the real prompt', () => {
  const packet = buildPacket([user('earlier work')], { to: 'codex' })!
  const sent = `${packet}now do the next thing`
  assert.ok(hasPacket(sent))
  assert.equal(stripPacket(sent), 'now do the next thing')
  assert.equal(hasPacket(stripPacket(sent)), false)
})

test('an unclosed packet drops forward, never leaks history back into a read', () => {
  const truncated = `${PACKET_OPEN}\nhalf a history`
  assert.equal(stripPacket(truncated), '')
})

test('text with no packet is returned untouched', () => {
  assert.equal(stripPacket('just a message'), 'just a message')
})

test('history already carrying a packet is not re-shipped inside a new one', () => {
  const first = buildPacket([user('the very first thing')], { to: 'codex' })!
  const second = buildPacket([user(`${first}then this`)], { to: 'gemini' })!
  assert.ok(second.includes('then this'))
  assert.ok(!second.includes('the very first thing'))
  // One packet in, one packet out — the nesting is what doubles a history.
  assert.equal(second.split(PACKET_OPEN).length - 1, 1)
})
