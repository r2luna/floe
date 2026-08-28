import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseSshTarget, isValidSshHost } from './sshTunnel.ts'

test('parseSshTarget: non-ssh targets are not SSH', () => {
  assert.equal(parseSshTarget(null), null)
  assert.equal(parseSshTarget(''), null)
  assert.equal(parseSshTarget('https://ide.pinguim.io'), null)
  assert.equal(parseSshTarget('http://127.0.0.1:41600'), null)
})

test('parseSshTarget: host with explicit remote port', () => {
  assert.deepEqual(parseSshTarget('ssh://link:80'), { host: 'link', remotePort: 80 })
})

test('parseSshTarget: host without a port defaults to the server default', () => {
  assert.deepEqual(parseSshTarget('ssh://link'), { host: 'link', remotePort: 41600 })
})

test('parseSshTarget: scheme match is case-insensitive', () => {
  assert.deepEqual(parseSshTarget('SSH://box:2020'), { host: 'box', remotePort: 2020 })
})

test('parseSshTarget: user@host is allowed', () => {
  assert.deepEqual(parseSshTarget('ssh://deploy@box'), { host: 'deploy@box', remotePort: 41600 })
})

test('parseSshTarget: rejects argv-smuggling and malformed hosts', () => {
  // A leading `-` would be read by ssh as a flag (e.g. -oProxyCommand=…) — must not parse.
  assert.equal(parseSshTarget('ssh://-oProxyCommand=calc'), null)
  assert.equal(parseSshTarget('ssh://-l'), null)
  assert.equal(parseSshTarget('ssh://'), null)
  assert.equal(parseSshTarget('ssh://host with space'), null)
  assert.equal(parseSshTarget('ssh://link:0'), null) // port out of range
  assert.equal(parseSshTarget('ssh://link:99999'), null)
  assert.equal(parseSshTarget('ssh://link:abc'), null)
})

test('isValidSshHost: leading dash is rejected, normal hosts pass', () => {
  assert.equal(isValidSshHost('-oProxyCommand=x'), false)
  assert.equal(isValidSshHost('link'), true)
  assert.equal(isValidSshHost('user@host.example.com'), true)
})
