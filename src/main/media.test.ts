import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { mediaResponse, mediaUrl, parseRange, pathFromMediaUrl, probeMedia, resolveMediaPath } from './media.ts'

const dir = mkdtempSync(join(tmpdir(), 'floe-media-'))
const video = join(dir, 'demo.mp4')
writeFileSync(video, Buffer.from('0123456789'))

test('a path survives the round trip through the url, spaces and all', () => {
  const path = '/tmp/my demo #2.mp4'
  assert.equal(pathFromMediaUrl(mediaUrl(path)), path)
})

test('a url of another scheme is not ours', () => {
  assert.equal(pathFromMediaUrl('https://floe.dev/a.mp4'), null)
})

test('~ is expanded, and a relative path needs the worktree', () => {
  assert.equal(resolveMediaPath('~/a.mp4'), join(homedir(), 'a.mp4'))
  assert.equal(resolveMediaPath('out/a.mp4'), null)
  assert.equal(resolveMediaPath('out/a.mp4', '/w'), '/w/out/a.mp4')
})

test('a probe answers only for a video that is really there', () => {
  const found = probeMedia(video)
  assert.equal(found?.name, 'demo.mp4')
  assert.equal(found?.mediaType, 'video/mp4')
  assert.equal(found?.size, 10)
  assert.equal(probeMedia(join(dir, 'nope.mp4')), null)
  // A directory that happens to be named like one is not a video.
  mkdirSync(join(dir, 'weird.mov'))
  assert.equal(probeMedia(join(dir, 'weird.mov')), null)
})

test('a file that is not a video gets no player', () => {
  writeFileSync(join(dir, 'notes.txt'), 'x')
  assert.equal(probeMedia(join(dir, 'notes.txt')), null)
})

test('the range the player asks for is clamped to the file', () => {
  assert.deepEqual(parseRange('bytes=0-', 10), { start: 0, end: 9 })
  assert.deepEqual(parseRange('bytes=2-5', 10), { start: 2, end: 5 })
  assert.deepEqual(parseRange('bytes=2-99', 10), { start: 2, end: 9 })
  // The trailing-bytes form: how a player reads an index at the end of a file.
  assert.deepEqual(parseRange('bytes=-4', 10), { start: 6, end: 9 })
  assert.equal(parseRange('bytes=20-', 10), null)
  assert.equal(parseRange(null, 10), null)
})

test('a range request comes back as a 206 with just those bytes', async () => {
  const res = mediaResponse(mediaUrl(video), 'bytes=2-4')
  assert.equal(res.status, 206)
  assert.equal(res.headers.get('Content-Range'), 'bytes 2-4/10')
  assert.equal(res.headers.get('Content-Length'), '3')
  assert.equal(await res.text(), '234')
})

test('no range means the whole file, and seeking is still offered', async () => {
  const res = mediaResponse(mediaUrl(video), null)
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('Accept-Ranges'), 'bytes')
  assert.equal(res.headers.get('Content-Type'), 'video/mp4')
  assert.equal(await res.text(), '0123456789')
})

test('a missing file is a 404, not a hang', () => {
  assert.equal(mediaResponse(mediaUrl(join(dir, 'gone.mp4')), null).status, 404)
})
