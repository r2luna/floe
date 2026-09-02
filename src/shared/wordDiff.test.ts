import assert from 'node:assert/strict'
import test from 'node:test'
import { markRuns, similarity, tokenize } from './wordDiff.ts'

/** What the reader sees: every run, in order. */
const shown = (before: string, after: string): string =>
  markRuns(before, after)
    .map((r) => r.text)
    .join('')

/** The new file, rebuilt from the runs that are not cuts — the caller's contract. */
const rebuilt = (before: string, after: string): string =>
  markRuns(before, after)
    .filter((r) => r.side !== 'cut')
    .map((r) => r.text)
    .join('')

const cuts = (before: string, after: string): string[] =>
  markRuns(before, after)
    .filter((r) => r.side === 'cut')
    .map((r) => r.text)

const added = (before: string, after: string): string[] =>
  markRuns(before, after)
    .filter((r) => r.side === 'new')
    .map((r) => r.text)

test('tokenize keeps the gaps, so a line rebuilds exactly', () => {
  const line = '  - one  well-traveled easel,'
  assert.equal(tokenize(line).join(''), line)
})

test('an unchanged line is one unmarked run', () => {
  const runs = markRuns('same words', 'same words')
  assert.deepEqual(runs, [{ text: 'same words' }])
})

test('the new file rebuilds from the runs that are not cuts', () => {
  const pairs: Array<[string, string]> = [
    ['wind caught the sketch', 'wind stole the sketch'],
    ['one field easel,', 'one well-traveled field easel,'],
    ['a thermos of coffee,', 'a heroic thermos of coffee,'],
    ['and more curiosity', 'and considerably more curiosity'],
    ['title: A Happy Accident', 'title: The Sketch in the Spruce'],
    ['dropped entirely', ''],
    ['', 'added entirely'],
    ['same', 'same']
  ]
  for (const [before, after] of pairs) {
    assert.equal(rebuilt(before, after), after, `rebuilding ${JSON.stringify(after)}`)
  }
})

test('one swapped word marks that word, not the sentence', () => {
  const before = 'wind caught the sketch and lifted it over the railing'
  const after = 'wind stole the sketch and carried it over the railing'
  assert.deepEqual(cuts(before, after), ['caught ', 'lifted '])
  assert.deepEqual(added(before, after), ['stole', 'carried'])
})

test('what both sides share is printed once, not twice', () => {
  // The wholesale path still fires here — the title WAS rewritten — but the
  // shared `title: ` is peeled off first, so it is not part of either mark.
  assert.equal(
    shown('title: A Happy Accident', 'title: The Sketch in the Spruce'),
    'title: A Happy Accident The Sketch in the Spruce'
  )
  assert.deepEqual(cuts('title: A Happy Accident', 'title: The Sketch in the Spruce'), [
    'A Happy Accident '
  ])
})

test('a rewritten sentence is replaced, not marked word by word', () => {
  const before = 'The next morning, Bob found Clara repairing a trail sign behind the center.'
  const after = 'The next morning arrived bright and windy, and Clara was nowhere near it.'
  assert.equal(cuts(before, after).length, 1, 'one cut, not a scatter of them')
  assert.equal(added(before, after).length, 1)
})

test('a short line is never called a rewrite', () => {
  // Two words, one of them changed, is 50% — the floor keeps this a word swap.
  assert.deepEqual(cuts('mood: hopeful', 'mood: playful'), ['hopeful '])
  assert.deepEqual(added('mood: hopeful', 'mood: playful'), ['playful'])
})

test('a one-word island between two changes is folded in', () => {
  // Two words changed with a shared `and` between them. Left alone that `and`
  // survives as an island and breaks one phrase into two marks.
  const before = 'the small red and blue flag above the door'
  const after = 'the small green and yellow flag above the door'
  const equal = markRuns(before, after)
    .filter((r) => !r.side)
    .map((r) => r.text)
  assert.ok(!equal.some((t) => t.trim() === 'and'), `stray island in ${JSON.stringify(equal)}`)
  assert.deepEqual(cuts(before, after), ['red and blue '])
  assert.deepEqual(added(before, after), ['green and yellow'])
})

test('an insertion carries its own spacing', () => {
  // The gap the new word needs belongs to the new word: it has to arrive and
  // leave with it, or the sentence gains a double space.
  assert.equal(shown('one field easel,', 'one well-traveled field easel,'), 'one well-traveled field easel,')
  assert.deepEqual(added('one field easel,', 'one well-traveled field easel,'), ['well-traveled '])
})

test('a cut never runs into the word after it', () => {
  for (const run of markRuns('wind caught Bob', 'wind stole Bob')) {
    if (run.side !== 'cut') continue
    assert.match(run.text, /\s$/, 'a cut mid-sentence keeps a trailing space')
  }
})

test('a pathological line falls back to a straight replacement', () => {
  const before = Array.from({ length: 600 }, (_, i) => `a${i}`).join(' ')
  const after = Array.from({ length: 600 }, (_, i) => `b${i}`).join(' ')
  assert.deepEqual(cuts(before, after), [`${before} `])
  assert.deepEqual(added(before, after), [after])
})

test('similarity reports words in common over the longer side', () => {
  assert.equal(similarity('a b c', 'a b c'), 1)
  assert.equal(similarity('a b c', 'x y z'), 0)
  assert.equal(similarity('', 'x'), 0)
  assert.ok(similarity('one field easel', 'one well-traveled field easel') > 0.5)
})
