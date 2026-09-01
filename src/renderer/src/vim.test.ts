import assert from 'node:assert/strict'
import test from 'node:test'
import { vimKey, vimStart, type Doc, type VimState } from './vim.ts'

/**
 * Type a string of keys at a document and report where it ended up.
 *
 * `<Esc>` and `<C-r>` are spelled out; everything else is one key per
 * character, which is exactly how these commands are described in vim's own
 * documentation — `ciwword<Esc>` reads as the thing it does.
 */
function type(keys: string, text: string, at = 0, state?: VimState): Doc & { mode: string } {
  let doc: Doc = { text, start: at, end: at }
  let st = state ?? vimStart('normal')
  // Start on the block, the way the composer holds normal mode.
  const first = vimKey({ key: 'Escape' }, doc, { ...st, mode: 'insert' })
  if (first && !state) {
    doc = { text: first.text, start: at, end: at }
  }
  const tokens: string[] = []
  for (let i = 0; i < keys.length; i++) {
    if (keys[i] === '<') {
      const close = keys.indexOf('>', i)
      tokens.push(keys.slice(i, close + 1))
      i = close
    } else tokens.push(keys[i])
  }
  for (const tok of tokens) {
    const ev =
      tok === '<Esc>'
        ? { key: 'Escape' }
        : tok === '<C-r>'
          ? { key: 'r', ctrlKey: true }
          : tok === '<CR>'
            ? { key: 'Enter' }
            : { key: tok }
    const out = vimKey(ev, doc, st)
    if (!out) continue
    // Insert mode types for itself — the textarea would, so the harness does.
    doc = { text: out.text, start: out.start, end: out.end }
    st = out.state
  }
  return { ...doc, mode: st.mode }
}

/** Keys in normal mode, then the literal text an insert would have typed. */
function typeThen(keys: string, insert: string, text: string, at = 0): string {
  const out = type(keys, text, at)
  assert.equal(out.mode, 'insert', 'expected to end in insert mode')
  return out.text.slice(0, out.start) + insert + out.text.slice(out.start)
}

test('hjkl move by one, and stop at the edges of the line', () => {
  assert.equal(type('lll', 'hello').start, 3)
  assert.equal(type('hhh', 'hello', 2).start, 0)
  // $ is the last character, not past it — normal mode sits ON a letter.
  assert.equal(type('$', 'hello').start, 4)
  assert.equal(type('llllllll', 'hello').start, 4)
})

test('j and k keep the column, clamped on a shorter line', () => {
  const text = 'longer line\nab\nlonger again'
  assert.equal(type('j', text, 8).start, 13) // clamped to the end of `ab`
  assert.equal(type('jj', text, 8).start, 23) // column comes back
  assert.equal(type('jjk', text, 8).start, 13)
})

test('w, b and e walk words, with punctuation as its own word', () => {
  const text = 'const x = foo(bar)'
  assert.equal(type('w', text).start, 6)
  assert.equal(type('ww', text).start, 8)
  assert.equal(type('e', text).start, 4)
  assert.equal(type('b', text, 10).start, 8)
  // W and B skip the punctuation and take the whole blob.
  assert.equal(type('WWW', text).start, 10)
})

test('a count repeats the motion', () => {
  assert.equal(type('3w', 'one two three four').start, 14)
  assert.equal(type('2j', 'a\nb\nc\nd').start, 4)
  assert.equal(type('3l', 'hello').start, 3)
})

test('gg and G go to the first and last line', () => {
  const text = 'one\ntwo\nthree'
  assert.equal(type('G', text).start, 8)
  assert.equal(type('gg', text, 10).start, 0)
  assert.equal(type('2G', text).start, 4)
})

test('f and t find on the line, and only on this line', () => {
  const text = 'a,b,c\nd,e'
  assert.equal(type('f,', text).start, 1)
  assert.equal(type('2f,', text).start, 3)
  assert.equal(type('t,', text).start, 0)
  // The comma on the next line is not a match.
  assert.equal(type('3f,', text).start, 0)
  assert.equal(type('F,', text, 4).start, 3)
})

test('i, a, I, A, o and O enter insert at the right place', () => {
  assert.equal(typeThen('i', 'X', 'hello', 2), 'heXllo')
  assert.equal(typeThen('a', 'X', 'hello', 2), 'helXlo')
  assert.equal(typeThen('I', 'X', '  hello', 4), '  Xhello')
  assert.equal(typeThen('A', 'X', 'hello', 2), 'helloX')
  assert.equal(typeThen('o', 'X', 'one\ntwo', 1), 'one\nX\ntwo')
  assert.equal(typeThen('O', 'X', 'one\ntwo', 5), 'one\nX\ntwo')
})

test('x deletes under the cursor and never past the line', () => {
  assert.equal(type('x', 'hello', 1).text, 'hllo')
  assert.equal(type('3x', 'hello', 1).text, 'ho')
  // At the end of a line there is nothing to take — the newline stays.
  assert.equal(type('5x', 'ab\ncd', 1).text, 'a\ncd')
})

test('dw, de and d$ span what their motion covers', () => {
  assert.equal(type('dw', 'one two three').text, 'two three')
  assert.equal(type('de', 'one two three').text, ' two three')
  assert.equal(type('d$', 'one two', 4).text, 'one ')
  assert.equal(type('D', 'one two', 4).text, 'one ')
})

test('dd takes whole lines, and a count takes several', () => {
  assert.equal(type('dd', 'one\ntwo\nthree', 5).text, 'one\nthree')
  assert.equal(type('2dd', 'one\ntwo\nthree').text, 'three')
  // The last line goes with its newline in front of it, leaving no blank.
  assert.equal(type('dd', 'one\ntwo', 5).text, 'one\n')
})

test('cw changes a word and leaves you in insert', () => {
  assert.equal(typeThen('cw', 'two', 'one three'), 'two three')
  assert.equal(typeThen('cc', 'new', 'one\ntwo', 0), 'new\ntwo')
  assert.equal(typeThen('C', 'X', 'one two', 4), 'one X')
})

test('ciw changes the word under the cursor, wherever in it you are', () => {
  assert.equal(typeThen('ciw', 'X', 'one two three', 5), 'one X three')
  assert.equal(typeThen('ciw', 'X', 'one two three', 4), 'one X three')
  assert.equal(typeThen('ciw', 'X', 'one two three', 6), 'one X three')
  // `aw` takes the trailing space with it.
  assert.equal(type('daw', 'one two three', 5).text, 'one three')
})

test('ci" and ci( reach inside the pair the cursor sits in', () => {
  assert.equal(typeThen('ci"', 'new', 'say "old" now', 6), 'say "new" now')
  assert.equal(typeThen('ci(', 'x', 'foo(bar)', 5), 'foo(x)')
  assert.equal(type('da(', 'foo(bar) baz', 5).text, 'foo baz')
  // Nesting counts: the inner pair is the one you are in.
  assert.equal(type('di(', 'a(b(c)d)', 4).text, 'a(b()d)')
})

test('yank and put move text without a mouse', () => {
  // yy then p drops the copy on the line below.
  assert.equal(type('yyp', 'one\ntwo').text, 'one\none\ntwo')
  assert.equal(type('yyP', 'one\ntwo', 4).text, 'one\ntwo\ntwo')
  // A charwise yank pastes after the cursor, like vim's p.
  assert.equal(type('ywP', 'ab cd').text, 'ab ab cd')
})

test('a linewise put on the last line brings its newline with it', () => {
  // The buffer ends without one, so pasting after it has to supply the break —
  // otherwise the copy lands glued to the end of the line it came from.
  assert.equal(type('yyp', 'only').text, 'only\nonly')
  assert.equal(type('Vyp', 'only').text, 'only\nonly')
  assert.equal(type('yyp', 'one\ntwo', 5).text, 'one\ntwo\ntwo')
})

test('undo puts the cursor where the text came back, not where it ended', () => {
  const out = type('vlldu', 'bold world', 2)
  assert.equal(out.text, 'bold world')
  assert.equal(out.start, 2)
})

test('dd then p is how a line moves', () => {
  assert.equal(type('ddp', 'one\ntwo\nthree').text, 'two\none\nthree')
})

test('visual mode selects, and an operator takes the selection', () => {
  assert.equal(type('vlld', 'abcdef').text, 'def')
  assert.equal(type('vey', 'one two').text, 'one two')
  assert.equal(typeThen('vlc', 'X', 'abcdef'), 'Xcdef')
  // V is linewise however far along the line you started.
  assert.equal(type('Vd', 'one\ntwo', 1).text, 'two')
  assert.equal(type('Vjd', 'one\ntwo\nthree', 1).text, 'three')
})

test('Escape leaves visual mode without touching the text', () => {
  const out = type('vll<Esc>', 'abcdef')
  assert.equal(out.text, 'abcdef')
  assert.equal(out.mode, 'normal')
  assert.equal(out.start, 2)
})

test('r replaces exactly one character', () => {
  assert.equal(type('rz', 'abc', 1).text, 'azc')
  // The cursor cannot rest on a newline, so a caret past the last character
  // replaces that character instead of falling off the line.
  assert.equal(type('rz', 'ab\ncd', 2).text, 'az\ncd')
})

test('J joins the next line with one space', () => {
  assert.equal(type('J', 'one\n   two').text, 'one two')
  assert.equal(type('J', 'only').text, 'only')
})

test('u undoes an edit and C-r puts it back', () => {
  assert.equal(type('ddu', 'one\ntwo').text, 'one\ntwo')
  assert.equal(type('ddu<C-r>', 'one\ntwo').text, 'two')
  // Each x is its own step, so two undos put two of the three back.
  assert.equal(type('xxxuu', 'hello').text, 'ello')
  // Undo with nothing behind it is a no-op, not a crash.
  assert.equal(type('u', 'hello').text, 'hello')
})

test('normal mode shows a block: one character wide, thin on a newline', () => {
  const on = type('l', 'hi')
  assert.deepEqual([on.start, on.end], [1, 2])
  const empty = type('j', 'ab\n\ncd')
  assert.deepEqual([empty.start, empty.end], [3, 3])
})

test('Escape from insert steps back onto the last character typed', () => {
  const doc = { text: 'hello', start: 5, end: 5 }
  const out = vimKey({ key: 'Escape' }, doc, vimStart('insert'))
  assert.deepEqual([out?.start, out?.end], [4, 5])
})

test('keys the composer owns are handed back untouched', () => {
  const doc = { text: 'hi', start: 0, end: 1 }
  const normal = vimStart('normal')
  // Enter sends the message, ⌘L links it, and a bare Escape closes a panel —
  // none of them may be swallowed by a mode that has nothing pending.
  assert.equal(vimKey({ key: 'Enter' }, doc, normal), null)
  assert.equal(vimKey({ key: 'l', metaKey: true }, doc, normal), null)
  assert.equal(vimKey({ key: 'Escape' }, doc, normal), null)
  // …but insert mode passes everything through except its one exit key.
  assert.equal(vimKey({ key: 'd' }, doc, vimStart('insert')), null)
})

test('an unfinished command is cancelled by Escape, not carried', () => {
  const out = type('2d<Esc>x', 'hello')
  assert.equal(out.text, 'ello')
})
