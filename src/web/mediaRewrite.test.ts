import test from 'node:test'
import assert from 'node:assert/strict'
import { rewriteProbe, toHttpMediaUrl } from './mediaRewrite.ts'

test('the scheme becomes the daemon route, encoding untouched', () => {
  // What mediaUrl() writes for `/tmp/my demo #2.mp4`.
  const url = 'floe-media://file/tmp/my%20demo%20%232.mp4'
  assert.equal(toHttpMediaUrl(url), '/media/tmp/my%20demo%20%232.mp4')
})

test('anything that is not ours is left alone', () => {
  assert.equal(toHttpMediaUrl('https://floe.dev/a.mp4'), 'https://floe.dev/a.mp4')
  assert.equal(toHttpMediaUrl('data:video/mp4;base64,AA'), 'data:video/mp4;base64,AA')
})

test('a probe answer comes back with a fetchable url and nothing else changed', () => {
  const probe = {
    url: 'floe-media://file/tmp/demo.mp4',
    mediaType: 'video/mp4',
    size: 16,
    name: 'demo.mp4',
    path: '/tmp/demo.mp4'
  }
  assert.deepEqual(rewriteProbe(probe), { ...probe, url: '/media/tmp/demo.mp4' })
})

test('"no such video" passes through — this rewrites, it does not validate', () => {
  assert.equal(rewriteProbe(null), null)
  assert.equal(rewriteProbe(undefined), undefined)
  assert.deepEqual(rewriteProbe({ mediaType: 'video/mp4' }), { mediaType: 'video/mp4' })
})
