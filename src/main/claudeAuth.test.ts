import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findLoginUrl } from './claudeAuth.ts'

// A real `claude auth login` PTY chunk (claude 2.1.222): the CLI opens the
// browser itself, then prints the URL as an OSC 8 hyperlink target and again as
// visible text, and finally parks on the code prompt.
const URL =
  'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Aprofile&state=fkJyk7'
const OUT = `Opening browser to sign in…\r\nIf the browser didn't open, visit: \x1b]8;;${URL}\x07${URL}\x1b]8;;\x07\r\nPaste code here if prompted > `

test('reads the sign-in URL out of the login PTY output', () => {
  assert.equal(findLoginUrl(OUT), URL)
})

test('waits for the whole URL instead of returning a truncated one', () => {
  assert.equal(findLoginUrl(OUT.slice(0, 120)), null)
})

test('ignores output before the URL arrives', () => {
  assert.equal(findLoginUrl('Opening browser to sign in…\r\n'), null)
})

test('rejects a non-https scheme', () => {
  assert.equal(findLoginUrl('\x1b]8;;file:///etc/passwd\x07'), null)
})
