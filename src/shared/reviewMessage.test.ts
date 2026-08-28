import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildReviewMessage, quoteBlock, fenceBlock } from './reviewMessage.ts'

test('quoteBlock prefixes every line, including blank ones', () => {
  assert.equal(quoteBlock('a\n\nb'), '> a\n> \n> b')
})

test('fenceBlock wraps with an optional language', () => {
  assert.equal(fenceBlock('x', 'diff'), '```diff\nx\n```')
  assert.equal(fenceBlock('x'), '```\nx\n```')
})

test('one group with one entry', () => {
  const out = buildReviewMessage('Please address these:', [
    { heading: 'src/a.ts:10', entries: [{ quoted: '> hi', body: 'why?' }] }
  ])
  assert.equal(out, 'Please address these:\n\n### src/a.ts:10\n\n> hi\nwhy?')
})

test('multiple groups keep their order and headings', () => {
  const out = buildReviewMessage('H', [
    { heading: 'one', entries: [{ quoted: '> a', body: 'A' }] },
    { heading: 'two', entries: [{ quoted: '> b', body: 'B' }] }
  ])
  assert.match(out, /### one[\s\S]*### two/)
  assert.ok(out.indexOf('### one') < out.indexOf('### two'))
})

test('several entries under one heading share it', () => {
  const out = buildReviewMessage('H', [
    {
      heading: 'file.ts',
      entries: [
        { quoted: '> a', body: 'A' },
        { quoted: '> b', body: 'B' }
      ]
    }
  ])
  assert.equal(out.match(/### file\.ts/g)?.length, 1)
  assert.match(out, /A[\s\S]*B/)
})

// A heading with nothing under it reads as a bug to whoever gets the message.
test('empty groups are dropped, not emitted as bare headings', () => {
  const out = buildReviewMessage('H', [
    { heading: 'empty', entries: [] },
    { heading: 'real', entries: [{ quoted: '> a', body: 'A' }] }
  ])
  assert.equal(out.includes('### empty'), false)
  assert.match(out, /### real/)
})

test('no groups at all leaves just the header, trimmed', () => {
  assert.equal(buildReviewMessage('H', []), 'H')
})

test('output never has trailing blank lines', () => {
  const out = buildReviewMessage('H', [{ heading: 'a', entries: [{ quoted: '> q', body: 'b' }] }])
  assert.equal(out, out.trimEnd())
})
