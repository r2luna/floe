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
  focusAt,
  focusDir,
  open,
  patchPanel,
  resizePanel,
  toggleDock,
  toggleKind
} from './lane.ts'
import { appendComment, parseUnifiedDiff, quoteSelection, selRange } from './diff.ts'
import type { Command, CommandContext } from './commands.ts'

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

/** Quote the selected diff lines into the chat composer, ready to send. */
function commentOnSelection(c: CommandContext): void {
  const panel = c.lane.panels[c.lane.focus]
  const r = selRange(panel?.selection)
  if (!panel || !r) return

  // Rows here must be the SAME list the cursor indexes: the parse, not the DOM,
  // so the quote cannot drift from what is highlighted.
  const { rows } = parseUnifiedDiff(c.patchFor(panel.sub ?? ''))
  const nav = c.rowsOf(c.panelEl(c.lane.focus))
  const offset = nav.length - rows.length
  const quote = quoteSelection(rows, r[0] - offset, r[1] - offset, panel.sub ?? '')
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
        run: (c) => c.setLane((l) => close(l, l.focus))
      },
      {
        id: 'panel.goto',
        title: 'Go to panel',
        group: 'Panels',
        keys: '⌘E / ⌘⇧E / ⌘K G',
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
        group: 'Diff',
        keys: 'v',
        enabled: (c) => c.lane.panels[c.lane.focus]?.kind === 'diff',
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
        group: 'Diff',
        keys: 'Esc',
        run: (c) => c.setLane((l) => patchPanel(l, l.focus, { selection: null }))
      },
      {
        id: 'selection.comment',
        title: 'Comment on selected lines',
        group: 'Diff',
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
        // The account panel IS the login flow, so "sign in" and "who am I"
        // are the same command — there is nothing to run behind your back.
        id: 'auth.account',
        title: 'Sign in to Claude…',
        group: 'App',
        run: (c) => c.setLane((l) => toggleKind(l, 'account', () => c.makePanel('account')))
      },
      {
        id: 'project.add',
        title: 'Add project…',
        group: 'App',
        run: (c) => c.addProject()
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
        // "Delete" is Rookery's record of the session, not the conversation:
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

