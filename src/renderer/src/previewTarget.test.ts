import { test } from 'node:test'
import assert from 'node:assert/strict'
import { previewTarget, previewUrl } from './previewTarget.ts'

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
