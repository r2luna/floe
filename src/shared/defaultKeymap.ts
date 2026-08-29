// Every binding Floe ships with, and the prose that explains it.
//
// One table, two jobs: it is what `resolveKey` walks at runtime, AND what
// `keybindings.toml` is generated from — block comments included. Keeping the
// documentation next to the binding is the only way the generated file cannot
// drift from what the app actually does: change a key here and the explanation
// travels with it.

import type { Keybind } from './keymap.ts'

export interface KeymapSection {
  title: string
  /** The block comment above the section in the generated file. */
  doc: string
  binds: Keybind[]
}

export const KEYMAP_SECTIONS: KeymapSection[] = [
  {
    title: 'Palettes',
    doc: `Two palettes, on purpose. \`⌘⇧P\` is every command; \`⌘/\` is the narrower
"switch project" list, because the common case should not make you read past
forty commands to reach it. \`⌘K\` opens a chord — the next key completes it.`,
    binds: [
      { key: 'super+k', command: 'palette.chord' },
      { key: 'super+shift+p', command: 'palette.commands' },
      { key: 'super+/', command: 'palette.open' }
    ]
  },
  {
    title: 'Settings',
    doc: `\`⌘,\` opens Settings — a view of this file's neighbour, \`floe.toml\`. Anything
it does not put on a row is a link to the file itself, which is documented in
place, so nothing is reachable only through the UI.`,
    binds: [{ key: 'super+,', command: 'settings.open' }]
  },
  {
    title: 'Panels',
    doc: `\`⌃H\` and \`⌃L\` always cross columns, never onto a panel stacked above or
below. They use ctrl rather than a bare letter because moving between panels
has to work while the composer has focus, which is most of the time.

\`⌃J\` and \`⌃K\` do double duty: they move within a stack where there is one, and
scroll where there isn't — two entries sharing a chord, split by \`when\`, with
the narrower one first. \`⌘1\`–\`⌘9\` jump straight to a panel by position, and
\`⌘K /\` flips the focused panel between docked beside and docked below.`,
    binds: [
      { key: 'ctrl+h', command: 'panel.left' },
      { key: 'ctrl+l', command: 'panel.right' },
      { key: 'ctrl+j', command: 'panel.down', when: 'stack-below' },
      { key: 'ctrl+k', command: 'panel.up', when: 'stack-above' },
      ...Array.from({ length: 9 }, (_, n) => ({
        key: `super+${n + 1}`,
        command: 'panel.focusAt',
        arg: String(n)
      })),
      { key: 'super+w', command: 'panel.close' },
      { key: 'super+k /', command: 'panel.dock' }
    ]
  },
  {
    title: 'Jumping to a Panel',
    doc: `\`panel.goto\` opens a panel by name rather than by position, so the binding
means the same thing whatever the layout looks like. From the project and
worktree lists, bare \`h\` and \`l\` jump between the two directly — those keys
stay free everywhere else.`,
    binds: [
      { key: 'super+e', command: 'panel.goto', arg: 'worktrees' },
      { key: 'super+shift+e', command: 'panel.goto', arg: 'projects' },
      { key: 'super+y', command: 'panel.goto', arg: 'terminal' },
      { key: 'super+k g', command: 'panel.goto', arg: 'changes' },
      { key: 'super+k f', command: 'panel.goto', arg: 'files' },
      { key: 'h', command: 'panel.goto', arg: 'projects', when: 'panel in ["projects", "worktrees"]' },
      { key: 'l', command: 'panel.goto', arg: 'worktrees', when: 'panel in ["projects", "worktrees"]' }
    ]
  },
  {
    title: 'Cursor & Scrolling',
    doc: `The vim set, and it means the same thing in a file, a diff and a list,
because all of these move the CURSOR. \`⌃D\` and \`⌃U\` take half a screen and
carry the cursor with them — that is what separates them from \`⌃J\` and \`⌃K\`,
where only the view moves.`,
    binds: [
      { key: 'ctrl+d', command: 'cursor.halfDown' },
      { key: 'ctrl+u', command: 'cursor.halfUp' },
      { key: 'ctrl+j', command: 'scroll.down' },
      { key: 'ctrl+k', command: 'scroll.up' },
      { key: 'arrowdown', command: 'cursor.down' },
      { key: 'arrowup', command: 'cursor.up' },
      { key: 'j', command: 'cursor.down' },
      { key: 'k', command: 'cursor.up' },
      { key: 'g', command: 'cursor.top' },
      { key: 'shift+g', command: 'cursor.bottom' }
    ]
  },
  {
    title: 'Find',
    doc: `\`/\` searches the focused panel, \`n\` and \`⇧N\` walk the matches forward and
back. The matches are cursor positions, so find works in any panel that has
lines.`,
    binds: [
      { key: '/', command: 'find.open' },
      { key: 'n', command: 'find.next' },
      { key: 'shift+n', command: 'find.prev' }
    ]
  },
  {
    title: 'Composer',
    doc: `\`i\` enters the composer, Escape leaves it. Escape unwinds exactly one level
and is never a no-op while there is something to back out of: out of the
text field first, then out of a selection — which is why the \`typing\` entry
comes before the \`selecting\` one.`,
    binds: [
      { key: 'i', command: 'composer.focus' },
      { key: 'escape', command: 'composer.leave', when: 'typing' }
    ]
  },
  {
    title: 'Diff Selection',
    doc: `Visual-line selection, only in the panel where lines exist to select. \`c\`
means comment only once there is a selection to comment on — loose, it would
swallow the letter for no reason.`,
    binds: [
      { key: 'v', command: 'selection.toggle', when: 'panel == "diff"' },
      { key: 'c', command: 'selection.comment', when: 'panel == "diff" and selecting' },
      { key: 'escape', command: 'selection.cancel', when: 'selecting' }
    ]
  },
  {
    title: 'Sessions & Worktrees',
    doc: `\`⌃I\` and \`⌃O\` walk this branch's sessions with vim's jumplist sense: \`⌃O\`
goes back through what you were doing, \`⌃I\` forward again. \`⌃W\` is the other
chat, not the readline word-delete — it has to work from the composer, which
is where you are when you want to go back.`,
    binds: [
      { key: 'super+t', command: 'session.new' },
      { key: 'ctrl+i', command: 'session.prev' },
      { key: 'ctrl+o', command: 'session.next' },
      { key: 'ctrl+w', command: 'session.alternate' },
      { key: 'super+n', command: 'worktree.new' }
    ]
  }
]

/**
 * The whole table, flattened, in the order it is tried.
 *
 * Order carries meaning — the `stack-below` entry for `⌃J` has to come before
 * the plain one — so sections are laid out in resolution order, not by theme,
 * and `Panels` sits above `Cursor & Scrolling` for exactly that reason.
 */
export const DEFAULT_KEYMAP: Keybind[] = KEYMAP_SECTIONS.flatMap((s) => s.binds)

/**
 * Commands that ship with no key, offered as commented-out examples.
 *
 * A chord is suggested for each one so binding it is uncommenting a line, but
 * none of them is active — the suggestions are not checked for collisions with
 * the defaults above, because the user picking one is the point.
 */
export const UNBOUND_SUGGESTIONS: Array<{ command: string; key?: string }> = [
  { command: 'panel.grow', key: 'super+shift+.' },
  { command: 'panel.shrink', key: 'super+shift+,' },
  { command: 'panel.resetSize', key: 'super+shift+0' },
  { command: 'project.add', key: 'super+shift+n' },
  { command: 'project.move' },
  { command: 'group.create' },
  { command: 'group.delete' },
  { command: 'auth.account', key: 'super+shift+a' },
  { command: 'keybindings.reset' },
  { command: 'session.delete', key: 'super+shift+w' },
  { command: 'session.deleteOthers' },
  { command: 'session.deleteAll' }
]
