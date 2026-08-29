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
    doc: `Three palettes, on purpose. \`⌘⇧P\` is every command; \`⌘/\` is the narrower
"switch project" list, because the common case should not make you read past
forty commands to reach it. \`⌘K\` opens a chord — the next key completes it. \`⌘P\` is
the worktree's files, and picking one opens it in the file panel.`,
    binds: [
      { key: 'super+k', command: 'palette.chord' },
      { key: 'super+shift+p', command: 'palette.commands' },
      { key: 'super+/', command: 'palette.open' },
      { key: 'super+p', command: 'palette.files' }
    ]
  },
  {
    title: 'Settings',
    doc: `\`⌘,\` opens Settings — a view of this file's neighbour, \`floe.toml\`. Anything
it does not put on a row is a link to the file itself, which is documented in
place, so nothing is reachable only through the UI.

\`⌘K S\` opens Skills — the Markdown in \`~/.config/floe/skills\` that \`/name\`
sends to whichever harness answers. It is a panel rather than a palette because
skills are things you keep: the list is where you write, rename and delete them.`,
    binds: [
      { key: 'super+,', command: 'settings.open' },
      { key: 'super+k s', command: 'skills.open' }
    ]
  },
  {
    title: 'Shell calls in the chat',
    doc: `A run of shell commands in a transcript is a block of rows, and each row
is a cursor row: \`j\`/\`k\` walks them and \`Enter\` opens the one you are on, which
is how you read a command too long for its line. A command that already fits has
nothing to open.

\`y\` copies the command under the cursor and \`x\` runs it in this worktree's
terminal — the same two things the icons on the row do, because the command an
agent ran is often the one you want to run yourself.`,
    binds: [
      { key: 'y', command: 'bash.copy', when: 'panel == "chat"' },
      { key: 'x', command: 'bash.run', when: 'panel == "chat"' }
    ]
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
      { key: 'super+k p', command: 'panel.goto', arg: 'plans' },
      { key: 'h', command: 'panel.goto', arg: 'projects', when: 'panel in ["projects", "worktrees"]' },
      { key: 'l', command: 'panel.goto', arg: 'worktrees', when: 'panel in ["projects", "worktrees"]' }
    ]
  },
  {
    title: 'File Tree',
    doc: `In the file tree \`h\` and \`l\` walk depth the way \`j\` and \`k\` walk rows:
\`l\` opens the directory under the cursor, \`h\` closes it. On anything that is
not an open directory \`h\` goes up to the containing one instead, so it is
never a key that does nothing.

These come before the cursor keys because \`h\` and \`l\` mean something else in
the project and worktree lists, and first match wins.

\`r\` renames the row under the cursor, \`m\` moves it to another directory and
\`d\` deletes it — the same three letters the project list uses, on the same
principle: the row the cursor is on is the thing they act on. \`r\` and \`m\` open
on the current name and directory, so editing one character is one keystroke.
Directories count too, and \`d\` asks first, because this one really does remove
from disk.`,
    binds: [
      { key: 'l', command: 'files.expand', when: 'panel == "files"' },
      { key: 'h', command: 'files.collapse', when: 'panel == "files"' },
      { key: 'r', command: 'files.rename', when: 'panel == "files"' },
      { key: 'm', command: 'files.move', when: 'panel == "files"' },
      { key: 'd', command: 'files.delete', when: 'panel == "files"' }
    ]
  },
  {
    title: 'Editor',
    doc: `\`e\` opens the file under the cursor in your editor — the one
\`[editor] command\` names in floe.toml. A terminal editor (nvim, vim, helix)
takes over the file panel itself, on the line the cursor was on; a GUI editor
(VS Code, Zed, Sublime) is launched beside the app. Either way it is the same
key from the file tree, the plans list, the reader and a diff.`,
    binds: [
      {
        key: 'e',
        command: 'editor.open',
        when: 'panel in ["files", "plans", "file", "diff", "edit"]'
      }
    ]
  },
  {
    title: 'Skills',
    doc: `The skills panel's own letters, and deliberately the same four the file
tree uses: \`n\` writes a new one, \`r\` renames it, \`d\` deletes it and \`e\` opens
it in your editor. Enter reads it in the file panel beside the list.

A skill is addressed by NAME, not by filename — renaming moves the file and
rewrites its frontmatter together, so \`/old-name\` stops working exactly when
the list stops showing it.

Right-clicking a row offers the same four, because they are the same commands:
the menu focuses the row it was opened on and dispatches an id.`,
    binds: [
      { key: 'n', command: 'skill.new', when: 'panel == "skills"' },
      { key: 'r', command: 'skill.rename', when: 'panel == "skills"' },
      { key: 'd', command: 'skill.delete', when: 'panel == "skills"' },
      { key: 'e', command: 'skill.edit', when: 'panel == "skills"' }
    ]
  },
  {
    title: 'Projects',
    doc: `The list's own letters. \`n\` adds a project, \`d\` removes the one under the
cursor — Floe forgets it, the folder on disk is untouched — and \`m\` picks it
up. While it is held, \`j\`/\`k\` and the arrows carry it from group to group,
Enter drops it there and Escape puts it back, so filing a project never
leaves the list.

Two orderings matter here. These sit above the cursor keys so that \`j\` moves
the PROJECT while one is in flight, and above Find so that \`n\` in this panel
adds a project rather than repeating a search — \`/\` still searches it, and
\`n\` still repeats the match everywhere else.`,
    binds: [
      { key: 'n', command: 'project.add', when: 'panel == "projects"' },
      { key: 'd', command: 'project.delete', when: 'panel == "projects"' },
      { key: 'm', command: 'project.move.start', when: 'panel == "projects"' },
      { key: 'j', command: 'project.move.down', when: 'moving' },
      { key: 'k', command: 'project.move.up', when: 'moving' },
      { key: 'arrowdown', command: 'project.move.down', when: 'moving' },
      { key: 'arrowup', command: 'project.move.up', when: 'moving' },
      { key: 'enter', command: 'project.move.commit', when: 'moving' },
      { key: 'escape', command: 'project.move.cancel', when: 'moving' }
    ]
  },
  {
    title: 'Cursor & Scrolling',
    doc: `The vim set, and it means the same thing in a file, a diff and a list,
because all of these move the CURSOR. \`⌃D\` and \`⌃U\` take half a screen and
carry the cursor with them — that is what separates them from \`⌃J\` and \`⌃K\`,
where only the view moves.

\`⌃⇧J\` and \`⌃⇧K\` scroll too, and only scroll: \`⌃J\`/\`⌃K\` give the chord up to
moving between stacked panels when there is one above or below, and adding
shift is how you read back through a chat that sits in a stack. Both work with
the cursor in the composer.`,
    binds: [
      { key: 'ctrl+d', command: 'cursor.halfDown' },
      { key: 'ctrl+u', command: 'cursor.halfUp' },
      { key: 'ctrl+j', command: 'scroll.down' },
      { key: 'ctrl+k', command: 'scroll.up' },
      { key: 'ctrl+shift+j', command: 'scroll.down' },
      { key: 'ctrl+shift+k', command: 'scroll.up' },
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
    title: 'Line Selection',
    doc: `Visual-line selection, only in the panels where lines exist to select — a
diff and a file (which includes a rendered .md, one row per source line). \`c\`
sends the range to the composer: the diff as a quoted patch, a file as a
\`path:12-30\` reference. It means comment only once there is a selection to
comment on — loose, it would swallow the letter for no reason.`,
    binds: [
      { key: 'v', command: 'selection.toggle', when: 'panel in ["diff", "file"]' },
      { key: 'c', command: 'selection.comment', when: 'panel in ["diff", "file"] and selecting' },
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
  { command: 'project.move' },
  { command: 'group.create' },
  { command: 'group.delete' },
  { command: 'auth.account', key: 'super+shift+a' },
  { command: 'keybindings.reset' },
  { command: 'session.delete', key: 'super+shift+w' },
  { command: 'session.deleteOthers' },
  { command: 'session.deleteAll' }
]
