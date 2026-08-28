// The whole keymap, as a pure function from a key press to an intent. Nothing
// here touches the DOM, so every rule — which modifier wins, what a chord does,
// what a bare letter means while you're typing — is testable without a browser.
//
// The app is keyboard-first, which mostly means: a binding that only sometimes
// fires is worse than no binding. The `typing` and `chord` flags exist so those
// cases are decided in one place instead of re-derived at each call site.

/**
 * A key resolves to a COMMAND ID, never to behaviour. That is what keeps the
 * keymap, the command palette and the MCP `run_command` tool describing the
 * same app: all three name commands from the registry in commands.ts.
 */
export interface Resolved {
  id: string
  arg?: string
}

export interface KeyInput {
  key: string
  meta?: boolean
  ctrl?: boolean
  shift?: boolean
  alt?: boolean
}

export interface KeyContext {
  /** Focus is in a text field, so bare letters are text, not commands. */
  typing?: boolean
  /** ⌘K was pressed and this key completes the chord. */
  chord?: boolean
  /** The kind of the focused panel — some bare keys only apply in a few. */
  kind?: string
  /** A line selection is open, which changes what Escape means. */
  selecting?: boolean
  /** The palette is open: it owns the keyboard until it closes. */
  palette?: boolean
  /**
   * There is a panel to move to below/above the focused one — it is docked, or
   * something is docked to it. ⌃J/⌃K do double duty: move within a stack where
   * there is one, scroll where there isn't. Without this the two would have to
   * share a key by falling back inside the command itself, which would make the
   * binding ambiguous everywhere else that reads the keymap (the palette, MCP).
   */
  stackDown?: boolean
  stackUp?: boolean
}

// Bare h/l jump to these two directly. Only from the panels they connect, so
// the keys stay free everywhere else.
const SIDE_BY_SIDE = new Set(['projects', 'worktrees'])

export function resolveKey(e: KeyInput, ctx: KeyContext = {}): Resolved | null {
  const key = e.key.toLowerCase()

  // While the palette is open it handles its own keys — including Escape and
  // the arrows. Resolving anything here would fire a command behind it.
  if (ctx.palette) return null

  // A chord swallows the next key whatever it is: the caller clears the pending
  // state on any result, so an unmapped key cancels rather than leaking through
  // as a normal binding.
  if (ctx.chord) {
    if (key === 'g') return { id: 'panel.goto', arg: 'changes' }
    if (key === 'f') return { id: 'panel.goto', arg: 'files' }
    // ⌘K / flips the focused panel between beside and below. On the chord
    // rather than on ⌘/ alone, which is already the project palette.
    if (key === '/') return { id: 'panel.dock' }
    return null
  }

  if (e.alt) return null

  if (e.meta) {
    if (key === 'k' && !e.shift) return { id: 'palette.chord' }
    // ⌘⇧P is every command; ⌘/ is the narrower "switch project" list. Two
    // palettes because the common case — changing project — should not make you
    // read past forty commands to reach it.
    if (key === 'p' && e.shift) return { id: 'palette.commands' }
    if (key === '/') return { id: 'palette.open' }
    if (key === 'e') return { id: 'panel.goto', arg: e.shift ? 'projects' : 'worktrees' }
    if (key === 'y') return { id: 'panel.goto', arg: 'terminal' }
    if (key === 't') return { id: 'session.new' }
    if (key === 'n') return { id: 'worktree.new' }
    if (key === 'w') return { id: 'panel.close' }
    if (key >= '1' && key <= '9') return { id: 'panel.focusAt', arg: String(Number(key) - 1) }
    return null
  }

  // ⌃H/⌃L move between panels. Ctrl rather than a bare letter because this one
  // has to work while the composer has focus, which is most of the time.
  if (e.ctrl) {
    // Left/right always cross columns — never onto a panel stacked below or
    // above, which is what would happen if this fell through to a flat index.
    if (key === 'h') return { id: 'panel.left' }
    if (key === 'l') return { id: 'panel.right' }
    // Up/down are two keys doing one job each, decided by what's actually
    // there: move within the stack when the focused panel has a neighbour in
    // that direction, otherwise scroll — which is the other thing you need
    // mid-sentence, reading back through a transcript while the composer holds
    // focus.
    // Half a screen at a time, vim's ⌃D/⌃U — the cursor moves with it, which
    // is the difference from ⌃J/⌃K, where only the view moves.
    if (key === 'd') return { id: 'cursor.halfDown' }
    if (key === 'u') return { id: 'cursor.halfUp' }
    if (key === 'j') return { id: ctx.stackDown ? 'panel.down' : 'scroll.down' }
    if (key === 'k') return { id: ctx.stackUp ? 'panel.up' : 'scroll.up' }
    // ⌃I/⌃O walk this branch's sessions, taking vim's jumplist sense: ⌃O goes
    // back through what you were doing, ⌃I forward again.
    if (key === 'i') return { id: 'session.prev' }
    if (key === 'o') return { id: 'session.next' }
    // ⌃W is the other chat, not the readline word-delete: it has to work from
    // the composer, which is where you are when you want to go back.
    if (key === 'w') return { id: 'session.alternate' }
    return null
  }

  // Arrows work everywhere except inside a text field, where they're cursor
  // movement and always were.
  if (key === 'arrowdown') return ctx.typing ? null : { id: 'cursor.down' }
  if (key === 'arrowup') return ctx.typing ? null : { id: 'cursor.up' }

  // Escape unwinds one level: out of a text field, or out of a selection. It is
  // never a no-op when there is something to back out of.
  if (key === 'escape') {
    if (ctx.typing) return { id: 'composer.leave' }
    return ctx.selecting ? { id: 'selection.cancel' } : null
  }

  if (ctx.typing) return null

  if (key === 'j') return { id: 'cursor.down' }
  if (key === 'k') return { id: 'cursor.up' }
  if (key === 'i') return { id: 'composer.focus' }

  // The rest of the vim set the lane can honour: g/G jump the cursor to the
  // ends, `/` searches the panel and n/N walk the matches. All of them move the
  // CURSOR, so they mean the same thing in a file, a diff and a list.
  if (key === 'g') return { id: e.shift ? 'cursor.bottom' : 'cursor.top' }
  if (key === '/') return { id: 'find.open' }
  if (key === 'n') return { id: e.shift ? 'find.prev' : 'find.next' }

  // Visual-line selection, in the panel where lines exist to select.
  if (ctx.kind === 'diff') {
    if (key === 'v') return { id: 'selection.toggle' }
    // `c` only means comment when there is a selection to comment on; loose, it
    // would swallow the letter for no reason.
    if (key === 'c' && ctx.selecting) return { id: 'selection.comment' }
  }

  if (SIDE_BY_SIDE.has(ctx.kind ?? '')) {
    if (key === 'h') return { id: 'panel.goto', arg: 'projects' }
    if (key === 'l') return { id: 'panel.goto', arg: 'worktrees' }
  }

  return null
}
