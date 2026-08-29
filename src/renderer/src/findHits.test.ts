import test from 'node:test'
import assert from 'node:assert/strict'
import { hitRanges, splitByHits } from './findHits.ts'

/** Tokens as the highlighter hands them over: text plus a colour. */
const t = (...parts: Array<[string, string]>) => parts.map(([content, style]) => ({ content, style }))
/** What came back, as `text` or `[text]` when it is marked — easy to read in a diff. */
const shape = (pieces: Array<{ content: string; hit: boolean }>): string =>
  pieces.map((p) => (p.hit ? `[${p.content}]` : p.content)).join('')

test('hitRanges finds every occurrence, case-insensitively', () => {
  assert.deepEqual(hitRanges('Log the log', 'log'), [[0, 3], [8, 11]])
  assert.deepEqual(hitRanges('nothing here', 'log'), [])
  assert.deepEqual(hitRanges('anything', ''), [])
})

test('hitRanges does not return overlapping matches', () => {
  // `aa` in `aaaa` is two matches, not three: overlapping marks would render as
  // one blur and the count would be wrong.
  assert.deepEqual(hitRanges('aaaa', 'aa'), [[0, 2], [2, 4]])
})

test('no query leaves the tokens exactly as they came', () => {
  const tokens = t(['const', 'kw'], [' x', 'var'])
  assert.deepEqual(splitByHits(tokens, undefined), [
    { content: 'const', style: 'kw', hit: false },
    { content: ' x', style: 'var', hit: false }
  ])
  assert.deepEqual(splitByHits(tokens, '   '), splitByHits(tokens, undefined))
})

test('a query that matches nothing leaves the tokens alone', () => {
  assert.equal(shape(splitByHits(t(['const x', 'kw']), 'zzz')), 'const x')
})

test('a match inside one token splits it in three', () => {
  const out = splitByHits(t(['$logger', 'var']), 'log')
  assert.equal(shape(out), '$[log]ger')
  assert.deepEqual(out.map((p) => p.style), ['var', 'var', 'var'], 'every piece keeps the token colour')
})

test('a match at the very start and end of a token', () => {
  assert.equal(shape(splitByHits(t(['logger', 'var']), 'log')), '[log]ger')
  assert.equal(shape(splitByHits(t(['catalog', 'var']), 'log')), 'cata[log]')
  assert.equal(shape(splitByHits(t(['log', 'var']), 'log')), '[log]')
})

test('a match straddling two tokens marks both halves, each with its own colour', () => {
  // The case a row-level highlighter cannot do: `->log` is a punctuation token
  // and a name token, and the query crosses the seam.
  const out = splitByHits(t(['$logger', 'var'], ['->', 'punct'], ['log', 'fn']), 'r->l')
  assert.equal(shape(out), '$logge[r][->][l]og')
  assert.deepEqual(
    out.filter((p) => p.hit).map((p) => p.style),
    ['var', 'punct', 'fn'],
    'each marked half keeps the colour of the token it came from'
  )
})

test('a match spanning a whole token in the middle', () => {
  const out = splitByHits(t(['a', 'x'], ['bb', 'y'], ['c', 'z']), 'abbc')
  assert.equal(shape(out), '[a][bb][c]')
  assert.ok(out.every((p) => p.hit))
})

test('several matches on one line are all marked', () => {
  assert.equal(shape(splitByHits(t(['log a log b', 'txt']), 'log')), '[log] a [log] b')
})

test('two matches inside one token, back to back', () => {
  assert.equal(shape(splitByHits(t(['loglog', 'txt']), 'log')), '[log][log]')
})

test('the match is case-insensitive but the text keeps its own case', () => {
  assert.equal(shape(splitByHits(t(['LOG_ENABLED', 'const']), 'log')), '[LOG]_ENABLED')
})

test('the joined text always survives the split, whatever the query', () => {
  const tokens = t(['function ', 'kw'], ['log', 'fn'], ['(', 'punct'], ['$log', 'var'], [')', 'punct'])
  const text = tokens.map((x) => x.content).join('')
  for (const q of ['log', 'o', '(', 'function', 'g($l', 'zzz', 'n log(']) {
    assert.equal(splitByHits(tokens, q).map((p) => p.content).join(''), text, q)
  }
})

test('an empty token between matches does not lose its place', () => {
  assert.equal(shape(splitByHits(t(['lo', 'a'], ['', 'b'], ['g', 'c']), 'log')), '[lo][g]')
})
