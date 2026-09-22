import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inWorktree, previewTarget, previewUrl } from './previewTarget.ts'

const CWD = '/Users/r/code/floe'

test('an open command with $PWD points at the worktree file', () => {
  const t = previewTarget('open "$PWD/mocks/app-icon.html"')
  assert.deepEqual(t, { kind: 'file', value: '$PWD/mocks/app-icon.html' })
  assert.equal(previewUrl(t!, CWD), 'file:///Users/r/code/floe/mocks/app-icon.html')
})

test('a relative html path is joined to the worktree', () => {
  const t = previewTarget('open mocks/a.html; open ./b.htm')
  assert.deepEqual(t, { kind: 'file', value: 'mocks/a.html' })
  assert.equal(previewUrl(t!, CWD + '/'), 'file:///Users/r/code/floe/mocks/a.html')
})

test('a URL wins over a file, and keeps its query', () => {
  const t = previewTarget('curl https://example.com/x.html?v=2 > page.html')
  assert.deepEqual(t, { kind: 'url', value: 'https://example.com/x.html?v=2' })
})

test('localhost without a scheme gets http', () => {
  assert.deepEqual(previewTarget('pnpm dev # then localhost:5173/app'), {
    kind: 'url',
    value: 'http://localhost:5173/app'
  })
})

test('a block with nothing to show is null', () => {
  assert.equal(previewTarget('pnpm gate && git status'), null)
  assert.equal(previewTarget('ls index.css'), null)
})

test('a path with a space survives as a file URL', () => {
  const t = previewTarget("open '/tmp/my page.html'")
  assert.equal(previewUrl(t!, CWD), 'file:///tmp/my%20page.html')
})

test('a page of the worktree is named relative to it, not sent to the browser', () => {
  const t = previewTarget('open "$PWD/mocks/app-icon.html"')
  assert.equal(inWorktree(t!, CWD), 'mocks/app-icon.html')
  assert.equal(inWorktree(previewTarget('open mocks/a.html')!, CWD + '/'), 'mocks/a.html')
  assert.equal(inWorktree(previewTarget(`open ${CWD}/index.html`)!, CWD), 'index.html')
})

test('a page anywhere else is not the worktree’s, and keeps its browser URL', () => {
  // A URL is never a file, whatever it ends in.
  assert.equal(inWorktree(previewTarget('curl https://x.dev/a.html')!, CWD), null)
  assert.equal(inWorktree(previewTarget('open ~/Desktop/a.html')!, CWD), null)
  assert.equal(inWorktree(previewTarget('open /tmp/a.html')!, CWD), null)
  // Climbing out and back in is not something to guess about.
  assert.equal(inWorktree(previewTarget('open ../other/a.html')!, CWD), null)
  // And with no worktree there is nothing to be inside of.
  assert.equal(inWorktree(previewTarget('open mocks/a.html')!, ''), null)
})
