import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import {
  CHUNK_LIMIT,
  mediaResponse,
  mediaUrl,
  parseRange,
  pathFromMediaUrl,
  probeMedia,
  readMediaChunk,
  resolveMediaPath
} from './media.ts'

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

test('a chunk is the slice that was asked for, and says how big the file is', async () => {
  const chunk = await readMediaChunk(video, 2, 3)
  assert.equal(chunk?.size, 10)
  assert.equal(chunk?.mediaType, 'video/mp4')
  assert.equal(chunk?.start, 2)
  assert.equal(chunk?.end, 4)
  assert.equal(Buffer.from(chunk!.base64, 'base64').toString(), '234')
})

test('a chunk stops at the end of the file, and at the frame limit', async () => {
  const tail = await readMediaChunk(video, 8, 999)
  assert.equal(Buffer.from(tail!.base64, 'base64').toString(), '89')
  assert.equal(tail?.end, 9)
  // Past the end there is nothing to send, and `end` says so rather than lying.
  const past = await readMediaChunk(video, 10, 4)
  assert.equal(past?.base64, '')
  assert.equal(past?.end, 9)
  assert.ok(CHUNK_LIMIT >= 1024)
})

test('a chunk of something that is not a playable video is refused', async () => {
  assert.equal(await readMediaChunk(join(dir, 'notes.txt'), 0, 4), null)
  assert.equal(await readMediaChunk(join(dir, 'nope.mp4'), 0, 4), null)
  // Junk offsets read from the start rather than throwing at the caller.
  const odd = await readMediaChunk(video, Number.NaN, 2)
  assert.equal(odd?.start, 0)
})

test('a transcript screenshot is served with its own type; a text file still is not', async () => {
  const png = join(dir, 'shot.png')
  writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  const res = mediaResponse(mediaUrl(png), null)
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('Content-Type'), 'image/png')
  assert.equal(Buffer.from(await res.arrayBuffer()).length, 4)

  const txt = join(dir, 'notes.txt')
  writeFileSync(txt, 'hi')
  assert.equal(mediaResponse(mediaUrl(txt), null).status, 415)
})
