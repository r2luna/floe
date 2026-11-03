import test from 'node:test'
import assert from 'node:assert/strict'
import { collapseProjectRefs, expandProjectRefs, hasProjectRef, type ProjectRef } from './projectRefs.ts'

const projects: Record<string, ProjectRef> = {
  floe: { name: 'floe', path: '/code/floe' },
  'my-app': { name: 'my "app"', path: '/code/my app' }
}
const resolve = (slug: string): ProjectRef | null => projects[slug] ?? null

test('a known name expands to the repo root', () => {
  const out = expandProjectRefs('compare with $floe please', resolve)
  assert.ok(out.startsWith('compare with <floe-project '))
  assert.ok(out.includes('/code/floe'))
  assert.ok(out.endsWith(' please'))
})

test('collapsing puts the message back the way it was typed', () => {
  for (const typed of ['$floe', 'see $floe and $my-app now']) {
    const sent = expandProjectRefs(typed, resolve)
    assert.ok(hasProjectRef(sent))
    assert.equal(collapseProjectRefs(sent), typed)
  }
})

test('anything that names no project is left alone', () => {
  for (const text of ['$HOME', '$5', 'cost$floe', '$floe,', '${floe}', 'echo "$floe"']) {
    assert.equal(expandProjectRefs(text, resolve), text)
  }
  assert.equal(hasProjectRef('nothing here'), false)
})

test('a project on another machine says so, and still collapses', () => {
  const far = { name: 'floe', path: '/srv/floe', machine: 'Link' }
  const sent = expandProjectRefs('check $floe@Link', (slug) => (slug === 'floe@Link' ? far : null))
  assert.ok(sent.includes('on the machine "Link"'))
  assert.ok(sent.includes('not readable'))
  assert.equal(collapseProjectRefs(sent), 'check $floe@Link')
})
