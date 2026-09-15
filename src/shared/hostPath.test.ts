import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseHostPath } from './hostPath.ts'

test('no host is this machine', () => {
  assert.deepEqual(parseHostPath('~/code/floe'), { host: null, path: '~/code/floe' })
  assert.deepEqual(parseHostPath('  /srv/app '), { host: null, path: '/srv/app' })
})

test('a host before @ names the machine', () => {
  assert.deepEqual(parseHostPath('gtt@~/code/app'), { host: 'gtt', path: '~/code/app' })
  assert.deepEqual(parseHostPath('gtt.tail1234.ts.net@/srv/app'), { host: 'gtt.tail1234.ts.net', path: '/srv/app' })
})

test('an @ inside a path does not make a host', () => {
  assert.deepEqual(parseHostPath('~/a@b'), { host: null, path: '~/a@b' })
  assert.deepEqual(parseHostPath('/srv/x@2'), { host: null, path: '/srv/x@2' })
  assert.deepEqual(parseHostPath('./x@y'), { host: null, path: './x@y' })
  assert.deepEqual(parseHostPath('@/srv'), { host: null, path: '@/srv' })
})

test('a host with nothing after it has an empty path', () => {
  assert.deepEqual(parseHostPath('gtt@'), { host: 'gtt', path: '' })
})
