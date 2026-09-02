import test from 'node:test'
import assert from 'node:assert/strict'
import { findVideoRefs } from './videoRefs.ts'

test('the path in a sentence is found', () => {
  assert.deepEqual(findVideoRefs('gravei em /tmp/demo.mp4, da uma olhada'), ['/tmp/demo.mp4'])
})

test('a path in backticks or a markdown link is the path, not the markup', () => {
  assert.deepEqual(findVideoRefs('salvei `~/Movies/a.mov`'), ['~/Movies/a.mov'])
  assert.deepEqual(findVideoRefs('[o video](out/demo.webm) ta pronto'), ['out/demo.webm'])
})

test('a file:// url comes back as the path it names', () => {
  assert.deepEqual(findVideoRefs('file:///tmp/my%20demo.mp4'), ['/tmp/my demo.mp4'])
})

test('the same file named twice is one video', () => {
  assert.deepEqual(findVideoRefs('gravei /tmp/a.mp4 — abre /tmp/a.mp4'), ['/tmp/a.mp4'])
})

test('an address on the web is a link, not a player', () => {
  assert.deepEqual(findVideoRefs('veja https://floe.dev/demo.mp4'), [])
})

test('a word that merely ends in the extension is not a path', () => {
  assert.deepEqual(findVideoRefs('o codec dele e mp4 mesmo'), [])
  assert.deepEqual(findVideoRefs('renomeei pra .mp4'), [])
})

test('an image is left alone', () => {
  assert.deepEqual(findVideoRefs('/tmp/shot.png e /tmp/shot.gif'), [])
})

test('the full stop after the path is not part of it', () => {
  assert.deepEqual(findVideoRefs('ta em /tmp/demo.mp4.'), ['/tmp/demo.mp4'])
})

test('every video in a message, in order', () => {
  assert.deepEqual(findVideoRefs('antes: /tmp/a.mov\ndepois: /tmp/b.mp4'), [
    '/tmp/a.mov',
    '/tmp/b.mp4'
  ])
})
