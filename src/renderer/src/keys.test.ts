import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveKey, type KeyContext, type KeyInput, type Resolved } from './keys.ts'

const r = (e: KeyInput, ctx?: KeyContext): Resolved | null => resolveKey(e, ctx)

test('⌃H and ⌃L move between panels, left and right', () => {
  assert.deepEqual(r({ key: 'h', ctrl: true }), { id: 'panel.left' })
  assert.deepEqual(r({ key: 'l', ctrl: true }), { id: 'panel.right' })
})

test('⌃H and ⌃L keep working while typing — that is why they are not bare keys', () => {
  assert.deepEqual(r({ key: 'l', ctrl: true }, { typing: true }), { id: 'panel.right' })
})

test('⌃W is the alternate chat, including from the composer', () => {
  assert.deepEqual(r({ key: 'w', ctrl: true }), { id: 'session.alternate' })
  assert.deepEqual(r({ key: 'w', ctrl: true }, { typing: true }), { id: 'session.alternate' })
})

test('⌘E and ⌘⇧E are told apart by shift', () => {
  assert.deepEqual(r({ key: 'e', meta: true }), { id: 'panel.goto', arg: 'worktrees' })
  // Browsers report the uppercase letter when shift is held.
  assert.deepEqual(r({ key: 'E', meta: true, shift: true }), { id: 'panel.goto', arg: 'projects' })
})

test('⌘Y goes to the terminal, through the same toggle as the rest', () => {
  assert.deepEqual(r({ key: 'y', meta: true }), { id: 'panel.goto', arg: 'terminal' })
})

test('⌘K starts a chord and g completes it', () => {
  assert.deepEqual(r({ key: 'k', meta: true }), { id: 'palette.chord' })
  assert.deepEqual(r({ key: 'g' }, { chord: true }), { id: 'panel.goto', arg: 'changes' })
  assert.deepEqual(r({ key: 'f' }, { chord: true }), { id: 'panel.goto', arg: 'files' })
})

test('an unmapped key cancels the chord instead of falling through', () => {
  // Without this, ⌘K then j would scroll the list — a chord that silently does
  // something else is worse than one that does nothing.
  assert.equal(r({ key: 'j' }, { chord: true }), null)
  assert.equal(r({ key: 'x' }, { chord: true }), null)
})

test('⌘W closes and ⌘1-9 jump to a panel', () => {
  assert.deepEqual(r({ key: 'w', meta: true }), { id: 'panel.close' })
  assert.deepEqual(r({ key: '3', meta: true }), { id: 'panel.focusAt', arg: '2' })
})

test('j/k and the arrows both move the row cursor', () => {
  assert.deepEqual(r({ key: 'j' }), { id: 'cursor.down' })
  assert.deepEqual(r({ key: 'ArrowDown' }), { id: 'cursor.down' })
  assert.deepEqual(r({ key: 'k' }), { id: 'cursor.up' })
  assert.deepEqual(r({ key: 'ArrowUp' }), { id: 'cursor.up' })
})

test('typing suppresses every bare key, arrows included', () => {
  const t = { typing: true }
  for (const key of ['j', 'k', 'i', 'h', 'l', 'ArrowDown', 'ArrowUp'])
    assert.equal(r({ key }, { ...t, kind: 'projects' }), null, key)
})

test('i enters the composer and Escape is the way back out', () => {
  assert.deepEqual(r({ key: 'i' }), { id: 'composer.focus' })
  assert.deepEqual(r({ key: 'Escape' }, { typing: true }), { id: 'composer.leave' })
  // Escape outside a field has nothing to leave.
  assert.equal(r({ key: 'Escape' }), null)
})

test('bare h/l only bind inside the two panels they connect', () => {
  assert.deepEqual(r({ key: 'h' }, { kind: 'projects' }), { id: 'panel.goto', arg: 'projects' })
  assert.deepEqual(r({ key: 'l' }, { kind: 'worktrees' }), { id: 'panel.goto', arg: 'worktrees' })
  // Elsewhere the letters stay free.
  assert.equal(r({ key: 'h' }, { kind: 'chat' }), null)
  assert.equal(r({ key: 'l' }, { kind: 'diff' }), null)
})

test('alt is never part of a binding', () => {
  assert.equal(r({ key: 'l', ctrl: true, alt: true }), null)
  assert.equal(r({ key: 'j', alt: true }), null)
})

test('a raw DOM event is not a KeyInput', () => {
  // The DOM spells these metaKey/ctrlKey. Passing the event straight through
  // leaves every modifier undefined, and ⌃L quietly becomes a bare `l` — which
  // is exactly the bug this guards. App.tsx adapts at the call seam.
  const domish = { key: 'l', ctrlKey: true } as unknown as KeyInput
  assert.equal(r(domish), null, 'ctrlKey must not be read as ctrl')
  assert.deepEqual(r({ key: 'l', ctrl: true }), { id: 'panel.right' })
})

test('v toggles selection, but only where there are lines to select', () => {
  assert.deepEqual(r({ key: 'v' }, { kind: 'diff' }), { id: 'selection.toggle' })
  assert.equal(r({ key: 'v' }, { kind: 'chat' }), null)
  assert.equal(r({ key: 'v' }, { kind: 'projects' }), null)
})

test('c only means comment while something is selected', () => {
  assert.deepEqual(r({ key: 'c' }, { kind: 'diff', selecting: true }), { id: 'selection.comment' })
  assert.equal(r({ key: 'c' }, { kind: 'diff' }), null, 'no selection, no comment')
})

test('Escape unwinds one level at a time', () => {
  assert.deepEqual(r({ key: 'Escape' }, { selecting: true }), { id: 'selection.cancel' })
  // A text field wins: you are inside it, so that is the level you leave first.
  assert.deepEqual(r({ key: 'Escape' }, { typing: true, selecting: true }), { id: 'composer.leave' })
  assert.equal(r({ key: 'Escape' }, {}), null)
})

test('⌘/ opens the palette', () => {
  assert.deepEqual(r({ key: '/', meta: true }), { id: 'palette.open' })
})

test('an open palette owns the keyboard', () => {
  // Otherwise ⌘E would switch panels behind it and Escape would unwind the
  // wrong level — the palette handles both itself.
  const open = { palette: true }
  assert.equal(r({ key: 'e', meta: true }, open), null)
  assert.equal(r({ key: 'Escape' }, open), null)
  assert.equal(r({ key: 'j' }, open), null)
  assert.equal(r({ key: 'l', ctrl: true }, open), null)
})

test('⌘T starts a session and ⌘N a worktree', () => {
  assert.deepEqual(r({ key: 't', meta: true }), { id: 'session.new' })
  assert.deepEqual(r({ key: 'n', meta: true }), { id: 'worktree.new' })
})

test('⌃J and ⌃K scroll by default, and keep working while typing', () => {
  assert.deepEqual(r({ key: 'j', ctrl: true }), { id: 'scroll.down' })
  assert.deepEqual(r({ key: 'k', ctrl: true }), { id: 'scroll.up' })
  // Reading back through a transcript while composing is the normal case.
  assert.deepEqual(r({ key: 'j', ctrl: true }, { typing: true }), { id: 'scroll.down' })
})

test('⌃J and ⌃K move within a stack when there is one to move into', () => {
  assert.deepEqual(r({ key: 'j', ctrl: true }, { stackDown: true }), { id: 'panel.down' })
  assert.deepEqual(r({ key: 'k', ctrl: true }, { stackUp: true }), { id: 'panel.up' })
  // The other direction still falls back to scrolling — being IN a stack does
  // not mean every direction out of it has somewhere to go.
  assert.deepEqual(r({ key: 'k', ctrl: true }, { stackDown: true }), { id: 'scroll.up' })
})

test('bare j/k still move the cursor — Ctrl is what makes it scrolling', () => {
  assert.deepEqual(r({ key: 'j' }), { id: 'cursor.down' })
  assert.deepEqual(r({ key: 'k' }), { id: 'cursor.up' })
})

test('⌘K / flips a panel between beside and below', () => {
  assert.deepEqual(r({ key: '/' }, { chord: true }), { id: 'panel.dock' })
  // Without the chord it is still the project palette, not a dock.
  assert.deepEqual(r({ key: '/', meta: true }), { id: 'palette.open' })
})

test('ctrl+i/o walk the branch sessions, even mid-sentence', () => {
  assert.deepEqual(r({ key: 'i', ctrl: true }), { id: 'session.prev' })
  assert.deepEqual(r({ key: 'o', ctrl: true }), { id: 'session.next' })
  // The whole point of using Ctrl: bare `i` is still "write a message".
  assert.deepEqual(r({ key: 'o', ctrl: true }, { typing: true }), { id: 'session.next' })
  assert.deepEqual(r({ key: 'i' }), { id: 'composer.focus' })
})

test('the vim set moves the cursor: g/G, ⌃D/⌃U, / and n/N', () => {
  assert.deepEqual(r({ key: 'g' }), { id: 'cursor.top' })
  assert.deepEqual(r({ key: 'G', shift: true }), { id: 'cursor.bottom' })
  assert.deepEqual(r({ key: 'd', ctrl: true }), { id: 'cursor.halfDown' })
  assert.deepEqual(r({ key: 'u', ctrl: true }), { id: 'cursor.halfUp' })
  assert.deepEqual(r({ key: '/' }), { id: 'find.open' })
  assert.deepEqual(r({ key: 'n' }), { id: 'find.next' })
  assert.deepEqual(r({ key: 'N', shift: true }), { id: 'find.prev' })
  // ⌘/ is still the project palette — the bare key is the panel search.
  assert.deepEqual(r({ key: '/', meta: true }), { id: 'palette.open' })
  // And none of them fire while you are typing.
  for (const key of ['g', '/', 'n']) assert.equal(r({ key }, { typing: true }), null)
})
