import assert from 'node:assert/strict'
import test from 'node:test'
import {
  describePaste,
  expandPastes,
  insertPasteRail,
  isBigPaste,
  pasteRail,
  pasteRailAt,
  pasteRailBefore,
  pasteRailOf,
  renumberPasteRails,
  type PastedText
} from './pastes.ts'

const log = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}`).join('\n')
const held = (...bodies: string[]): PastedText[] =>
  bodies.map((text, i) => ({ id: `p${i}`, text }))

/* --- what counts as too big to read -------------------------------------- */

test('a short paste is left alone', () => {
  assert.equal(isBigPaste('one line'), false)
  assert.equal(isBigPaste(log(10)), false)
})

test('long or fat pastes collapse', () => {
  assert.equal(isBigPaste(log(40)), true)
  assert.equal(isBigPaste('x'.repeat(2000)), true)
})

/* --- the rail ------------------------------------------------------------ */

test('the rail names the size and shows the first real line', () => {
  const rail = pasteRail(1, '\n\n  Process: Floe [56380]\nmore\n')
  assert.equal(rail, '│ paste 01 · 5 lines · 31 B\n│   Process: Floe [56380]')
})

test('a long first line is cut, not wrapped', () => {
  const [, line] = pasteRail(1, 'y'.repeat(200)).split('\n')
  assert.equal(line.length, 74)
  assert.ok(line.endsWith('…'))
})

test('the size is human', () => {
  assert.equal(describePaste('ab\ncd'), '2 lines · 5 B')
  assert.ok(describePaste(log(400)).endsWith('KB'))
})

/* --- putting one in ------------------------------------------------------ */

test('a rail takes lines of its own', () => {
  const put = insertPasteRail('see this:', 9, 1, log(30))
  assert.match(put.text, /^see this:\n│ paste 01 · 30 lines · [\d.]+ [KB]+\n│ line 0\n$/)
  assert.equal(put.caret, put.text.length)
})

test('text after the caret is pushed onto its own line', () => {
  const put = insertPasteRail('before after', 7, 1, log(30))
  const lines = put.text.split('\n')
  assert.equal(lines[0], 'before ')
  assert.equal(lines.at(-1), 'after')
  assert.equal(put.text.slice(put.caret), 'after')
})

/* --- finding one --------------------------------------------------------- */

test('the caret is in the rail at either edge and inside it', () => {
  const text = insertPasteRail('', 0, 1, log(30)).text
  const rail = pasteRailAt(text, 0)
  assert.equal(rail?.n, 1)
  assert.equal(pasteRailAt(text, rail!.end)?.n, 1)
  assert.equal(pasteRailAt(text, 5)?.n, 1)
  assert.equal(pasteRailAt(text, text.length), null)
})

test('backspace only claims the rail it sits at the end of', () => {
  const text = insertPasteRail('', 0, 1, log(30)).text
  const rail = pasteRailAt(text, 0)!
  assert.equal(pasteRailBefore(text, rail.end)?.n, 1)
  assert.equal(pasteRailBefore(text, rail.end - 1), null)
})

/* --- taking one out ------------------------------------------------------ */

test('removing a rail closes the numbering and leaves no hole', () => {
  let text = insertPasteRail('', 0, 1, log(30)).text
  text = insertPasteRail(text, text.length, 2, log(40)).text
  text = insertPasteRail(text, text.length, 3, log(50)).text

  const next = renumberPasteRails(text, 1, 3)
  const heads = next.match(/paste \d\d/g)
  assert.deepEqual(heads, ['paste 01', 'paste 02'])
  assert.ok(!next.includes('\n\n'))
  assert.ok(next.includes('30 lines') === false)
})

test('numbers past the count are prose and are left alone', () => {
  const text = '│ paste 09 · mine'
  assert.equal(renumberPasteRails(text, 1, 2), text)
})

/* --- sending ------------------------------------------------------------- */

test('what goes out is the paste, not the rail', () => {
  const body = log(30)
  const text = insertPasteRail('look:', 5, 1, body).text
  const sent = expandPastes(text, held(body))
  assert.equal(sent, `look:\n${body}\n`)
  assert.ok(!sent.includes('│'))
})

test('a rail whose paste is gone is sent as it reads', () => {
  const text = insertPasteRail('', 0, 1, log(30)).text
  assert.equal(expandPastes(text, []), text)
})

test('each rail expands into its own paste', () => {
  let text = insertPasteRail('', 0, 1, 'first').text
  text = insertPasteRail(text, text.length, 2, 'second').text
  assert.equal(expandPastes(text, held('first', 'second')), 'first\nsecond\n')
})

test('a rail can be found by its number', () => {
  let text = insertPasteRail('', 0, 1, 'first').text
  text = insertPasteRail(text, text.length, 2, 'second').text
  const rail = pasteRailOf(text, 2)!
  assert.equal(text.slice(rail.start, rail.end), pasteRail(2, 'second'))
  assert.equal(pasteRailOf(text, 3), null)
})
