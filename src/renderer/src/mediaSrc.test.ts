import test from 'node:test'
import assert from 'node:assert/strict'
import { mediaSrc } from './mediaSrc.ts'

test('the desktop keeps the scheme it registered', () => {
  const url = 'floe-media://file/tmp/demo.mp4'
  assert.equal(mediaSrc(url, false), url)
})

test('a browser gets the daemon route, with the encoding untouched', () => {
  // What mediaUrl() writes for `/tmp/my demo #2.mp4`.
  const url = 'floe-media://file/tmp/my%20demo%20%232.mp4'
  assert.equal(mediaSrc(url, true), '/media/tmp/my%20demo%20%232.mp4')
})

test('anything that is not ours is left alone', () => {
  assert.equal(mediaSrc('https://floe.dev/a.mp4', true), 'https://floe.dev/a.mp4')
  assert.equal(mediaSrc('data:video/mp4;base64,AA', true), 'data:video/mp4;base64,AA')
})
