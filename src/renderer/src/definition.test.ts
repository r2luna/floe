import { test } from 'node:test'
import assert from 'node:assert/strict'
import { identifiersOf, pickDefinition, wordAt } from './definition.ts'

test('wordAt finds the identifier under an offset', () => {
  const line = 'const x = useMemo(() => $el.a1, [])'
  assert.equal(wordAt(line, line.indexOf('useMemo') + 3), 'useMemo')
  // The caret just past the last letter still means the word.
  assert.equal(wordAt(line, line.indexOf('useMemo') + 7), 'useMemo')
  assert.equal(wordAt(line, line.indexOf('$el')), '$el')
  assert.equal(wordAt(line, line.indexOf('=>') + 1), null)
})

test('identifiersOf drops keywords and repeats', () => {
  assert.deepEqual(identifiersOf('foo(bar, foo, new Baz())'), ['foo', 'bar', 'Baz'])
  assert.deepEqual(identifiersOf('  return null'), [])
})

test('identifiersOf leaves out what the line declares', () => {
  assert.deepEqual(identifiersOf('export const target = pickDefinition(defs, { path })'), ['pickDefinition', 'defs', 'path'])
  assert.deepEqual(identifiersOf('function FileView({ root }: Props) {'), ['root', 'Props'])
})

test('pickDefinition prefers another definition in the same file, then other files', () => {
  const defs = [
    { path: 'a.ts', line: 3, text: '' },
    { path: 'a.ts', line: 7, text: '' },
    { path: 'b.ts', line: 1, text: '' }
  ]
  assert.equal(pickDefinition(defs, { path: 'a.ts', line: 3 }), defs[1])
  assert.equal(pickDefinition(defs, { path: 'a.ts', line: 9 }), defs[0])
  assert.equal(pickDefinition(defs, { path: 'c.ts', line: 1 }), defs[0])
})

test('pickDefinition stays put on a name only this file defines', () => {
  const defs = [
    { path: 'a.ts', line: 3, text: '' },
    { path: 'b.ts', line: 1, text: '' }
  ]
  assert.equal(pickDefinition(defs, { path: 'a.ts', line: 3 }), null)
})
