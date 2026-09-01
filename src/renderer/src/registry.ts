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
import { shorten } from './fileRefs.ts'
import type { Command, CommandContext } from './commands.ts'
import { editSub } from './editorTarget.ts'
import { sendToTerminal } from './terminalBus.ts'
import { startSkillDraft } from './skillDraft.ts'
import { startMcpDraft } from './mcpDraft.ts'
import { reason } from './ipcError.ts'
import type { FileOp } from '../../shared/types.ts'

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

/**
 * The tree row the cursor is on, as a worktree-relative path.
 *
 * Directories count: renaming, moving and deleting a directory are the same
 * three operations, and refusing them on a folder would be an arbitrary hole.
 */
function fileTarget(c: CommandContext): string | undefined {
  if (c.lane.panels[c.lane.focus]?.kind !== 'files') return undefined
  const row = fileRow(c)
  return row?.dataset.file ?? row?.dataset.dir
}

/**
 * The skill row the cursor is on, or null when the focus is somewhere else.
 *
 * Read from the DOM for the same reason `fileTarget` is: the row already knows
 * which skill it is, and lifting the list into the lane just so three commands
 * could ask would give the panel a second copy of itself to keep in step.
 */
function skillRow(c: CommandContext): HTMLElement | null {
  if (c.lane.panels[c.lane.focus]?.kind !== 'skills') return null
  const row = fileRow(c)
  return row?.dataset.skill ? row : null
}

/** The MCP server row under the cursor — same contract as skillRow. */
function mcpRow(c: CommandContext): HTMLElement | null {
  if (c.lane.panels[c.lane.focus]?.kind !== 'mcp') return null
  const row = fileRow(c)
  return row?.dataset.mcp ? row : null
}

/**
 * The command row the cursor is on, as its id.
 *
 * Read off the row's own `data-command` rather than by counting rows, for the
 * same reason `fileTarget` does: the row already knows which command it is, and
 * an index into a list that grows a header the day someone adds one is exactly
 * the arithmetic that starts the wrong process.
 */
function commandTarget(c: CommandContext): string | undefined {
  if (c.lane.panels[c.lane.focus]?.kind !== 'commands') return undefined
  return fileRow(c)?.dataset.command
}

/** Whether the command under the cursor has a live process. */
function commandLive(c: CommandContext): boolean {
  const id = commandTarget(c)
  const state = id ? c.commands.runOf(id)?.state : undefined
  return state === 'running' || state === 'starting'
}

/** Join a directory and a name, where the directory may be the root (''). */
function join(dir: string, name: string): string {
  const clean = name.replace(/^\/+|\/+$/g, '')
  const base = dir.replace(/^\/+|\/+$/g, '')
  return base ? `${base}/${clean}` : clean
}

/**
 * Run file operations and report what failed.
 *
 * Nothing here refreshes the tree: the panel already follows the worktree's
 * watcher, so the row disappears (or reappears under its new name) the same way
 * it would if an agent had done it.
 */
function applyOps(c: CommandContext, root: string, ops: FileOp[]): void {
  void window.floe.files.apply(root, ops).then((errors) => {
    if (errors.length) c.say(errors[0])
  })
}

/** The command on the shell row the cursor is on, if it is on one. */
function bashCommand(c: CommandContext): string | undefined {
  // The kind is checked first so this stays answerable without a DOM: the
  // palette and the MCP tool ask every command whether it is available, from
  // a node process with no document in sight.
  if (c.lane.panels[c.lane.focus]?.kind !== 'chat') return undefined
  const active = document.activeElement as HTMLElement | null
  if (!active || !c.panelEl(c.lane.focus)?.contains(active)) return undefined
  return active.closest<HTMLElement>('[data-cmd]')?.dataset.cmd
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
 * Four panels can answer: the tree and the plans list (the row under the
 * cursor), the reader (its own file, on the cursor's line) and a diff (the
 * file, on the line that row is in the NEW version — an editor has nothing to
 * say about the old one). Null when the focused panel is none of those, which
 * is what dims the command.
 */
function editTargetOf(c: CommandContext): { path: string; line?: number } | null {
  const panel = c.lane.panels[c.lane.focus]
  if (!panel) return null
  // A list whose rows name a file — the tree and the plans list. Both mark the
  // row with `data-file`, so one read covers them and a third list joins by
  // marking its rows the same way.
  if (panel.kind === 'files' || panel.kind === 'plans') {
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
      ? // A file panel reading its own root — a skill, which lives in Floe's
        // config — is not in the worktree, so a relative path would name
        // nothing the agent can open. The full path is what gets sent; the
        // composer only ever shows the short token standing for it.
        shorten(fileRef(panel.root ? `${panel.root}/${panel.sub ?? ''}` : (panel.sub ?? ''), r[0], r[1]).trim()) + '\n\n'
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
        // The scheduled poll is hours apart, so right after a release the machine
        // that published it would otherwise sit on the old version — or get the
        // new one hand-copied over a running bundle, which corrupts the asar
        // reads. This is the way to pull a release in on demand.
        id: 'update.check',
        title: 'Check for updates now',
        group: 'App',
        run: (c) => {
          void window.floe.checkForUpdate().then((message) => c.say(message))
        }
      },
      {
        // The only way a downloaded update ever gets applied: the main process
        // refuses to swap the bundle on quit, so quitting and reopening keeps
        // you on the old version. The banner's button dispatches this id.
        id: 'update.install',
        title: 'Restart to update…',
        group: 'App',
        enabled: (c) => !!c.pendingUpdate,
        unavailable: () => 'no update downloaded yet',
        run: () => {
          void window.floe.installUpdate()
        }
      },
      {
        // Manual fallback for the boot-time auto-registration (mcpServer.ts):
        // needed when Floe came up on a fallback port, or the `claude` CLI
        // appeared on PATH after launch.
        id: 'mcp.install',
        title: 'Install Floe MCP globally',
        group: 'App',
        run: (c) => {
          void window.floe.mcp.installGlobal().then((r) => c.say(r.message))
        }
      },
      {
        // The file is the setting's home; this is the way to flip it without
        // leaving the keyboard — and the way an agent flips it too, since every
        // registry command is an MCP `run_command`.
        id: 'composer.vim',
        title: 'Toggle vim motions in the composer',
        group: 'App',
        run: (c) => {
          void window.floe.config
            .get()
            .then((config) => window.floe.config.set('composer', 'vim', !config.composer.vim))
            .then((config) => c.say(config.composer.vim ? 'Vim motions on' : 'Vim motions off'))
            .catch((err: unknown) => c.say(reason(err)))
        }
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
        id: 'bash.copy',
        title: 'Copy this command',
        group: 'Chat',
        keys: 'y',
        enabled: (c) => !!bashCommand(c),
        run: (c) => {
          const command = bashCommand(c)
          if (!command) return
          void navigator.clipboard.writeText(command)
          c.say('Command copied.')
        }
      },
      {
        id: 'bash.run',
        title: 'Run this command in the terminal',
        group: 'Chat',
        keys: 'x',
        enabled: (c) => !!bashCommand(c) && !!c.worktree,
        // The same thing the ▶ on the row does, and the same thing a shell block
        // in a message does: open this worktree's terminal and type it in. The
        // terminal queues it if it is still attaching, so the panel opening and
        // the command arriving cannot race.
        run: (c) => {
          const command = bashCommand(c)
          const cwd = c.worktree?.path
          if (!command || !cwd) return
          c.setLane((l) => open(l, c.makePanel('terminal', cwd)))
          sendToTerminal(`term:${cwd}`, command)
        }
      },
      {
        id: 'files.rename',
        title: 'Rename file…',
        group: 'Files',
        keys: 'r',
        enabled: (c) => !!fileTarget(c) && !!c.worktree,
        run: (c) => {
          const path = fileTarget(c)
          const root = c.worktree?.path
          if (!path || !root) return
          const cut = path.lastIndexOf('/')
          const dir = cut === -1 ? '' : path.slice(0, cut)
          c.askText({
            placeholder: 'New name…',
            value: path.slice(cut + 1),
            verb: 'Rename to',
            // A name, not a path: this renames in place. Moving somewhere else
            // is `m`, and keeping the two apart is what makes `r` safe to press.
            onDone: (name) => applyOps(c, root, [{ kind: 'rename', from: path, to: join(dir, name) }])
          })
        }
      },
      {
        id: 'files.move',
        title: 'Move file…',
        group: 'Files',
        keys: 'm',
        enabled: (c) => !!fileTarget(c) && !!c.worktree,
        run: (c) => {
          const path = fileTarget(c)
          const root = c.worktree?.path
          if (!path || !root) return
          const cut = path.lastIndexOf('/')
          c.askText({
            placeholder: 'Destination directory…',
            value: cut === -1 ? '' : path.slice(0, cut),
            verb: 'Move to',
            // The directory, and the file keeps its name — the common move. A
            // rename on the way is `r` afterwards, or a path with a new last
            // segment, which `join` handles either way.
            onDone: (dest) =>
              applyOps(c, root, [{ kind: 'rename', from: path, to: join(dest, path.slice(cut + 1)) }])
          })
        }
      },
      {
        id: 'files.delete',
        title: 'Delete file…',
        group: 'Files',
        keys: 'd',
        enabled: (c) => !!fileTarget(c) && !!c.worktree,
        run: (c) => {
          const path = fileTarget(c)
          const root = c.worktree?.path
          if (!path || !root) return
          // This one really does delete from disk, so it says so — unlike
          // removing a project, which only forgets it.
          if (!window.confirm(`Delete "${path}" from the worktree? This removes it from disk.`)) return
          applyOps(c, root, [{ kind: 'delete', path }])
        }
      },
      {
        id: 'commands.open',
        title: 'Commands…',
        group: 'App',
        keys: '⌘K C',
        enabled: (c) => c.canOpen('commands'),
        unavailable: (c) => c.whyCannotOpen('commands'),
        run: (c) => c.setLane((l) => toggleKind(l, 'commands', () => c.makePanel('commands')))
      },
      {
        // The panel, not a palette: skills are things you keep, so the list has
        // to be somewhere you can act on it, not somewhere that closes the
        // moment you pick a row.
        id: 'skills.open',
        title: 'Skills…',
        group: 'App',
        run: (c) => c.setLane((l) => toggleKind(l, 'skills', () => c.makePanel('skills')))
      },
      {
        // Opens the panel if it is not up, then asks it for a draft row. The
        // naming happens in the list — see skillDraft.ts for why the command
        // only starts the flow.
        id: 'skill.new',
        title: 'New skill…',
        group: 'Skills',
        keys: 'n',
        run: (c) => {
          if (!c.lane.panels.some((p) => p.kind === 'skills')) {
            c.setLane((l) => open(l, c.makePanel('skills')))
          }
          startSkillDraft({ kind: 'new' })
        }
      },
      {
        id: 'skill.rename',
        title: 'Rename skill…',
        group: 'Skills',
        keys: 'r',
        enabled: (c) => !!skillRow(c),
        run: (c) => {
          const name = skillRow(c)?.dataset.skill
          // The row itself becomes the box. Renaming a skill renames the token
          // you type, and the main process moves the file and rewrites its
          // frontmatter so the two cannot disagree.
          if (name) startSkillDraft({ kind: 'rename', name })
        }
      },
      {
        id: 'skill.delete',
        title: 'Delete skill…',
        group: 'Skills',
        keys: 'd',
        enabled: (c) => !!skillRow(c),
        run: (c) => {
          const name = skillRow(c)?.dataset.skill
          if (!name) return
          // Like a file and unlike a project: this one really does remove from
          // disk, so it says the word.
          if (!window.confirm(`Delete the skill "${name}"? This removes the file from disk.`)) return
          void window.floe.skills.remove(name, c.worktree?.path).catch((err: unknown) => c.say(reason(err)))
        }
      },
      {
        id: 'skill.edit',
        title: 'Edit skill in your editor',
        group: 'Skills',
        keys: 'e',
        enabled: (c) => !!skillRow(c),
        run: (c) => {
          const row = skillRow(c)
          const root = row?.dataset.skillRoot
          const file = row?.dataset.skillFile
          if (root && file) c.editSkill(root, file)
        }
      },
      {
        // The panel, not a palette, for the reason skills got one: servers are
        // things you keep, and the list is where their state (connected /
        // needs-auth / off) is worth watching.
        id: 'mcp.open',
        title: 'MCP servers…',
        group: 'App',
        run: (c) => c.setLane((l) => toggleKind(l, 'mcp', () => c.makePanel('mcp')))
      },
      {
        // Opens the panel if it is not up, then asks it for a draft row — the
        // scope and the name happen in the list, see mcpDraft.ts.
        id: 'mcp.new',
        title: 'Add MCP server…',
        group: 'MCP',
        keys: 'n',
        run: (c) => {
          if (!c.lane.panels.some((p) => p.kind === 'mcp')) {
            c.setLane((l) => open(l, c.makePanel('mcp')))
          }
          startMcpDraft({ kind: 'new' })
        }
      },
      {
        // The row IS the file entry: editing a server is editing its mcp.toml,
        // opened in your editor rooted at the config directory it lives in.
        id: 'mcp.edit',
        title: 'Edit MCP server in your editor',
        group: 'MCP',
        keys: 'e',
        enabled: (c) => !!mcpRow(c),
        run: (c) => {
          const file = mcpRow(c)?.dataset.mcpFile
          if (!file) return
          const slash = file.lastIndexOf('/')
          c.editSkill(file.slice(0, slash), file.slice(slash + 1))
        }
      },
      {
        id: 'mcp.toggle',
        title: 'Enable/disable MCP server',
        group: 'MCP',
        keys: 't',
        enabled: (c) => !!mcpRow(c),
        run: (c) => {
          const row = mcpRow(c)
          const name = row?.dataset.mcp
          if (!name) return
          const enabled = row?.dataset.mcpEnabled === '1'
          void window.floe.mcp.servers
            .update(name, { enabled: !enabled }, c.worktree?.path)
            .catch((err: unknown) => c.say(reason(err)))
        }
      },
      {
        // `claude mcp login <name>` in a PTY (main/mcpAuth.ts): the consent URL
        // comes back over mcp:auth:event and the panel opens it in the browser.
        id: 'mcp.auth',
        title: 'Authenticate MCP server…',
        group: 'MCP',
        keys: 'a',
        enabled: (c) => !!mcpRow(c),
        run: (c) => {
          const name = mcpRow(c)?.dataset.mcp
          if (!name) return
          void window.floe.claude.authMcp(c.worktree?.path ?? window.floe.homeDir, name)
        }
      },
      {
        id: 'mcp.delete',
        title: 'Delete MCP server…',
        group: 'MCP',
        keys: 'd',
        enabled: (c) => !!mcpRow(c),
        run: (c) => {
          const name = mcpRow(c)?.dataset.mcp
          if (!name) return
          // Removes the entry from mcp.toml — the server itself is untouched,
          // but every future session loses it, so it still asks.
          if (!window.confirm(`Remove "${name}" from Floe's MCP registry?`)) return
          void window.floe.mcp.servers.remove(name, c.worktree?.path).catch((err: unknown) => c.say(reason(err)))
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
        // Newer and older, in the sidebar's own order — across every branch in
        // it, not just the open one. Ctrl, not a bare letter, for the same
        // reason ⌃H/⌃L are: this has to work mid-sentence in the composer,
        // which is where you are when you want the other session.
        id: 'session.prev',
        title: 'Newer session',
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
        title: 'Older session',
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
      // --- guided merge ---------------------------------------------------
      // Everything the checklist offers is a command: its chips dispatch these
      // ids, and so do ⏎ / r / s / esc over the panel.
      {
        id: 'worktree.merge',
        title: 'Merge worktree into its base',
        group: 'Worktrees',
        keys: '⌘K M',
        enabled: (c) => !!c.worktree,
        unavailable: () => 'no worktree to merge — open one first',
        run: (c) => c.merge.start()
      },
      {
        id: 'merge.confirm',
        // One key for the one thing the checklist is waiting for: it stops
        // either at the review checkpoint or on a failed step, never both.
        title: 'Merge: approve, or retry the failed step',
        group: 'Worktrees',
        keys: '⏎',
        enabled: (c) => c.merge.awaitingReview || c.merge.failed,
        unavailable: () => 'the merge is not waiting on you',
        run: (c) => (c.merge.failed ? c.merge.retry() : c.merge.approve())
      },
      {
        id: 'merge.review',
        title: 'Merge: review the changes',
        group: 'Worktrees',
        keys: 'r',
        // The flow stays paused at the checkpoint — this only puts the diff on
        // screen, so approving is still a deliberate second key.
        enabled: (c) => c.merge.awaitingReview && c.canOpen('changes'),
        unavailable: (c) =>
          c.merge.awaitingReview ? c.whyCannotOpen('changes') : 'the merge is not waiting on a review',
        run: (c) => c.setLane((l) => toggleKind(l, 'changes', () => c.makePanel('changes')))
      },
      {
        id: 'merge.stash',
        title: 'Merge: stash the uncommitted changes and retry',
        group: 'Worktrees',
        keys: 's',
        enabled: (c) => c.merge.canStash,
        unavailable: () => 'nothing to stash — the merge is not blocked on a dirty tree',
        run: (c) => c.merge.stashRetry()
      },
      {
        id: 'merge.cancel',
        title: 'Merge: cancel',
        group: 'Worktrees',
        keys: 'esc',
        enabled: (c) => c.merge.active,
        unavailable: () => 'no merge running',
        // What git has already done stays done — this drops the checklist, it
        // does not roll the merge back.
        //
        // The panel goes with it: a dismissed merge leaves an empty checklist
        // holding the focus, which is exactly the stranded focus the
        // keyboard-first rule is about.
        run: (c) => {
          c.merge.cancel()
          c.setLane((l) => {
            const at = l.panels.findIndex((p) => p.kind === 'merge')
            return at === -1 ? l : close(l, at)
          })
        }
      },
      {
        id: 'command.run',
        title: 'Run command',
        group: 'Commands',
        keys: 'r',
        enabled: (c) => !!commandTarget(c),
        unavailable: () => 'no command under the cursor',
        // One key for both, because the question you are answering is "run
        // this" either way — a running command restarts, a stopped one starts.
        run: (c) => {
          const id = commandTarget(c)
          if (!id) return
          if (commandLive(c)) c.commands.restart(id)
          else c.commands.start(id)
        }
      },
      {
        id: 'command.stop',
        title: 'Stop command',
        group: 'Commands',
        keys: 's',
        enabled: (c) => commandLive(c),
        unavailable: (c) => (commandTarget(c) ? 'that command is not running' : 'no command under the cursor'),
        run: (c) => {
          const id = commandTarget(c)
          if (id) c.commands.stop(id)
        }
      },
      {
        id: 'command.restart',
        title: 'Restart command',
        group: 'Commands',
        keys: '⇧R',
        enabled: (c) => !!commandTarget(c),
        unavailable: () => 'no command under the cursor',
        run: (c) => {
          const id = commandTarget(c)
          if (id) c.commands.restart(id)
        }
      },
      {
        id: 'command.logs',
        title: 'Show command output',
        group: 'Commands',
        keys: '⏎',
        enabled: (c) => !!commandTarget(c) && !!c.worktree,
        unavailable: () => 'no command under the cursor',
        run: (c) => {
          const id = commandTarget(c)
          if (!id || !c.worktree) return
          c.setLane((l) => open(l, c.makePanel('cmdlog', `${c.worktree?.path}#${id}`)))
        }
      },
      {
        id: 'command.runAll',
        title: 'Run every stopped command',
        group: 'Commands',
        enabled: (c) => c.commands.list.length > 0,
        unavailable: () => 'this worktree has no commands',
        run: (c) => c.commands.startAll()
      },
      {
        id: 'command.stopAll',
        title: 'Stop every running command',
        group: 'Commands',
        enabled: (c) => c.commands.list.some((x) => c.commands.runOf(x.id)?.state === 'running'),
        unavailable: () => 'nothing running in this worktree',
        run: (c) => {
          for (const x of c.commands.list) c.commands.stop(x.id)
        }
      },
      {
        id: 'command.add',
        title: 'Add command…',
        group: 'Commands',
        keys: 'a',
        enabled: (c) => !!c.worktree,
        unavailable: () => 'no worktree open',
        // Two prompts rather than a form: the palette is what the app already
        // uses to ask for one line, and a name and a command line are two.
        run: (c) => {
          c.askText({
            placeholder: 'Name…',
            verb: 'Call it',
            onDone: (name) => {
              if (!name.trim()) return
              c.askText({
                placeholder: 'Command to run…',
                verb: 'Run',
                onDone: (command) => {
                  if (!command.trim()) return
                  void c.commands.add(name, command)
                }
              })
            }
          })
        }
      },
      {
        id: 'command.edit',
        title: 'Edit command…',
        group: 'Commands',
        keys: 'e',
        enabled: (c) => !!commandTarget(c),
        unavailable: () => 'no command under the cursor',
        run: (c) => {
          const id = commandTarget(c)
          const cmd = c.commands.list.find((x) => x.id === id)
          if (!id || !cmd) return
          c.askText({
            placeholder: 'Command to run…',
            value: cmd.command,
            verb: 'Run',
            onDone: (command) => {
              if (command.trim()) void c.commands.update(id, { command })
            }
          })
        }
      },
      {
        id: 'command.rename',
        title: 'Rename command…',
        group: 'Commands',
        // Deliberately refused while it runs: the id is the slug of the name
        // (see commandStore), so renaming re-keys the command and the output
        // panel loses the process it was showing — which keeps running, and
        // which you can then no longer stop by name.
        enabled: (c) => !!commandTarget(c) && !commandLive(c),
        unavailable: (c) =>
          commandLive(c) ? 'stop it first — renaming a running command orphans its output' : 'no command under the cursor',
        run: (c) => {
          const id = commandTarget(c)
          const cmd = c.commands.list.find((x) => x.id === id)
          if (!id || !cmd) return
          c.askText({
            placeholder: 'Name…',
            value: cmd.name,
            verb: 'Call it',
            onDone: (name) => {
              if (name.trim()) void c.commands.update(id, { name })
            }
          })
        }
      },
      {
        id: 'command.scope',
        title: 'Move command between project and this worktree',
        group: 'Commands',
        enabled: (c) => !!commandTarget(c),
        unavailable: () => 'no command under the cursor',
        // A toggle, not two commands: "shared by the project" and "only here"
        // are the two halves of one question.
        run: (c) => {
          const id = commandTarget(c)
          const cmd = c.commands.list.find((x) => x.id === id)
          if (!id || !cmd) return
          void c.commands.setScope(id, cmd.scope === 'project' ? 'local' : 'project')
        }
      },
      {
        id: 'command.delete',
        title: 'Delete command…',
        group: 'Commands',
        keys: 'd',
        enabled: (c) => !!commandTarget(c),
        unavailable: () => 'no command under the cursor',
        // Stopped first: deleting the row while the process runs would leave it
        // running with nothing left in the UI that can name it.
        run: (c) => {
          const id = commandTarget(c)
          const cmd = c.commands.list.find((x) => x.id === id)
          if (!id || !cmd) return
          c.askText({
            placeholder: `Delete "${cmd.name}"? Type y to confirm`,
            verb: 'Delete',
            onDone: (answer) => {
              if (answer.trim().toLowerCase() !== 'y') return
              c.commands.stop(id)
              void c.commands.remove(id)
            }
          })
        }
      },
      {
        id: 'backend.use',
        title: 'Attach backend…',
        group: 'Backends',
        // With an id (the MCP path) it switches directly; bare, App offers the
        // picker. Switching remounts the tree so every panel refetches from the
        // new machine — how is App's business, not the registry's.
        run: (c, arg) => c.useBackend(arg)
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

