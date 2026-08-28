import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findAuthUrl } from './mcpAuth.ts'

// A real `claude mcp login <name> --no-browser` PTY chunk: the URL arrives as an
// OSC 8 hyperlink target and again as visible text.
const URL = 'https://slack.com/oauth/v2_user/authorize?response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A3118%2Fcallback'
const OUT = `Visit this URL to authorize:\r\n  \x1b]8;;${URL}\x07${URL}\x1b]8;;\x07\r\n`

test('reads the authorization URL out of the login PTY output', () => {
  assert.equal(findAuthUrl(OUT), URL)
})

test('waits for the whole URL instead of returning a truncated one', () => {
  assert.equal(findAuthUrl(OUT.slice(0, 80)), null)
})

test('ignores output with no URL yet', () => {
  assert.equal(findAuthUrl('Starting authentication for "plugin:slack:slack"…\r\n'), null)
})

test('rejects a non-https scheme', () => {
  assert.equal(findAuthUrl('\x1b]8;;file:///etc/passwd\x07'), null)
})
