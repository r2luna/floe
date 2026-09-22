import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bangPrompt, bangTokens, isBang, readBang } from './bang.ts'

test('a leading ! is shell mode, anywhere else it is punctuation', () => {
  assert.equal(isBang('!git status'), true)
  // Indented, and still the first thing typed.
  assert.equal(isBang('  !ls'), true)
  // The bare key, before there is a command: the composer colours on this.
  assert.equal(isBang('!'), true)
  assert.equal(isBang('no way!'), false)
  assert.equal(isBang('wow! !ls'), false)
})

test('the command is what follows the !', () => {
  assert.equal(readBang('!git status'), 'git status')
  assert.equal(readBang('  ! pnpm test  '), 'pnpm test')
  // Nothing to run: a lone `!` is a keystroke, not an errand.
  assert.equal(readBang('!'), null)
  assert.equal(readBang('!   '), null)
  assert.equal(readBang('ls'), null)
})

test('the prompt carries the command, and the exit code only when it failed', () => {
  assert.equal(bangPrompt('ls', 'a\nb', 0), 'I ran `ls`:\n\n```\na\nb\n```')
  assert.match(bangPrompt('pnpm test', 'boom', 1), /^I ran `pnpm test` \(exit 1\):/)
  // Silence is a result too, and an empty fence reads as the run never happening.
  assert.match(bangPrompt('true', '   \n', 0), /\n```\n\(no output\)\n```$/)
})

test('the fence outgrows the backticks in the output', () => {
  // `!cat README.md`: the output closes a three-tick fence halfway down, and
  // everything after it reaches the model as prose.
  const out = 'before\n```sh\nnpm i\n```\nafter'
  const prompt = bangPrompt('cat README.md', out, 0)
  assert.ok(prompt.includes('````\n' + out + '\n````'))
  // Whatever the output holds, the body comes back out of the fence whole.
  const fence = prompt.slice(prompt.indexOf('\n\n') + 2)
  const mark = fence.slice(0, fence.indexOf('\n'))
  assert.equal(fence, `${mark}\n${out}\n${mark}`)
})

test('a command with backticks stays inside its own span', () => {
  assert.equal(bangPrompt('echo `date`', 'Mon', 0), 'I ran `` echo `date` ``:\n\n```\nMon\n```')
})

test('the draft paints as a command, not as markdown', () => {
  assert.deepEqual(bangTokens('!git log'), [
    { text: '!', cls: 'md-bang' },
    { text: 'git log', cls: 'md-shell' }
  ])
  // The indent is neither: it has to stay put or the mirror slides off the text.
  assert.deepEqual(bangTokens('  !ls'), [
    { text: '  ', cls: '' },
    { text: '!', cls: 'md-bang' },
    { text: 'ls', cls: 'md-shell' }
  ])
  assert.deepEqual(bangTokens('!'), [{ text: '!', cls: 'md-bang' }])
})
