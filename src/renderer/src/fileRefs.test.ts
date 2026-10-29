import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chipLabel, describeRef, fileTarget, opensFile, refFromHref, splitRefs } from './fileRefs.ts'

test('a file reference is cut out of the text it sits in', () => {
  assert.deepEqual(splitRefs('see docs/plan.md:4 now'), [
    { text: 'see ' },
    { ref: 'docs/plan.md:4' },
    { text: ' now' }
  ])
})

test('the mention mark is dropped — the chip replaces the whole token', () => {
  assert.deepEqual(splitRefs('#src/main/agent.ts'), [{ ref: 'src/main/agent.ts' }])
})

test('a bare file name in prose stays prose', () => {
  assert.deepEqual(splitRefs('read the notes.md file'), [{ text: 'read the notes.md file' }])
})

test('a chip shows the whole path and the lines, not just the file name', () => {
  assert.deepEqual(describeRef('/a/b/example.md:7-23'), {
    path: '/a/b/example.md',
    lines: '7-23',
    full: '/a/b/example.md:7-23'
  })
  assert.deepEqual(describeRef('src/a.ts'), {
    path: 'src/a.ts',
    lines: undefined,
    full: 'src/a.ts'
  })
})

test('a folder path chips whole, not up to the first dotted segment', () => {
  assert.deepEqual(splitRefs('../93.hubstack/infra - um repo'), [
    { ref: '../93.hubstack/infra' },
    { text: ' - um repo' }
  ])
})

test('an anchored folder is a reference; an unanchored word pair is not', () => {
  assert.deepEqual(splitRefs('see ./src/main and /etc/hosts'), [
    { text: 'see ' },
    { ref: './src/main' },
    { text: ' and ' },
    { ref: '/etc/hosts' }
  ])
  assert.deepEqual(splitRefs('pick one and/or the other'), [
    { text: 'pick one and/or the other' }
  ])
})

test('a chip never covers only part of the path', () => {
  assert.deepEqual(splitRefs('open docs/plan.md.'), [
    { text: 'open ' },
    { ref: 'docs/plan.md' },
    { text: '.' }
  ])
})

test('a folder the # menu wrote chips whole; an unmarked one stays prose', () => {
  assert.deepEqual(splitRefs('look in #src/main/ now'), [
    { text: 'look in ' },
    { ref: 'src/main/' },
    { text: ' now' }
  ])
  assert.deepEqual(splitRefs('look in src/main/ now'), [{ text: 'look in src/main/ now' }])
})

test('a chip label leads with the name, then the last two folders, then the line', () => {
  assert.deepEqual(chipLabel('/Users/me/skills/universal/sol-loop/SKILL.md:123'), {
    name: 'SKILL.md',
    dir: 'universal/sol-loop',
    lines: 'L123',
    full: '/Users/me/skills/universal/sol-loop/SKILL.md:123'
  })
  assert.deepEqual(chipLabel('notes.md:4-9'), { name: 'notes.md', dir: undefined, lines: 'L4-9', full: 'notes.md:4-9' })
})

test('a markdown link to a file becomes a reference; a URL does not', () => {
  assert.equal(refFromHref('skills/sol-loop/SKILL.md#L123'), 'skills/sol-loop/SKILL.md:123')
  assert.equal(refFromHref('src/a.ts#L12-L30'), 'src/a.ts:12-30')
  assert.equal(refFromHref('/abs/path%20x/b.ts'), '/abs/path x/b.ts')
  assert.equal(refFromHref('notes.md#L4'), 'notes.md:4')
  assert.equal(refFromHref('https://x.dev/a.ts'), null)
  assert.equal(refFromHref('mailto:a@b.c'), null)
  assert.equal(refFromHref('#section'), null)
  assert.equal(refFromHref('notes.md'), null)
})

test('a clicked reference opens in the worktree, or rooted at its own folder', () => {
  const cwd = '/w/repo'
  assert.deepEqual(fileTarget('src/a.ts:12-30', cwd), { sub: 'src/a.ts', line: 12 })
  assert.deepEqual(fileTarget('./README.md', cwd), { sub: 'README.md', line: undefined })
  assert.deepEqual(fileTarget('/w/repo/x/b.md', cwd), { sub: 'x/b.md', line: undefined })
  assert.deepEqual(fileTarget('/etc/hosts:3', cwd), { root: '/etc', sub: 'hosts', line: 3 })
  assert.deepEqual(fileTarget('../other/c.ts', cwd), { root: '/w/other', sub: 'c.ts', line: undefined })
  assert.equal(fileTarget('src/', cwd), null)
  assert.equal(fileTarget('~/notes.md', cwd), null)
})

test('a folder or a ~ path opens no file', () => {
  assert.equal(opensFile('src/a.ts'), true)
  assert.equal(opensFile('src/'), false)
  assert.equal(opensFile('~/notes.md'), false)
  assert.equal(opensFile(''), false)
})
