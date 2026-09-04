import test from 'node:test'
import assert from 'node:assert/strict'
import { isIpLiteral, secureBackendUrl } from './backendUrl.ts'

test('an https page upgrades a named machine to wss and drops the default port', () => {
  assert.equal(
    secureBackendUrl('ws://cypher.leopon-sole.ts.net:443', 'https:'),
    'wss://cypher.leopon-sole.ts.net/'
  )
})

test('a non-default port survives the upgrade', () => {
  assert.equal(secureBackendUrl('ws://box.example:8443', 'https:'), 'wss://box.example:8443/')
})

test('an https page refuses a machine paired by bare IP — there is no cert to upgrade to', () => {
  assert.equal(secureBackendUrl('ws://100.72.82.64:41680', 'https:'), null)
  assert.equal(secureBackendUrl('ws://[fd7a:115c:a1e0::1]:41680', 'https:'), null)
})

test('an http page leaves ws alone — the socket is no worse than the page', () => {
  assert.equal(secureBackendUrl('ws://100.72.82.64:41680', 'http:'), 'ws://100.72.82.64:41680')
})

test('an already-secure url passes through', () => {
  assert.equal(secureBackendUrl('wss://box.example/ws', 'https:'), 'wss://box.example/ws')
})

test('anything that is not a websocket url is refused', () => {
  assert.equal(secureBackendUrl('https://box.example', 'https:'), null)
  assert.equal(secureBackendUrl('not a url', 'https:'), null)
})

test('ip literals are told from names', () => {
  assert.equal(isIpLiteral('100.72.82.64'), true)
  assert.equal(isIpLiteral('[::1]'), true)
  assert.equal(isIpLiteral('cypher.leopon-sole.ts.net'), false)
})
