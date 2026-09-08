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
forty commands to reach it. \`⌘K\` opens a chord — the next key completes it.

\`⌘P\` finds a place to be: the project's chats first, then the worktree's files.
A chat opens in the lane on the worktree it belongs to, a file opens in the file
panel, and \`⇥\` narrows the list to one kind or the other.`,
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
    title: 'The colony board',
    doc: `The board is two axes: \`h\`/\`l\` cross columns and \`j\`/\`k\` walk the cards
inside one. The cursor drives the panel to its right, so moving is reading;
\`⏎\` forces the card's chat open and takes you into it.

\`ESC\` swaps that same panel to the nanny — the board's own session, one per
project. \`n\` goes there too, with the composer ready, because there is no "new
task" dialog: she already knows the base branch and which stage is full.

\`s\` releases a task from the backlog, which is where its worktree gets cut, and
\`x\` takes a card off the board without touching its branch.`,
    binds: [
      { key: 'h', command: 'colony.left', when: 'panel == "colony"' },
      { key: 'l', command: 'colony.right', when: 'panel == "colony"' },
      { key: 's', command: 'colony.start', when: 'panel == "colony"' },
      { key: 'x', command: 'colony.archive', when: 'panel == "colony"' },
      { key: 'n', command: 'colony.new', when: 'panel == "colony"' },
      { key: 'escape', command: 'colony.nanny', when: 'panel == "colony"' }
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
stay free everywhere else.

\`⌘K B\` is the colony board — b for board, because \`⌘K C\` is already the
commands panel and the two are the pair you would most easily confuse.`,
    binds: [
      { key: 'super+e', command: 'panel.goto', arg: 'worktrees' },
      { key: 'super+shift+e', command: 'panel.goto', arg: 'projects' },
      { key: 'super+y', command: 'panel.goto', arg: 'terminal' },
      { key: 'super+k b', command: 'panel.goto', arg: 'colony' },
      { key: 'super+k g', command: 'panel.goto', arg: 'changes' },
      { key: 'super+k f', command: 'panel.goto', arg: 'files' },
      { key: 'super+k p', command: 'panel.goto', arg: 'plans' },
      { key: 'super+k d', command: 'panel.goto', arg: 'draw' },
      { key: 'super+k c', command: 'panel.goto', arg: 'commands' },
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

\`.\` and \`-\` move the ROOT rather than the cursor: \`.\` points the whole tree at
the directory under the cursor, so it lists that folder and nothing else, and
\`-\` steps the root back out one level until it is the worktree again. \`-\` is
what netrw and vinegar have always used for "up a directory"; the pair is not
\`⇧L\`/\`⇧H\` because no default may take a capital (see Find, below). The header
prints the path the tree is rooted at, and clicking a segment of it roots there
too.

\`r\` renames the row under the cursor, \`m\` moves it to another directory and
\`d\` deletes it — the same three letters the project list uses, on the same
principle: the row the cursor is on is the thing they act on. \`r\` and \`m\` open
on the current name and directory, so editing one character is one keystroke.
Directories count too, and \`d\` asks first, because this one really does remove
from disk.`,
    binds: [
      { key: '.', command: 'files.root', when: 'panel == "files"' },
      { key: '-', command: 'files.unroot', when: 'panel == "files"' },
      { key: 'l', command: 'files.expand', when: 'panel == "files"' },
      { key: 'h', command: 'files.collapse', when: 'panel == "files"' },
      { key: 'r', command: 'files.rename', when: 'panel == "files"' },
      { key: 'm', command: 'files.move', when: 'panel == "files"' },
      { key: 'd', command: 'files.delete', when: 'panel == "files"' }
    ]
  },
  {
    title: 'Commands',
    doc: `The worktree's registered processes — what \`commands.toml\` lists. The keys
are the same letters the file tree uses, on the same principle: they act on the
row the cursor is on. \`r\` runs it, or restarts it if it is already running, so
one key answers "run this" whatever state it is in. \`s\` stops it, \`⏎\` opens its
output beside the list.

\`a\` adds one, \`e\` edits the command line, \`d\` deletes it after asking.
Renaming has no key on purpose: a command's id is the slug of its name, so a
rename re-keys it and orphans the output of a process that is still running —
\`command.rename\` is in the palette, and it refuses while the command runs.`,
    binds: [
      { key: 'r', command: 'command.run', when: 'panel == "commands"' },
      { key: 's', command: 'command.stop', when: 'panel == "commands"' },
      { key: 'enter', command: 'command.logs', when: 'panel == "commands"' },
      { key: 'a', command: 'command.add', when: 'panel == "commands"' },
      { key: 'e', command: 'command.edit', when: 'panel == "commands"' },
      { key: 'd', command: 'command.delete', when: 'panel == "commands"' }
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
    title: 'Drawings',
    doc: `The draw panel's own letters, and deliberately the same ones the skills
and file lists use: \`n\` starts a new drawing, \`r\` renames the one under the
cursor, \`d\` deletes it and \`o\` reveals the file on disk. \`⏎\` opens it on the
canvas beside the list.

\`n\` writes into the branch's \`specs/\` folder: a drawing is part of the work,
so it travels with the branch and turns up in the commit. \`s\` moves an older
draft out of the gitignored \`.floe/draw/\` and into that same folder, and the
canvas follows it there.

Inside the canvas none of these apply: Excalidraw owns every bare key there
(\`r\` rectangle, \`o\` ellipse, \`d\` diamond), which is what the \`raw\` rule in
keymap.ts is for. \`⌃H\`/\`⌃L\` still get you out, because they hold a modifier.`,
    binds: [
      { key: 'n', command: 'draw.new', when: 'panel == "draw"' },
      { key: 'r', command: 'draw.rename', when: 'panel == "draw"' },
      { key: 'd', command: 'draw.delete', when: 'panel == "draw"' },
      { key: 's', command: 'draw.promote', when: 'panel == "draw"' },
      { key: 'o', command: 'draw.reveal', when: 'panel == "draw"' }
    ]
  },
  {
    title: 'MCP servers',
    doc: `The MCP panel's own letters, mirroring the skills panel: \`n\` adds a
server (scope under the +, name on the row), \`e\` opens its mcp.toml in your
editor, \`t\` enables/disables it, \`a\` runs the OAuth flow for a server whose
status chip says needs-auth, \`d\` removes the entry.`,
    binds: [
      { key: 'n', command: 'mcp.new', when: 'panel == "mcp"' },
      { key: 'e', command: 'mcp.edit', when: 'panel == "mcp"' },
      { key: 't', command: 'mcp.toggle', when: 'panel == "mcp"' },
      { key: 'a', command: 'mcp.auth', when: 'panel == "mcp"' },
      { key: 'd', command: 'mcp.delete', when: 'panel == "mcp"' }
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
      { key: 'r', command: 'project.reload', when: 'panel == "projects"' },
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
    title: 'Guided merge',
    doc: `\`⌘K M\` merges the worktree you are in into its base, as a checklist you
can watch: it brings base in, hands any conflicts to an agent in a session of
its own, and stops for you to read the result.

The other four are the checklist's own keys, and they only mean anything while
it is focused. \`⏎\` answers whatever it is waiting for — approve at the review
checkpoint, retry on a step that failed, since it never stops at both. \`r\` puts
the diff on screen without approving, \`s\` stashes a tree too dirty to merge and
runs the checks again, and Escape drops the checklist and its panel with it.
Escape does not undo the merge: what git has already done stays done.

\`⌘K M\` while one is already running brings its panel back rather than starting
a second — which is how you get from the diff you opened with \`r\` to the
approval waiting for you.`,
    binds: [
      { key: 'super+k m', command: 'worktree.merge' },
      { key: 'enter', command: 'merge.confirm', when: 'panel == "merge"' },
      { key: 'r', command: 'merge.review', when: 'panel == "merge"' },
      { key: 's', command: 'merge.stash', when: 'panel == "merge"' },
      { key: 'escape', command: 'merge.cancel', when: 'panel == "merge"' }
    ]
  },
  {
    title: 'Guided remove',
    doc: `\`⌘K X\` removes the worktree you are in and deletes its branch, as
the same kind of checklist: it inspects the tree, drops the branch's database,
removes the worktree and deletes the branch.

It stops in exactly one place. A tree with uncommitted work pauses and lists
what is about to be destroyed, and \`⏎\` is what says yes to that — the same
key that retries a step that failed, since it never stops at both. Escape drops
the checklist and its panel with it, and does not put back what has already
gone.

There is no rail icon for it: an icon you can click at any time is an
invitation, and this is not one.`,
    binds: [
      { key: 'super+k x', command: 'worktree.remove' },
      { key: 'enter', command: 'remove.confirm', when: 'panel == "remove"' },
      { key: 'escape', command: 'remove.cancel', when: 'panel == "remove"' }
    ]
  },
  {
    title: 'Worktree setup',
    doc: `A new worktree provisions itself: it copies the main checkout's \`.env\`
and rewrites it for this branch, creates the storage directories, installs the
dependencies, links the site and creates and migrates a database of its own.
The checklist opens on its own while that runs.

The per-branch database is the part that matters most. Two worktrees sharing
one \`DB_DATABASE\` overwrite each other's test data, and the failure looks like
a bug in the feature rather than a shared database.

\`⌘K W\` runs it again for the worktree you are in. Every step is idempotent, so
it is also the repair for an install that died halfway. Over the checklist,
\`⏎\` re-runs from the step that failed and Escape only hides it — the steps run
in main and carry on.`,
    binds: [
      { key: 'super+k w', command: 'worktree.provision' },
      { key: 'enter', command: 'provision.confirm', when: 'panel == "provision"' },
      { key: 'escape', command: 'provision.cancel', when: 'panel == "provision"' }
    ]
  },
  {
    title: 'Project setup',
    doc: `Adding a project Floe has never seen starts the command setup: a
checklist that asks whether the project already has commands and, when it does
not, opens a background session running the \`setup-commands\` skill to work
them out.

The session is deliberately not on screen. The panel is what you watch, and the
one moment it needs you is the \`choose\` step — the agent has asked which
processes to register and is waiting. \`⏎\` there opens that chat; \`r\`
retries a step that failed, and escape drops the checklist without stopping the
session it opened.

No rail icon, for the removal's reason: an icon you can click at any time is an
invitation, and this one only means something while a setup is running.
\`setup.start\` in the palette runs it again for a project added before.`,
    binds: [
      { key: 'enter', command: 'setup.chat', when: 'panel == "setup"' },
      { key: 'r', command: 'setup.retry', when: 'panel == "setup"' },
      { key: 'escape', command: 'setup.cancel', when: 'panel == "setup"' }
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
      { key: 'g', command: 'cursor.top' }
    ]
  },
  {
    title: 'Find',
    doc: `\`/\` searches the focused panel and \`n\` walks the matches forward. The
matches are cursor positions, so find works in any panel that has lines.

Walking BACK has no default key on purpose: a bare shift+letter is how you type
a capital, and a binding on one is a letter the composer cannot have. Reach for
\`find.prev\` in the palette, or give it a chord of your own.`,
    binds: [
      { key: '/', command: 'find.open' },
      { key: 'n', command: 'find.next' }
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
    title: 'Reading a Diff',
    doc: `\`]\` and \`[\` walk the changes, a run of changed lines counting as one —
a rewritten paragraph is one edit, not twelve.

\`p\` switches a markdown diff between prose and its source. Prose is the
default for \`.md\`: the document with only the changed WORDS marked inside it,
rather than a rewritten sentence shown as one red line and one green one.`,
    binds: [
      { key: 'p', command: 'diff.view', when: 'panel == "diff"' },
      { key: ']', command: 'diff.nextChange', when: 'panel == "diff"' },
      { key: '[', command: 'diff.prevChange', when: 'panel == "diff"' }
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
is where you are when you want to go back.

\`⌘⇧W\` forgets the open session: shift on \`⌘W\`, which closes the panel, so
the pair reads as "close this" and "close this for good". It asks first, and
what it deletes is Floe's record — the transcript stays on disk.`,
    binds: [
      { key: 'super+t', command: 'session.new' },
      { key: 'super+shift+w', command: 'session.delete' },
      { key: 'ctrl+i', command: 'session.prev' },
      { key: 'ctrl+o', command: 'session.next' },
      { key: 'ctrl+w', command: 'session.alternate' },
      { key: 'alt+a', command: 'subagents.toggle' },
      { key: 'super+n', command: 'worktree.new' }
    ]
  },
  {
    title: 'Queries',
    doc: `A query is another agent answering beside this chat — \`@codex analisa isso\`
opens one. The three keys are what end it: \`⌘⇧M\` merges the conversation into
the chat, \`⌘⇧G\` lets the chat read it without closing anything, \`⌘⇧D\` throws
it away.

They work from either panel, so you can merge without leaving the chat. \`⌘W\`
deliberately does NOT discard — closing a panel and throwing a conversation
away are different things, and one key for both would make the safe habit
destructive.`,
    binds: [
      { key: 'super+shift+m', command: 'query.merge' },
      { key: 'super+shift+g', command: 'query.peek' },
      { key: 'super+shift+d', command: 'query.discard' }
    ]
  },
  {
    title: 'Selecting Sessions',
    doc: `In the worktree list \`x\` ticks the session under the cursor and \`d\` deletes
what is ticked — or, with nothing ticked, the one you are on. Ticks are a SET,
not a range: sessions worth clearing out are scattered down the list and under
different branches, so \`v\`'s contiguous selection would be the wrong shape.

\`escape\` unticks everything. The mouse says the same three things — \`⌘\`-click
ticks one, \`⇧\`-click ticks up to it from the last one, and right-click offers
all three with their keys printed beside them — and a red button appears in
the panel header while anything is ticked, so what \`d\` is about to delete is
always on screen.

\`d\` asks before it deletes, and what it deletes is Floe's record: the Claude
transcripts stay on disk.`,
    binds: [
      { key: 'x', command: 'session.mark', when: 'panel == "worktrees"' },
      { key: 'd', command: 'session.deleteMarked', when: 'panel == "worktrees"' },
      { key: 'escape', command: 'session.markClear', when: 'panel == "worktrees" and marked' }
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
  { command: 'session.deleteOthers' },
  { command: 'session.deleteAll' },
  { command: 'session.deleteIdle' },
  { command: 'query.open', key: 'super+shift+q' },
  { command: 'query.focus' },
  { command: 'query.reopen' }
]
