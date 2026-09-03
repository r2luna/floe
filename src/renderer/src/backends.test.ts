import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canonGroup, mergeProjects } from './backends.ts'
import type { Project } from '../../shared/types.ts'

// The projects panel is the union of every attached machine's list, but a
// mutation (move, remove, a deleted group) answers with only ITS backend's list.
// Splicing that slice back in is the one place where getting it wrong silently
// empties the panel of the other machines — hence the check.
const p = (path: string, backend?: string): Project => ({
  path,
  name: path,
  group: 'g',
  ...(backend ? { backend } : {})
})

const order = ['local', 'link']
const union = [p('/Users/me/a', 'local'), p('/Users/me/b', 'local'), p('/home/me/x', 'link')]

test('a backend mutation only replaces its own slice', () => {
  const next = mergeProjects(union, [p('/Users/me/a'), p('/Users/me/c')], 'local', order)
  assert.deepEqual(
    next.map((x) => x.path),
    ['/Users/me/a', '/Users/me/c', '/home/me/x']
  )
  // Everything stays tagged, including the untouched remote slice.
  assert.deepEqual(
    next.map((x) => x.backend),
    ['local', 'local', 'link']
  )
})

test('the remote slice can be replaced without losing the local one', () => {
  const next = mergeProjects(union, [p('/home/me/y')], 'link', order)
  assert.deepEqual(
    next.map((x) => x.path),
    ['/Users/me/a', '/Users/me/b', '/home/me/y']
  )
})

// Two machines spelling one group differently drew two identical-looking blocks,
// since the panel renders group names uppercase.
test('groups match case-insensitively, first spelling wins', () => {
  assert.equal(canonGroup('elevaris'), 'elevaris')
  assert.equal(canonGroup('Elevaris'), 'elevaris')
  // …including on the slice a mutation splices back in.
  const next = mergeProjects(union, [{ ...p('/home/me/x'), group: 'Elevaris' }], 'link', order)
  assert.equal(next.find((x) => x.path === '/home/me/x')?.group, 'elevaris')
})

test('a detached backend drops out with the next merge', () => {
  const next = mergeProjects(union, [p('/Users/me/a')], 'local', ['local'])
  assert.deepEqual(
    next.map((x) => x.path),
    ['/Users/me/a']
  )
})
