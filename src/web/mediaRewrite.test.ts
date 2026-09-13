import test from 'node:test'
import assert from 'node:assert/strict'
import { rewriteProbe, rewriteTranscript, toHttpMediaUrl } from './mediaRewrite.ts'

test('the scheme becomes the daemon route, encoding untouched', () => {
  // What mediaUrl() writes for `/tmp/my demo #2.mp4`.
  const url = 'floe-media://file/tmp/my%20demo%20%232.mp4'
  assert.equal(toHttpMediaUrl(url, 'local'), '/media/local/tmp/my%20demo%20%232.mp4')
})

test('the url names the machine the file is on', () => {
  const url = 'floe-media://file/tmp/demo.mp4'
  assert.equal(toHttpMediaUrl(url, 'mac-1'), '/media/mac-1/tmp/demo.mp4')
  // An id is one segment whatever is in it — the path starts after it.
  assert.equal(toHttpMediaUrl(url, 'a/b'), '/media/a%2Fb/tmp/demo.mp4')
})

test('anything that is not ours is left alone', () => {
  assert.equal(toHttpMediaUrl('https://floe.dev/a.mp4', 'local'), 'https://floe.dev/a.mp4')
  assert.equal(toHttpMediaUrl('data:video/mp4;base64,AA', 'local'), 'data:video/mp4;base64,AA')
})

test('a probe answer comes back with a fetchable url and nothing else changed', () => {
  const probe = {
    url: 'floe-media://file/tmp/demo.mp4',
    mediaType: 'video/mp4',
    size: 16,
    name: 'demo.mp4',
    path: '/tmp/demo.mp4'
  }
  assert.deepEqual(rewriteProbe(probe, 'local'), { ...probe, url: '/media/local/tmp/demo.mp4' })
})

test('"no such video" passes through — this rewrites, it does not validate', () => {
  assert.equal(rewriteProbe(null, 'local'), null)
  assert.equal(rewriteProbe(undefined, 'local'), undefined)
  assert.deepEqual(rewriteProbe({ mediaType: 'video/mp4' }, 'local'), { mediaType: 'video/mp4' })
})

test('a transcript comes back with its served images fetchable and nothing else touched', () => {
  const rows = [
    { role: 'user', text: 'look' },
    { role: 'image', mediaType: 'image/png', src: 'floe-media://file/tmp/cache/ab.png' },
    { role: 'image', mediaType: 'image/png', data: 'AA==' }
  ]
  assert.deepEqual(rewriteTranscript(rows, 'mac-1'), [
    rows[0],
    { role: 'image', mediaType: 'image/png', src: '/media/mac-1/tmp/cache/ab.png' },
    rows[2]
  ])
  // Not a list: not a transcript. Passed through, not guessed at.
  assert.equal(rewriteTranscript(null, 'local'), null)
  assert.deepEqual(rewriteTranscript({ items: [] }, 'local'), { items: [] })
})
