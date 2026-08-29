// The command registry: every action the UI can perform, as data.
//
// Its own module, not a constant inside App, because three callers must be able
// to enumerate it — the keymap (keys.ts resolves a key to an id), the command
// palette, and the MCP `run_command` tool. A registry that only React can see
// would make "one source of truth" a claim rather than a fact; this one is
// importable by a plain test, which is how the id list stays honest.
// Explicit .ts extensions: this module is imported by a plain `node --test`
// run as well as by Vite, and Node's ESM resolver does not guess extensions.
import {
  clearSize,
  close,
  closePanel,
  focusAt,
  focusDir,
  open,
  patchPanel,
  resizePanel,
  toggleDock,
  toggleKind
} from './lane.ts'
import { appendComment, fileRef, parseUnifiedDiff, quoteSelection, selRange } from './diff.ts'
import type { Command, CommandContext } from './commands.ts'
import { editSub } from './editorTarget.ts'

/**
 * Scroll the focused panel's content.
 *
 * Which element scrolls is a DOM question — the chat scrolls its transcript,
 * the diff scrolls its body — so it finds the overflowing one rather than
 * naming them. A panel that fits needs no scrolling and gets none.
 *
 * The step is a fraction of what you can see, not a fixed number of pixels: on
 * a tall panel a fixed step crawls, and on a short one it jumps past the line
 * you were reading.
 */
function scrollPanel(c: CommandContext, dir: number): void {
  const panel = c.panelEl(c.lane.focus)
  if (!panel) return
  const scroller = [...panel.querySelectorAll<HTMLElement>('*')].find(
    (el) => el.scrollHeight > el.clientHeight + 4 && getComputedStyle(el).overflowY !== 'visible'
  )
  if (!scroller) return
  // Plain assignment, and deliberately NOT smooth — neither scrollBy's
  // behaviour option nor CSS scroll-behavior animates in this Chromium, and
  // asking for either leaves the element exactly where it was. Instant is also
  // the right feel for a key you hold down.
  scroller.scrollTop += dir * Math.max(80, scroller.clientHeight * 0.2)
}

/**
 * The composer `i` should land in: the one in the panel you are already in, or
 * failing that the only one open. Preferring the focused panel matters once two
 * are on screen — with a chat beside a branch launcher, `i` has to mean "write
 * here", not "write in whichever one the lane lists first".
 */
function findComposer(c: CommandContext): HTMLTextAreaElement | null {
  const here = c.panelEl(c.lane.focus)?.querySelector<HTMLTextAreaElement>('.composer-input')
  if (here) return here
  for (let i = 0; i < c.lane.panels.length; i++) {
    const box = c.panelEl(i)?.querySelector<HTMLTextAreaElement>('.composer-input')
    if (box) return box
  }
  return null
}

/**
 * Move the cursor inside the focused panel, and — while a selection is open —
 * drag its head along, so moving grows or shrinks the range instead of leaving
 * it behind.
 */
/**
 * Put the cursor on row `to`, clamped. The same tail every movement command
 * ends with: focus the row, remember the index, drag an open selection along.
 */
function landOn(c: CommandContext, rows: HTMLElement[], to: number): void {
  const row = rows[Math.max(0, Math.min(to, rows.length - 1))]
  if (!row) return
  row.focus()
  const at = rows.indexOf(row)
  c.setLane((l) => {
    const panel = l.panels[l.focus]
    const sel = panel?.selection ? { ...panel.selection, head: at } : panel?.selection
    return patchPanel(l, l.focus, { cursor: at, selection: sel })
  })
}

/** Half a screen of rows, so ⌃D/⌃U move by what you can actually see. */
function pageStep(c: CommandContext, rows: HTMLElement[]): number {
  const panel = c.panelEl(c.lane.focus)
  const rowHeight = rows[0]?.offsetHeight || 20
  return Math.max(1, Math.round((panel?.clientHeight ?? 400) / rowHeight / 2))
}

/** The file row the cursor is on, or null when it is somewhere else. */
function fileRow(c: CommandContext): HTMLElement | null {
  const active = document.activeElement as HTMLElement | null
  return active && c.panelEl(c.lane.focus)?.contains(active) ? active : null
}

function moveCursor(c: CommandContext, delta: number): void {
  const panelEl = c.panelEl(c.lane.focus)
  const all = c.rowsOf(panelEl)
  if (!all.length) return

  const active = document.activeElement as HTMLElement | null
  // A panel with two lists (the diff's files and its hunks) marks each one a
  // `data-nav-group`; movement stays inside the group you're in. The index
  // stored is the flat one, so it still points at the right row afterwards.
  const scope = active?.closest('[data-nav-group]')
  const rows = scope ? [...scope.querySelectorAll<HTMLElement>('button, [data-nav]')] : all

  const cursor = c.lane.panels[c.lane.focus]?.cursor
  const fromActive = rows.indexOf(active as HTMLElement)
  const here = fromActive !== -1 ? fromActive : cursor != null ? rows.indexOf(all[cursor]) : -1
  // From nowhere, down enters at the top and up at the bottom.
  const next = here === -1 ? (delta > 0 ? 0 : rows.length - 1) : here + delta
  const row = rows[Math.max(0, Math.min(next, rows.length - 1))]
  if (!row) return

  row.focus()
  const to = all.indexOf(row)
  c.setLane((l) => {
    const panel = l.panels[l.focus]
    const sel = panel?.selection ? { ...panel.selection, head: to } : panel?.selection
    return patchPanel(l, l.focus, { cursor: to, selection: sel })
  })
}

/**
 * Put the selected lines into the chat composer, ready to say something about.
 *
 * What lands there depends on the panel. A diff is quoted in full — the patch
 * is not on disk, so the text is the only way the agent can see it. A file is
 * referenced by `path:from-to` instead: the agent can open it, and a pasted
 * copy would go stale the moment either of you edits the file.
 */
/**
 * The file `e` would open, and the line to land on.
 *
 * Three panels can answer: the tree (the row under the cursor), the reader (its
 * own file, on the cursor's line) and a diff (the file, on the line that row is
 * in the NEW version — an editor has nothing to say about the old one). Null
 * when the focused panel is none of those, which is what dims the command.
 */
function editTargetOf(c: CommandContext): { path: string; line?: number } | null {
  const panel = c.lane.panels[c.lane.focus]
  if (!panel) return null
  if (panel.kind === 'files') {
    const path = fileRow(c)?.dataset.file
    return path ? { path } : null
  }
  if (panel.kind === 'file') return { path: panel.sub ?? '', line: (panel.cursor ?? 0) + 1 }
  if (panel.kind === 'diff') {
    const path = panel.sub ?? ''
    // The parse, not the DOM, for the same reason the quote uses it: the row the
    // cursor indexes has to be the row we read a line number off.
    const { rows } = parseUnifiedDiff(c.patchFor(path))
    const nav = c.rowsOf(c.panelEl(c.lane.focus))
    const row = rows[(panel.cursor ?? 0) - (nav.length - rows.length)]
    return { path, line: row?.newNo }
  }
  return null
}

function commentOnSelection(c: CommandContext): void {
  const panel = c.lane.panels[c.lane.focus]
  const r = selRange(panel?.selection)
  if (!panel || !r) return

  // Rows here must be the SAME list the cursor indexes: the parse, not the DOM,
  // so the quote cannot drift from what is highlighted.
  const quote =
    panel.kind === 'file'
      ? fileRef(panel.sub ?? '', r[0], r[1])
      : (() => {
          const { rows } = parseUnifiedDiff(c.patchFor(panel.sub ?? ''))
          const nav = c.rowsOf(c.panelEl(c.lane.focus))
          const offset = nav.length - rows.length
          return quoteSelection(rows, r[0] - offset, r[1] - offset, panel.sub ?? '')
        })()
  if (!quote) return

  // Any composer, not only the chat's: the launcher has one too, and a comment
  // that silently does nothing because the session hasn't started yet is worse
  // than one that lands where you can see it.
  const box = findComposer(c)
  if (!box) return

  // Write through the native setter so React's onChange sees it — the composer
  // is controlled, and assigning .value alone would be reverted on next render.
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  const next = appendComment(box.value, quote)
  setValue?.call(box, next)
  box.dispatchEvent(new Event('input', { bubbles: true }))
  // Drop the selection: it has been said, and leaving it highlighted invites
  // commenting on the same lines twice.
  c.setLane((l) => patchPanel(l, l.focus, { selection: null }))
  box.focus()
  // Caret at the very end: the next thing you do is write about the block that
  // just arrived, and a caret left mid-message would put that note in the
  // middle of the previous one.
  box.setSelectionRange(next.length, next.length)
  box.scrollTop = box.scrollHeight
}

/**
 * The registry. Defined at module scope, not inside the component: the palette
 * and the MCP tool need to enumerate it without a render, and a command that
 * captured React state would go stale the moment the lane changed. State
 * arrives through the context instead.
 */
/**
 * Resize the focused panel by a step, measuring from what it is on screen.
 *
 * The current size is read from the DOM rather than from the lane, because most
 * panels have no size recorded — they are whatever their kind's default and the
 * leftover width worked out to. Growing from the number you can see is the only
 * way the first keypress does not jump.
 */
function nudgeSize(c: CommandContext, step: number): void {
  const el = c.panelEl(c.lane.focus)
  if (!el) return
  const docked = c.lane.panels[c.lane.focus]?.dock === 'below'
  const now = docked ? el.offsetHeight : el.offsetWidth
  c.setLane((l) => resizePanel(l, l.focus, now + step, docked ? 120 : 180))
}

export const REGISTRY: Map<string, Command> = new Map(
  (
    [
      {
        id: 'panel.right',
        title: 'Focus panel to the right',
        group: 'Panels',
        keys: '⌃L',
        run: (c) => c.setLane((l) => focusDir(l, 1, 0))
      },
      {
        id: 'panel.left',
        title: 'Focus panel to the left',
        group: 'Panels',
        keys: '⌃H',
        run: (c) => c.setLane((l) => focusDir(l, -1, 0))
      },
      {
        // Only reachable where there is something to move between — a stack.
        // Plain ⌃J/⌃K keep scrolling everywhere else (see scroll.down/up).
        id: 'panel.down',
        title: 'Focus panel below (in a stack)',
        group: 'Panels',
        keys: '⌃J',
        run: (c) => c.setLane((l) => focusDir(l, 0, 1))
      },
      {
        id: 'panel.up',
        title: 'Focus panel above (in a stack)',
        group: 'Panels',
        keys: '⌃K',
        run: (c) => c.setLane((l) => focusDir(l, 0, -1))
      },
      {
        id: 'panel.focusAt',
        title: 'Focus panel by position',
        group: 'Panels',
        keys: '⌘1–9',
        run: (c, arg) => c.setLane((l) => focusAt(l, Number(arg ?? 0)))
      },
      {
        // "Below" and "beside" are the same panel in two shapes — one command,
        // so the header button and the palette can never drift apart.
        id: 'panel.dock',
        title: 'Dock panel below its neighbour',
        group: 'Panels',
        keys: '⌘K /',
        enabled: (c) => c.lane.focus > 0 && !!c.lane.panels[c.lane.focus],
        run: (c) => c.setLane((l) => toggleDock(l, l.focus))
      },
      {
        // The keyboard half of dragging a splitter. Same lane field, so a drag
        // and a keypress cannot disagree about how wide a panel is.
        id: 'panel.grow',
        title: 'Make panel bigger',
        group: 'Panels',
        run: (c) => nudgeSize(c, 60)
      },
      {
        id: 'panel.shrink',
        title: 'Make panel smaller',
        group: 'Panels',
        run: (c) => nudgeSize(c, -60)
      },
      {
        id: 'panel.resetSize',
        title: 'Reset panel size',
        group: 'Panels',
        enabled: (c) => {
          const panel = c.lane.panels[c.lane.focus]
          return !!panel && (panel.width !== undefined || panel.height !== undefined)
        },
        run: (c) => c.setLane((l) => clearSize(l, l.focus))
      },
      {
        id: 'panel.close',
        title: 'Close panel',
        group: 'Panels',
        keys: '⌘W',
        enabled: (c) => c.lane.panels.length > 0,
        // Closing the chat lands on the launcher — see closePanel.
        run: (c) => c.setLane((l) => closePanel(l, l.focus, () => c.makePanel('branch')))
      },
      {
        id: 'panel.goto',
        title: 'Go to panel',
        group: 'Panels',
        keys: '⌘E / ⌘⇧E / ⌘K G',
        // Some panels read the checked-out tree — git status, the file list, a
        // patch — so without a worktree there is nothing for them to show. That
        // is a refusal with a reason, not a no-op: this used to return silently,
        // which made ⌘K F look like a broken binding.
        enabled: (c, arg) => c.canOpen(arg ?? 'projects'),
        unavailable: (c, arg) => c.whyCannotOpen(arg ?? 'projects'),
        // Open it, focus it, or — if it is already the focused one — put it away.
        run: (c, arg) => {
          const kind = arg ?? 'projects'
          c.setLane((l) => toggleKind(l, kind, () => c.makePanel(kind)))
        }
      },
      {
        id: 'cursor.down',
        title: 'Move cursor down',
        group: 'Cursor',
        keys: 'j / ↓',
        run: (c) => moveCursor(c, 1)
      },
      {
        id: 'cursor.up',
        title: 'Move cursor up',
        group: 'Cursor',
        keys: 'k / ↑',
        run: (c) => moveCursor(c, -1)
      },
      // gg and G are two presses in vim because `g` is a prefix there. Here it
      // is not: nothing else starts with it, so the first press already means
      // "top" and a second one would be a key you press for nothing.
      {
        id: 'cursor.top',
        title: 'Move cursor to the top',
        group: 'Cursor',
        keys: 'g',
        run: (c) => landOn(c, c.rowsOf(c.panelEl(c.lane.focus)), 0)
      },
      {
        id: 'cursor.bottom',
        title: 'Move cursor to the bottom',
        group: 'Cursor',
        keys: '⇧G',
        run: (c) => {
          const rows = c.rowsOf(c.panelEl(c.lane.focus))
          landOn(c, rows, rows.length - 1)
        }
      },
      {
        id: 'cursor.halfDown',
        title: 'Move cursor half a screen down',
        group: 'Cursor',
        keys: '⌃D',
        run: (c) => moveCursor(c, pageStep(c, c.rowsOf(c.panelEl(c.lane.focus))))
      },
      {
        id: 'cursor.halfUp',
        title: 'Move cursor half a screen up',
        group: 'Cursor',
        keys: '⌃U',
        run: (c) => moveCursor(c, -pageStep(c, c.rowsOf(c.panelEl(c.lane.focus))))
      },
      {
        id: 'find.open',
        title: 'Search this panel',
        group: 'Cursor',
        keys: '/',
        run: (c) => c.openFind()
      },
      {
        id: 'find.next',
        title: 'Next match',
        group: 'Cursor',
        keys: 'n',
        run: (c) => c.findNext(1)
      },
      {
        id: 'find.prev',
        title: 'Previous match',
        group: 'Cursor',
        keys: '⇧N',
        run: (c) => c.findNext(-1)
      },
      {
        id: 'scroll.down',
        title: 'Scroll down',
        group: 'Cursor',
        keys: '⌃J',
        run: (c) => scrollPanel(c, 1)
      },
      {
        id: 'scroll.up',
        title: 'Scroll up',
        group: 'Cursor',
        keys: '⌃K',
        run: (c) => scrollPanel(c, -1)
      },
      {
        id: 'composer.focus',
        title: 'Write a message',
        group: 'Chat',
        keys: 'i',
        // Which panels have a composer is a DOM question, not a list of kinds:
        // the chat has one and so does the branch launcher, and the next panel
        // that grows one would otherwise have to be remembered here too.
        enabled: (c) => !!findComposer(c),
        run: (c) => findComposer(c)?.focus()
      },
      {
        id: 'composer.leave',
        title: 'Leave the composer',
        group: 'Chat',
        keys: 'Esc',
        run: () => (document.activeElement as HTMLElement | null)?.blur()
      },
      {
        id: 'selection.toggle',
        title: 'Start or end line selection',
        group: 'Selection',
        keys: 'v',
        enabled: (c) => {
          const kind = c.lane.panels[c.lane.focus]?.kind
          return kind === 'diff' || kind === 'file'
        },
        run: (c) =>
          c.setLane((l) => {
            const panel = l.panels[l.focus]
            if (!panel) return l
            const at = panel.cursor ?? 0
            return patchPanel(l, l.focus, {
              selection: panel.selection ? null : { anchor: at, head: at }
            })
          })
      },
      {
        id: 'selection.cancel',
        title: 'Cancel line selection',
        group: 'Selection',
        keys: 'Esc',
        run: (c) => c.setLane((l) => patchPanel(l, l.focus, { selection: null }))
      },
      {
        id: 'selection.comment',
        title: 'Send selected lines to the composer',
        group: 'Selection',
        keys: 'c',
        enabled: (c) => !!c.lane.panels[c.lane.focus]?.selection,
        run: (c) => commentOnSelection(c)
      },
      {
        id: 'palette.open',
        title: 'Switch project…',
        group: 'App',
        keys: '⌘/',
        run: (c) => c.openPalette()
      },
      {
        id: 'palette.commands',
        title: 'Show all commands',
        group: 'App',
        keys: '⌘⇧P',
        run: (c) => c.openCommands()
      },
      {
        id: 'palette.files',
        title: 'Find file…',
        group: 'App',
        keys: '⌘P',
        // The list is the checked-out tree's, so it needs one — same refusal,
        // and the same sentence, as opening the Files panel.
        enabled: (c) => c.canOpen('file'),
        unavailable: (c) => c.whyCannotOpen('file'),
        run: (c) => c.openFiles()
      },
      {
        // The account panel IS the login flow, so "sign in" and "who am I"
        // are the same command — there is nothing to run behind your back.
        id: 'auth.account',
        title: 'Sign in to Claude…',
        group: 'App',
        run: (c) => c.setLane((l) => toggleKind(l, 'account', () => c.makePanel('account')))
      },
      {
        id: 'keybindings.reset',
        title: 'Reset keybindings to defaults…',
        group: 'App',
        run: () => {
          void window.floe.keybindings.reset()
        }
      },
      {
        id: 'editor.open',
        title: 'Edit in your editor',
        group: 'Files',
        keys: 'e',
        enabled: (c) => !!editTargetOf(c) && !!c.worktree,
        run: (c) => {
          const target = editTargetOf(c)
          const cwd = c.worktree?.path
          if (!target?.path || !cwd) return
          // The main process owns the choice: a terminal editor answers `panel`
          // and runs in the editor panel's PTY, a GUI one is already launching
          // by the time this resolves. The renderer must not keep its own list
          // of which editors are which.
          void window.floe.editor.launch(cwd, target.path, target.line).then((result) => {
            if (result.mode !== 'panel') return
            c.setLane((l) => open(l, c.makePanel('edit', editSub(target.path, target.line))))
          })
        }
      },
      {
        id: 'files.expand',
        title: 'Open directory',
        group: 'Cursor',
        keys: 'l',
        enabled: (c) => c.lane.panels[c.lane.focus]?.kind === 'files',
        run: (c) => {
          // The row already draws whether it is open, so the DOM answers this —
          // no need to lift a tree's expansion state into the lane just so a
          // key can read it. Clicking is what a mouse does here too, so both
          // routes go through exactly one toggle.
          const row = fileRow(c)
          if (row?.dataset.dir !== undefined && row.dataset.open === undefined) row.click()
        }
      },
      {
        id: 'files.collapse',
        title: 'Close directory',
        group: 'Cursor',
        keys: 'h',
        enabled: (c) => c.lane.panels[c.lane.focus]?.kind === 'files',
        run: (c) => {
          const row = fileRow(c)
          if (!row) return
          if (row.dataset.dir !== undefined && row.dataset.open !== undefined) return row.click()
          // Not on an open directory: go up to the one that contains this row.
          // `h` should never be a no-op — walking out of a directory is the
          // other half of walking into it.
          const parent = row.dataset.parent
          if (!parent) return
          const up = c.panelEl(c.lane.focus)?.querySelector<HTMLElement>(`[data-dir="${CSS.escape(parent)}"]`)
          up?.focus()
        }
      },
      {
        id: 'settings.open',
        title: 'Settings…',
        group: 'App',
        keys: '⌘,',
        run: (c) => c.setLane((l) => toggleKind(l, 'settings', () => c.makePanel('settings')))
      },
      {
        id: 'project.add',
        title: 'Add project…',
        group: 'App',
        keys: 'n',
        run: (c) => c.addProject()
      },
      {
        id: 'group.create',
        title: 'New project group…',
        group: 'App',
        run: (c) => c.createGroup()
      },
      {
        id: 'project.move',
        title: 'Move project to group…',
        group: 'App',
        run: (c) => c.moveProject()
      },
      {
        // The row the cursor is on, not the current project: `d` acts on what
        // you are looking at, which is the only reading that matches the list.
        id: 'project.delete',
        title: 'Remove project from Floe…',
        group: 'App',
        keys: 'd',
        enabled: (c) => c.lane.panels[c.lane.focus]?.kind === 'projects',
        run: (c) => c.deleteProject()
      },
      {
        id: 'project.move.start',
        title: 'Move project between groups',
        group: 'App',
        keys: 'm',
        enabled: (c) => c.lane.panels[c.lane.focus]?.kind === 'projects',
        run: (c) => c.startMoveProject()
      },
      {
        id: 'project.move.down',
        title: 'Carry the held project down a group',
        group: 'App',
        keys: 'j',
        enabled: (c) => c.movingProject,
        run: (c) => c.stepMoveProject(1)
      },
      {
        id: 'project.move.up',
        title: 'Carry the held project up a group',
        group: 'App',
        keys: 'k',
        enabled: (c) => c.movingProject,
        run: (c) => c.stepMoveProject(-1)
      },
      {
        id: 'project.move.commit',
        title: 'Drop the held project in this group',
        group: 'App',
        keys: '↵',
        enabled: (c) => c.movingProject,
        run: (c) => c.endMoveProject(true)
      },
      {
        id: 'project.move.cancel',
        title: 'Put the held project back',
        group: 'App',
        keys: 'Esc',
        enabled: (c) => c.movingProject,
        run: (c) => c.endMoveProject(false)
      },
      {
        id: 'group.delete',
        title: 'Delete project group…',
        group: 'App',
        run: (c) => c.deleteGroup()
      },
      {
        id: 'session.new',
        title: 'New session',
        group: 'Sessions',
        keys: '⌘T',
        // A session with nothing said yet IS the launcher, so this opens it
        // rather than creating a record: an empty session persisted before you
        // type anything would litter the list with things you abandoned.
        enabled: (c) => !!c.worktree,
        run: (c) =>
          c.setLane((l) =>
            open(l, c.makePanel('branch', c.worktree?.branch))
          )
      },
      {
        // Newer and older, in the sidebar's own order. Ctrl, not a bare letter,
        // for the same reason ⌃H/⌃L are: this has to work mid-sentence in the
        // composer, which is where you are when you want the other session.
        id: 'session.prev',
        title: 'Newer session on this branch',
        group: 'Sessions',
        keys: '⌃I',
        enabled: (c) => !!c.worktree,
        run: (c) => c.cycleSession(-1)
      },
      {
        // vim's ⌃^: two chats, one key, back and forth. Not a history stack —
        // just the last one, which is the jump you actually make.
        id: 'session.alternate',
        title: 'Back to the last chat',
        group: 'Sessions',
        keys: '⌃W',
        enabled: (c) => !!c.alternateSession,
        run: (c) => c.alternateSession?.()
      },
      {
        id: 'session.next',
        title: 'Older session on this branch',
        group: 'Sessions',
        keys: '⌃O',
        enabled: (c) => !!c.worktree,
        run: (c) => c.cycleSession(1)
      },
      {
        // "Delete" is Floe's record of the session, not the conversation:
        // the Claude transcript stays on disk and `claude --resume` still finds
        // it. Same call the sidebar's close uses — one way to forget a session.
        id: 'session.delete',
        title: 'Delete session…',
        group: 'Sessions',
        enabled: (c) => c.lane.panels.some((p) => p.session),
        run: (c) => c.deleteSession()
      },
      {
        // The same forget, in bulk, over the sessions of the worktree the open
        // chat belongs to — the sidebar's list, not every session in the app.
        id: 'session.deleteOthers',
        title: 'Delete other sessions on this worktree…',
        group: 'Sessions',
        enabled: (c) => c.lane.panels.some((p) => p.session),
        run: (c) => c.deleteSession('others')
      },
      {
        id: 'session.deleteAll',
        title: 'Delete all sessions on this worktree…',
        group: 'Sessions',
        enabled: (c) => !!c.worktree || c.lane.panels.some((p) => p.session),
        run: (c) => c.deleteSession('all')
      },
      {
        id: 'worktree.new',
        title: 'New worktree',
        group: 'Worktrees',
        keys: '⌘N',
        run: (c) => c.newWorktree()
      },
      {
        id: 'palette.chord',
        title: 'Command palette',
        group: 'App',
        keys: '⌘K',
        // ponytail: the chord is handled in the key dispatcher today. When the
        // palette exists this opens it, and ⌘K G stays a shortcut through it.
        run: () => {}
      }
    ] satisfies Command[]
  ).map((c) => [c.id, c])
)

