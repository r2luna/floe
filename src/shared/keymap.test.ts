import test from 'node:test'
import assert from 'node:assert/strict'
import { chordFor, compileKeymap, formatChord, normalizeChord, parseWhen, resolveIn } from './keymap.ts'

const ok = (expr: string): ((ctx: Record<string, unknown>) => boolean) => {
  const r = parseWhen(expr)
  assert.ok(r.ok, `expected "${expr}" to compile`)
  return r.ok ? (r.predicate as never) : (null as never)
}

test('the flags read straight off the context', () => {
  assert.equal(ok('typing')({ typing: true }), true)
  assert.equal(ok('typing')({}), false)
  assert.equal(ok('selecting')({ selecting: true }), true)
  assert.equal(ok('stack-below')({ stackDown: true }), true)
  assert.equal(ok('stack-above')({ stackUp: true }), true)
})

test('panel compares against the focused panel kind', () => {
  assert.equal(ok('panel == "diff"')({ kind: 'diff' }), true)
  assert.equal(ok('panel == "diff"')({ kind: 'chat' }), false)
  assert.equal(ok('panel != "terminal"')({ kind: 'chat' }), true)
  assert.equal(ok('panel in ["projects", "worktrees"]')({ kind: 'worktrees' }), true)
  assert.equal(ok('panel in ["projects", "worktrees"]')({ kind: 'diff' }), false)
})

test('and binds tighter than or, as documented', () => {
  // `a and b or c` is `(a and b) or c` — c alone is enough.
  const p = ok('typing and selecting or stack-below')
  assert.equal(p({ stackDown: true }), true)
  assert.equal(p({ typing: true }), false)
  assert.equal(p({ typing: true, selecting: true }), true)
})

test('not negates the condition that follows it', () => {
  assert.equal(ok('not typing')({}), true)
  assert.equal(ok('not typing')({ typing: true }), false)
  assert.equal(ok('not panel == "terminal"')({ kind: 'chat' }), true)
})

test('an unknown condition is refused, and says what is allowed', () => {
  const r = parseWhen('focused')
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.reason, /unknown condition "focused"/)
})

test('panel with the wrong operator is refused rather than guessed at', () => {
  const r = parseWhen('panel is "diff"')
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.reason, /panel expects ==, != or in/)
})

test('trailing junk is an error, not silently ignored', () => {
  assert.equal(parseWhen('typing selecting').ok, false)
})

test('chordFor puts modifiers in one order, whatever the press', () => {
  assert.equal(chordFor({ key: 'P', meta: true, shift: true }), 'super+shift+p')
  assert.equal(chordFor({ key: 'j', ctrl: true }), 'ctrl+j')
  assert.equal(chordFor({ key: 'j' }), 'j', 'a bare letter is a chord here — the `when` is what gates it')
  assert.equal(chordFor({ key: 'Shift' }), null, 'a modifier held alone is a chord in progress')
})

test('every Mac and Linux spelling of the Command key normalizes to super', () => {
  // The point of the rename: one file, both platforms, and nobody has to relearn
  // the word they already type.
  for (const alias of ['cmd', 'command', 'meta', 'win', '⌘'])
    assert.equal(normalizeChord(`${alias}+k`), 'super+k', alias)
  assert.equal(normalizeChord('shift+command+p'), 'super+shift+p')
  assert.equal(normalizeChord('Control+J'), 'ctrl+j')
  assert.equal(normalizeChord('super+k g'), 'super+k g', 'a sequence normalizes step by step')
})

test('formatChord prints the glyphs in Mac keyboard order', () => {
  assert.equal(formatChord('super+shift+p'), '⇧⌘P')
  assert.equal(formatChord('ctrl+j'), '⌃J')
  assert.equal(formatChord('escape'), 'Esc')
  assert.equal(formatChord('cmd+enter'), '⌘↵', 'the Mac spelling still prints, via normalization')
})

test('a modifier-less binding gets an implicit "not typing"', () => {
  const map = compileKeymap([{ key: 'j', command: 'cursor.down' }])
  assert.deepEqual(resolveIn(map, { key: 'j' }), { id: 'cursor.down' })
  assert.equal(resolveIn(map, { key: 'j' }, { typing: true }), null)
})

test('shift is not a modifier: shift+n stays out of the way while typing', () => {
  const map = compileKeymap([{ key: 'shift+n', command: 'find.prev' }])
  assert.deepEqual(resolveIn(map, { key: 'N', shift: true }), { id: 'find.prev' })
  assert.equal(
    resolveIn(map, { key: 'N', shift: true }, { typing: true }),
    null,
    'a capital N in the composer is a letter, not a command'
  )
})

test('a binding that names typing itself keeps its own rule', () => {
  const map = compileKeymap([{ key: 'escape', command: 'composer.leave', when: 'typing' }])
  assert.deepEqual(resolveIn(map, { key: 'Escape' }, { typing: true }), { id: 'composer.leave' })
  assert.equal(resolveIn(map, { key: 'Escape' }, {}), null)
})

test('first match wins, which is how one chord does two jobs', () => {
  const map = compileKeymap([
    { key: 'ctrl+j', command: 'panel.down', when: 'stack-below' },
    { key: 'ctrl+j', command: 'scroll.down' }
  ])
  assert.deepEqual(resolveIn(map, { key: 'j', ctrl: true }, { stackDown: true }), { id: 'panel.down' })
  assert.deepEqual(resolveIn(map, { key: 'j', ctrl: true }, {}), { id: 'scroll.down' })
})

test('a pending chord only matches sequences, and swallows anything else', () => {
  const map = compileKeymap([
    { key: 'super+k g', command: 'panel.goto', arg: 'changes' },
    { key: 'g', command: 'cursor.top' }
  ])
  assert.deepEqual(resolveIn(map, { key: 'g' }, { chord: true }), { id: 'panel.goto', arg: 'changes' })
  assert.equal(resolveIn(map, { key: 'x' }, { chord: true }), null)
  assert.deepEqual(resolveIn(map, { key: 'g' }, {}), { id: 'cursor.top' })
})

test('an open palette owns the keyboard, whatever is bound', () => {
  const map = compileKeymap([{ key: 'super+e', command: 'panel.goto', arg: 'worktrees' }])
  assert.equal(resolveIn(map, { key: 'e', meta: true }, { palette: true }), null)
})

test('a chord accepts its prefix modifier still being held', () => {
  // Nobody lets go of Command between ⌘K and ⌘F, and every editor with chords
  // accepts it. This was the bug: the tail arrived as `super+f` and the entry
  // wanted `f`, so the whole chord silently did nothing.
  const map = compileKeymap([{ key: 'super+k f', command: 'panel.goto', arg: 'files' }])
  const opened = { id: 'panel.goto', arg: 'files' }
  assert.deepEqual(resolveIn(map, { key: 'f' }, { chord: true }), opened, 'released')
  assert.deepEqual(resolveIn(map, { key: 'f', meta: true }, { chord: true }), opened, 'still held')
})

test('only the prefix modifier is forgiven, not any other', () => {
  // Shift changes which key you pressed, so ⌘K ⇧G is not ⌘K G — forgiving it
  // would make two different chords collide.
  const map = compileKeymap([{ key: 'super+k g', command: 'panel.goto', arg: 'changes' }])
  assert.equal(resolveIn(map, { key: 'g', meta: true, shift: true }, { chord: true }), null)
  assert.equal(resolveIn(map, { key: 'g', ctrl: true }, { chord: true }), null)
})

test('a ctrl-prefixed chord forgives ctrl, not cmd', () => {
  const map = compileKeymap([{ key: 'ctrl+x s', command: 'session.new' }])
  assert.deepEqual(resolveIn(map, { key: 's', ctrl: true }, { chord: true }), { id: 'session.new' })
  assert.equal(resolveIn(map, { key: 's', meta: true }, { chord: true }), null)
})

test('a panel that owns the raw keyboard keeps every bare key', () => {
  // The drawing canvas has its own `r` (rectangle), `d` (diamond), `v`
  // (selection). Floe eating them would leave half the tool unusable.
  const map = compileKeymap([
    { key: 'j', command: 'cursor.down' },
    { key: 'ctrl+l', command: 'panel.right' },
    { key: 'super+k d', command: 'panel.goto', arg: 'draw' }
  ])
  assert.equal(resolveIn(map, { key: 'j' }, { raw: true }), null)
  assert.deepEqual(resolveIn(map, { key: 'j' }, {}), { id: 'cursor.down' }, 'and only under raw')
  // The way back out is a chord, so it survives — as does the sequence's tail.
  assert.deepEqual(resolveIn(map, { key: 'l', ctrl: true }, { raw: true }), { id: 'panel.right' })
  assert.deepEqual(resolveIn(map, { key: 'd', meta: true }, { raw: true, chord: true }), {
    id: 'panel.goto',
    arg: 'draw'
  })
})

test('raw suppresses Escape even while typing, which is the whole reason it is positional', () => {
  // `composer.leave` names `typing`, so it escapes the implicit `not typing` —
  // and would escape a `not raw` written the same way. Editing text inside the
  // canvas makes typing AND raw true at once, and blurring mid-word is exactly
  // what must not happen: Escape there belongs to the canvas.
  const map = compileKeymap([{ key: 'escape', command: 'composer.leave', when: 'typing' }])
  assert.equal(resolveIn(map, { key: 'escape' }, { raw: true, typing: true }), null)
  assert.deepEqual(resolveIn(map, { key: 'escape' }, { typing: true }), { id: 'composer.leave' })
})
