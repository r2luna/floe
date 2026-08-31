import test from 'node:test'
import assert from 'node:assert/strict'
import { bashGist, bashProgram, highlightShell } from './shell.ts'

/** The tokens as `cls:text` pairs, which is what the assertions read on. */
const tokens = (cmd: string): string[] =>
  highlightShell(cmd).map((t) => `${t.cls || 'plain'}:${t.text}`)

test('the first word is the program, and the rest is not', () => {
  assert.deepEqual(tokens('ls src'), ['sh-cmd:ls', 'plain: src'])
})

test('what follows an operator is a program again', () => {
  assert.deepEqual(tokens('ls | head'), ['sh-cmd:ls', 'plain: ', 'sh-op:|', 'plain: ', 'sh-cmd:head'])
  assert.deepEqual(tokens('a && b'), ['sh-cmd:a', 'plain: ', 'sh-op:&&', 'plain: ', 'sh-cmd:b'])
  assert.deepEqual(tokens('a; b'), ['sh-cmd:a', 'sh-op:;', 'plain: ', 'sh-cmd:b'])
})

test('flags, strings and redirects each read as themselves', () => {
  assert.deepEqual(tokens('grep -ril "print" src 2>/dev/null'), [
    'sh-cmd:grep',
    'plain: ',
    'sh-flag:-ril',
    'plain: ',
    'sh-str:"print"',
    'plain: src ',
    'sh-op:2>/dev/null'
  ])
})

test('an operator inside a string is text, not plumbing', () => {
  assert.deepEqual(tokens('echo "a | b"'), ['sh-cmd:echo', 'plain: ', 'sh-str:"a | b"'])
})

test('sudo and an env assignment hand the program on', () => {
  assert.deepEqual(tokens('sudo rm x'), ['sh-cmd:sudo', 'plain: ', 'sh-cmd:rm', 'plain: x'])
  assert.deepEqual(tokens('FOO=1 node x'), [
    'sh-cmd:FOO=1',
    'plain: ',
    'sh-cmd:node',
    'plain: x'
  ])
})

test('a line number argument reads as a number', () => {
  assert.deepEqual(tokens('sed -n 1,400p file'), [
    'sh-cmd:sed',
    'plain: ',
    'sh-flag:-n',
    'plain: ',
    'sh-num:1,400p',
    'plain: file'
  ])
})

test('every character of the command survives — the row shows what ran', () => {
  for (const cmd of [
    'ls',
    'ls -la /tmp | head -20',
    'grep -n "a\\|b" src/x.php | head -60',
    'cd /x && ls && echo "--- hits ---"',
    'echo "unterminated',
    ''
  ])
    assert.equal(highlightShell(cmd).reduce((s, t) => s + t.text, ''), cmd)
})

test('the gist drops the cd prefix and collapses whitespace', () => {
  assert.equal(bashGist('cd /Users/x/proj; grep -n "foo" src/a.ts'), 'grep -n "foo" src/a.ts')
  assert.equal(bashGist('cd /Users/x/proj && pnpm test'), 'pnpm test')
  assert.equal(bashGist('cd /a; cd /b && ls'), 'ls')
  assert.equal(bashGist("python3 - <<'PY'\n  x = 1\nPY"), "python3 - <<'PY' x = 1 PY")
})

test('a bare cd is a command, not a prefix — the gist keeps it', () => {
  assert.equal(bashGist('cd /tmp'), 'cd /tmp')
  assert.equal(bashGist('cd /tmp;'), 'cd /tmp;')
})

test('the program skips launchers and the cd prefix', () => {
  assert.equal(bashProgram('cd /x; python3 - <<PY'), 'python3')
  assert.equal(bashProgram('sudo rm -rf ./dist'), 'rm')
  assert.equal(bashProgram('FOO=1 node x.js'), 'node')
  assert.equal(bashProgram('ls'), 'ls')
})
